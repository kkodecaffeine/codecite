import { policyRetrievalScopeForQuery } from '../retrieval/query-intent.js';
import {
  completedAnswerItems,
  isPolicyAnswerAbstention,
  numericValues,
} from './answer-contract.js';
import {
  CLOSING_REMARK_PATTERN,
  CUSTOMER_OUTCOME_PATTERN,
  DEFAULT_INVENTED_CONDITION_TERMS,
  DEFERRAL_ANSWER_PATTERNS,
  IMPLEMENTATION_WORDING_PATTERN,
  WITHHOLDING_ANSWER_PATTERN,
} from './constants.js';
import { deterministicPolicyFallback } from './fallback.js';
import type {
  AnswerGuardInput,
  AnswerGuardReason,
  AnswerGuardResult,
  PolicyEvidence,
} from './types.js';

/**
 * 모델이 쓴 답을 묶인 근거와 대 보고, 믿을 수 없으면 결정적 답변으로 바꾼다
 * 걸리는 경우: 근거가 없다, 마무리 말을 빼면 빈 답이다, 근거가 있는데 답을 미루거나 다른 창구로 떠넘겼다,
 * 고객이 얻는 결과 없이 구현 작업만 말했다, 근거·질문에 없는 숫자나 조건을 지어냈다
 * 통과하면 상담형 마무리 말만 뗀 답을 돌려준다. 문장 수와 빠진 숫자는 다음 단계인 답변 계약이 맞춘다
 */
export function guardGeneratedAnswer(
  input: AnswerGuardInput,
): AnswerGuardResult {
  const replace = (reason: AnswerGuardReason): AnswerGuardResult => ({
    answer: deterministicPolicyFallback({
      question: input.question,
      evidence: input.evidence,
      answerMode: input.answerMode,
    }),
    replaced: true,
    reason,
  });

  if (input.evidence.length === 0) {
    return replace('no_evidence');
  }
  const answer = withoutClosingRemarks(input.answer.normalize('NFC').trim());
  if (!answer) {
    return replace('empty');
  }
  const corpus = evidenceCorpus(input.evidence);
  if (isEvasiveAnswer(answer, compact(corpus))) {
    return replace('evasive');
  }
  if (isImplementationOnlyAnswer(input.question, answer)) {
    return replace('implementation_only');
  }
  if (inventedFigures(input.question, answer, corpus).length > 0) {
    return replace('invented_figure');
  }
  const terms =
    input.inventedConditionTerms ?? DEFAULT_INVENTED_CONDITION_TERMS;
  if (inventedConditions(input.question, answer, corpus, terms).length > 0) {
    return replace('invented_condition');
  }
  return { answer, replaced: false };
}

/** 답 끝의 "더 궁금한 점이 있으면…" 같은 마무리 말을 뗀다. 여러 개면 끝에서부터 모두 뗀다 */
function withoutClosingRemarks(answer: string): string {
  let current = answer;
  for (;;) {
    const next = current.replace(CLOSING_REMARK_PATTERN, '').trimEnd();
    if (next === current) {
      return current;
    }
    current = next;
  }
}

/**
 * 근거가 있는데 답을 피했는지
 * 첫 항목에서 근거 부족을 말했거나, 근거에 없는 창구·안내로 미뤘거나, 자세한 조건을 알려 줄 수 없다고 비켜 갔으면 피한 답이다
 */
function isEvasiveAnswer(answer: string, evidenceCompact: string): boolean {
  if (isPolicyAnswerAbstention(answer)) {
    return true;
  }
  return completedAnswerItems(answer).some(
    ({ text }) =>
      WITHHOLDING_ANSWER_PATTERN.test(text) ||
      DEFERRAL_ANSWER_PATTERNS.some((pattern) => {
        const match = pattern.exec(text);
        return (
          match !== null &&
          !evidenceCompact.includes(compact(match.groups?.channel ?? match[0]))
        );
      }),
  );
}

/** 정책 질문에 고객이 얻는 결과(적립, 환불, 배송 등) 없이 조회·저장 같은 구현 작업만 답했는지 */
function isImplementationOnlyAnswer(question: string, answer: string): boolean {
  if (policyRetrievalScopeForQuery(question).intent === 'technical') {
    return false;
  }
  return (
    IMPLEMENTATION_WORDING_PATTERN.test(answer) &&
    !CUSTOMER_OUTCOME_PATTERN.test(answer)
  );
}

/**
 * 근거에도 질문에도 없는 숫자. "보통 쇼핑몰은 14 일" 같은 상식이 정책으로 둔갑하는 것을 막는다
 * 질문의 숫자는 사용자가 준 상황이라 답에 다시 나와도 된다. 줄머리 번호(`1.`, `2)`)는 세지 않는다
 */
function inventedFigures(
  question: string,
  answer: string,
  corpus: string,
): string[] {
  const allowed = new Set([
    ...numericValues(corpus),
    ...numericValues(question),
  ]);
  const body = answer.replace(/^\s*(?:[-*•]\s*)?\d{1,2}[.)]\s+/gmu, '');
  return numericValues(body).filter((value) => !allowed.has(value));
}

/** 근거에도 질문에도 없는데 답에 나온 조건 낱말. 띄어쓰기 차이는 무시한다 */
function inventedConditions(
  question: string,
  answer: string,
  corpus: string,
  terms: readonly string[],
): string[] {
  const answerCompact = compact(answer);
  const groundedCompact = compact(`${corpus}\n${question}`);
  return terms.filter((term) => {
    const target = compact(term);
    return (
      target.length > 0 &&
      answerCompact.includes(target) &&
      !groundedCompact.includes(target)
    );
  });
}

/** 답과 대 볼 근거 글. 사람이 읽는 필드만 모은다. claim id·출처 같은 내부 값은 넣지 않는다 */
function evidenceCorpus(evidence: readonly PolicyEvidence[]): string {
  return evidence
    .flatMap((item) => [
      item.section,
      item.text,
      item.publicText ?? '',
      ...(item.policyClaims ?? []).flatMap((claim) => [
        claim.subject ?? '',
        claim.statement,
        claim.value ?? '',
        ...(claim.conditions ?? []),
        ...(claim.exceptions ?? []),
        ...(claim.requiredAnswerDetails ?? []).flatMap((detail) => [
          detail.label,
          ...detail.items,
        ]),
      ]),
    ])
    .filter(Boolean)
    .join('\n');
}

function compact(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/\s+/gu, '');
}
