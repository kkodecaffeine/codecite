import {
  POLICY_PROCEDURE_CALLEES_HEADING,
  POLICY_PROCEDURE_DEFERRED_HEADING,
  POLICY_PROCEDURE_STEPS_HEADING,
} from '../domain/constants.js';
import type { PolicyClaimProps } from '../domain/types.js';
import type { PolicyEvidence } from '../generation/types.js';
import {
  tokenizePolicySearchQuery,
  tokenizePolicySearchText,
} from '../text/tokenizer.js';
import type { Vocabulary } from '../text/types.js';
import { DEFAULT_KOREAN_VOCABULARY } from '../text/vocabulary.js';
import {
  ANCHOR_POLICY_EVIDENCE_MIN_COVERAGE,
  ANCHOR_POLICY_EVIDENCE_MIN_MATCHED_TERMS,
  ANCHOR_POLICY_EVIDENCE_SLOT_LIMIT,
  ANCHOR_QUESTION_FILLER_PATTERN,
  POLICY_FIRST_EVIDENCE_MIN_MATCHED_TERMS,
  POLICY_FIRST_EVIDENCE_SLOT_LIMIT,
  PROCEDURE_GENERIC_QUESTION_TERM_PATTERN,
  PROCEDURE_POLICY_EVIDENCE_MIN_MATCHED_TERMS,
  PROCEDURE_POLICY_EVIDENCE_SLOT_LIMIT,
} from './constants.js';
import type { QuestionCoverage } from './types.js';

/** 질문 낱말마다 정규화한 토큰과 동의어를 묶는다. 첫 값이 대표 낱말이다 */
function questionAnchorGroups(
  question: string,
  vocabulary: Vocabulary,
): string[][] {
  return question
    .split(/[^\p{L}\p{N}_]+/u)
    .map((word) => tokenizePolicySearchQuery(word, vocabulary))
    .filter(
      (group) =>
        group.length > 0 &&
        Array.from(group[0]).length >= 2 &&
        !ANCHOR_QUESTION_FILLER_PATTERN.test(group[0]),
    );
}

/** 질문에서 조사와 질문 말투를 뺀 내용 낱말 */
export function questionAnchorTerms(
  question: string,
  vocabulary: Vocabulary = DEFAULT_KOREAN_VOCABULARY,
): string[] {
  return questionAnchorGroups(question, vocabulary).map((group) => group[0]);
}

/**
 * 검색 순서로 받은 근거에서 질문 낱말을 가장 많이 덮는 high claim 근거를 고른다
 * 덮은 낱말이 2 개 이상이고 절반 이상일 때만 고르며, 같으면 claim 주제가 질문 낱말을 더 많이 담은 쪽, 그다음 검색 순서를 따른다
 * 별칭 검색 결과나 다른 기능의 근거가 앞자리를 채워도 질문에 바로 답하는 claim 이 빠지지 않게 하려는 것이다
 */
export function selectAnchorPolicyEvidence(
  question: string,
  evidence: readonly PolicyEvidence[],
  limit = ANCHOR_POLICY_EVIDENCE_SLOT_LIMIT,
  vocabulary: Vocabulary = DEFAULT_KOREAN_VOCABULARY,
): PolicyEvidence[] {
  const groups = questionAnchorGroups(question, vocabulary);
  if (groups.length === 0 || limit <= 0) {
    return [];
  }
  return scoreQuestionCoverage(groups, evidence, vocabulary)
    .filter(
      ({ matched, coverage }) =>
        matched >= ANCHOR_POLICY_EVIDENCE_MIN_MATCHED_TERMS &&
        coverage >= ANCHOR_POLICY_EVIDENCE_MIN_COVERAGE,
    )
    .sort(compareCoverage)
    .slice(0, limit)
    .map(({ item }) => item);
}

/**
 * 실행 흐름 질문에 붙일 절차 근거를 고른다
 * 흐름 질문은 "하나하나 짚어서" 같은 말투 낱말이 많아 기준 근거의 덮은 비율 하한을 넘기 어렵다
 * 그래서 처리 순서·앞뒤 흐름을 포함한 행 전체 글에서 질문 낱말을 둘 이상 덮은 행만 남기고 많이 덮은 순서로 고른다
 */
export function selectProcedurePolicyEvidence(
  question: string,
  evidence: readonly PolicyEvidence[],
  limit = PROCEDURE_POLICY_EVIDENCE_SLOT_LIMIT,
  vocabulary: Vocabulary = DEFAULT_KOREAN_VOCABULARY,
): PolicyEvidence[] {
  // "처리 순서" 는 모든 절차 행이 검색 표현으로 가지므로 질문의 흐름 낱말은 덮은 수에 넣지 않는다
  const groups = questionAnchorGroups(question, vocabulary).filter(
    (group) => !PROCEDURE_GENERIC_QUESTION_TERM_PATTERN.test(group[0]),
  );
  if (groups.length === 0 || limit <= 0) {
    return [];
  }
  const selected = evidence
    .filter(hasProcedureSteps)
    .map((item, index) => ({
      item,
      index,
      matched: countMatchedGroups(groups, [
        ...highConfidenceClaimTokens(item, vocabulary),
        ...tokenizePolicySearchText(item.text, vocabulary),
      ]),
    }))
    // "환불 절차 알려줘" 처럼 흐름 낱말을 빼면 한 낱말만 남는 짧은 질문은 그 낱말만 덮으면 된다
    .filter(
      ({ matched }) =>
        matched >=
        Math.min(PROCEDURE_POLICY_EVIDENCE_MIN_MATCHED_TERMS, groups.length),
    )
    .sort(
      (left, right) => right.matched - left.matched || left.index - right.index,
    )
    .slice(0, limit)
    .map(({ item }) => item);
  return callersFirst(selected);
}

