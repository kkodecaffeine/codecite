// 호출·데코레이터 자리의 인자 값에서 비밀값 모양을 가린다. 자리는 탐지에만 쓰고 저장하지 않지만,
// 탐지 결과(경로, 큐 이름, 근거 문자열)로 값이 흘러 나갈 수 있어 추출기를 떠나기 전에 가린다
// 파이프라인의 원문 가리기와는 따로 둔 작은 거름망이다. 원문 전체가 아니라 인자 값 하나하나를 본다
import type { CodeSite, CodeSiteArgument } from '../types.js';
import {
  HEX_RUN_PATTERN,
  RANDOM_RUN_MIN_CLASS_CHANGE_RATIO,
  RANDOM_RUN_MIN_ENTROPY,
  RANDOM_RUN_PATTERN,
  REDACTED_PLACEHOLDER,
  SECRET_KEY_WORDS,
  SECRET_TOKEN_PATTERNS,
  URL_USERINFO_PATTERN,
} from './constants.js';

/** 값 안의 비밀값 모양을 가린다. 주소의 사용자 정보는 그 부분만 바꿔 호스트와 경로는 남긴다 */
export function redactSecretValue(value: string): string {
  let result = value.replace(
    URL_USERINFO_PATTERN,
    (_, scheme: string) => `${scheme}${REDACTED_PLACEHOLDER}@`,
  );
  for (const pattern of SECRET_TOKEN_PATTERNS) {
    result = result.replace(pattern, REDACTED_PLACEHOLDER);
  }
  result = result.replace(HEX_RUN_PATTERN, REDACTED_PLACEHOLDER);
  return result.replace(RANDOM_RUN_PATTERN, (run) =>
    looksRandom(run) ? REDACTED_PLACEHOLDER : run,
  );
}

/** 키 이름이 비밀값을 담는 자리처럼 보이는지(`apiKey`, `client_secret`, `Authorization`) */
export function isSecretKeyName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[_-]/g, '');
  return SECRET_KEY_WORDS.some((word) => normalized.includes(word));
}

/** 자리마다 인자 값을 가린 새 자리를 돌려준다. 이름(name, identifier)과 가린 원문(text)은 그대로 둔다 */
export function redactSiteSecrets(sites: readonly CodeSite[]): CodeSite[] {
  return sites.map((site) => ({
    ...site,
    args: site.args.map((argument) => redactArgument(argument, false)),
  }));
}

function redactArgument(
  argument: CodeSiteArgument,
  underSecretKey: boolean,
): CodeSiteArgument {
  const redact = (value: string): string =>
    underSecretKey && value.length > 0
      ? REDACTED_PLACEHOLDER
      : redactSecretValue(value);
  return {
    text: argument.text,
    ...(argument.literal !== undefined
      ? { literal: redact(argument.literal) }
      : {}),
    ...(argument.template ? { template: argument.template.map(redact) } : {}),
    ...(argument.substitutions
      ? {
          substitutions: argument.substitutions.map((item) =>
            redactArgument(item, underSecretKey),
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
              redactArgument(value, underSecretKey || isSecretKeyName(key)),
            ]),
          ),
        }
      : {}),
    ...(argument.elements
      ? {
          elements: argument.elements.map((item) =>
            redactArgument(item, underSecretKey),
          ),
        }
      : {}),
  };
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
