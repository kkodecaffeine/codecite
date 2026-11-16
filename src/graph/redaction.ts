// 저장하는 원문과 실행 사실 값에서 비밀값 모양을 가린다
// 원문은 실행 사실을 다시 뽑거나 구문 트리로 탐지할 수 있게 따옴표와 코드 구조를 남기고 따옴표 안만 바꾼다
// 이름으로 찾는 규칙은 이름이 평범하면 놓치므로, 값 모양(알려진 토큰 형식, 무작위 문자열)으로 찾는 규칙을 함께 건다
import {
  CREDENTIAL_HEX_MIN_LENGTH,
  CREDENTIAL_MIXED_MIN_LENGTH,
  CREDENTIAL_NAME_LAST_WORDS,
  KNOWN_TOKEN_PATTERNS,
  RANDOM_LITERAL_MIN_ENTROPY,
  RANDOM_LITERAL_MIN_LENGTH,
  REDACTED_PRIVATE_KEY,
  REDACTED_TOKEN,
  REDACTED_VALUE,
  SECRET_NAME_LAST_PAIRS,
  SECRET_NAME_LAST_WORDS,
} from './constants.js';

/** 따옴표로 감싼 문자열. 작은·큰따옴표는 한 줄, 백틱은 여러 줄일 수 있다 */
const QUOTED =
  String.raw`("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|` +
  '`(?:\\\\.|[^`\\\\])*`)';
/** 이름 뒤에 올 수 있는 것: 닫는 따옴표(JSON 키), 타입 표기, 대입·속성 기호. 긴 줄에서 되짚기가 길어지지 않게 길이를 묶는다 */
const ASSIGNMENT = String.raw`["']?[ \t]*(?::[ \t]*[\w$.<>\[\]| ]{1,80}?[ \t]*)?(?:=|:)\s{0,40}`;

const PRIVATE_KEY_BEGIN = /-{5}BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-{5}/g;
const PRIVATE_KEY_END = /-{5}END [A-Z0-9 ]{0,40}PRIVATE KEY-{5}/g;
const URL_USERINFO =
  /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@'"`]+:)[^\s@'"`/]+@/gi;
const AUTHORIZATION_VALUE =
  /\b(Bearer|Basic|Token)(\s+)[A-Za-z0-9._~+/=-]{16,}/g;
const NAMED_LITERAL = new RegExp(
  String.raw`(\b([\w$][\w$-]{0,80})${ASSIGNMENT})${QUOTED}`,
  'g',
);
const ANY_LITERAL = new RegExp(QUOTED, 'g');

/**
 * 저장하는 심볼 원문의 비밀값을 가린다. 따옴표와 코드 구조는 남긴다
 * 1. 개인 키 블록
 * 2. 형식이 알려진 토큰과 인증 머리글 값
 * 3. 주소 안의 계정 비밀번호
 * 4. 비밀값 이름에 넣은 문자열. 띄어쓰기가 있거나 ASCII 가 아닌 글(안내 문구)은 남긴다
 * 5. 키·솔트 같은 이름에 넣은 무작위 모양 문자열
 * 6. 이름과 상관없이 길고 무작위인 문자열
 */
export function redactSecretLiterals(source: string): string {
  let result = redactPrivateKeyBlocks(source);
  for (const pattern of KNOWN_TOKEN_PATTERNS) {
    result = result.replace(pattern, REDACTED_TOKEN);
  }
  return result
    .replace(AUTHORIZATION_VALUE, `$1$2${REDACTED_VALUE}`)
    .replace(URL_USERINFO, `$1${REDACTED_VALUE}@`)
    .replace(
      NAMED_LITERAL,
      (match, prefix: string, name: string, literal: string) => {
        const value = unquote(literal);
        const words = nameWords(name);
        if (isSecretName(words) && looksLikeSecretText(value)) {
          return `${prefix}${requote(literal, REDACTED_VALUE)}`;
        }
        if (
          isCredentialName(words) &&
          looksRandom(value, CREDENTIAL_MIXED_MIN_LENGTH, true)
        ) {
          return `${prefix}${requote(literal, REDACTED_VALUE)}`;
        }
        return match;
      },
    )
    .replace(ANY_LITERAL, (literal: string) => {
      const value = unquote(literal);
      return looksRandom(value, RANDOM_LITERAL_MIN_LENGTH, false) &&
        shannonEntropy(value) >= RANDOM_LITERAL_MIN_ENTROPY
        ? requote(literal, REDACTED_VALUE)
        : literal;
    });
}

