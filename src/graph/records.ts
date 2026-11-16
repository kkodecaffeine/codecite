import { createHash } from 'node:crypto';
import type {
  CodeSymbolRelation,
  CurrentSymbolRecord,
  ExecutionFact,
  ExecutionFactKind,
} from '../extensions/code-knowledge.js';
import {
  EXECUTION_FACT_KINDS,
  FORBIDDEN_RECORD_KEYS,
  GRAPH_SCHEMA_VERSION,
  RECORD_KEYS,
} from './constants.js';
import { compareText, compileGlob, matchesGlob } from './files.js';
import { redactSecretLiterals } from './redaction.js';
import type {
  ExtractedSymbol,
  ExtractionFailure,
  GraphGroupRule,
  RecordContext,
} from './types.js';

/** 저장소·파일 경로·심볼 이름의 해시. 파일을 옮기거나 이름을 바꾸면 바뀐다 */
export function stableSymbolId(
  repository: string,
  filePath: string,
  symbol: string,
): string {
  return sha256(`${repository}\0${filePath.replaceAll('\\', '/')}\0${symbol}`);
}

/** 원문(가리기 전)의 해시. 같은 원문이면 같은 값이다 */
export function contentHash(content: string): string {
  return sha256(content);
}

/**
 * 파일이 받치는 정책 묶음. 여러 묶음에 걸리면 glob 의 글자(와일드카드 뺀) 수가 많은 쪽, 같으면 설정에 먼저 적은 쪽이다
 * 그래서 `shop-api:**` 와 `shop-api:src/points/**` 를 함께 두면 적립금 폴더는 좁은 쪽으로 간다
 */
export function policyGroupFor(
  repository: string,
  filePath: string,
  groups: Record<string, string[]>,
): string | undefined {
  let best: GraphGroupRule | undefined;
  for (const rule of groupRules(groups)) {
    if (rule.repository !== repository || !matchesGlob(filePath, rule.glob)) {
      continue;
    }
    if (
      !best ||
      rule.specificity > best.specificity ||
      (rule.specificity === best.specificity && rule.order < best.order)
    ) {
      best = rule;
    }
  }
  return best?.group;
}

/** `저장소:경로 glob` 을 저장소와 glob 으로 나눈다. 모양이 틀리면 undefined */
export function parseGroupPattern(
  pattern: string,
): { repository: string; glob: string } | undefined {
  const separator = pattern.indexOf(':');
  if (separator <= 0 || separator === pattern.length - 1) {
    return undefined;
  }
  return {
    repository: pattern.slice(0, separator),
    glob: pattern.slice(separator + 1),
  };
}

/**
 * 추출기가 돌려준 심볼을 현재 심볼 레코드로 바꾼다
 * 원문 해시는 가리기 전 원문으로 만들고, 저장하는 원문·설명·실행 사실 값은 비밀값을 가린다
 * 계약에 맞지 않는 값(상대 경로가 아닌 경로, 줄 번호 등)은 어느 심볼인지 밝혀 throw 한다
 */
