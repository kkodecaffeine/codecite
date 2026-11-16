// 필드 쓰기 색인. 필드마다 그 필드에 값을 넣는 심볼을 모아, 상태 값을 다시 켜는 곳 같은 질문의 출발점으로 쓴다
// 쓰기는 두 곳에서 모은다: ORM 프리셋의 field-write 탐지(엔티티를 안다)와 레코드 실행 사실의 속성 대입
// - 키는 계약대로 `저장소:필드` 다. 같은 이름의 필드가 여러 엔티티에 있으므로, 읽는 쪽은 항목의 entity 로 걸러야 한다.
//   필드 이름만으로 읽는 쪽과 잇지 않는다(아키텍처 6.5). entity 는 받는 쪽 타입을 알 때만 단다
// - 키 하나의 항목 수는 한도에서 모듈을 돌아가며 골라 자른다. 경로 순으로만 자르면 뒤쪽 모듈(작업자, 예약 작업)의 쓰기가 통째로 빠진다
import type {
  CurrentSymbolRecord,
  ExecutionFact,
  FieldWriteKind,
  FieldWriterEntry,
  FieldWriterIndex,
} from '../../extensions/code-knowledge.js';
import { GRAPH_SCHEMA_VERSION, TOPOLOGY_SELF_RECEIVERS } from '../constants.js';
import { repositoryReceivers } from '../detect.js';
import {
  CLIPPED_TEXT_MARK,
  DUPLICATE_SYMBOL_SEPARATOR,
  ENV_PLACEHOLDER,
  EXECUTABLE_SYMBOL_KINDS,
  LITERAL_PLACEHOLDER,
} from '../extractors/constants.js';
import { canonicalJson, latestCommittedAt } from '../output.js';
import { compareText, matchesAnyGlob } from '../files.js';
import { stableSymbolId } from '../records.js';
import type { FieldWriteDetection, GraphBuildState } from '../types.js';
import {
  CONSTRUCTOR_NAMES,
  ENVIRONMENT_READ_PATTERN,
  FIELD_WRITE_KINDS,
  FIELD_WRITER_GLOBAL_PREFIXES,
  FIELD_WRITER_GLOBAL_ROOTS,
  FIELD_WRITER_MAX_CONDITIONS,
  FIELD_WRITER_MODULE_SEGMENTS,
  FIELD_WRITER_SKIPPED_PATHS,
  FIELD_WRITER_SKIPPED_SEGMENTS,
  FIELD_WRITER_VALUE_MAX_CHARS,
  MAX_WRITERS_PER_FIELD,
  PLAIN_NAME_PATTERN,
  PROPERTY_CHAIN_PATTERN,
  QUOTED_LITERAL_PATTERN,
} from './constants.js';
import { createEntityTableResolver } from './entities.js';
import type { EntityTableResolver } from './types.js';

/** 쓰기 하나와 그 키 */
interface FieldWrite {
  key: string;
  entry: FieldWriterEntry;
}

/**
 * 필드 쓰기 색인을 만든다
 * - ORM 탐지(field-write): 프리셋이 낸 필드·쓰기 방식·엔티티. 엔티티 클래스 이름은 entities.json 의 테이블 이름으로 푼다(못 풀면 그대로)
 * - 실행 사실(assigns): 함수·메서드의 속성 연쇄 대입(`order.status`, `this.coupon.expiresAt`, `self.balance`). 필드는 끝 조각이고 방식은 assignment 다.
 *   같은 자리·같은 필드를 ORM 탐지가 이미 냈으면(엔티티를 아는 쪽) 대입 사실은 버린다
 * - 빼는 것: 테스트·목·스토리 경로, 파일 최상위 문장·상수·열거형(선언이다), 지역 변수 하나, 전역 객체·환경 변수·내보내기,
 *   생성자에서 매개변수를 그대로 받아 두는 대입
 * generatedAt 은 저장소 커밋 시각 가운데 가장 늦은 것이다
 */
