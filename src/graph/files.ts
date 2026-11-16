import { lstat, open } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import {
  EMPTY_FILE_SKIP_COUNTS,
  GRAPH_BINARY_PROBE_BYTES,
  GRAPH_FLOOR_EXCLUDES,
  GRAPH_MAX_SOURCE_FILE_BYTES,
} from './constants.js';
import type {
  FileSelection,
  FileSelectionRules,
  FileSkipCounts,
  SourceFile,
} from './types.js';

const compiledGlobs = new Map<string, RegExp>();

/**
 * glob 을 정규식으로 바꾼다. 의존성 없이 쓰는 작은 매처다
 * - 별 두 개는 몇 겹이든 폴더를 건너뛰고, 별 하나는 `/` 를 넘지 않는 아무 글자, 물음표는 글자 하나다
 * - `{a,b}` 는 둘 중 하나, `[abc]`·`[!abc]` 는 글자 묶음
 * 짝이 맞지 않는 괄호는 오류로 본다. 설정 검사가 이 함수로 glob 을 미리 확인한다
 */
export function compileGlob(pattern: string, ignoreCase = false): RegExp {
  return cachedGlob(pattern, ignoreCase, false);
}

/**
 * 저장소 기준 상대 경로가 glob 에 맞는지
 * - `/` 가 없는 glob(`*.spec.ts`, `node_modules`)은 경로의 어느 조각에든 맞춘다
 * - `/` 가 있는 glob 은 저장소 뿌리부터 맞춘다
 * 폴더에 맞으면 그 아래 파일도 맞는 것으로 본다. 그래서 `src/legacy` 는 그 폴더 전체다
 */
export function matchesGlob(
  filePath: string,
  pattern: string,
  ignoreCase = false,
): boolean {
  if (!normalizeGlob(pattern).includes('/')) {
    const expression = cachedGlob(pattern, ignoreCase, false);
    return filePath.split('/').some((segment) => expression.test(segment));
  }
  return cachedGlob(pattern, ignoreCase, true).test(filePath);
}

export function matchesAnyGlob(
  filePath: string,
  patterns: readonly string[],
  ignoreCase = false,
): boolean {
  return patterns.some((pattern) => matchesGlob(filePath, pattern, ignoreCase));
}

/** 바닥 규칙에 걸리는 경로인지. 설정으로 끌 수 없다 */
export function isFloorExcluded(filePath: string): boolean {
  return matchesAnyGlob(filePath, GRAPH_FLOOR_EXCLUDES, true);
}

/** 설정에 쓸 수 있는 glob 인지 확인한다. 절대 경로와 상위 폴더로 나가는 glob 은 받지 않는다 */
export function validateGlob(pattern: string): void {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    throw new Error('glob must be a non-empty string');
  }
  const normalized = pattern.replaceAll('\\', '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new Error(`glob must stay inside the repository: ${pattern}`);
  }
  compileGlob(pattern);
}

/**
 * 추적 중인 파일 목록에서 추출기에 넘길 파일을 고른다
 * 바닥 규칙 → 기본 제외 → 저장소 exclude → 저장소 include → 맡는 추출기 순서로 보고, 처음 걸린 까닭으로 센다
 */
export function selectSourceFiles(
  filePaths: readonly string[],
  rules: FileSelectionRules,
): FileSelection {
  const skipped: FileSkipCounts = { ...EMPTY_FILE_SKIP_COUNTS };
  const selected: string[] = [];
  const include = rules.include ?? [];
  const exclude = rules.exclude ?? [];
  for (const filePath of [...new Set(filePaths)].sort(compareText)) {
    if (isFloorExcluded(filePath)) {
      skipped.floor += 1;
    } else if (matchesAnyGlob(filePath, rules.defaultExcludes)) {
      skipped.defaultExcludes += 1;
    } else if (matchesAnyGlob(filePath, exclude)) {
      skipped.exclude += 1;
    } else if (include.length > 0 && !matchesAnyGlob(filePath, include)) {
      skipped.notIncluded += 1;
    } else if (
      rules.extensions &&
      !matchingExtension(filePath, rules.extensions)
    ) {
      skipped.unsupported += 1;
    } else {
      selected.push(filePath);
    }
  }
  return { selected, skipped };
}

/** 경로에 맞는 확장자 가운데 가장 긴 것. 대소문자는 가리지 않는다 */
export function matchingExtension(
  filePath: string,
  extensions: readonly string[],
): string | undefined {
  const lower = filePath.toLowerCase();
  let best: string | undefined;
  for (const extension of extensions) {
    if (
      lower.endsWith(extension.toLowerCase()) &&
      (!best || extension.length > best.length)
    ) {
      best = extension;
    }
  }
  return best;
}

