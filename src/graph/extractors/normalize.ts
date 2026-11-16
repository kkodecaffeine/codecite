// 언어와 상관없이 추출 결과를 같은 꼴로 다듬는다. 같은 입력이면 같은 출력이 나오도록 정렬·중복 제거를 여기서 한 번에 한다
import type {
  CodeSymbolRelation,
  ExecutionFact,
} from '../../extensions/code-knowledge.js';
import type {
  ExtractedSymbol,
  ExtractionFailure,
  ExtractionResult,
} from '../types.js';
import {
  CLIPPED_TEXT_MARK,
  CONDITION_LABELS,
  DECLARATION_CONTENT_HEAD_RATIO,
  DUPLICATE_SYMBOL_SEPARATOR,
  EXECUTABLE_SYMBOL_KINDS,
  EXTRACTED_RELATION_TYPES,
  IMPORT_TARGET_SEPARATOR,
  MAX_CALL_RELATIONS,
  MAX_DECLARATION_CONTENT_LENGTH,
  MAX_FACT_TEXT_LENGTH,
  SIMPLE_NEGATION_PATTERN,
  WHOLE_MODULE_IMPORT,
} from './constants.js';
import type { RawRelation } from './types.js';

/** IMPORTS 대상 원문. 가져온 꼴이 없으면 모듈 전체를 읽은 것으로 적는다 */
export function importTarget(specifier: string, imported?: string): string {
  return `${imported ?? WHOLE_MODULE_IMPORT}${IMPORT_TARGET_SEPARATOR}${specifier}`;
}