export function buildFieldWriterIndex(
  state: GraphBuildState,
): FieldWriterIndex {
  const resolver = createEntityTableResolver(state);
  const writes: FieldWrite[] = [];
  const detected = new Set<string>();
  for (const repository of [...state.detections.keys()].sort(compareText)) {
    for (const detection of state.detections.get(repository) ?? []) {
      if (detection.kind !== 'field-write') {
        continue;
      }
      const write = detectionWrite(repository, detection, resolver);
      if (write) {
        writes.push(write);
        detected.add(
          siteKey(
            repository,
            detection.filePath,
            detection.symbol,
            detection.line,
            detection.field,
          ),
        );
      }
    }
  }
  const receivers = receiverIndex(state);
  for (const record of state.records) {
    if (
      !EXECUTABLE_SYMBOL_KINDS.includes(record.kind) ||
      isSkippedPath(record.filePath)
    ) {
      continue;
    }
    for (const fact of record.executionFacts ?? []) {
      const write = assignmentWrite(record, fact, resolver, receivers);
      if (
        write &&
        !detected.has(
          siteKey(
            record.repository,
            record.filePath,
            record.symbol,
            fact.line,
            write.key.slice(record.repository.length + 1),
          ),
        )
      ) {
        writes.push(write);
      }
    }
  }
  return indexWrites(
    writes,
    latestCommittedAt(state.repositories.map((build) => build.manifest)),
  );
}

/**
 * 색인의 정해진 순서: 키는 이름 순, 키 안의 항목은 경로 → 줄 → 심볼 → 방식 → 엔티티 → 값 → 조건 → 심볼 id
 * truncated 도 키 이름 순이다. 결과 검사도 이 함수로 순서를 본다
 */
export function sortFieldWriterIndex(
  index: FieldWriterIndex,
): FieldWriterIndex {
  return {
    ...index,
    writers: Object.fromEntries(
      Object.keys(index.writers)
        .sort(compareText)
        .map((key) => [key, [...index.writers[key]].sort(compareFieldWriters)]),
    ),
    truncated: Object.fromEntries(
      Object.keys(index.truncated)
        .sort(compareText)
        .map((key) => [key, index.truncated[key]]),
    ),
  };
}

export function compareFieldWriters(
  left: FieldWriterEntry,
  right: FieldWriterEntry,
): number {
  return (
    compareText(left.filePath, right.filePath) ||
    left.lineStart - right.lineStart ||
    compareText(left.symbol, right.symbol) ||
    compareText(left.kind, right.kind) ||
    compareText(left.entity ?? '', right.entity ?? '') ||
    compareText(left.valueSummary, right.valueSummary) ||
    compareText(
      (left.conditions ?? []).join('\n'),
      (right.conditions ?? []).join('\n'),
    ) ||
    compareText(left.symbolId, right.symbolId)
  );
}

/** 경로 앞 두 조각을 모듈로 본다(`src/order/order.service.ts` → `src/order`) */
export function fieldWriterModule(filePath: string): string {
  return filePath.split('/').slice(0, FIELD_WRITER_MODULE_SEGMENTS).join('/');
}

/**
 * 한도를 넘는 항목을 모듈마다 돌아가며 고른다. 모듈은 이름 순, 모듈 안은 항목 순서로 하나씩 꺼내고,
 * 고른 항목은 다시 항목 순서로 놓는다
 */
export function pickAcrossModules(
  entries: readonly FieldWriterEntry[],
  limit: number,
): FieldWriterEntry[] {
  if (entries.length <= limit) {
    return [...entries];
  }
  const queues = new Map<string, FieldWriterEntry[]>();
  for (const entry of entries) {
    const module = fieldWriterModule(entry.filePath);
    queues.set(module, [...(queues.get(module) ?? []), entry]);
  }
  const ordered = [...queues.keys()]
    .sort(compareText)
    .map((module) => queues.get(module) ?? []);
  const picked: FieldWriterEntry[] = [];
  for (let round = 0; picked.length < limit; round += 1) {
    for (const queue of ordered) {
      if (round < queue.length && picked.length < limit) {
        picked.push(queue[round]);
      }
    }
  }
  return picked.sort(compareFieldWriters);
}

