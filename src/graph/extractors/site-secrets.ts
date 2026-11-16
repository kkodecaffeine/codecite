// 호출·데코레이터 자리의 인자 값에서 비밀값 모양을 가린다. 자리는 탐지에만 쓰고 저장하지 않지만,
// 탐지 결과(경로, 큐 이름, 근거 문자열)로 값이 흘러 나갈 수 있어 추출기를 떠나기 전에 가린다
// 알려진 토큰 형식과 비밀값 이름 낱말은 원문 가리기(../redaction.ts)와 같은 목록(../constants.ts)을 쓴다.
// 원문 전체가 아니라 인자 값 하나하나를 보므로, 값 하나에만 맞는 규칙과 기준값은 ./constants.ts 에 따로 둔다
import {
  CREDENTIAL_HEX_MIN_LENGTH,
  CREDENTIAL_MIXED_MIN_LENGTH,
  CREDENTIAL_NAME_LAST_WORDS,
  KNOWN_TOKEN_PATTERNS,
  SECRET_NAME_LAST_PAIRS,
  SECRET_NAME_LAST_WORDS,
} from '../constants.js';
import type { CodeSite, CodeSiteArgument } from '../types.js';
import {
  HEX_RUN_PATTERN,
  RANDOM_RUN_MIN_CLASS_CHANGE_RATIO,
  RANDOM_RUN_MIN_ENTROPY,
  RANDOM_RUN_PATTERN,
  REDACTED_PLACEHOLDER,
  SITE_AUTHORIZATION_PATTERN,
  SITE_PRIVATE_KEY_PATTERN,
  URL_USERINFO_PATTERN,
} from './constants.js';

/**
 * 키 이름이 가리키는 값의 종류
 * - secret: 비밀값 이름(`password`, `clientSecret`, `apiKey`). 값 모양과 상관없이 가린다
 * - credential: 키·솔트 같은 이름(`key`, `salt`). 무작위 문자열처럼 보일 때만 가린다(캐시 키 이름 같은 값은 남긴다)
 */
type KeyKind = 'secret' | 'credential';

/** 값 안의 비밀값 모양을 가린다. 주소의 사용자 정보는 그 부분만 바꿔 호스트와 경로는 남긴다 */
export function redactSecretValue(value: string, keyKind?: KeyKind): string {
  if (keyKind === 'secret') {
    return value.length > 0 ? REDACTED_PLACEHOLDER : value;
  }
  let result = value
    .replace(
      URL_USERINFO_PATTERN,
      (_, scheme: string) => `${scheme}${REDACTED_PLACEHOLDER}@`,
    )
    .replace(SITE_PRIVATE_KEY_PATTERN, REDACTED_PLACEHOLDER);
  for (const pattern of KNOWN_TOKEN_PATTERNS) {
    result = result.replace(pattern, REDACTED_PLACEHOLDER);
  }
  result = result
    .replace(SITE_AUTHORIZATION_PATTERN, REDACTED_PLACEHOLDER)
    .replace(HEX_RUN_PATTERN, REDACTED_PLACEHOLDER);
  if (keyKind === 'credential' && looksLikeCredential(result)) {
    return REDACTED_PLACEHOLDER;
  }
  return result.replace(RANDOM_RUN_PATTERN, (run) =>
    looksRandom(run) ? REDACTED_PLACEHOLDER : run,
  );
}

/** 키 이름이 비밀값을 담는 자리처럼 보이는지(`apiKey`, `client_secret`, `Authorization`) */
export function isSecretKeyName(name: string): boolean {
  return keyKindOf(name) === 'secret';
}

/** 자리마다 인자 값을 가린 새 자리를 돌려준다. 이름(name, identifier)과 가린 원문(text)은 그대로 둔다 */
export function redactSiteSecrets(sites: readonly CodeSite[]): CodeSite[] {
  return sites.map((site) => ({
    ...site,
    args: site.args.map((argument) => redactArgument(argument)),
  }));
}

/**
 * 이름을 마지막 낱말로 가른다. 원문 가리기와 같은 규칙이다: 낙타 표기·밑줄·하이픈으로 낱말을 나누고
 * 마지막 낱말(또는 마지막 두 낱말)만 보아, passwordHint·tokenType 처럼 비밀값을 설명하는 이름은 남긴다
 */
function keyKindOf(name: string): KeyKind | undefined {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const last = words.at(-1);
  if (last === undefined) {
    return undefined;
  }
  if (
    SECRET_NAME_LAST_WORDS.includes(last) ||
    SECRET_NAME_LAST_PAIRS.includes(words.slice(-2).join(' '))
  ) {
    return 'secret';
  }
  return CREDENTIAL_NAME_LAST_WORDS.includes(last) ? 'credential' : undefined;
}

function redactArgument(
  argument: CodeSiteArgument,
  keyKind?: KeyKind,
): CodeSiteArgument {
  const redact = (value: string): string => redactSecretValue(value, keyKind);
  return {
    text: argument.text,
    ...(argument.literal !== undefined
      ? { literal: redact(argument.literal) }
      : {}),
    ...(argument.template ? { template: argument.template.map(redact) } : {}),
    ...(argument.substitutions
      ? {
          substitutions: argument.substitutions.map((item) =>
            redactArgument(item, keyKind),
          ),
        }
      : {}),
    ...(argument.identifier !== undefined
      ? { identifier: argument.identifier }
      : {}),
    ...(argument.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(argument.properties).map(([key, value]) => [
              key,
              // 비밀값 이름 아래는 끝까지 비밀값으로 본다
              redactArgument(
                value,
                keyKind === 'secret' ? 'secret' : (keyKindOf(key) ?? keyKind),
              ),
            ]),
          ),
        }
      : {}),
    ...(argument.elements
      ? {
          elements: argument.elements.map((item) =>
            redactArgument(item, keyKind),
          ),
        }
      : {}),
  };
}

/** 키·솔트 이름에 넣은 값이 무작위로 만든 값처럼 보이는지. 기준 길이는 원문 가리기와 같다 */
function looksLikeCredential(value: string): boolean {
  if (
    value.length >= CREDENTIAL_HEX_MIN_LENGTH &&
    /^[0-9a-fA-F]+$/.test(value)
  ) {
    return true;
  }
  return (
    value.length >= CREDENTIAL_MIXED_MIN_LENGTH &&
    /^[A-Za-z0-9+/=_-]+$/.test(value) &&
    /[A-Za-z]/.test(value) &&
    /\d/.test(value)
  );
}

/** 글자·숫자가 섞이고, 글자 종류(소문자·대문자·숫자·기호)가 자주 바뀌고, 엔트로피가 높은 묶음 */
function looksRandom(run: string): boolean {
  if (!/[A-Za-z]/.test(run) || !/[0-9]/.test(run)) {
    return false;
  }
  let changes = 0;
  for (let index = 1; index < run.length; index += 1) {
    if (charClass(run[index]) !== charClass(run[index - 1])) {
      changes += 1;
    }
  }
  return (
    changes / (run.length - 1) >= RANDOM_RUN_MIN_CLASS_CHANGE_RATIO &&
    entropy(run) >= RANDOM_RUN_MIN_ENTROPY
  );
}

function charClass(character: string): number {
  if (character >= 'a' && character <= 'z') {
    return 0;
  }
  if (character >= 'A' && character <= 'Z') {
    return 1;
  }
  return character >= '0' && character <= '9' ? 2 : 3;
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let total = 0;
  for (const count of counts.values()) {
    const share = count / value.length;
    total -= share * Math.log2(share);
  }
  return total;
}