/**
 * 꺼낸 폴더에서 고른 파일을 읽는다. 일반 파일만 읽고(심볼릭 링크는 따라가지 않는다),
 * 크기 상한을 넘거나 글이 아닌 파일(NUL 바이트, 깨진 UTF-8)은 건너뛰고 센다
 */
export async function readSourceFiles(
  root: string,
  repository: string,
  filePaths: readonly string[],
): Promise<{
  files: SourceFile[];
  skipped: Pick<FileSkipCounts, 'binary' | 'tooLarge'>;
}> {
  const files: SourceFile[] = [];
  const skipped = { binary: 0, tooLarge: 0 };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const filePath of filePaths) {
    const absolute = join(root, filePath);
    const info = await lstat(absolute);
    if (!info.isFile()) {
      skipped.binary += 1;
      continue;
    }
    if (info.size > GRAPH_MAX_SOURCE_FILE_BYTES) {
      skipped.tooLarge += 1;
      continue;
    }
    const handle = await open(absolute, 'r');
    let bytes: Buffer;
    try {
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
    if (bytes.subarray(0, GRAPH_BINARY_PROBE_BYTES).includes(0)) {
      skipped.binary += 1;
      continue;
    }
    let content: string;
    try {
      content = decoder.decode(bytes);
    } catch {
      skipped.binary += 1;
      continue;
    }
    files.push({ repository, filePath, content: stripByteOrderMark(content) });
  }
  return { files, skipped };
}

/** 기준 폴더에서 본 상대 경로(`/` 구분). 결과와 오류 메시지에 이 컴퓨터의 절대 경로를 남기지 않으려고 쓴다 */
export function portablePath(base: string, path: string): string {
  return relative(base, path).split(sep).join('/') || '.';
}

/** 정렬 순서를 실행 환경의 언어 설정과 상관없이 고정한다 */
export function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** 컴파일한 glob. withDescendants 면 그 경로 아래 파일까지 한 번에 맞춘다(`^glob(?:/.*)?$`) */
function cachedGlob(
  pattern: string,
  ignoreCase: boolean,
  withDescendants: boolean,
): RegExp {
  const key = `${ignoreCase ? 'i' : 's'}${withDescendants ? 'd' : 'e'}:${pattern}`;
  const cached = compiledGlobs.get(key);
  if (cached) {
    return cached;
  }
  const expression = globExpression(pattern);
  const compiled = new RegExp(
    `^${expression}${withDescendants ? '(?:/.*)?' : ''}$`,
    ignoreCase ? 'i' : '',
  );
  compiledGlobs.set(key, compiled);
  return compiled;
}

function globExpression(pattern: string): string {
  const source = normalizeGlob(pattern);
  let expression = '';
  let braceDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '*') {
      if (source[index + 1] !== '*') {
        expression += '[^/]*';
      } else if (
        (index === 0 || source[index - 1] === '/') &&
        source[index + 2] === '/'
      ) {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
      continue;
    }
    if (character === '?') {
      expression += '[^/]';
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      expression += '(?:';
      continue;
    }
    if (character === '}' && braceDepth > 0) {
      braceDepth -= 1;
      expression += ')';
      continue;
    }
    if (character === ',' && braceDepth > 0) {
      expression += '|';
      continue;
    }
    if (character === '[') {
      const end = source.indexOf(']', index + 2);
      if (end === -1) {
        throw new Error(`invalid glob (unclosed "["): ${pattern}`);
      }
      const body = source.slice(index + 1, end);
      const negated = body.startsWith('!') || body.startsWith('^');
      const members = (negated ? body.slice(1) : body).replace(
        /[\\\]]/g,
        '\\$&',
      );
      expression += negated ? `[^/${members}]` : `[${members}]`;
      index = end;
      continue;
    }
    expression += character.replace(/[.+^$()|\\\]}]/g, '\\$&');
  }
  if (braceDepth !== 0) {
    throw new Error(`invalid glob (unclosed "{"): ${pattern}`);
  }
  return expression;
}

/** 경로 구분자를 맞추고, 앞뒤 `/` 를 떼고, 이어진 `**` 조각을 하나로 줄인다(되짚기가 길어지지 않게) */
function normalizeGlob(pattern: string): string {
  return pattern
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/(?:\*\*\/)+/g, '**/')
    .replace(/(?:\/\*\*)+$/, '/**');
}

function stripByteOrderMark(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}