export function toCurrentSymbolRecord(
  symbol: ExtractedSymbol,
  context: RecordContext,
): CurrentSymbolRecord {
  const label = `${context.repository} ${String(symbol.filePath)} ${String(symbol.symbol)}`;
  try {
    requireString(symbol.content, 'content');
    requirePositiveInteger(symbol.lineStart, 'lineStart');
    requirePositiveInteger(symbol.lineEnd, 'lineEnd');
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`, { cause: error });
  }
  const filePath = String(symbol.filePath ?? '').replaceAll('\\', '/');
  const policyGroup = policyGroupFor(
    context.repository,
    filePath,
    context.groups,
  );
  const description = symbol.description
    ? redactSecretLiterals(symbol.description)
    : undefined;
  const triggeredBy = unique(symbol.triggeredBy ?? []);
  const executionFacts = (symbol.executionFacts ?? []).map(redactFact);
  const record = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    recordType: 'current_symbol',
    repository: context.repository,
    filePath,
    language: symbol.language,
    symbol: symbol.symbol,
    stableSymbolId: stableSymbolId(context.repository, filePath, symbol.symbol),
    kind: symbol.kind,
    commitSha: context.commitSha,
    committedAt: context.committedAt,
    contentHash: contentHash(symbol.content),
    content: redactSecretLiterals(symbol.content),
    lineStart: symbol.lineStart,
    lineEnd: symbol.lineEnd,
    ...(description ? { description } : {}),
    relations: uniqueRelations(symbol.relations ?? []),
    ...(triggeredBy.length > 0 ? { triggeredBy } : {}),
    ...(policyGroup ? { policyGroup } : {}),
    ...(executionFacts.length > 0 ? { executionFacts } : {}),
  };
  return validateCurrentSymbolRecord(record, label);
}

/**
 * 저장소 하나의 심볼을 레코드로 바꾸고 정렬한다
 * 같은 파일·같은 이름 심볼이 둘 이상이면 앞 줄의 것만 남기고 나머지는 실패로 남긴다(조용히 버리지 않는다)
 */
export function buildRepositoryRecords(
  symbols: readonly ExtractedSymbol[],
  context: RecordContext,
): { records: CurrentSymbolRecord[]; failures: ExtractionFailure[] } {
  const records = symbols
    .map((symbol) => toCurrentSymbolRecord(symbol, context))
    .sort(compareRecords);
  const kept: CurrentSymbolRecord[] = [];
  const failures: ExtractionFailure[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.stableSymbolId)) {
      failures.push({
        filePath: record.filePath,
        message: `duplicate symbol ${record.symbol} at line ${record.lineStart ?? '?'}; kept the first one`,
      });
      continue;
    }
    seen.add(record.stableSymbolId);
    kept.push(record);
  }
  return { records: kept, failures };
}

/** 레코드 정렬 순서: 파일 경로 → 시작 줄 → 심볼 이름 → 종류 → 원문 해시 */
export function compareRecords(
  left: CurrentSymbolRecord,
  right: CurrentSymbolRecord,
): number {
  return (
    compareText(left.filePath, right.filePath) ||
    (left.lineStart ?? 0) - (right.lineStart ?? 0) ||
    compareText(left.symbol, right.symbol) ||
    compareText(left.kind, right.kind) ||
    compareText(left.contentHash, right.contentHash)
  );
}

/**
 * 현재 심볼 레코드가 계약을 지키는지 검사하고, 키 순서를 고정한 새 객체로 돌려준다
 * 변경 원문·비밀값을 담는 키, 저장소 밖 경로, 해시와 맞지 않는 id 는 받지 않는다
 */
export function validateCurrentSymbolRecord(
  value: unknown,
  label = 'record',
): CurrentSymbolRecord {
  try {
    rejectForbiddenKeys(value);
    const record = requireObject(value, 'record');
    for (const key of Object.keys(record)) {
      if (!RECORD_KEYS.has(key)) {
        throw new Error(`unknown field ${key}`);
      }
    }
    if (record.schemaVersion !== GRAPH_SCHEMA_VERSION) {
      throw new Error(`schemaVersion must be ${GRAPH_SCHEMA_VERSION}`);
    }
    if (record.recordType !== 'current_symbol') {
      throw new Error('recordType must be current_symbol');
    }
    const repository = requireText(record.repository, 'repository');
    const filePath = requireRelativePath(record.filePath, 'filePath');
    const symbol = requireText(record.symbol, 'symbol');
    const id = requireHash(record.stableSymbolId, 'stableSymbolId');
    if (id !== stableSymbolId(repository, filePath, symbol)) {
      throw new Error(
        'stableSymbolId does not match repository, path and symbol',
      );
    }
    const result: Omit<CurrentSymbolRecord, 'relations'> &
      Partial<Pick<CurrentSymbolRecord, 'relations'>> = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      recordType: 'current_symbol',
      repository,
      filePath,
      language: requireText(record.language, 'language'),
      symbol,
      stableSymbolId: id,
      kind: requireText(record.kind, 'kind'),
      commitSha: requirePattern(
        record.commitSha,
        'commitSha',
        /^[0-9a-f]{7,64}$/,
      ),
      committedAt: requireIsoDate(record.committedAt, 'committedAt'),
      contentHash: requireHash(record.contentHash, 'contentHash'),
    };
    if (record.content !== undefined) {
      result.content = requireString(record.content, 'content');
    }
    if (record.lineStart !== undefined || record.lineEnd !== undefined) {
      result.lineStart = requirePositiveInteger(record.lineStart, 'lineStart');
      result.lineEnd = requirePositiveInteger(record.lineEnd, 'lineEnd');
      if (result.lineEnd < result.lineStart) {
        throw new Error('lineEnd must not be before lineStart');
      }
    }
    if (record.description !== undefined) {
      result.description = requireText(record.description, 'description');
    }
    result.relations = requireArray(record.relations, 'relations').map(
      (item, index) => validateRelation(item, `relations[${index}]`),
    );
    if (record.triggeredBy !== undefined) {
      result.triggeredBy = requireArray(record.triggeredBy, 'triggeredBy').map(
        (item, index) => requireText(item, `triggeredBy[${index}]`),
      );
    }
    if (record.policyGroup !== undefined) {
      result.policyGroup = requireText(record.policyGroup, 'policyGroup');
    }
    if (record.executionFacts !== undefined) {
      result.executionFacts = requireArray(
        record.executionFacts,
        'executionFacts',
      ).map((item, index) => validateFact(item, `executionFacts[${index}]`));
    }
    return result as CurrentSymbolRecord;
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`, { cause: error });
  }
}

function groupRules(groups: Record<string, string[]>): GraphGroupRule[] {
  const rules: GraphGroupRule[] = [];
  for (const [group, patterns] of Object.entries(groups)) {
    for (const pattern of patterns) {
      const parsed = parseGroupPattern(pattern);
      if (!parsed) {
        continue;
      }
      compileGlob(parsed.glob);
      rules.push({
        group,
        repository: parsed.repository,
        glob: parsed.glob,
        specificity: parsed.glob.replace(/[*?{}[\],!]/g, '').length,
        order: rules.length,
      });
    }
  }
  return rules;
}

