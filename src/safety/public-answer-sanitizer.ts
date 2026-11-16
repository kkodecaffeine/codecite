import {
  HANGUL_SYLLABLE_END,
  HANGUL_SYLLABLE_START,
  KOREAN_PARTICLE_BASE,
} from '../text/constants.js';
import { withKoreanParticle } from '../text/korean-particle.js';
import {
  ABSOLUTE_PATH_ROOTS,
  CLAIM_ID_PATTERN,
  CODE_IDENTIFIER_PATTERN,
  EMBEDDED_INSTRUCTION_PLACEHOLDER,
  HIDDEN_FILE_TEXT,
  HIDDEN_PATH_TEXT,
  IMPLEMENTATION_TYPE_SUFFIXES,
  JS_PRODUCT_NAMES,
  PROCESSING_IDENTIFIER_SUFFIX_PATTERN,
  PROMPT_DELIMITER_PATTERN,
  PROMPT_FORMAT_LABEL_PATTERN,
  PROMPT_TEMPLATE_ECHO_PATTERN,
  PUBLIC_ANSWER_PARTICLE_PATTERN,
  SOURCE_FILE_EXTENSIONS,
  SOURCE_PATH_EXTENSIONS,
} from './constants.js';
import type { PublicAnswerSanitizerOptions } from './types.js';

const PARTICLE = PUBLIC_ANSWER_PARTICLE_PATTERN.source;
const TRAILING_PARTICLE = new RegExp(`(?:${PARTICLE})$`, 'u');

/**
 * 공개 답변에서 내부 정보를 걷어 낸다. 모델이 무엇을 쓰든 답을 내보내기 직전에 마지막으로 돈다
 * 1. 프롬프트 문구: 경계 태그, 지시문 자리 표시, 답변 형식 라벨, 말투 예시, claim id
 * 2. 파일 경로: 장비 절대 경로, 저장소 안 소스 경로, 소스 파일 이름과 `.env`
 * 3. 내부 식별자: 데코레이터, 함수 호출, `Type.member`, 구현 타입 이름, 백틱으로 감싼 식별자
 * 식별자는 용어집의 공개 이름이나 모양으로 정한 역할 낱말로 바꾸고, 뒤에 붙은 조사는 바꾼 낱말의 받침에 맞춘다
 */
export function sanitizePublicPolicyAnswer(
  value: string,
  options: PublicAnswerSanitizerOptions = {},
): string {
  const glossary = options.identifierGlossary ?? {};
  return tidyWhitespace(
    rewriteCodeIdentifiers(
      hideImplementationNames(
        hideFilePaths(stripPromptWording(value)),
        glossary,
      ),
      glossary,
    ),
  );
}

/** 답에 옮겨 적힌 프롬프트 장치를 지운다. 경계 태그와 지시문 자리 표시는 사용자에게 뜻이 없다 */
function stripPromptWording(value: string): string {
  return value
    .replace(PROMPT_DELIMITER_PATTERN, '')
    .replaceAll(EMBEDDED_INSTRUCTION_PLACEHOLDER, '')
    .replace(PROMPT_FORMAT_LABEL_PATTERN, '$1')
    .replace(PROMPT_TEMPLATE_ECHO_PATTERN, '')
    .replace(CLAIM_ID_PATTERN, '');
}

/**
 * 장비 절대 경로와 저장소 안 소스 경로는 앞 폴더와 `:줄:칸` 까지 한 덩어리로 가린다
 * 주소 안의 경로는 바로 앞 글자가 `/`·`.` 이라 건너뛰고, 확장자 없는 API 경로(`/v1/orders`)도 그대로 둔다
 * 폴더 없이 쓴 소스 파일 이름과 `.env` 도 가리되 `Node.js` 같은 제품 이름은 둔다
 */
function hideFilePaths(value: string): string {
  const absolutePath = new RegExp(
    `(?<![\\w.])\\/(?:${ABSOLUTE_PATH_ROOTS})\\/[^\\s'"\`)]+`,
    'gu',
  );
  const sourcePath = new RegExp(
    `(?<![\\w./@-])(?:[\\w.-]+\\/)+[\\w.-]+\\.(?:${SOURCE_PATH_EXTENSIONS})(?::\\d+)*\\b`,
    'gu',
  );
  const sourceFile = new RegExp(
    `(?<![\\w./@-])(?!(?:${JS_PRODUCT_NAMES.join('|')})\\.js\\b)(?:\\.env(?:\\.[\\w-]+)?|[\\w-]+(?:\\.[\\w-]+)*\\.(?:${SOURCE_FILE_EXTENSIONS}))(?::\\d+)*\\b`,
    'gu',
  );
  return value
    .replace(absolutePath, HIDDEN_PATH_TEXT)
    .replace(sourcePath, HIDDEN_PATH_TEXT)
    .replace(sourceFile, HIDDEN_FILE_TEXT);
}

/**
 * 구현 이름은 답에 내보내지 않는다
 * 데코레이터는 "내부 구현 항목", camelCase 함수 호출과 이어진 속성·호출, 두 낱말 이상의 PascalCase 에 붙은 `.member` 는 "내부 처리" 로 바꾼다
 * 구현 타입 끝말(Service, Repository 등)로 끝나는 이름은 백틱이 있으면 역할 낱말, 없으면 "내부 구현 항목" 이 된다
 * 한 낱말 PascalCase 의 `.member`(`Date.now`)는 표준 이름이라 둔다
 */