/**
 * 개인 키 블록(BEGIN 줄부터 END 줄까지)을 가린다
 * 정규식 하나로 짝을 찾으면 END 없는 BEGIN 마다 끝까지 다시 훑어 큰 파일에서 느려지므로, 앞에서부터 한 번만 훑는다
 */
function redactPrivateKeyBlocks(source: string): string {
  let result = '';
  let cursor = 0;
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  for (;;) {
    const begin = PRIVATE_KEY_BEGIN.exec(source);
    if (!begin) {
      break;
    }
    PRIVATE_KEY_END.lastIndex = begin.index + begin[0].length;
    const end = PRIVATE_KEY_END.exec(source);
    if (!end) {
      break;
    }
    result += source.slice(cursor, begin.index) + REDACTED_PRIVATE_KEY;
    cursor = end.index + end[0].length;
    PRIVATE_KEY_BEGIN.lastIndex = cursor;
  }
  return result + source.slice(cursor);
}

/**
 * 오류 메시지에서 이 컴퓨터의 경로를 지우고 비밀값을 가린 뒤 자른다
 * 결과 파일에 남기는 메시지가 만든 컴퓨터의 절대 경로나 사용자 이름을 담지 않게 한다
 */
export function scrubMessage(
  message: string,
  localRoots: readonly string[],
  maxChars: number,
): string {
  let result = message;
  const roots = [...new Set(localRoots.filter((root) => root.length > 1))].sort(
    (left, right) => right.length - left.length,
  );
  for (const root of roots) {
    result = result.split(`${root}/`).join('').split(root).join('.');
  }
  result = redactSecretLiterals(result).replace(/\s+/g, ' ').trim();
  return result.length > maxChars
    ? `${result.slice(0, maxChars - 1)}…`
    : result;
}

/** 이름을 소문자 낱말로 나눈다(`clientSecret`, `API_KEY`, `x-api-key`) */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function isSecretName(words: readonly string[]): boolean {
  const last = words.at(-1);
  if (!last) {
    return false;
  }
  return (
    SECRET_NAME_LAST_WORDS.includes(last) ||
    SECRET_NAME_LAST_PAIRS.includes(words.slice(-2).join(' '))
  );
}

function isCredentialName(words: readonly string[]): boolean {
  const last = words.at(-1);
  return last !== undefined && CREDENTIAL_NAME_LAST_WORDS.includes(last);
}

/** 비밀값 이름에 넣은 값 가운데 가릴 것. 비어 있거나 사람이 읽는 글이거나 경로·주소면 남긴다 */
function looksLikeSecretText(value: string): boolean {
  return (
    value.length > 0 &&
    /^[\x21-\x7e]+$/.test(value) &&
    !value.includes('${') &&
    !value.startsWith('/') &&
    !value.startsWith('./') &&
    !value.includes('://') &&
    value !== REDACTED_VALUE
  );
}

/**
 * 무작위로 만든 값처럼 보이는지
 * 16 진수만으로 된 값은 이름이 비밀값을 가리킬 때만 본다(이름 없는 해시·체크섬은 남긴다)
 * 섞인 글자 값은 대문자·소문자·숫자가 모두 있어야 하고, 낙타 표기 낱말에 숫자만 붙은 이름(설정 키)은 뺀다
 */
function looksRandom(
  value: string,
  minLength: number,
  allowHex: boolean,
): boolean {
  if (
    allowHex &&
    value.length >= CREDENTIAL_HEX_MIN_LENGTH &&
    /^[0-9a-fA-F]+$/.test(value)
  ) {
    return true;
  }
  return (
    value.length >= minLength &&
    /^[A-Za-z0-9+/=_-]+$/.test(value) &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /\d/.test(value) &&
    !/^[A-Za-z][a-z]*(?:[A-Z][a-z]+)*\d*$/.test(value)
  );
}

/** 글자당 엔트로피(비트). 같은 글자가 되풀이되는 이름보다 무작위 값이 높다 */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const share = count / value.length;
    entropy -= share * Math.log2(share);
  }
  return entropy;
}

function unquote(literal: string): string {
  return literal.slice(1, -1);
}

function requote(literal: string, value: string): string {
  return `${literal[0]}${value}${literal[0]}`;
}
