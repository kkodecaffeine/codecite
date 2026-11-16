// 결과 파일의 모든 글에서 만든 컴퓨터의 절대 경로와 비밀값 모양을 찾는다
// 비밀값 모양은 결과를 만들 때 쓴 가리기 규칙(../redaction.ts, ../constants.ts 의 토큰 꼴)을 그대로 다시 걸어, 가리기 전 값이 남았는지 본다.
// 메시지에는 찾은 값을 싣지 않고 자리만 적는다
import { realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { REDACTED_VALUE } from '../constants.js';
import {
  REDACTED_PLACEHOLDER,
  SITE_PRIVATE_KEY_PATTERN,
} from '../extractors/constants.js';
import { redactSecretLiterals } from '../redaction.js';
import type { GraphConfig } from '../types.js';
import {
  HOME_LIKE_PATH_PATTERNS,
  LINUX_HOME_PATH_PATTERNS,
  MACHINE_ROOT_MIN_SEGMENTS,
  VALIDATION_CONTENT_KEY,
  VALIDATION_EXECUTION_FACTS_KEY,
  VALIDATION_IDENTIFIER_KEYS,
  VALIDATION_PATH_KEYS,
  VALIDATION_ROUTE_KEYS,
} from './constants.js';
import { walkStrings, type IssueLog } from './validate-support.js';

const PRIVATE_KEY_MARK = new RegExp(SITE_PRIVATE_KEY_PATTERN.source);

/** 결과 글 검사기. 이 컴퓨터의 경로(임시·집 폴더, 결과·설정 폴더)는 만들 때 한 번 구한다 */
export class OutputScanner {
  private constructor(
    private readonly log: IssueLog,
    private readonly roots: readonly string[],
  ) {}

  static async create(
    log: IssueLog,
    output: string,
    config?: GraphConfig,
  ): Promise<OutputScanner> {
    const roots = [tmpdir(), homedir(), resolve(output)];
    if (config) {
      roots.push(config.cwd, config.output, config.cache);
    }
    const resolved = await Promise.all(
      roots.map((root) => realpath(root).catch(() => root)),
    );
    const unique = [...new Set([...roots, ...resolved])]
      .map((root) => root.replace(/[\\/]+$/, ''))
      .filter((root) => root.length > 1)
      .sort((left, right) => right.length - left.length);
    return new OutputScanner(log, unique);
  }

  /** 값 하나를 훑는다. prefix 는 메시지 앞에 붙일 자리(`line 3`) */
  scan(file: string, value: unknown, prefix = ''): void {
    walkStrings(value, (text, key, path) => {
      const where = [prefix, path].filter(Boolean).join(' ') || '(root)';
      const problem = this.pathProblem(text, key);
      if (problem) {
        this.log.error('absolute-path', file, `${where}: ${problem}`);
      }
      if (looksSecret(text, key, path)) {
        this.log.error(
          'secret',
          file,
          `${where}: holds a secret-looking value; check redaction and build again`,
        );
      }
    });
  }

  private pathProblem(text: string, key: string): string | undefined {
    if (VALIDATION_PATH_KEYS.includes(key) && !isPortablePath(text)) {
      return `${key} must be a relative path inside the repository or output folder`;
    }
    const sensitive =
      key === VALIDATION_CONTENT_KEY || VALIDATION_ROUTE_KEYS.includes(key);
    for (const root of this.roots) {
      if (
        sensitive &&
        root.split(/[\\/]/).filter(Boolean).length < MACHINE_ROOT_MIN_SEGMENTS
      ) {
        continue;
      }
      if (
        text === root ||
        text.includes(`${root}/`) ||
        text.includes(`${root}\\`)
      ) {
        return 'contains a path of the machine that built or checks the graph';
      }
    }
    if (key === VALIDATION_CONTENT_KEY) {
      return undefined;
    }
    if (HOME_LIKE_PATH_PATTERNS.some((pattern) => pattern.test(text))) {
      return 'contains a home, temporary or drive path';
    }
    if (
      !VALIDATION_ROUTE_KEYS.includes(key) &&
      LINUX_HOME_PATH_PATTERNS.some((pattern) => pattern.test(text))
    ) {
      return 'contains a home folder path';
    }
    return undefined;
  }
}

/** 저장소(또는 결과 폴더) 기준 상대 경로인지. `.` 은 저장소 뿌리다 */
export function isPortablePath(text: string): boolean {
  if (text === '.') {
    return true;
  }
  return (
    text.trim() !== '' &&
    !text.includes('\\') &&
    !text.startsWith('/') &&
    !text.startsWith('~') &&
    !/^[A-Za-z]:/.test(text) &&
    !text.split('/').some((part) => part === '' || part === '..')
  );
}

/**
 * 가리기 규칙을 다시 걸었을 때 바뀌는 글이면 비밀값 모양이 남은 것이다
 * - 이미 가린 표시(`<redacted>`, `[REDACTED]`)는 남은 것으로 보지 않는다
 * - 원문(content)은 만들 때 같은 규칙으로 가렸으므로 그대로 다시 건다
 * - 그 밖의 글은 따옴표로 감싸 한 번 더 건다. 값 하나가 통째로 무작위 문자열(32 자 이상)이면 그때 걸린다
 * - 심볼·이름 필드와 실행 사실은 코드 식별자·식이라 따옴표로 감싸 보지 않는다. 실행 사실의 리터럴은 만들 때 `<literal>` 로 바뀐다
 */
export function looksSecret(text: string, key: string, path = ''): boolean {
  const normalized = text.replaceAll(REDACTED_PLACEHOLDER, REDACTED_VALUE);
  if (PRIVATE_KEY_MARK.test(normalized)) {
    return true;
  }
  if (redactSecretLiterals(normalized) !== normalized) {
    return true;
  }
  if (
    key === VALIDATION_CONTENT_KEY ||
    VALIDATION_IDENTIFIER_KEYS.includes(key) ||
    path.includes(`${VALIDATION_EXECUTION_FACTS_KEY}[`) ||
    normalized.includes('"') ||
    normalized.includes('\n')
  ) {
    return false;
  }
  const quoted = `"${normalized}"`;
  return redactSecretLiterals(quoted) !== quoted;
}
