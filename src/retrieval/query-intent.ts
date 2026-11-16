import {
  ACQUISITION_OVERVIEW_QUERY_PATTERN,
  BROAD_LIST_QUERY_PATTERN,
  COMPARISON_QUERY_PATTERN,
  DECISION_CRITERION_QUERY_PATTERN,
  DECISION_OWNER_QUERY_PATTERN,
  DOMAIN_OVERVIEW_QUERY_PATTERN,
  ELIGIBILITY_WHEN_QUERY_PATTERN,
  FOCUSED_QUERY_PATTERN,
  NUMERIC_FIGURE_QUERY_PATTERN,
  POLICY_DETAIL_QUERY_PATTERN,
  TECHNICAL_QUERY_PATTERNS,
  USER_ACTION_ELIGIBILITY_PATTERN,
} from './constants.js';
import type {
  PolicyCoverageMode,
  PolicyRetrievalScope,
  PreferredPolicyClaimFacets,
} from './types.js';

/** 글·댓글을 쓰거나 올릴 수 있는지 묻는 질문인지 */
export function isUserActionEligibilityQuestion(query: string): boolean {
  return USER_ACTION_ELIGIBILITY_PATTERN.test(query);
}

/** 무엇을 기준으로 판단·구분하는지 묻는 질문인지. 누가 정했는지 묻는 질문은 뺀다 */
export function isDecisionCriterionQuestion(query: string): boolean {
  return (
    (DECISION_CRITERION_QUERY_PATTERN.test(query) ||
      isUserActionEligibilityQuestion(query)) &&
    !DECISION_OWNER_QUERY_PATTERN.test(query)
  );
}

/** 질문에 금액, 비율, 횟수 같은 구체적인 숫자 기준이 들어 있는지 */
export function mentionsNumericFigure(query: string): boolean {
  return NUMERIC_FIGURE_QUERY_PATTERN.test(query);
}

/** 질문이 요구하는 정책 사실의 종류를 정책 이름과 무관하게 분류한다 */
export function preferredPolicyClaimFacets(
  query: string,
): PreferredPolicyClaimFacets {
  if (isDecisionCriterionQuestion(query)) {
    return {
      primary: ['eligibility'],
      secondary: ['outcome', 'exception', 'procedure'],
    };
  }
  if (
    /(못\s*받|받지\s*못|안\s*(?:받|들어|쌓|적립)|미지급|누락|대상|조건|왜)/.test(
      query,
    )
  ) {
    return mentionsNumericFigure(query)
      ? {
          primary: ['eligibility', 'amount'],
          secondary: ['outcome', 'exception'],
        }
      : { primary: ['eligibility'], secondary: ['outcome', 'exception'] };
  }
  if (
    /(얼마|금액|비율|퍼센트|%|몇\s*(?:원|개|회|건))/.test(query) ||
    mentionsNumericFigure(query)
  ) {
    return { primary: ['amount'], secondary: ['eligibility', 'outcome'] };
  }
  if (ELIGIBILITY_WHEN_QUERY_PATTERN.test(query)) {
    return {
      primary: ['eligibility'],
      secondary: ['exception', 'procedure', 'outcome'],
    };
  }
  if (
    /(언제|시점|시간대|며칠|몇\s*(?:시|일|시간|분)|주기)/.test(query) ||
    /(?:익일|다음\s*날|당일|즉시|바로|실시간|직후)\s*(?:지급|적립|반영|처리)/.test(
      query,
    )
  ) {
    return { primary: ['schedule', 'duration'], secondary: ['eligibility'] };
  }
  if (/(만료|유효)/.test(query)) {
    return { primary: ['expiration'], secondary: ['exception', 'procedure'] };
  }
  if (/(취소|환불|회수|차감)/.test(query)) {
    return { primary: ['reversal'], secondary: ['exception', 'procedure'] };
  }
  if (
    /(?:적립|지급)(?:은|는|이|가|을|를)?\s*(?:어떻게|방법|처리)/.test(query) ||
    /어떻게.{0,12}(?:받|적립|지급)/.test(query) ||
    /(?:받|적립|지급).{0,12}(?:수\s*있|가능|방법|조건|어떻게|법)/.test(query)
  ) {
    return {
      primary: ['eligibility'],
      secondary: ['amount', 'schedule', 'outcome', 'procedure'],
    };
  }
  if (/(방법|신청|처리|어떻게)/.test(query)) {
    return { primary: ['procedure'], secondary: ['eligibility', 'outcome'] };
  }
  return {
    primary: ['outcome'],
    secondary: [
      'eligibility',
      'amount',
      'schedule',
      'expiration',
      'exception',
      'reversal',
      'procedure',
    ],
  };
}

/** 기술 구현 신호가 분명할 때만 기술 조각까지 검색 범위를 연다 */
export function policyRetrievalScopeForQuery(
  query: string,
): PolicyRetrievalScope {
  const technical = TECHNICAL_QUERY_PATTERNS.some((pattern) =>
    pattern.test(query),
  );
  const coverageMode = policyCoverageModeForQuery(query);
  return technical
    ? {
        intent: 'technical',
        contextKinds: ['technical', 'policy'],
        coverageMode,
      }
    : { intent: 'policy', contextKinds: ['policy'], coverageMode };
}

/** 한 가지 사실, 목록·개요, 비교 중 무엇을 묻는지 가른다. 판단 기준 질문은 늘 한 가지 사실로 본다 */
export function policyCoverageModeForQuery(query: string): PolicyCoverageMode {
  if (isDecisionCriterionQuestion(query)) {
    return 'focused';
  }
  if (COMPARISON_QUERY_PATTERN.test(query)) {
    return 'comparison';
  }
  if (ELIGIBILITY_WHEN_QUERY_PATTERN.test(query)) {
    return 'broad-list';
  }
  if (
    (BROAD_LIST_QUERY_PATTERN.test(query) ||
      ACQUISITION_OVERVIEW_QUERY_PATTERN.test(query) ||
      isPolicyDomainOverviewQuery(query)) &&
    !FOCUSED_QUERY_PATTERN.test(query)
  ) {
    return 'broad-list';
  }
  return 'focused';
}

/** "~란?", "~가 뭐야?" 처럼 대상 자체를 묻고 조건·기준 같은 구체적인 사실은 묻지 않는 질문인지 */
export function isPolicyDomainOverviewQuery(query: string): boolean {
  return (
    DOMAIN_OVERVIEW_QUERY_PATTERN.test(query) &&
    !POLICY_DETAIL_QUERY_PATTERN.test(query)
  );
}
