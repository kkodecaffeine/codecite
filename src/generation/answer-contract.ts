import type { PolicyClaimProps } from '../domain/types.js';
import { termMatches } from '../retrieval/anchor-evidence.js';
import {
  tokenizePolicySearchQuery,
  tokenizePolicySearchText,
} from '../text/tokenizer.js';
import {
  ABSTENTION_PATTERN,
  ANSWER_ITEM_LIMITS,
  ANSWER_SENTENCE_PATTERN,
  DETAILED_ANSWER_QUERY_PATTERN,
  FINAL_EXCEPTION_ITEM_PATTERN,
  LEADING_BULLET_PATTERN,
  LIST_ANSWER_QUERY_PATTERN,
  PERCENTAGE_RANGE_PATTERN,
  PERCENTAGE_VALUE_SOURCE,
  RATE_NOUN_SOURCE,
  VAGUE_QUANTITY_PATTERN,
} from './constants.js';
import { policyAnswerRequiredDetails } from './evidence.js';
import type {
  AnswerItem,
  PolicyAnswerMode,
  PolicyEvidence,
  RequiredEvidenceDetailsInput,
} from './types.js';

/** 질문 말투로 답변 길이 모드를 정한다. 상세 요청이 목록 요청보다 앞선다 */
export function policyAnswerMode(question: string): PolicyAnswerMode {
  if (DETAILED_ANSWER_QUERY_PATTERN.test(question)) {
    return 'detailed';
  }
  return LIST_ANSWER_QUERY_PATTERN.test(question) ? 'list' : 'default';
}

/** 고객 응대용 기본 답변은 짧게 두고, 명시적인 상세 요청만 더 허용한다 */
export function policyAnswerItemLimit(mode: PolicyAnswerMode): number {
  return ANSWER_ITEM_LIMITS[mode];
}

/**
 * 근거 부족으로 답을 미룬 답변인지. 첫 항목만 본다
 * 결론을 말한 뒤 "나머지는 확인되지 않는다" 고 덧붙인 답은 확인한 범위를 밝힌 것이라 미룬 답이 아니다
 */
export function isPolicyAnswerAbstention(answer: string): boolean {
  const normalized = answer.normalize('NFC');
  const first = completedAnswerItems(normalized)[0]?.text ?? normalized;
  return ABSTENTION_PATTERN.test(first);
}

/**
 * 답이 빠뜨린 근거의 상세를 되살린다. 문장 수 제한에 잘리지 않게 첫 항목 바로 뒤에 넣는다
 * 1. 비율 범위의 한쪽 끝만 남았으면 근거의 범위로 되돌린다
 * 2. 근거에 숫자 조건이 있는데 답이 "일정 기간" 처럼 뭉뚱그렸으면 그 claim 문장을 넣는다
 * 3. claim 이 꼭 답하라고 정한 상세(requiredAnswerDetails)가 빠졌으면 넣는다
 */
export function ensureRequiredEvidenceDetails(
  input: RequiredEvidenceDetailsInput,
): string {
  const restored = restoreVagueNumericCondition(
    restoreGroundedPercentageRanges(input.answer, input.evidence),
    input.evidence,
  );
  const requiredDetails = input.evidence.flatMap((evidence) =>
    highConfidenceClaims(evidence).flatMap((claim) =>
      policyAnswerRequiredDetails(claim, input.question),
    ),
  );
  const missingDetails = requiredDetails.filter(
    (detail) => !detail.items.every((item) => restored.includes(item)),
  );
  if (missingDetails.length === 0) {
    return restored;
  }
  return insertAfterFirstItem(
    restored,
    missingDetails.map(
      (detail) =>
        `${detail.label.replace(/[.!?。]+$/, '')} ${detail.items.join(', ')}입니다.`,
    ),
  );
}

