import type { PolicyClaimFacet, PolicyClaimProps } from '../domain/types.js';
import type { PolicyEvidence } from '../generation/types.js';
import {
  tokenizePolicySearchQuery,
  tokenizePolicySearchText,
} from '../text/tokenizer.js';
import type { Vocabulary } from '../text/types.js';
import { DEFAULT_KOREAN_VOCABULARY } from '../text/vocabulary.js';
import { USER_FACING_KNOWLEDGE_KINDS } from './constants.js';
import {
  isDecisionCriterionQuestion,
  policyRetrievalScopeForQuery,
  preferredPolicyClaimFacets,
} from './query-intent.js';
import type { AmountUnitIntent, TimeUnitIntent } from './types.js';

/**
 * 근거가 질문에 답할 만한지 본다. 모자라면 답변 모델을 부르지 않고 근거 부족으로 끝낸다
 * - 기술 질문은 기술 근거가 있어야 한다
 * - 질문 낱말을 담은 high claim 중 질문이 원하는 종류(수량이면 같은 단위, 시간이면 같은 모양)가 있으면 충분하다
 * - 판단 기준 질문은 조건을 가진 자격 claim 이 있어야 한다
 * - 수량·시간 질문이 아니면, 관련 claim 이 있고 근거 글이 질문 낱말을 두 개(낱말이 하나뿐이면 하나) 이상 덮을 때 충분하다
 */
export function isPolicyEvidenceSufficient(
  question: string,
  evidence: PolicyEvidence[],
  vocabulary: Vocabulary = DEFAULT_KOREAN_VOCABULARY,
): boolean {
  if (evidence.length === 0) {
    return false;
  }

  const scope = policyRetrievalScopeForQuery(question);
  if (
    scope.intent === 'technical' &&
    !evidence.some((item) => item.contextKind === 'technical')
  ) {
    return false;
  }

  const preferences = preferredPolicyClaimFacets(question);
  const queryTokens = tokenizePolicySearchQuery(question, vocabulary).filter(
    (token) => token.length > 1,
  );
  const claims = evidence
    .flatMap((item) => item.policyClaims ?? [])
    .filter(
      (claim) =>
        claim.confidence === 'high' &&
        (!claim.knowledgeKind ||
          USER_FACING_KNOWLEDGE_KINDS.has(claim.knowledgeKind)),
    );
  const relevantClaims = claims.filter((claim) =>
    claimMatchesQuestion(claim, queryTokens, vocabulary),
  );
  if (
    isDecisionCriterionQuestion(question) &&
    !relevantClaims.some(isDecisionCriterionClaim)
  ) {
    return false;
  }
  const amountUnitIntent = amountUnitIntentForQuestion(question);
  const timeUnitIntent = timeUnitIntentForQuestion(question);
  if (
    relevantClaims.some(
      (claim) =>
        preferences.primary.includes(claim.facet) &&
        (claim.facet !== 'amount' ||
          claimMatchesAmountUnit(claim, amountUnitIntent)) &&
        (!hasTimeFacet([claim.facet]) ||
          claimMatchesTimeUnit(claim, timeUnitIntent)),
    )
  ) {
    return true;
  }

  const combinedText = evidence
    .map((item) => `${item.publicText ?? ''} ${item.text}`)
    .join(' ');
  if (
    preferences.primary.includes('amount') ||
    hasTimeFacet(preferences.primary)
  ) {
    return false;
  }

  if (queryTokens.length === 0) {
    return relevantClaims.length > 0;
  }
  const evidenceTokens = new Set(
    tokenizePolicySearchText(combinedText, vocabulary),
  );
  const matched = queryTokens.filter((token) => evidenceTokens.has(token));
  return (
    relevantClaims.length > 0 &&
    matched.length >= Math.min(2, queryTokens.length)
  );
}

function timeUnitIntentForQuestion(question: string): TimeUnitIntent {
  if (
    /(?:몇\s*시|시간대).*(?:부터|까지)|(?:부터|시작).*(?:몇\s*시|시간대).*(?:까지|종료)/u.test(
      question,
    )
  ) {
    return 'clock-range';
  }
  if (/(?:몇\s*시|시간대|시각)/u.test(question)) {
    return 'clock-point';
  }
  if (/(?:몇\s*(?:분|시간|일)|소요\s*시간|기간)/u.test(question)) {
    return 'duration';
  }
  return 'unspecified';
}

