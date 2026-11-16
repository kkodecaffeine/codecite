import type { PolicyClaimFacet, PolicyClaimProps } from '../domain/types.js';
import {
  selectAnchorPolicyEvidence,
  selectPolicyFirstEvidence,
} from '../retrieval/anchor-evidence.js';
import { POLICY_GROUP_SUMMARY_CLAIM_ID_PREFIX } from '../retrieval/constants.js';
import {
  isUserActionEligibilityQuestion,
  mentionsNumericFigure,
  policyRetrievalScopeForQuery,
  preferredPolicyClaimFacets,
} from '../retrieval/query-intent.js';
import { tokenizePolicySearchText } from '../text/tokenizer.js';
import type { Vocabulary } from '../text/types.js';
import { DEFAULT_KOREAN_VOCABULARY } from '../text/vocabulary.js';
import {
  BACKGROUND_UNIT_PATTERN,
  COMPLETED_SENTENCE_PATTERN,
  DEFAULT_POLICY_CONTEXT_PACKING_OPTIONS,
  EVIDENCE_BODY_HEADING_PATTERN,
  EVIDENCE_HEADING_PATTERNS,
  INTERNAL_SOURCE_LINE_PATTERN,
  POLICY_EVIDENCE_SEPARATOR,
  POLICY_FIRST_QUESTION_PATTERN,
  POLICY_UNIT_PATTERN,
  WHOLE_LINE_UNIT_PATTERNS,
} from './constants.js';
import { serializePolicyEvidence } from './evidence.js';
import type {
  AnswerEvidencePackingOptions,
  EvidenceSlotOptions,
  ExtractivePolicyUnit,
  PackedPolicyContext,
  PolicyContextPackingOptions,
  PolicyEvidence,
} from './types.js';

/**
 * 근거 묶기 진입점. 검색 순서로 받은 근거의 자리 순서를 정한 뒤 개수·글자 수 한도 안에서 묶는다
 * 기준 근거와 정책 우선 근거가 앞자리를 먼저 받고, 남은 자리는 한 묶음이 독점하지 않게 검색 순서대로 채운다
 */
export function packAnswerEvidence(
  question: string,
  ranked: readonly PolicyEvidence[],
  options: AnswerEvidencePackingOptions = {},
): PackedPolicyContext {
  const limits = normalizeOptions(options);
  const ordered = orderEvidenceSlots(question, ranked, {
    ...options,
    maxItems: limits.maxItems,
  });
  return packPolicyContext(question, ordered, limits, options.vocabulary);
}

/**
 * 근거 자리 순서를 정한다
 * 1. 기준 근거(anchor). 노출·한도·자격·시점처럼 정책 문장이 바로 답하는 질문이면 정책 우선 근거까지
 * 2. 남은 자리는 검색 순서대로 채우되, 한 정책 묶음이나 한 조각 종류는 상한까지만 먼저 받는다
 * 3. 상한에 걸려 밀린 근거는 그 뒤에 검색 순서대로 둔다. 다른 근거가 없으면 결국 남은 자리를 채운다
 */
export function orderEvidenceSlots(
  question: string,
  ranked: readonly PolicyEvidence[],
  options: EvidenceSlotOptions & { maxItems?: number } = {},
): PolicyEvidence[] {
  const vocabulary = options.vocabulary ?? DEFAULT_KOREAN_VOCABULARY;
  const unique = deduplicateEvidence(ranked);
  const leading = isPolicyFirstQuestion(question)
    ? selectPolicyFirstEvidence(question, unique, undefined, vocabulary)
    : selectAnchorPolicyEvidence(question, unique, undefined, vocabulary);
  const leadingIds = new Set(leading.map((item) => item.chunkId));
  const rest = unique.filter((item) => !leadingIds.has(item.chunkId));

  const maxItems = positiveInteger(
    options.maxItems,
    DEFAULT_POLICY_CONTEXT_PACKING_OPTIONS.maxItems,
  );
  // 후보가 한 묶음·한 종류뿐이면 상한을 걸 까닭이 없다. 걸면 다른 기준의 상한과 엉켜 자리만 비운다
  const groupLimit = hasSeveral(unique, groupKey)
    ? positiveInteger(options.maxItemsPerGroup, Math.ceil(maxItems / 2))
    : Number.POSITIVE_INFINITY;
  const kindLimit = hasSeveral(unique, kindKey)
    ? positiveInteger(options.maxItemsPerKind, Math.max(1, maxItems - 1))
    : Number.POSITIVE_INFINITY;
  const groupCounts = new Map<string, number>();
  const kindCounts = new Map<string, number>();
  const count = (item: PolicyEvidence) => {
    increment(groupCounts, groupKey(item));
    increment(kindCounts, kindKey(item));
  };
  leading.forEach(count);

  const picked = new Set<PolicyEvidence>();
  for (const item of rest) {
    if (leading.length + picked.size >= maxItems) {
      break;
    }
    if (
      (groupCounts.get(groupKey(item)) ?? 0) >= groupLimit ||
      (kindCounts.get(kindKey(item)) ?? 0) >= kindLimit
    ) {
      continue;
    }
    picked.add(item);
    count(item);
  }
  return [
    ...leading,
    ...rest.filter((item) => picked.has(item)),
    ...rest.filter((item) => !picked.has(item)),
  ];
}