/**
 * 글에 나오는 숫자를 비교용 값으로 모은다
 * 자릿수 쉼표를 떼고 `3만`·`5천` 을 숫자로 펴서 `30,000원` 과 `3만 원` 을 같은 값으로 본다
 * `claim-3f2a` 나 `v2` 처럼 영문 식별자에 붙은 숫자는 세지 않는다
 */
export function numericValues(value: string): string[] {
  const normalized = value
    .normalize('NFKC')
    .replace(/\b[A-Za-z_][\w-]*\d[\w-]*/gu, ' ')
    .replace(/(\d),(?=\d{3}(?!\d))/gu, '$1')
    .replace(
      /(\d+(?:\.\d+)?)\s*만(?:\s*(\d+)\s*천)?(?=\s*(?:원|개|건|명|포인트)|[^가-힣]|$)/gu,
      (_match, tenThousands: string, thousands?: string) =>
        String(Number(tenThousands) * 10_000 + Number(thousands ?? 0) * 1_000),
    )
    .replace(
      /(\d+(?:\.\d+)?)\s*천(?=\s*(?:원|개|건|명|포인트)|[^가-힣]|$)/gu,
      (_match, thousands: string) => String(Number(thousands) * 1_000),
    );
  return (normalized.match(/\d+(?:\.\d+)?/gu) ?? []).map((number) =>
    String(Number(number)),
  );
}

/**
 * 목록 줄은 한 항목, 일반 문장은 완결 문장 하나를 한 항목으로 세어 항목 수를 맞춘다
 * 기본 답변을 줄일 때는 마지막 예외·한계 항목을 따로 남겨 "단, …" 이 잘리지 않게 한다
 * 항목이 둘 이상이면 훑기 쉬운 목록으로, prose 면 이어진 문장으로 낸다
 */
export function enforcePolicyAnswerContract(
  answer: string,
  mode: PolicyAnswerMode,
  itemLimit?: number,
  style: 'bullets' | 'prose' = 'bullets',
): string {
  const limit = itemLimit ?? policyAnswerItemLimit(mode);
  const items = completedAnswerItems(answer);
  if (items.length <= limit) {
    return renderAnswerItems(items, style);
  }

  if (mode === 'default') {
    const finalException = [...items]
      .reverse()
      .find((item) => FINAL_EXCEPTION_ITEM_PATTERN.test(item.text));
    const retained = items.slice(0, finalException ? limit - 1 : limit);
    if (finalException && !retained.includes(finalException)) {
      retained.push(finalException);
    }
    return renderAnswerItems(retained, style);
  }

  return renderAnswerItems(items.slice(0, limit), style);
}

/**
 * 답변을 항목으로 나눈다. 목록 기호 줄은 줄 전체가 한 항목이다
 * 일반 줄은 완결 문장마다 한 항목이고, 완결 문장 뒤의 미완성 꼬리는 버린다. 구두점이 하나도 없는 줄은 마침표를 붙여 한 항목으로 센다
 */
export function completedAnswerItems(answer: string): AnswerItem[] {
  return answer.split('\n').flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }
    if (
      LEADING_BULLET_PATTERN.test(trimmed) &&
      /\S/.test(trimmed.replace(LEADING_BULLET_PATTERN, ''))
    ) {
      return [{ text: trimmed }];
    }
    const completed = trimmed
      .match(ANSWER_SENTENCE_PATTERN)
      ?.map((text) => ({ text: text.trim() }));
    return completed?.length
      ? completed
      : [{ text: `${trimmed.replace(/[.!?。]+$/, '')}.` }];
  });
}