function indexWrites(
  writes: readonly FieldWrite[],
  generatedAt: string,
): FieldWriterIndex {
  const grouped = new Map<string, Map<string, FieldWriterEntry>>();
  for (const { key, entry } of writes) {
    const entries = grouped.get(key) ?? new Map<string, FieldWriterEntry>();
    entries.set(canonicalJson(entry), entry);
    grouped.set(key, entries);
  }
  const writers: Record<string, FieldWriterEntry[]> = {};
  const truncated: Record<string, number> = {};
  for (const key of [...grouped.keys()].sort(compareText)) {
    const entries = [...(grouped.get(key)?.values() ?? [])].sort(
      compareFieldWriters,
    );
    writers[key] = pickAcrossModules(entries, MAX_WRITERS_PER_FIELD);
    if (entries.length > MAX_WRITERS_PER_FIELD) {
      truncated[key] = entries.length;
    }
  }
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    generatedAt,
    maxWritersPerField: MAX_WRITERS_PER_FIELD,
    writers,
    truncated,
  };
}

function detectionWrite(
  repository: string,
  detection: FieldWriteDetection,
  resolver: EntityTableResolver,
): FieldWrite | undefined {
  const field = detection.field.trim();
  if (
    !field ||
    isSkippedPath(detection.filePath) ||
    !FIELD_WRITE_KINDS.includes(detection.writeKind)
  ) {
    return undefined;
  }
  const raw = detection.entity?.trim();
  const entity = raw
    ? (resolver.resolveClass(repository, raw) ??
      resolver.resolveTable(raw) ??
      raw)
    : undefined;
  return {
    key: `${repository}:${field}`,
    entry: entry(
      stableSymbolId(repository, detection.filePath, detection.symbol),
      detection.symbol,
      detection.filePath,
      detection.line,
      detection.writeKind,
      entity,
      detection.valueSummary,
      detection.conditions,
    ),
  };
}

/** 실행 사실 하나가 필드 쓰기면 그 쓰기. buildFieldWriterIndex 주석의 규칙으로 고르고 엔티티를 단다 */
function assignmentWrite(
  record: CurrentSymbolRecord,
  fact: ExecutionFact,
  resolver: EntityTableResolver,
  receivers: ReadonlyMap<string, Record<string, string>>,
): FieldWrite | undefined {
  if (fact.kind !== 'assigns' || !fact.subject) {
    return undefined;
  }
  const parts = propertyChain(fact.subject);
  if (!parts || isGlobalTarget(parts)) {
    return undefined;
  }
  const value = (fact.value ?? '').trim();
  if (isConstructor(record.symbol) && PLAIN_NAME_PATTERN.test(value)) {
    return undefined;
  }
  const field = parts[parts.length - 1];
  const entity = receiverEntity(record, parts, resolver, receivers);
  return {
    key: `${record.repository}:${field}`,
    entry: entry(
      record.stableSymbolId,
      record.symbol,
      record.filePath,
      fact.line,
      'assignment',
      entity,
      value,
      fact.conditions,
    ),
  };
}

/**
 * 받는 쪽 타입을 알 때 그 엔티티(테이블 이름)
 * - `this.필드`(`self.`, `cls.` 도): 메서드가 속한 클래스가 엔티티면 그 테이블. 같은 파일의 선언을 먼저 본다
 * - `this.멤버.필드`: 멤버의 타입 표기(탐지 단계가 남긴 클래스 멤버 타입)가 엔티티 클래스면 그 테이블
 * 그 밖(지역 변수, 더 깊은 연쇄)은 타입을 모르므로 비운다. 변수 이름이 클래스 이름과 닮았다는 것만으로 짐작하지 않는다
 */
function receiverEntity(
  record: CurrentSymbolRecord,
  parts: readonly string[],
  resolver: EntityTableResolver,
  receivers: ReadonlyMap<string, Record<string, string>>,
): string | undefined {
  if (!TOPOLOGY_SELF_RECEIVERS.includes(parts[0])) {
    return undefined;
  }
  const separator = record.symbol.lastIndexOf('.');
  if (separator <= 0) {
    return undefined;
  }
  const owner = record.symbol.slice(0, separator);
  if (parts.length === 2) {
    const className = owner.slice(owner.lastIndexOf('.') + 1);
    return resolver.resolveClass(record.repository, className, record.filePath);
  }
  if (parts.length === 3) {
    const type = receivers.get(
      receiverKey(record.repository, record.filePath, owner),
    )?.[parts[1]];
    return type ? resolver.resolveClass(record.repository, type) : undefined;
  }
  return undefined;
}

