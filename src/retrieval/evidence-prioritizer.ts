import {
  tokenizePolicySearchQuery,
  tokenizePolicySearchText,
} from '../text/tokenizer.js';
import type { Vocabulary } from '../text/types.js';
import { DEFAULT_KOREAN_VOCABULARY } from '../text/vocabulary.js';
import {
  POLICY_COMPARISON_PATTERN,
  POLICY_CONDITION_PATTERN,
  POLICY_DECISION_PATTERN,
  POLICY_NUMERIC_PATTERN,
  RELEVANCE_BAND_SIZE,
} from './constants.js';
import type { PolicyRetrievalCandidate } from './types.js';

/**
 * 구체적인 조건과 결정이 담긴 근거를 단순 구조 설명보다 앞에 둔다
 * 검색 순위를 5 개 단위 구간으로 묶어 구간 안에서만 다시 정렬하므로, 관련 없는 규칙이 위 구간으로 올라오지 않는다
 */
export function prioritizePolicyEvidenceCandidates(
  query: string,
  candidates: PolicyRetrievalCandidate[],
  vocabulary: Vocabulary = DEFAULT_KOREAN_VOCABULARY,
): PolicyRetrievalCandidate[] {
  const queryTokens = tokenizePolicySearchQuery(query, vocabulary);
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      relevanceBand: Math.floor(index / RELEVANCE_BAND_SIZE),
      queryMatches: queryMatchCount(candidate, queryTokens, vocabulary),
      score: policyEvidenceScore(candidate.chunk.searchText),
    }))
    .sort(
      (left, right) =>
        left.relevanceBand - right.relevanceBand ||
        right.queryMatches - left.queryMatches ||
        right.score - left.score ||
        left.index - right.index,
    )
    .map(({ candidate }) => candidate);
}

function queryMatchCount(
  candidate: PolicyRetrievalCandidate,
  queryTokens: string[],
  vocabulary: Vocabulary,
): number {
  const documentTokens = new Set(
    tokenizePolicySearchText(candidate.chunk.searchText, vocabulary),
  );
  return queryTokens.filter((token) => documentTokens.has(token)).length;
}

/** 조건·비교·숫자·결정 낱말 수를 글 길이로 나눈 점수. 낱말 종류마다 8 개까지만 센다 */
function policyEvidenceScore(text: string): number {
  const conditionCount = matches(text, POLICY_CONDITION_PATTERN);
  const comparisonCount = matches(text, POLICY_COMPARISON_PATTERN);
  const numericCount = matches(text, POLICY_NUMERIC_PATTERN);
  const decisionCount = matches(text, POLICY_DECISION_PATTERN);

  const rawScore =
    Math.min(conditionCount, 8) * 5 +
    Math.min(comparisonCount, 8) * 4 +
    Math.min(numericCount, 8) * 2 +
    Math.min(decisionCount, 8) * 3;
  return (rawScore * 1_000) / Math.max(text.length, 500);
}

function matches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}