/** 근거 claim 의 비율 범위를 답이 한쪽 값만 남겼을 때 원래 범위로 되돌린다. 비율 낱말 바로 뒤의 값을 먼저 고친다 */
function restoreGroundedPercentageRanges(
  answer: string,
  evidence: readonly PolicyEvidence[],
): string {
  const ranges = new Map<string, { lower: string; upper: string }>();
  for (const claim of evidence.flatMap(highConfidenceClaims)) {
    for (const text of [claim.statement, claim.value]) {
      for (const match of text?.matchAll(PERCENTAGE_RANGE_PATTERN) ?? []) {
        ranges.set(`${match[1]}:${match[2]}`, {
          lower: match[1],
          upper: match[2],
        });
      }
    }
  }

  let restored = answer;
  for (const { lower, upper } of ranges.values()) {
    if (restored.includes(`${lower}%`) && restored.includes(`${upper}%`)) {
      continue;
    }
    const groundedRange = `${lower}%부터 ${upper}% 사이`;
    const percentage = new RegExp(PERCENTAGE_VALUE_SOURCE, 'u');
    const contextualRate = new RegExp(
      `(${RATE_NOUN_SOURCE})${PERCENTAGE_VALUE_SOURCE}`,
      'u',
    );
    restored = contextualRate.test(restored)
      ? restored.replace(contextualRate, `$1${groundedRange}`)
      : restored.replace(percentage, groundedRange);
  }
  return restored;
}

/**
 * 답이 숫자 대신 "일정 기간", "정해진 금액" 처럼 뭉뚱그렸고, 그 항목과 낱말이 가장 많이 겹치는 숫자 claim 의 숫자가 답에 없으면
 * 그 claim 문장을 넣는다. "적립금은 일정 기간 뒤 사라져요" 에 만료 claim 의 기간을 되살리는 식이다
 */
function restoreVagueNumericCondition(
  answer: string,
  evidence: readonly PolicyEvidence[],
): string {
  const vagueItem = completedAnswerItems(answer).find((item) =>
    VAGUE_QUANTITY_PATTERN.test(item.text),
  );
  if (!vagueItem) {
    return answer;
  }
  const itemTerms = tokenizePolicySearchQuery(vagueItem.text);
  let best:
    { claim: PolicyClaimProps; numbers: string[]; overlap: number } | undefined;
  for (const claim of evidence.flatMap(highConfidenceClaims)) {
    if (claim.knowledgeKind === 'implementation-detail') {
      continue;
    }
    const numbers = numericValues(claimNumericText(claim));
    const claimTokens = tokenizePolicySearchText(claim.statement);
    const overlap = itemTerms.filter((term) =>
      claimTokens.some((token) => termMatches(term, token)),
    ).length;
    // 겹친 낱말 수가 같으면 근거 순서가 앞선 claim 을 둔다
    if (numbers.length > 0 && overlap > (best?.overlap ?? 0)) {
      best = { claim, numbers, overlap };
    }
  }
  if (!best) {
    return answer;
  }
  const answerNumbers = new Set(numericValues(answer));
  if (best.numbers.some((number) => answerNumbers.has(number))) {
    return answer;
  }
  return insertAfterFirstItem(answer, [best.claim.statement]);
}

function claimNumericText(claim: PolicyClaimProps): string {
  return [
    claim.statement,
    claim.value ?? '',
    ...(claim.conditions ?? []),
    ...(claim.exceptions ?? []),
  ].join('\n');
}

function highConfidenceClaims(evidence: PolicyEvidence): PolicyClaimProps[] {
  return (evidence.policyClaims ?? []).filter(
    (claim) => claim.confidence === 'high',
  );
}

function insertAfterFirstItem(
  answer: string,
  sentences: readonly string[],
): string {
  const items = completedAnswerItems(answer);
  if (items.length === 0) {
    return sentences.join('\n');
  }
  return [
    items[0].text,
    ...sentences,
    ...items.slice(1).map((item) => item.text),
  ].join('\n');
}

function renderAnswerItems(
  items: readonly AnswerItem[],
  style: 'bullets' | 'prose',
): string {
  if (style === 'prose') {
    return items
      .map((item) => item.text.replace(LEADING_BULLET_PATTERN, ''))
      .join(' ');
  }
  if (items.length < 2) {
    return items.map((item) => item.text).join('\n');
  }
  return items
    .map((item) => `• ${item.text.replace(LEADING_BULLET_PATTERN, '')}`)
    .join('\n');
}