/** 로캘과 상관없는 비교. localeCompare 는 실행 환경마다 순서가 달라질 수 있어 쓰지 않는다 */
export function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** 공백을 한 칸으로 줄이고 한도를 넘으면 자른다. 자른 글 끝에는 표시를 붙인다 */
export function collapseText(
  text: string,
  maxLength = MAX_FACT_TEXT_LENGTH,
): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  let end = maxLength - CLIPPED_TEXT_MARK.length;
  const last = collapsed.charCodeAt(end - 1);
  // 서로게이트 쌍 가운데서 자르지 않는다
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${collapsed.slice(0, end)}${CLIPPED_TEXT_MARK}`;
}

/** 조건의 부정. `!order` 처럼 이름 하나를 뒤집은 조건은 `NOT (!order)` 대신 `order` 로 적는다 */
export function negateCondition(predicate: string): string {
  const negated = SIMPLE_NEGATION_PATTERN.exec(predicate);
  if (negated) {
    return negated[1];
  }
  return `${CONDITION_LABELS.not} (${predicate})`;
}

/**
 * 실행 사실을 줄이고, 빈 칸을 빼고, 같은 사실을 하나로 합친 뒤 줄 번호로 정렬한다
 * 같은 줄 안에서는 들어온 순서(구문 트리를 도는 순서)를 지킨다
 */
export function finalizeFacts(
  facts: readonly ExecutionFact[],
): ExecutionFact[] {
  const seen = new Set<string>();
  const unique: ExecutionFact[] = [];
  for (const fact of facts) {
    const normalized = normalizeFact(fact);
    const key = JSON.stringify(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(normalized);
  }
  return unique
    .map((fact, index) => ({ fact, index }))
    .sort(
      (left, right) =>
        left.fact.line - right.fact.line || left.index - right.index,
    )
    .map(({ fact }) => fact);
}

function normalizeFact(fact: ExecutionFact): ExecutionFact {
  const subject = fact.subject ? collapseText(fact.subject) : '';
  const value = fact.value ? collapseText(fact.value) : '';
  const conditions = (fact.conditions ?? [])
    .map((condition) => collapseText(condition))
    .filter((condition) => condition.length > 0);
  // 키 순서를 고정해 JSON 출력이 늘 같게 한다
  return {
    line: fact.line,
    kind: fact.kind,
    ...(subject ? { subject } : {}),
    ...(value ? { value } : {}),
    ...(conditions.length > 0 ? { conditions } : {}),
  };
}

/** 관계에 저장소를 붙이고, 같은 관계를 합치고, 종류·대상 순으로 정렬한다. CALLS 만 한도에서 자른다 */
export function finalizeRelations(
  repository: string,
  relations: readonly RawRelation[],
): CodeSymbolRelation[] {
  const unique = new Map<string, RawRelation>();
  for (const relation of relations) {
    if (!relation.symbol) {
      continue;
    }
    const key = relationKey(relation);
    if (!unique.has(key)) {
      unique.set(key, relation);
    }
  }
  const sorted = [...unique.entries()]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        relationTypeRank(left) - relationTypeRank(right) ||
        compareText(leftKey, rightKey),
    )
    .map(([, relation]) => relation);
  let calls = 0;
  const kept: CodeSymbolRelation[] = [];
  for (const relation of sorted) {
    if (relation.type === 'CALLS') {
      calls += 1;
      if (calls > MAX_CALL_RELATIONS) {
        continue;
      }
    }
    kept.push({
      type: relation.type,
      target: { repository, symbol: relation.symbol },
    });
  }
  return kept;
}

function relationKey(relation: RawRelation): string {
  return `${relation.type}\u0000${relation.symbol}`;
}

function relationTypeRank(relation: RawRelation): number {
  return EXTRACTED_RELATION_TYPES.indexOf(relation.type);
}

/**
 * 클래스·상수·열거형 원문이 길면 앞뒤만 남긴다. 함수·메서드는 실행 사실의 줄 번호와 맞도록 자르지 않는다
 * comment 는 생략 표시를 그 언어의 주석으로 감싸는 데 쓴다
 */
export function boundDeclarationContent(
  content: string,
  kind: string,
  comment: { open: string; close: string },
): string {
  if (
    EXECUTABLE_SYMBOL_KINDS.includes(kind) ||
    content.length <= MAX_DECLARATION_CONTENT_LENGTH
  ) {
    return content;
  }
  const head = Math.floor(
    MAX_DECLARATION_CONTENT_LENGTH * DECLARATION_CONTENT_HEAD_RATIO,
  );
  const tail = MAX_DECLARATION_CONTENT_LENGTH - head;
  const omitted = content.length - head - tail;
  return `${content.slice(0, head)}\n${comment.open} ${omitted} characters omitted ${comment.close}\n${content.slice(-tail)}`;
}

export function compareSymbols(
  left: ExtractedSymbol,
  right: ExtractedSymbol,
): number {
  return (
    compareText(left.filePath, right.filePath) ||
    left.lineStart - right.lineStart ||
    left.lineEnd - right.lineEnd ||
    compareText(left.symbol, right.symbol) ||
    compareText(left.kind, right.kind)
  );
}

/**
 * 심볼과 실패를 정해진 순서로 놓고, 같은 파일 안에서 이름이 겹치는 심볼에 꼬리를 붙인다
 * 저장소·경로·이름으로 만드는 심볼 id 가 겹치지 않게 하려는 것이다. 꼬리는 나온 순서(줄 번호)로 센다
 */
export function finalizeExtraction(result: ExtractionResult): ExtractionResult {
  const symbols = [...result.symbols].sort(compareSymbols);
  const counts = new Map<string, number>();
  const named = symbols.map((symbol) => {
    const key = `${symbol.filePath}\u0000${symbol.symbol}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count === 1
      ? symbol
      : {
          ...symbol,
          symbol: `${symbol.symbol}${DUPLICATE_SYMBOL_SEPARATOR}${count}`,
        };
  });
  const failures = [...result.failures].sort(
    (left: ExtractionFailure, right: ExtractionFailure) =>
      compareText(left.filePath, right.filePath) ||
      compareText(left.message, right.message),
  );
  return { symbols: named, failures };
}

/** 확장자 비교. 대소문자는 가리지 않는다 */
export function hasExtension(
  filePath: string,
  extensions: readonly string[],
): boolean {
  const lower = filePath.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