/**
 * 받은 순서대로 근거를 개수·글자 수 한도 안에 묶는다
 * high claim 은 자르지 않고 통째로 넣거나 뺀다. 남은 글자 수로만 설명 글을 완결 단위로 줄여 붙인다
 */
export function packPolicyContext(
  query: string,
  evidence: readonly PolicyEvidence[],
  options: Partial<PolicyContextPackingOptions> = {},
  vocabulary: Vocabulary = DEFAULT_KOREAN_VOCABULARY,
): PackedPolicyContext {
  const limits = normalizeOptions(options);
  const uniqueEvidence = deduplicateEvidence(evidence);
  const packed: PolicyEvidence[] = [];
  let totalChars = 0;
  let omittedItemCount = 0;

  for (const item of uniqueEvidence) {
    if (
      packed.length >= limits.maxItems ||
      totalChars >= limits.maxTotalChars
    ) {
      omittedItemCount += 1;
      continue;
    }

    const separatorLength =
      packed.length > 0 ? codePointLength(POLICY_EVIDENCE_SEPARATOR) : 0;
    const available = Math.min(
      limits.maxItemChars,
      limits.maxTotalChars - totalChars - separatorLength,
    );
    const packedItem = packEvidence(query, item, available, vocabulary);
    if (!packedItem) {
      omittedItemCount += 1;
      continue;
    }

    packed.push(withHighConfidenceClaims(packedItem));
    totalChars +=
      separatorLength + codePointLength(serializePolicyEvidence(packedItem));
  }

  const inputClaimIds = highConfidenceClaimIds(uniqueEvidence);
  const packedClaimIds = highConfidenceClaimIds(packed);
  const omittedHighConfidenceClaimIds = [...inputClaimIds].filter(
    (claimId) => !packedClaimIds.has(claimId),
  );
  const oversizedClaimIds = uniqueEvidence.flatMap((item) =>
    highConfidenceClaims(item)
      .filter(
        (claim) =>
          codePointLength(
            serializePolicyEvidence({
              ...item,
              text: '',
              policyClaims: [claim],
            }),
          ) > limits.maxItemChars,
      )
      .map((claim) => claim.claimId),
  );
  return {
    evidence: packed,
    omittedItemCount,
    omittedHighConfidenceClaimCount: omittedHighConfidenceClaimIds.length,
    oversizedClaimCount: oversizedClaimIds.length,
    omittedHighConfidenceClaimIds,
    oversizedClaimIds,
  };
}

/** 정책 문장이 바로 답하는 질문인지. 기술 구현을 묻는 질문은 정책 우선 자리를 주지 않는다 */
function isPolicyFirstQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, ' ').trim();
  if (policyRetrievalScopeForQuery(normalized).intent === 'technical') {
    return false;
  }
  return (
    POLICY_FIRST_QUESTION_PATTERN.test(normalized) ||
    mentionsNumericFigure(normalized) ||
    isUserActionEligibilityQuestion(normalized)
  );
}

function groupKey(item: PolicyEvidence): string {
  return item.policyGroup || item.policyCode;
}

function kindKey(item: PolicyEvidence): string {
  return item.contextKind ?? 'policy';
}

