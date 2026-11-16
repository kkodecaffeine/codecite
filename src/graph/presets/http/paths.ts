// HTTP 경로 정규화와 호스트 읽기. 받는 쪽 라우트와 부르는 쪽 호출을 같은 꼴로 바꿔야 연결 단계가 글자 비교로 맞출 수 있다
// 규칙: 앞에 `/` 하나, 매개변수(`:id`, `{id}`, `<id>`, `[id]`, `${…}`)는 모두 `:param`, 질의·해시는 버리고, 끝 `/` 는 뗀다
import { PATH_PARAMETER } from './constants.js';

/** 스킴이 있는 주소(`https://`), 또는 스킴을 뺀 주소(`//host`) */
const ABSOLUTE_URL = /^(?:[a-z][a-z\d+.-]*:)?\/\//i;
/** Express 매개변수(`:id`, `:id?`, `:id(\\d+)`, `:file*`) */
const COLON_PARAMETER = /:[A-Za-z_$][\w$]*(?:\([^)]*\))?[?*+]?/g;
/** FastAPI·OpenAPI 매개변수(`{order_id}`, `{file_path:path}`) */
const BRACE_PARAMETER = /\{[^{}/]*\}/g;
/** Flask 매개변수(`<refund_id>`, `<int:refund_id>`) */
const ANGLE_PARAMETER = /<[^<>/]*>/g;
/** Next.js 동적 조각(`[id]`, `[...slug]`, `[[...slug]]`) */
const BRACKET_PARAMETER = /\[\[?[^\][/]*\]\]?/g;

/** 경로나 주소를 정규화한 경로로 바꾼다. 호스트가 있으면 떼고 경로만 남긴다 */
export function normalizeHttpPath(value: string): string {
  const withoutHost = stripOrigin(replaceSubstitutions(value.trim()));
  const pathOnly = withoutHost.split(/[?#]/, 1)[0] ?? '';
  const segments = pathOnly
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(normalizeSegment);
  return `/${segments.join('/')}`;
}

/**
 * 기준 경로와 하위 경로를 이어 정규화한다(`orders` + `:id/cancel` → `/orders/:param/cancel`)
 * 조각 앞의 `/` 를 떼고 잇는다. 그대로 이으면 빈 기준 경로와 `/orders` 가 `//orders` 가 되어 호스트로 읽힌다
 */
export function joinHttpPaths(...parts: readonly string[]): string {
  return normalizeHttpPath(
    `/${parts
      .map((part) => part.replace(/^\/+/, ''))
      .filter((part) => part.length > 0)
      .join('/')}`,
  );
}

/** 주소에 적힌 호스트. 소문자로 바꾸고 계정 정보와 포트를 뗀다. 호스트가 없거나 실행 중에 정해지면 undefined */
export function hostOf(value: string): string | undefined {
  const trimmed = value.trim();
  const scheme = ABSOLUTE_URL.exec(trimmed);
  if (!scheme) {
    return undefined;
  }
  const authority = trimmed.slice(scheme[0].length).split(/[/?#]/, 1)[0] ?? '';
  const host = authority
    .slice(authority.lastIndexOf('@') + 1)
    .replace(/:\d*$/, '')
    .toLowerCase();
  return host.length > 0 && /^[a-z\d.-]+$/.test(host) ? host : undefined;
}

/** 스킴과 호스트가 있는 주소인지 */
export function isAbsoluteUrl(value: string): boolean {
  return ABSOLUTE_URL.test(value.trim());
}

/** 경로로 볼 수 있는 글인지. 빈 글(기준 경로 그대로)은 받고, 공백이 섞인 글은 문장이라 받지 않는다 */
export function isPathLike(value: string): boolean {
  return !/\s/.test(value);
}

function stripOrigin(value: string): string {
  const scheme = ABSOLUTE_URL.exec(value);
  if (!scheme) {
    return value;
  }
  const rest = value.slice(scheme[0].length);
  const end = rest.search(/[/?#]/);
  return end < 0 ? '' : rest.slice(end);
}

/** `${…}` 를 매개변수 자리로 바꾼다. 안쪽 중괄호가 짝을 이루는 동안은 한 자리로 본다 */
function replaceSubstitutions(value: string): string {
  let result = '';
  let index = 0;
  while (index < value.length) {
    if (value.startsWith('${', index)) {
      let depth = 0;
      let end = index + 1;
      for (; end < value.length; end += 1) {
        if (value[end] === '{') {
          depth += 1;
        } else if (value[end] === '}') {
          depth -= 1;
          if (depth === 0) {
            break;
          }
        }
      }
      result += PATH_PARAMETER;
      index = end + 1;
      continue;
    }
    result += value[index];
    index += 1;
  }
  return result;
}

function normalizeSegment(segment: string): string {
  return segment
    .replace(BRACKET_PARAMETER, PATH_PARAMETER)
    .replace(BRACE_PARAMETER, PATH_PARAMETER)
    .replace(ANGLE_PARAMETER, PATH_PARAMETER)
    .replace(COLON_PARAMETER, PATH_PARAMETER);
}
