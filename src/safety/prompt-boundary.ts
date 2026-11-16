import {
  EMBEDDED_INSTRUCTION_PATTERNS,
  EMBEDDED_INSTRUCTION_PLACEHOLDER,
  PROMPT_DELIMITER_PATTERN,
} from './constants.js';

/**
 * 사용자 입력 안의 태그 꼴(`</질문>`, `<system>`, `<|im_start|>`, `[INST]`)의 꺾쇠를 전각으로 바꿔 프롬프트 구분자로 읽히지 않게 한다
 * 뜻은 남고 구분자 기능만 없어진다. `금액 < 50000` 처럼 태그가 아닌 부등호는 그대로 둔다
 */
export function neutralizePromptDelimiters(text: string): string {
  return text.replace(PROMPT_DELIMITER_PATTERN, (match) =>
    match
      .replace(/</gu, '＜')
      .replace(/>/gu, '＞')
      .replace(/\[/gu, '［')
      .replace(/\]/gu, '］'),
  );
}

/**
 * 근거 본문과 도구 결과 안에서 모델에게 내리는 지시문처럼 생긴 줄을 자리 표시로 바꾼다
 * 코드 주석이나 정책 문장에 심은 간접 주입이 모델에 닿지 않게 한다. 걸리는 줄이 없으면 입력을 그대로 돌려준다
 */
export function neutralizeEmbeddedInstructions(text: string): string {
  if (!text) {
    return text;
  }
  const lines = text.split('\n');
  let changed = false;
  const cleaned = lines.map((line) => {
    if (!containsEmbeddedInstruction(line)) {
      return line;
    }
    changed = true;
    return EMBEDDED_INSTRUCTION_PLACEHOLDER;
  });
  return changed ? cleaned.join('\n') : text;
}

/** 한 줄이 모델에게 내리는 지시문처럼 생겼는지. 전각·호환 문자는 NFKC 로 펴서 본다 */
export function containsEmbeddedInstruction(line: string): boolean {
  const normalized = line.normalize('NFKC');
  return EMBEDDED_INSTRUCTION_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(normalized);
  });
}