function hasSeveral(
  evidence: readonly PolicyEvidence[],
  key: (item: PolicyEvidence) => string,
): boolean {
  return new Set(evidence.map(key)).size > 1;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function highConfidenceClaims(evidence: PolicyEvidence): PolicyClaimProps[] {
  return (evidence.policyClaims ?? []).filter(
    (claim) => claim.confidence === 'high',
  );
}

function highConfidenceClaimIds(
  evidence: readonly PolicyEvidence[],
): Set<string> {
  return new Set(
    evidence.flatMap((item) =>
      highConfidenceClaims(item).map((claim) => claim.claimId),
    ),
  );
}

/** 묶인 근거에는 high claim 만 남긴다. low claim 은 답의 근거로 쓰지 않는다 */
function withHighConfidenceClaims(evidence: PolicyEvidence): PolicyEvidence {
  return evidence.policyClaims
    ? { ...evidence, policyClaims: highConfidenceClaims(evidence) }
    : evidence;
}

/**
 * 근거 하나를 직렬화 글자 수 안에 맞춘다
 * claim 이 있으면 질문이 원하는 종류의 claim 부터 통째로 담고, 남은 글자 수로 설명 글을 줄여 붙인다
 * claim 이 없으면 설명 글을 완결 단위로 줄인다. 어느 쪽도 들어가지 않으면 근거를 뺀다
 */
function packEvidence(
  query: string,
  evidence: PolicyEvidence,
  serializedBudget: number,
  vocabulary: Vocabulary,
): PolicyEvidence | undefined {
  const claims = highConfidenceClaims(evidence);
  if (claims.length > 0) {
    const preferences = preferredPolicyClaimFacets(query);
    const orderedClaims = [...claims].sort(
      (left, right) =>
        claimPriority(right.facet, preferences.primary, preferences.secondary) -
        claimPriority(left.facet, preferences.primary, preferences.secondary),
    );
    const selectedClaims: PolicyClaimProps[] = [];
    for (const claim of orderedClaims) {
      const candidate = {
        ...evidence,
        text: '',
        policyClaims: [...selectedClaims, claim],
      };
      if (
        codePointLength(serializePolicyEvidence(candidate)) <= serializedBudget
      ) {
        selectedClaims.push(claim);
        continue;
      }
      const compacted = compactGroupSummaryClaim(
        query,
        evidence,
        selectedClaims,
        claim,
        serializedBudget,
        vocabulary,
      );
      if (compacted) {
        selectedClaims.push(compacted);
      }
    }
    if (selectedClaims.length === 0) {
      return undefined;
    }

    const claimOnly = { ...evidence, text: '', policyClaims: selectedClaims };
    const textBudget =
      serializedBudget - codePointLength(serializePolicyEvidence(claimOnly));
    const text =
      textBudget > 0 && !isClaimDerivedEvidence(evidence, selectedClaims)
        ? packEvidenceText(query, evidence.text, textBudget, vocabulary)
        : '';
    const packed = { ...evidence, text, policyClaims: selectedClaims };
    return codePointLength(serializePolicyEvidence(packed)) <= serializedBudget
      ? packed
      : claimOnly;
  }

  let textBudget =
    serializedBudget -
    codePointLength(serializePolicyEvidence({ ...evidence, text: '' }));
  while (textBudget > 0) {
    const text = packEvidenceText(query, evidence.text, textBudget, vocabulary);
    if (!text) {
      return undefined;
    }
    const packed = { ...evidence, text };
    const serializedLength = codePointLength(serializePolicyEvidence(packed));
    if (serializedLength <= serializedBudget) {
      return packed;
    }
    // 이스케이프로 늘어난 만큼 글 예산을 줄여 다시 고른다
    textBudget -= serializedLength - serializedBudget;
  }
  return undefined;
}

/** claim 하나나 묶음 요약 claim 에서 만든 근거는 설명 글이 claim 문장과 겹쳐 다시 붙이지 않는다 */
function isClaimDerivedEvidence(
  evidence: PolicyEvidence,
  claims: readonly PolicyClaimProps[],
): boolean {
  return (
    claims.length === 1 &&
    (evidence.chunkId === claims[0].claimId ||
      claims[0].claimId.startsWith(POLICY_GROUP_SUMMARY_CLAIM_ID_PREFIX))
  );
}

/**
 * 묶음 요약 claim 은 묶음 전체를 여러 문장으로 담아 길다. 한도를 넘으면 버리지 않고 질문에 맞는 완결 문장만 남겨 줄인다
 * 다른 claim 은 줄이지 않는다. 줄인 요약은 값을 줄인 문장으로 바꾸고 조건·예외를 비워 문장과 어긋나지 않게 한다
 */
function compactGroupSummaryClaim(
  query: string,
  evidence: PolicyEvidence,
  selectedClaims: readonly PolicyClaimProps[],
  claim: PolicyClaimProps,
  serializedBudget: number,
  vocabulary: Vocabulary,
): PolicyClaimProps | undefined {
  if (!claim.claimId.startsWith(POLICY_GROUP_SUMMARY_CLAIM_ID_PREFIX)) {
    return undefined;
  }
  let statementBudget = serializedBudget;
  while (statementBudget > 0) {
    const statement = packWholeUnits(
      query,
      completedSentences(claim.statement),
      statementBudget,
      vocabulary,
    );
    if (!statement) {
      return undefined;
    }
    const compacted: PolicyClaimProps = {
      ...claim,
      statement,
      ...(claim.schemaVersion === 2
        ? { value: statement, conditions: [], exceptions: [] }
        : {}),
    };
    const serializedLength = codePointLength(
      serializePolicyEvidence({
        ...evidence,
        text: '',
        policyClaims: [...selectedClaims, compacted],
      }),
    );
    if (serializedLength <= serializedBudget) {
      return compacted;
    }
    statementBudget -= serializedLength - serializedBudget;
  }
  return undefined;
}

function claimPriority(
  facet: PolicyClaimFacet,
  primary: readonly PolicyClaimFacet[],
  secondary: readonly PolicyClaimFacet[],
): number {
  if (primary.includes(facet)) {
    return 2;
  }
  if (secondary.includes(facet)) {
    return 1;
  }
  return 0;
}

function packEvidenceText(
  query: string,
  text: string,
  budget: number,
  vocabulary: Vocabulary,
): string {
  return packWholeUnits(query, extractWholeUnits(text), budget, vocabulary);
}

/**
 * 완결 단위를 질문 낱말을 많이 덮는 것, 정책·조건·예외 단위, 원래 순서 순으로 골라 예산 안에 담는다
 * 고른 단위는 원래 순서로 되돌려 잇는다. 단위 하나를 중간에서 자르지 않는다
 */
function packWholeUnits(
  query: string,
  wholeUnits: readonly string[],
  budget: number,
  vocabulary: Vocabulary,
): string {
  const queryTerms = tokenizePolicySearchText(query, vocabulary);
  const units = wholeUnits
    .map((unit, index): ExtractivePolicyUnit => ({
      text: unit,
      index,
      relevance: overlapScore(unit, queryTerms),
      policyPriority: policyPriority(unit),
    }))
    .sort(
      (left, right) =>
        right.relevance - left.relevance ||
        right.policyPriority - left.policyPriority ||
        left.index - right.index,
    );
  const selected: ExtractivePolicyUnit[] = [];
  let used = 0;
  for (const unit of units) {
    const separatorLength = selected.length > 0 ? 1 : 0;
    const unitLength = codePointLength(unit.text);
    if (used + separatorLength + unitLength > budget) {
      continue;
    }
    selected.push(unit);
    used += separatorLength + unitLength;
  }
  return selected
    .sort((left, right) => left.index - right.index)
    .map((unit) => unit.text)
    .join('\n');
}

function extractWholeUnits(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .flatMap((paragraph) => splitParagraph(paragraph.trim()))
    .map((unit) => unit.trim())
    .filter(Boolean);
}

/** 섹션 머리, 목록 줄, 완결된 줄은 통째로 두고, 나머지 줄은 완결 문장으로 나눈다. 미완성 꼬리는 버린다 */
function splitParagraph(paragraph: string): string[] {
  const lines = paragraph
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) => Boolean(line) && !INTERNAL_SOURCE_LINE_PATTERN.test(line),
    );
  return lines.flatMap((line, index) => {
    if (
      EVIDENCE_HEADING_PATTERNS.some((pattern) => pattern.test(line)) ||
      WHOLE_LINE_UNIT_PATTERNS.some((pattern) => pattern.test(line)) ||
      EVIDENCE_BODY_HEADING_PATTERN.test(lines[index - 1] ?? '')
    ) {
      return [line];
    }
    return completedSentences(line);
  });
}