function claimMatchesTimeUnit(
  claim: PolicyClaimProps,
  requestedUnit: TimeUnitIntent,
): boolean {
  if (requestedUnit === 'unspecified') {
    return true;
  }
  const claimText = claimDetailText(claim);
  if (requestedUnit === 'duration') {
    return /(?:\d[\d,.]*\s*(?:분|시간|일|주|개월|년)|소요\s*시간|기간)/u.test(
      claimText,
    );
  }
  const clockTimes = claimText.match(
    /(?:(?:오전|오후)\s*)?\d{1,2}\s*시|(?:[01]?\d|2[0-3]):[0-5]\d/gu,
  );
  return requestedUnit === 'clock-range'
    ? (clockTimes?.length ?? 0) >= 2
    : (clockTimes?.length ?? 0) >= 1;
}

function amountUnitIntentForQuestion(question: string): AmountUnitIntent {
  if (/(?:몇\s*(?:개|건|회)|개수|갯수|수량)/u.test(question)) {
    return 'count';
  }
  if (/(?:비율|퍼센트|%)/u.test(question)) {
    return 'rate';
  }
  if (/(?:얼마|금액|가격|\d[\d,.]*\s*원)/u.test(question)) {
    return 'money';
  }
  return 'unspecified';
}

function claimMatchesAmountUnit(
  claim: PolicyClaimProps,
  requestedUnit: AmountUnitIntent,
): boolean {
  if (requestedUnit === 'unspecified') {
    return true;
  }
  const claimText = claimDetailText(claim);

  if (requestedUnit === 'count') {
    return /(?:\d[\d,.]*\s*(?:개|건|회)|개수|갯수|수량|보관\s*한도)/u.test(
      claimText,
    );
  }
  if (requestedUnit === 'rate') {
    return /(?:\d[\d,.]*\s*%|비율|퍼센트)/u.test(claimText);
  }
  return /(?:\d[\d,.]*\s*원|금액|가격|할인액|결제액)/u.test(claimText);
}

/** 단위를 견줄 claim 글. 주제·문장·값·조건·예외를 함께 본다 */
function claimDetailText(claim: PolicyClaimProps): string {
  return [
    claim.subject,
    claim.statement,
    claim.value,
    ...(claim.conditions ?? []),
    ...(claim.exceptions ?? []),
  ]
    .filter(Boolean)
    .join(' ');
}

/** claim 이 질문 말투가 아닌 질문 낱말을 하나라도 담는지. 질문 말투 낱말만 있으면 모든 claim 을 관련 있다고 본다 */
function claimMatchesQuestion(
  claim: PolicyClaimProps,
  queryTokens: string[],
  vocabulary: Vocabulary,
): boolean {
  const anchors = queryTokens.filter((token) => !isQuestionShapeToken(token));
  if (anchors.length === 0) {
    return true;
  }
  const claimTokens = new Set(
    tokenizePolicySearchText(
      [
        claim.subject,
        claim.statement,
        ...(claim.searchAliases ?? []),
        ...(claim.userQuestionExamples ?? []),
      ]
        .filter(Boolean)
        .join(' '),
      vocabulary,
    ),
  );
  return anchors.some((token) => claimTokens.has(token));
}

/** 조건을 가졌거나 "~이면", "~일 때" 처럼 갈림길을 말하는 자격 claim 인지 */
function isDecisionCriterionClaim(claim: PolicyClaimProps): boolean {
  if (claim.facet !== 'eligibility') {
    return false;
  }
  if ((claim.conditions ?? []).some((condition) => condition.trim())) {
    return true;
  }
  const text = [claim.subject, claim.predicate, claim.statement, claim.value]
    .filter(Boolean)
    .join(' ');
  return /(?:이면|일\s*때|경우|false|true|boolean|flag|predicate)/iu.test(text);
}

function isQuestionShapeToken(token: string): boolean {
  return (
    /^(?:최대|최소|몇|수|얼마|언제|어떻게|가능.*|있.*|없.*)$/u.test(token) ||
    /^시(?:부터|까지.*)?$/u.test(token) ||
    /^\d*(?:개|건|회|원|%|퍼센트|분|시간|일|주|개월|년)(?:까지)?$/u.test(token)
  );
}

function hasTimeFacet(facets: readonly PolicyClaimFacet[]): boolean {
  return facets.some((facet) =>
    ['schedule', 'duration', 'expiration'].includes(facet),
  );
}
