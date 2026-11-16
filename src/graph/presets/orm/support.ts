// ORM 프리셋이 함께 쓰는 도우미. 엔티티 읽기·쓰기 결과 만들기, 필드 쓰기 만들기, 읽어 온 엔티티 변수 찾기
import { collapseText } from '../../extractors/normalize.js';
import type {
  CodeSite,
  CodeSiteArgument,
  DataAccessDetection,
  ExtractedSymbol,
  FieldWriteDetection,
  PresetContext,
} from '../../types.js';
import { detectionBase, siteConditions } from '../messaging/support.js';
import { LOCAL_NAME_PATTERN, MAX_VALUE_SUMMARY_LENGTH } from './constants.js';
import type { EntityAccess, FieldWriteSource } from './types.js';

/** 넣는 값을 줄여 쓴 글. 자리 인자 글은 이미 문자열을 `<literal>` 로 가린 상태다 */
export function valueSummary(text: string): string {
  return collapseText(text, MAX_VALUE_SUMMARY_LENGTH);
}

/** 대문자로 시작하는 이름 하나(엔티티 클래스 자리) */
export function isClassName(name: string | undefined): name is string {
  return name !== undefined && /^[A-Z][\w$]*$/.test(name);
}

/** 엔티티 인자. 클래스 이름이나 엔티티 이름 문자열 */
export function entityArgument(
  argument: CodeSiteArgument | undefined,
): string | undefined {
  if (!argument) {
    return undefined;
  }
  if (argument.literal !== undefined) {
    return argument.literal || undefined;
  }
  return isClassName(argument.identifier) ? argument.identifier : undefined;
}

/** 호출식 글의 괄호 안을 비우고 공백을 뺀다(`await repo.findOneBy({ id })` → `awaitrepo.findOneBy()`) */
export function stripCallArguments(text: string): string {
  let result = '';
  let depth = 0;
  for (const character of text) {
    if (character === '(') {
      if (depth === 0) {
        result += character;
      }
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        result += character;
      }
    } else if (depth === 0) {
      result += character;
    }
  }
  return result.replace(/\s+/g, '');
}

/** 연쇄 호출의 앞 단계 자리. 이름이 같고 이 자리보다 앞(같은 줄 포함)에 있는 것 가운데 가장 가까운 것 */
export function chainStep(
  sites: readonly CodeSite[],
  site: CodeSite,
  name: string,
): CodeSite | undefined {
  let found: CodeSite | undefined;
  for (const candidate of sites) {
    if (
      candidate.name === name &&
      candidate.line <= site.line &&
      (!found || candidate.line >= found.line)
    ) {
      found = candidate;
    }
  }
  return found;
}

/** 심볼 하나의 엔티티 읽기·쓰기. 같은 종류·같은 엔티티는 처음 자리 하나로 합친다 */
export function accessDetections(
  symbol: ExtractedSymbol,
  context: PresetContext,
  detector: string,
  accesses: readonly EntityAccess[],
): DataAccessDetection[] {
  const groups = new Map<string, EntityAccess[]>();
  for (const access of accesses) {
    const key = `${access.kind}\u0000${access.entity}`;
    const group = groups.get(key) ?? [];
    group.push(access);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const [first] = group;
    const more = group.length > 1 ? ` (+${group.length - 1})` : '';
    return {
      ...detectionBase(
        symbol,
        context,
        detector,
        Math.min(...group.map((item) => item.confidence)),
        first.site.line,
        `${first.site.name} via ${first.via}${more}`,
      ),
      kind: first.kind,
      target: first.entity,
      targetType: 'class',
    };
  });
}

/** 바꿀 필드 묶음(객체, 객체 배열)의 키마다 필드 쓰기 하나 */
export function fieldWriteDetections(
  symbol: ExtractedSymbol,
  context: PresetContext,
  detector: string,
  sources: readonly FieldWriteSource[],
): FieldWriteDetection[] {
  const found: FieldWriteDetection[] = [];
  for (const source of sources) {
    const objects = source.fields.elements ?? [source.fields];
    const conditions = siteConditions(symbol, source.site);
    for (const object of objects) {
      for (const [field, value] of Object.entries(object.properties ?? {})) {
        const summary = source.operator
          ? `${source.operator} ${value.text}`
          : value.text;
        found.push({
          ...detectionBase(
            symbol,
            context,
            detector,
            source.confidence,
            source.site.line,
            `${source.site.name}(…) sets ${field}`,
          ),
          kind: 'field-write',
          ...(source.entity ? { entity: source.entity } : {}),
          field,
          writeKind: source.writeKind,
          valueSummary: valueSummary(summary),
          ...(conditions ? { conditions } : {}),
        });
      }
    }
  }
  return found;
}

/**
 * 엔티티 하나를 읽어 온 지역 변수(`const order = await this.orders.findOneBy(…)`) → 그 엔티티
 * 대입 사실의 값 글에 읽기 호출 자리가 들어 있고 그 호출이 하나만 돌려줄 때만 잇는다
 */
export function singleEntityLocals(
  symbol: ExtractedSymbol,
  accesses: readonly EntityAccess[],
  isSingle: (access: EntityAccess) => boolean,
): Map<string, EntityAccess> {
  const locals = new Map<string, EntityAccess>();
  for (const fact of symbol.executionFacts ?? []) {
    if (
      fact.kind !== 'assigns' ||
      !fact.subject ||
      !LOCAL_NAME_PATTERN.test(fact.subject) ||
      !fact.value
    ) {
      continue;
    }
    const stripped = stripCallArguments(fact.value);
    let best: EntityAccess | undefined;
    for (const access of accesses) {
      if (
        isSingle(access) &&
        access.site.line >= fact.line &&
        stripped.includes(`${access.site.name}(`) &&
        (!best || access.site.name.length > best.site.name.length)
      ) {
        best = access;
      }
    }
    if (best) {
      locals.set(fact.subject, best);
    } else {
      locals.delete(fact.subject);
    }
  }
  return locals;
}

/** 읽어 온 엔티티 변수의 필드 대입(`order.status = …`) */
export function assignmentWrites(
  symbol: ExtractedSymbol,
  context: PresetContext,
  detector: string,
  locals: ReadonlyMap<string, EntityAccess>,
  confidence: number,
): FieldWriteDetection[] {
  const found: FieldWriteDetection[] = [];
  for (const fact of symbol.executionFacts ?? []) {
    if (fact.kind !== 'assigns' || !fact.subject) {
      continue;
    }
    const [local, field, ...rest] = fact.subject.split('.');
    const access = locals.get(local);
    if (
      !access ||
      rest.length > 0 ||
      !field ||
      !LOCAL_NAME_PATTERN.test(field)
    ) {
      continue;
    }
    found.push({
      ...detectionBase(
        symbol,
        context,
        detector,
        confidence,
        fact.line,
        `${fact.subject} = … (${local} from ${access.site.name})`,
      ),
      kind: 'field-write',
      entity: access.entity,
      field,
      writeKind: 'assignment',
      valueSummary: valueSummary(fact.value ?? ''),
      ...(fact.conditions && fact.conditions.length > 0
        ? { conditions: [...fact.conditions] }
        : {}),
    });
  }
  return found;
}