/**
 * 다른 절차 행이 [이어지는 처리] 로 부르는 행은 그 행 뒤에 둔다
 * 답변 모델이 앞 근거부터 흐름을 세우므로, 하위 단계 행이 앞에 오면 일부 단계를 전체 흐름처럼 답한다
 */
function callersFirst(evidence: readonly PolicyEvidence[]): PolicyEvidence[] {
  const callees = evidence.map((item) =>
    procedureSection(item.text, POLICY_PROCEDURE_CALLEES_HEADING),
  );
  const isCalledBySelected = (item: PolicyEvidence, index: number): boolean => {
    const summary = procedureSummary(item);
    return (
      summary.length >= 4 &&
      callees.some(
        (section, other) => other !== index && section.includes(summary),
      )
    );
  };
  const ranked = evidence.map((item, index) => ({
    item,
    index,
    called: isCalledBySelected(item, index),
  }));
  return ranked
    .sort(
      (left, right) =>
        Number(left.called) - Number(right.called) || left.index - right.index,
    )
    .map(({ item }) => item);
}

function procedureSection(text: string, heading: string): string {
  const start = text.indexOf(`[${heading}]`);
  if (start < 0) {
    return '';
  }
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(/^\[[^\]\n]+\]\s*$/mu);
  return next < 0 ? rest : rest.slice(0, next);
}

/** 정책 안내 문장에서 "<주제> 정책:" 머리를 뗀 앞부분. 다른 행의 [이어지는 처리] 줄과 견줄 때 쓴다 */
function procedureSummary(item: PolicyEvidence): string {
  return procedureStatementSummary(item.text);
}

/** 정책 행 글의 정책 안내 첫 줄에서 "<주제> 정책:" 머리를 뗀 앞 40 자. 다른 행의 앞뒤 흐름 줄이 이 행을 가리키는지 볼 때 쓴다 */
export function procedureStatementSummary(text: string): string {
  const statement =
    procedureSection(text, '정책 안내').trim().split('\n')[0] ?? '';
  return statement
    .replace(/^[^:]{1,40}정책:\s*/u, '')
    .replace(/[.。]+$/u, '')
    .slice(0, 40)
    .trim();
}

/** 정책 행의 [나중에 이어지는 처리] 섹션. 이 행이 남긴 값을 나중에 읽는 배치를 적는다 */
export function deferredProcedureSection(text: string): string {
  return procedureSection(text, POLICY_PROCEDURE_DEFERRED_HEADING);
}

/**
 * 고른 절차 근거에 [나중에 이어지는 처리] 가 가리키는 배치 행을 붙이고 시간 순서로 다시 놓는다
 * - 요청 때 바로 도는 행을 앞에, 나중에 도는 배치 행을 뒤에 둔다. 배치 진입 행(처리 순서가 있는 행)이 배치의 조회 행보다 먼저다
 * - 이미 고른 행 중 배치와 같은 정책 묶음의 행은 배치의 하위 단계라 배치 행 뒤로 보낸다
 * 배치의 하위 단계 행이 요청 처리 행보다 앞에 오면 답변 모델이 나중에 도는 처리를 요청 즉시 처리처럼 답한다
 */
export function withDeferredProcedureEvidence(
  selected: readonly PolicyEvidence[],
  linked: readonly PolicyEvidence[],
): PolicyEvidence[] {
  const selectedIds = new Set(selected.map((item) => item.chunkId));
  const linkerGroups = new Set(
    selected
      .filter((item) => deferredProcedureSection(item.text).trim())
      .map((item) => item.policyGroup),
  );
  const added = linked
    .filter((item) => !selectedIds.has(item.chunkId))
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        Number(hasProcedureSteps(right.item)) -
          Number(hasProcedureSteps(left.item)) || left.index - right.index,
    )
    .map(({ item }) => item);
  const deferredGroups = new Set(
    linked
      .map((item) => item.policyGroup)
      .filter(
        (group): group is string => Boolean(group) && !linkerGroups.has(group),
      ),
  );
  if (added.length === 0 && deferredGroups.size === 0) {
    return [...selected];
  }
  const isDeferred = (item: PolicyEvidence): boolean =>
    item.policyGroup !== undefined && deferredGroups.has(item.policyGroup);
  const linkedIds = new Set(linked.map((item) => item.chunkId));
  const linkedSelected = linked.filter((item) => selectedIds.has(item.chunkId));
  return [
    ...selected.filter(
      (item) => !isDeferred(item) && !linkedIds.has(item.chunkId),
    ),
    ...[...linkedSelected, ...added].sort(
      (left, right) =>
        Number(hasProcedureSteps(right)) - Number(hasProcedureSteps(left)),
    ),
    ...selected.filter(
      (item) => isDeferred(item) && !linkedIds.has(item.chunkId),
    ),
  ];
}