function redactFact(fact: ExecutionFact): ExecutionFact {
  return {
    line: fact.line,
    kind: fact.kind,
    ...(fact.subject !== undefined
      ? { subject: redactSecretLiterals(fact.subject) }
      : {}),
    ...(fact.value !== undefined
      ? { value: redactFactValue(fact.subject, fact.value) }
      : {}),
    ...(fact.conditions !== undefined
      ? { conditions: fact.conditions.map(redactSecretLiterals) }
      : {}),
  };
}

/** 값만 보면 이름 규칙이 걸리지 않으므로, 대상 이름에 넣는 대입 꼴로 이어 붙여 가린 뒤 값 부분만 되돌린다 */
function redactFactValue(subject: string | undefined, value: string): string {
  const alone = redactSecretLiterals(value);
  if (subject === undefined) {
    return alone;
  }
  const prefix = `${subject} = `;
  const combined = redactSecretLiterals(`${prefix}${alone}`);
  return combined.startsWith(prefix) ? combined.slice(prefix.length) : alone;
}

function uniqueRelations(
  relations: readonly CodeSymbolRelation[],
): CodeSymbolRelation[] {
  const seen = new Set<string>();
  const result: CodeSymbolRelation[] = [];
  for (const relation of relations) {
    const target = relation?.target ?? {};
    const key = JSON.stringify([
      relation?.type,
      target.repository,
      target.filePath,
      target.symbol,
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      type: relation?.type,
      target: {
        repository: target.repository,
        ...(target.filePath !== undefined
          ? { filePath: target.filePath.replaceAll('\\', '/') }
          : {}),
        ...(target.symbol !== undefined ? { symbol: target.symbol } : {}),
      },
    });
  }
  return result;
}

function validateRelation(value: unknown, label: string): CodeSymbolRelation {
  const relation = requireObject(value, label);
  const target = requireObject(relation.target, `${label}.target`);
  const result: CodeSymbolRelation = {
    type: requireText(relation.type, `${label}.type`),
    target: {
      repository: requireText(target.repository, `${label}.target.repository`),
    },
  };
  if (target.filePath !== undefined) {
    result.target.filePath = requireRelativePath(
      target.filePath,
      `${label}.target.filePath`,
    );
  }
  if (target.symbol !== undefined) {
    result.target.symbol = requireText(target.symbol, `${label}.target.symbol`);
  }
  if (!result.target.filePath && !result.target.symbol) {
    throw new Error(`${label}.target needs filePath or symbol`);
  }
  return result;
}

function validateFact(value: unknown, label: string): ExecutionFact {
  const fact = requireObject(value, label);
  if (!EXECUTION_FACT_KINDS.includes(fact.kind as ExecutionFactKind)) {
    throw new Error(
      `${label}.kind must be one of ${EXECUTION_FACT_KINDS.join(', ')}`,
    );
  }
  const result: ExecutionFact = {
    line: requirePositiveInteger(fact.line, `${label}.line`),
    kind: fact.kind as ExecutionFactKind,
  };
  if (fact.subject !== undefined) {
    result.subject = requireString(fact.subject, `${label}.subject`);
  }
  if (fact.value !== undefined) {
    result.value = requireString(fact.value, `${label}.value`);
  }
  if (fact.conditions !== undefined) {
    result.conditions = requireArray(
      fact.conditions,
      `${label}.conditions`,
    ).map((item, index) =>
      requireString(item, `${label}.conditions[${index}]`),
    );
  }
  return result;
}

function rejectForbiddenKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(rejectForbiddenKeys);
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RECORD_KEYS.includes(key.toLowerCase().replaceAll('_', ''))) {
      throw new Error(`forbidden field ${key}`);
    }
    rejectForbiddenKeys(child);
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePattern(
  value: unknown,
  label: string,
  pattern: RegExp,
): string {
  const text = requireText(value, label);
  if (!pattern.test(text)) {
    throw new Error(`${label} has an invalid format`);
  }
  return text;
}

function requireHash(value: unknown, label: string): string {
  return requirePattern(value, label, /^[0-9a-f]{64}$/);
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value as number;
}

function requireIsoDate(value: unknown, label: string): string {
  const text = requireText(value, label);
  const time = Date.parse(text);
  if (Number.isNaN(time) || new Date(time).toISOString() !== text) {
    throw new Error(`${label} must be an ISO 8601 UTC timestamp`);
  }
  return text;
}

/** 저장소 기준 상대 경로만 받는다. 절대 경로와 상위 폴더로 나가는 경로는 결과에 이 컴퓨터의 경로를 남긴다 */
function requireRelativePath(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (
    text.includes('\\') ||
    text.startsWith('/') ||
    /^[A-Za-z]:/.test(text) ||
    text.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(`${label} must be a repository-relative path`);
  }
  return text;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