function hideImplementationNames(
  value: string,
  glossary: Readonly<Record<string, string>>,
): string {
  const typeName = `\\b[A-Za-z][A-Za-z0-9]*(?:${IMPLEMENTATION_TYPE_SUFFIXES.join('|')})\\b`;
  return value
    .replace(/@[A-Z][A-Za-z0-9]*(?:\([^()\n]*\))?/gu, '내부 구현 항목')
    .replace(
      new RegExp(
        `\`?(?<![\\w$.])[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\\([^()\\n]*\\)(?:\\.[A-Za-z_$][\\w$]*(?:\\([^()\\n]*\\))?)*\`?(?:${PARTICLE})?`,
        'gu',
      ),
      (match: string) => attachParticle('내부 처리', trailingParticle(match)),
    )
    .replace(
      new RegExp(
        `\`?(?<![\\w$.])[A-Z][a-z0-9]*[A-Z][A-Za-z0-9]*(?:\\.[A-Za-z_$][\\w$]*)+(?:\\([^()\\n]*\\))?\`?(?:${PARTICLE})?`,
        'gu',
      ),
      (match: string) => attachParticle('내부 처리', trailingParticle(match)),
    )
    .replace(
      new RegExp(`(\`?)(${typeName})\\1(?:${PARTICLE})?`, 'gu'),
      (match: string, tick: string, name: string) =>
        attachParticle(
          tick ? identifierRole(name, glossary) : '내부 구현 항목',
          trailingParticle(match),
        ),
    );
}

/**
 * 백틱으로 감싼 코드 식별자를 공개 이름이나 역할 낱말로 바꾼다. 식별자가 아니면 백틱만 뗀다
 * `isOpen=true` 처럼 값이 붙은 꼴은 상태 문장으로 푼다
 */
function rewriteCodeIdentifiers(
  value: string,
  glossary: Readonly<Record<string, string>>,
): string {
  return value.replace(
    new RegExp(`\`([^\`\\n]+)\`(?:${PARTICLE})?`, 'gu'),
    (_match, inner: string, trailing?: string) => {
      const plain = plainIdentifierText(inner.trim(), glossary);
      return plain === undefined
        ? `${inner.trim()}${trailing ?? ''}`
        : attachParticle(plain, trailing);
    },
  );
}

/** 식별자면 공개할 낱말, 식별자가 아니거나 그대로 두어도 되는 값이면 undefined */
function plainIdentifierText(
  inner: string,
  glossary: Readonly<Record<string, string>>,
): string | undefined {
  const assignment = /^([A-Za-z_$][\w$]*)\s*=\s*(\S+)$/u.exec(inner);
  if (assignment) {
    return assignmentState(assignment[1], assignment[2], glossary);
  }
  if (!CODE_IDENTIFIER_PATTERN.test(inner)) {
    return undefined;
  }
  // 대문자·숫자·밑줄만 있는 이름은 화면에 그대로 보이는 코드 값일 때가 많아 둔다
  if (/^[A-Z0-9_]+$/u.test(inner)) {
    return undefined;
  }
  // 소문자 한 낱말은 상태 값이나 일반 낱말일 때가 많다. 용어집에 없으면 뜻을 잃지 않게 백틱만 뗀다
  if (/^[a-z]+$/u.test(inner) && !glossary[inner]) {
    return undefined;
  }
  return identifierRole(inner, glossary);
}

function assignmentState(
  identifier: string,
  literal: string,
  glossary: Readonly<Record<string, string>>,
): string {
  const subject = attachParticle(identifierRole(identifier, glossary), '가');
  const normalized = literal.trim().toLowerCase();
  if (normalized === 'true') {
    return `${subject} 켜진 상태`;
  }
  if (normalized === 'false') {
    return `${subject} 꺼진 상태`;
  }
  if (['null', 'nil', 'undefined'].includes(normalized)) {
    return `${subject} 비어 있는 상태`;
  }
  return `${identifierRole(identifier, glossary)} 값이 ${literal}인 상태`;
}

/** 용어집에 있으면 공개 이름, 없으면 이름 모양으로 역할 낱말을 정한다 */
function identifierRole(
  identifier: string,
  glossary: Readonly<Record<string, string>>,
): string {
  const bare = identifier.replace(/\(\)$/u, '');
  if (glossary[bare]) {
    return glossary[bare];
  }
  if (bare.includes('.') || identifier.endsWith('()')) {
    return '내부 처리';
  }
  if (/Flag$/u.test(bare)) {
    return '내부 상태 값';
  }
  if (PROCESSING_IDENTIFIER_SUFFIX_PATTERN.test(bare)) {
    return '내부 처리';
  }
  return /^[A-Z]/u.test(bare) ? '내부 구현 항목' : '내부 항목';
}

function trailingParticle(match: string): string | undefined {
  return TRAILING_PARTICLE.exec(match)?.[0];
}

/** 바꾼 낱말 뒤에 조사를 받침에 맞춰 붙인다. 한글로 끝나지 않으면 원래 조사를 그대로 붙인다 */
function attachParticle(word: string, particle?: string): string {
  if (!particle) {
    return word;
  }
  const last = word.codePointAt(word.length - 1) ?? 0;
  if (last < HANGUL_SYLLABLE_START || last > HANGUL_SYLLABLE_END) {
    return `${word}${particle}`;
  }
  const base = KOREAN_PARTICLE_BASE[particle];
  if (base) {
    return withKoreanParticle(word, base);
  }
  if (particle === '과' || particle === '와') {
    return `${word}${(last - HANGUL_SYLLABLE_START) % 28 === 0 ? '와' : '과'}`;
  }
  return `${word}${particle}`;
}

/** 지운 자리에 남은 공백과 빈 괄호를 정리한다. 줄 나눔은 답변 항목 경계라 그대로 둔다 */
function tidyWhitespace(value: string): string {
  return value
    .replace(/\(\s*\)/gu, '')
    .replace(/[^\S\n]{2,}/gu, ' ')
    .replace(/[^\S\n]+([,.!?。])/gu, '$1')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