/** 처리 순서 섹션이 있는 절차 근거인지. 실행 흐름 질문에서 고를 수 있는 정책 행이다 */
export function hasProcedureSteps(evidence: PolicyEvidence): boolean {
  return evidence.text.includes(`[${POLICY_PROCEDURE_STEPS_HEADING}]`);
}

/**
 * 노출, 한도, 이용 자격 질문의 근거 묶음 앞자리를 채울 정책 근거를 고른다
 * 기준 근거(anchor) 를 먼저 두고, 남은 자리는 검색 순서대로 질문 낱말을 하나라도 덮는 high claim 근거로 채운다
 */
export function selectPolicyFirstEvidence(
  question: string,
  evidence: readonly PolicyEvidence[],
  limit = POLICY_FIRST_EVIDENCE_SLOT_LIMIT,
  vocabulary: Vocabulary = DEFAULT_KOREAN_VOCABULARY,
): PolicyEvidence[] {
  const groups = questionAnchorGroups(question, vocabulary);
  if (groups.length === 0 || limit <= 0) {
    return [];
  }
  const anchors = selectAnchorPolicyEvidence(
    question,
    evidence,
    ANCHOR_POLICY_EVIDENCE_SLOT_LIMIT,
    vocabulary,
  );
  const anchorIds = new Set(anchors.map((item) => item.chunkId));
  const supporting = scoreQuestionCoverage(groups, evidence, vocabulary)
    .filter(
      ({ item, matched }) =>
        !anchorIds.has(item.chunkId) &&
        matched >= POLICY_FIRST_EVIDENCE_MIN_MATCHED_TERMS,
    )
    .map(({ item }) => item);
  return [...anchors, ...supporting].slice(0, limit);
}

function compareCoverage(
  left: QuestionCoverage,
  right: QuestionCoverage,
): number {
  return (
    right.coverage - left.coverage ||
    right.subjectMatched - left.subjectMatched ||
    left.index - right.index
  );
}

function scoreQuestionCoverage(
  groups: readonly string[][],
  evidence: readonly PolicyEvidence[],
  vocabulary: Vocabulary,
): QuestionCoverage[] {
  return evidence.map((item, index) => {
    const claimTokens = highConfidenceClaimTokens(item, vocabulary);
    const subjectTokens = highConfidenceSubjectTokens(item, vocabulary);
    const matched = countMatchedGroups(groups, claimTokens);
    return {
      item,
      index,
      matched,
      coverage: matched / groups.length,
      subjectMatched: countMatchedGroups(groups, subjectTokens),
    };
  });
}

function countMatchedGroups(
  groups: readonly string[][],
  tokens: readonly string[],
): number {
  return groups.filter((group) =>
    group.some((term) => tokens.some((token) => termMatches(term, token))),
  ).length;
}

function highConfidenceClaims(evidence: PolicyEvidence): PolicyClaimProps[] {
  return (evidence.policyClaims ?? []).filter(
    (claim) => claim.confidence === 'high',
  );
}

function highConfidenceClaimTokens(
  evidence: PolicyEvidence,
  vocabulary: Vocabulary,
): string[] {
  const text = highConfidenceClaims(evidence)
    .flatMap((claim) => [
      claim.subject,
      claim.statement,
      ...(claim.searchAliases ?? []),
      ...(claim.userQuestionExamples ?? []),
    ])
    .filter(Boolean)
    .join(' ');
  return text ? tokenizePolicySearchText(text, vocabulary) : [];
}

/** claim 주제와 기능 이름(section) 은 그 행이 무엇에 관한 것인지 말하므로 본문에서 다른 기능을 언급한 행과 가른다 */
function highConfidenceSubjectTokens(
  evidence: PolicyEvidence,
  vocabulary: Vocabulary,
): string[] {
  const claims = highConfidenceClaims(evidence);
  if (claims.length === 0) {
    return [];
  }
  const text = [evidence.section, ...claims.map((claim) => claim.subject)]
    .filter(Boolean)
    .join(' ');
  return text ? tokenizePolicySearchText(text, vocabulary) : [];
}

/** 세 글자 이상 한글 낱말은 앞 두 글자 어간으로 비교해 `가입한` 과 `가입하면` 을 같은 낱말로 본다 */
function termMatches(term: string, token: string): boolean {
  if (term === token) {
    return true;
  }
  const characters = Array.from(term);
  if (!/^[가-힣]/u.test(term)) {
    return false;
  }
  const stem = characters.length >= 3 ? characters.slice(0, 2).join('') : term;
  return token.startsWith(stem);
}