function completedSentences(value: string): string[] {
  return (
    value.match(COMPLETED_SENTENCE_PATTERN)?.map((item) => item.trim()) ?? []
  );
}

function overlapScore(value: string, queryTerms: readonly string[]): number {
  const normalized = value.toLowerCase();
  return queryTerms.reduce(
    (score, term) => score + (normalized.includes(term) ? 1 : 0),
    0,
  );
}

function policyPriority(value: string): number {
  if (POLICY_UNIT_PATTERN.test(value)) {
    return 2;
  }
  if (BACKGROUND_UNIT_PATTERN.test(value)) {
    return 0;
  }
  return 1;
}

function deduplicateEvidence(
  evidence: readonly PolicyEvidence[],
): PolicyEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    if (seen.has(item.chunkId)) {
      return false;
    }
    seen.add(item.chunkId);
    return true;
  });
}

function normalizeOptions(
  options: Partial<PolicyContextPackingOptions>,
): PolicyContextPackingOptions {
  return {
    maxTotalChars: positiveInteger(
      options.maxTotalChars,
      DEFAULT_POLICY_CONTEXT_PACKING_OPTIONS.maxTotalChars,
    ),
    maxItemChars: positiveInteger(
      options.maxItemChars,
      DEFAULT_POLICY_CONTEXT_PACKING_OPTIONS.maxItemChars,
    ),
    maxItems: positiveInteger(
      options.maxItems,
      DEFAULT_POLICY_CONTEXT_PACKING_OPTIONS.maxItems,
    ),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : fallback;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}