/** 대입 대상을 속성 연쇄 조각으로 나눈다. 이름 하나, 첨자·호출·형 변환을 거치는 대상은 undefined */
function propertyChain(subject: string): string[] | undefined {
  const text = subject
    .replace(/\s+/g, '')
    .replaceAll('?.', '.')
    .replace(/!(?=\.)/g, '');
  if (!PROPERTY_CHAIN_PATTERN.test(text)) {
    return undefined;
  }
  return text.split('.').map((part) => part.replace(/^#/, ''));
}

function isGlobalTarget(parts: readonly string[]): boolean {
  return (
    FIELD_WRITER_GLOBAL_ROOTS.includes(parts[0]) ||
    FIELD_WRITER_GLOBAL_PREFIXES.includes(parts.slice(0, 2).join('.')) ||
    parts.some((part) => FIELD_WRITER_SKIPPED_SEGMENTS.includes(part))
  );
}

function isConstructor(symbol: string): boolean {
  const leaf = symbol
    .slice(symbol.lastIndexOf('.') + 1)
    .split(DUPLICATE_SYMBOL_SEPARATOR)[0];
  return CONSTRUCTOR_NAMES.includes(leaf);
}

function isSkippedPath(filePath: string): boolean {
  return matchesAnyGlob(filePath, FIELD_WRITER_SKIPPED_PATHS, true);
}

/** 계약의 필드 순서로 항목을 만든다. 값과 조건은 가리고 자른다 */
function entry(
  symbolId: string,
  symbol: string,
  filePath: string,
  lineStart: number,
  kind: FieldWriteKind,
  entity: string | undefined,
  value: string,
  conditions: readonly string[] | undefined,
): FieldWriterEntry {
  const kept = (conditions ?? [])
    .slice(0, FIELD_WRITER_MAX_CONDITIONS)
    .map(summarize)
    .filter(Boolean);
  return {
    symbolId,
    symbol,
    filePath,
    lineStart,
    kind,
    ...(entity ? { entity } : {}),
    valueSummary: summarize(value),
    ...(kept.length > 0 ? { conditions: kept } : {}),
  };
}

/** 문자열 리터럴은 `<literal>`, 환경 변수 읽기는 `<env>` 로 가리고(이미 가린 표시는 그대로), 공백을 줄이고 자른다 */
function summarize(text: string): string {
  const masked = text
    .replace(ENVIRONMENT_READ_PATTERN, ENV_PLACEHOLDER)
    .replace(QUOTED_LITERAL_PATTERN, LITERAL_PLACEHOLDER)
    .replace(/\s+/g, ' ')
    .trim();
  return masked.length > FIELD_WRITER_VALUE_MAX_CHARS
    ? `${masked.slice(0, FIELD_WRITER_VALUE_MAX_CHARS - CLIPPED_TEXT_MARK.length)}${CLIPPED_TEXT_MARK}`
    : masked;
}

/** 저장소·파일·클래스 → 클래스 멤버 이름 → 타입 이름 */
function receiverIndex(
  state: GraphBuildState,
): Map<string, Record<string, string>> {
  const index = new Map<string, Record<string, string>>();
  for (const build of state.repositories) {
    for (const receiver of repositoryReceivers(build)) {
      index.set(
        receiverKey(build.manifest.name, receiver.filePath, receiver.symbol),
        receiver.members,
      );
    }
  }
  return index;
}

function receiverKey(repository: string, filePath: string, symbol: string) {
  return `${repository}\u0000${filePath}#${symbol}`;
}

function siteKey(
  repository: string,
  filePath: string,
  symbol: string,
  line: number,
  field: string,
): string {
  return [repository, filePath, symbol, String(line), field].join('\u0000');
}
