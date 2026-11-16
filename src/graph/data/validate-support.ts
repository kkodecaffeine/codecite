// 결과 검사 도우미. 문제를 모으는 기록장, 손으로 짠 작은 모양 검사기, 두 값의 첫 차이 찾기
import type {
  GraphValidationCheck,
  GraphValidationIssue,
  GraphValidationResult,
} from './types.js';
import { VALIDATION_MAX_ISSUES_PER_CHECK } from './constants.js';

/** 찾은 문제를 모은다. 한 파일·한 검사에서 한도를 넘는 문제는 수만 센다 */
export class IssueLog {
  private readonly errors: GraphValidationIssue[] = [];
  private readonly warnings: GraphValidationIssue[] = [];
  private readonly counts = new Map<string, number>();

  error(check: GraphValidationCheck, file: string, message: string): void {
    this.add('error', check, file, message);
  }

  warn(check: GraphValidationCheck, file: string, message: string): void {
    this.add('warning', check, file, message);
  }

  result(): GraphValidationResult {
    const errors = [...this.errors];
    const warnings = [...this.warnings];
    for (const [key, count] of this.counts) {
      if (count <= VALIDATION_MAX_ISSUES_PER_CHECK) {
        continue;
      }
      const [level, check, file] = key.split('\u0000');
      const issue: GraphValidationIssue = {
        check: check as GraphValidationCheck,
        file,
        message: `${count - VALIDATION_MAX_ISSUES_PER_CHECK} more ${check} issues not shown`,
      };
      (level === 'error' ? errors : warnings).push(issue);
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  private add(
    level: 'error' | 'warning',
    check: GraphValidationCheck,
    file: string,
    message: string,
  ): void {
    const key = [level, check, file].join('\u0000');
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (count <= VALIDATION_MAX_ISSUES_PER_CHECK) {
      (level === 'error' ? this.errors : this.warnings).push({
        check,
        file,
        message,
      });
    }
  }
}

/** 계약 모양을 손으로 본다. 틀린 곳마다 JSON 자리(`nodes[3].type`)와 까닭을 shape 오류로 남긴다 */
export class Shape {
  ok = true;

  constructor(
    private readonly log: IssueLog,
    readonly file: string,
  ) {}

  fail(path: string, message: string): void {
    this.ok = false;
    this.log.error('shape', this.file, `${path || '(root)'}: ${message}`);
  }

  object(value: unknown, path: string): Record<string, unknown> | undefined {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'must be an object');
      return undefined;
    }
    return value as Record<string, unknown>;
  }

  array(value: unknown, path: string, optional = false): unknown[] {
    if (value === undefined && optional) {
      return [];
    }
    if (!Array.isArray(value)) {
      this.fail(path, 'must be an array');
      return [];
    }
    return value;
  }

  /** 빈 글이 아닌 문자열 */
  text(value: unknown, path: string, optional = false): void {
    if (value === undefined && optional) {
      return;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      this.fail(path, 'must be a non-empty string');
    }
  }

  /** 빈 글도 받는 문자열 */
  string(value: unknown, path: string, optional = false): void {
    if (value === undefined && optional) {
      return;
    }
    if (typeof value !== 'string') {
      this.fail(path, 'must be a string');
    }
  }

  integer(value: unknown, path: string, min: number, optional = false): void {
    if (value === undefined && optional) {
      return;
    }
    if (!Number.isInteger(value) || (value as number) < min) {
      this.fail(path, `must be an integer of at least ${min}`);
    }
  }

  number(
    value: unknown,
    path: string,
    min: number,
    max: number,
    optional = false,
  ): void {
    if (value === undefined && optional) {
      return;
    }
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max
    ) {
      this.fail(path, `must be a number from ${min} to ${max}`);
    }
  }

  oneOf(
    value: unknown,
    path: string,
    allowed: readonly string[],
    optional = false,
  ): void {
    if (value === undefined && optional) {
      return;
    }
    if (typeof value !== 'string' || !allowed.includes(value)) {
      this.fail(path, `must be one of ${allowed.join(', ')}`);
    }
  }

  textArray(value: unknown, path: string, optional = false): void {
    if (value === undefined && optional) {
      return;
    }
    this.array(value, path).forEach((item, index) =>
      this.text(item, `${path}[${index}]`),
    );
  }

  stringArray(value: unknown, path: string, optional = false): void {
    if (value === undefined && optional) {
      return;
    }
    this.array(value, path).forEach((item, index) =>
      this.string(item, `${path}[${index}]`),
    );
  }

  /** 코드 자리(CodeLocation) */
  location(value: unknown, path: string): void {
    const location = this.object(value, path);
    if (!location) {
      return;
    }
    this.text(location.repository, `${path}.repository`);
    this.text(location.filePath, `${path}.filePath`);
    this.text(location.symbol, `${path}.symbol`);
    this.integer(location.lineStart, `${path}.lineStart`, 0);
    this.integer(location.lineEnd, `${path}.lineEnd`, 0);
  }

  /** 실행 사실(ExecutionFact) */
  fact(value: unknown, path: string, kinds: readonly string[]): void {
    const fact = this.object(value, path);
    if (!fact) {
      return;
    }
    this.integer(fact.line, `${path}.line`, 1);
    this.oneOf(fact.kind, `${path}.kind`, kinds);
    this.string(fact.subject, `${path}.subject`, true);
    this.string(fact.value, `${path}.value`, true);
    this.stringArray(fact.conditions, `${path}.conditions`, true);
  }
}

/** 두 JSON 값이 처음 갈리는 자리. 같으면 undefined */
export function firstDifference(
  left: unknown,
  right: unknown,
  path = '',
): string | undefined {
  if (Object.is(left, right)) {
    return undefined;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const found = firstDifference(
        left[index],
        right[index],
        `${path}[${index}]`,
      );
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (
    typeof left === 'object' &&
    left !== null &&
    typeof right === 'object' &&
    right !== null &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.join('\u0000') !== rightKeys.join('\u0000')) {
      return path || '(root)';
    }
    for (const key of leftKeys) {
      const found = firstDifference(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
      );
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  return path || '(root)';
}

/** 값 안의 모든 문자열(객체 키 포함)을 부른다. key 는 그 값을 담은 가장 가까운 객체 키, path 는 JSON 자리 */
export function walkStrings(
  value: unknown,
  visit: (text: string, key: string, path: string) => void,
  key = '',
  path = '',
): void {
  if (typeof value === 'string') {
    visit(value, key, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      walkStrings(item, visit, key, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [child, item] of Object.entries(value)) {
      const childPath = path ? `${path}.${child}` : child;
      visit(child, '', `${childPath} (key)`);
      walkStrings(item, visit, child, childPath);
    }
  }
}
