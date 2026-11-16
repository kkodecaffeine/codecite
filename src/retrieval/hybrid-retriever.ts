import { projectPolicyChunks } from '../domain/chunk-projector.js';
import { POLICY_PROCEDURE_STEPS_HEADING } from '../domain/constants.js';
import type { PolicyChunk } from '../domain/policy-chunk.js';
import type { PolicyClaimProps, PolicyContextKind } from '../domain/types.js';
import type { Embedder, Logger, PolicySource, VectorIndex } from '../ports.js';
import {
  tokenizePolicySearchQuery,
  tokenizePolicySearchText,
} from '../text/tokenizer.js';
import type { Vocabulary } from '../text/types.js';
import { DEFAULT_KOREAN_VOCABULARY } from '../text/vocabulary.js';
import { procedureStatementSummary } from './anchor-evidence.js';
import {
  CONCRETE_TIMING_PATTERN,
  COVERAGE_GENERIC_QUERY_TOKENS,
  DEFAULT_RETRIEVAL_OPTIONS,
  DEFERRED_LINK_MIN_SUMMARY_CHARS,
  GENERIC_DOMAIN_OVERVIEW_QUERY_PATTERN,
  POLICY_COVERAGE_PROTECTED_LEXICAL_RANK,
  POLICY_GROUP_SUMMARY_CLAIM_ID_PREFIX,
  PROCEDURE_DEFERRED_EVIDENCE_LIMIT,
  PROCEDURE_POLICY_LEXICAL_CANDIDATE_LIMIT,
  TIMING_ACTION_PATTERN,
  TIMING_QUESTION_PATTERN,
} from './constants.js';
import { prioritizePolicyEvidenceCandidates } from './evidence-prioritizer.js';
import {
  isPolicyDomainOverviewQuery,
  policyRetrievalScopeForQuery,
  preferredPolicyClaimFacets,
} from './query-intent.js';
import { fusePolicyRankings } from './rrf.js';
import { rankPolicyChunksByScope } from './scoped-ranker.js';
import type {
  HybridRetrievalResult,
  HybridRetrieverOptions,
  PolicyCoverageMode,
  PolicyRetrievalCandidate,
  PreferredPolicyClaimFacets,
  RetrievalOptions,
} from './types.js';

/** 사전마다 한 번 만드는 낱말 집합. 사전 객체는 쓰는 동안 바꾸지 않는다고 본다 */
const genericQueryTokenSets = new WeakMap<Vocabulary, ReadonlySet<string>>();
const coverageGenericTokenSets = new WeakMap<Vocabulary, ReadonlySet<string>>();

/** 정책 소스에서 활성 정책만 골라 검색 조각으로 나눈다. 벡터 색인과 검색기가 같은 조각을 쓰게 한다 */
export async function loadActivePolicyChunks(
  source: PolicySource,
): Promise<PolicyChunk[]> {
  const policies = await source.loadPolicies();
  return policies
    .filter((policy) => policy.isActive())
    .flatMap((policy) => projectPolicyChunks(policy));
}

/**
 * dense 검색과 BM25 를 따로 돌려 순위로 합치고(RRF), 질문 낱말을 가장 많이 덮는 정책 묶음 안에서 후보를 고른다
 * 임베더나 벡터 색인이 없거나 dense 검색이 실패하면 BM25 만으로 돌고, 결과의 mode 가 bm25 가 된다
 */
export class HybridPolicyRetriever {
  private readonly chunks: PolicyChunk[];
  private readonly chunkById: ReadonlyMap<string, PolicyChunk>;
  private readonly embedder?: Embedder;
  private readonly index?: VectorIndex;
  private readonly vocabulary: Vocabulary;
  private readonly logger?: Logger;
  private procedureChunks?: PolicyChunk[];
  private statementSummaries?: Array<{ chunk: PolicyChunk; summary: string }>;

  constructor(options: HybridRetrieverOptions) {
    // BM25 역색인은 배열 객체마다 한 번 만들어지므로 검색기가 쓰는 배열은 처음 복사한 것 하나로 고정한다
    this.chunks = [...options.chunks];
    this.chunkById = new Map(this.chunks.map((chunk) => [chunk.id, chunk]));
    this.embedder = options.embedder;
    this.index = options.index;
    this.vocabulary = options.vocabulary ?? DEFAULT_KOREAN_VOCABULARY;
    this.logger = options.logger;
  }

  /** dense 와 BM25 를 독립으로 돌려 합친 뒤, 묶음 범위와 claim 덮개로 후보를 고른다 */
  async retrieve(
    query: string,
    options: RetrievalOptions = DEFAULT_RETRIEVAL_OPTIONS,
  ): Promise<HybridRetrievalResult> {
    const startedAt = Date.now();
    const limits = normalizeOptions(options);
    const scope = policyRetrievalScopeForQuery(query);
    // 질문 임베딩 요청을 먼저 보내 두고, 응답을 기다리는 동안 BM25 를 돈다
    const dense = this.searchDense(
      query,
      limits.denseLimit,
      scope.contextKinds,
    );
    const scopedLexicalRanking = filterLexicallyRelevantCandidates(
      query,
      rankPolicyChunksByScope(
        query,
        this.chunks,
        scope.contextKinds,
        limits.lexicalLimit,
        this.vocabulary,
      ),
      this.vocabulary,
    );
    const denseOutcome = await dense;
    const denseRanking = hydrateDenseRanking(
      denseOutcome?.ranking ?? [],
      this.chunkById,
      new Set(scope.contextKinds),
    );
    // 정책 질문에 맞는 정책 조각이 하나도 없으면 기술 조각에서라도 찾는다
    const lexicalRanking =
      scope.intent === 'policy' &&
      denseRanking.length === 0 &&
      scopedLexicalRanking.length === 0
        ? rankPolicyChunksByScope(
            query,
            this.chunks,
            ['technical'],
            limits.lexicalLimit,
            this.vocabulary,
          )
        : scopedLexicalRanking;

    const candidatePoolLimit = Math.max(
      limits.denseLimit,
      limits.lexicalLimit,
      limits.fusedLimit,
    );
    const fused = fusePolicyRankings(
      denseRanking,
      lexicalRanking,
      candidatePoolLimit,
    );
    const expanded =
      scope.coverageMode !== 'focused'
        ? expandSamePolicyGroupCandidates(
            query,
            fused,
            this.chunks,
            new Set(scope.contextKinds),
            candidatePoolLimit + limits.fusedLimit,
            this.vocabulary,
          )
        : fused;
    const prioritized =
      scope.intent === 'policy'
        ? prioritizePolicyEvidenceCandidates(query, expanded, this.vocabulary)
        : expanded;
    const candidates = selectCoverageCandidates(
      query,
      prioritized,
      scope.coverageMode,
      this.vocabulary,
    ).slice(0, limits.fusedLimit);
    const mode = denseOutcome && !denseOutcome.error ? 'hybrid' : 'bm25';
    this.logger?.debug('policy retrieval completed', {
      intent: scope.intent,
      coverage: scope.coverageMode,
      mode,
      dense: denseRanking.length,
      lexical: lexicalRanking.length,
      candidates: candidates.length,
      elapsedMs: Date.now() - startedAt,
    });
    return denseOutcome?.error
      ? { candidates, mode, denseError: denseOutcome.error }
      : { candidates, mode };
  }

  /**
   * 질문 낱말만으로 조각을 BM25 순위로 고른다. dense 검색과 융합을 거치지 않는다
   * 기본 검색 후보에 기준 근거(anchor) 가 없을 때 사용자가 부른 이름이 그대로 적힌 행을 다시 찾으려는 것이다
   * 기본 검색이 질문과 무관하다고 거른 행을 다시 들이지 않도록 lexical 관련성과 묶음 범위는 기본 검색과 같이 적용한다
   */
  retrieveLexical(
    question: string,
    limit: number = DEFAULT_RETRIEVAL_OPTIONS.lexicalLimit,
  ): PolicyRetrievalCandidate[] {
    const scope = policyRetrievalScopeForQuery(question);
    const normalizedLimit = positiveInteger(limit);
    const ranked = filterLexicallyRelevantCandidates(
      question,
      rankPolicyChunksByScope(
        question,
        this.chunks,
        scope.contextKinds,
        normalizedLimit,
        this.vocabulary,
      ),
      this.vocabulary,
    ).map(lexicalCandidate);
    const prioritized =
      scope.intent === 'policy'
        ? prioritizePolicyEvidenceCandidates(question, ranked, this.vocabulary)
        : ranked;
    return selectCoverageCandidates(
      question,
      prioritized,
      scope.coverageMode,
      this.vocabulary,
    ).slice(0, normalizedLimit);
  }

  /**
   * 처리 순서 섹션이 있는 절차 행만 놓고 질문 낱말로 BM25 순위를 매긴다
   * 실행 흐름 질문은 일반 정책 행을 쓰지 않으므로, 전체 조각에서 상위만 자르면 절차 행이 다른 행에 밀려 후보에 들지 못한다
   */
  retrieveProcedureLexical(
    question: string,
    limit: number = PROCEDURE_POLICY_LEXICAL_CANDIDATE_LIMIT,
  ): PolicyRetrievalCandidate[] {
    this.procedureChunks ??= this.chunks.filter((chunk) =>
      chunk.text.includes(`[${POLICY_PROCEDURE_STEPS_HEADING}]`),
    );
    return filterLexicallyRelevantCandidates(
      question,
      rankPolicyChunksByScope(
        question,
        this.procedureChunks,
        ['policy'],
        positiveInteger(limit),
        this.vocabulary,
      ),
      this.vocabulary,
    ).map(lexicalCandidate);
  }

  /**
   * 절차 행의 [나중에 이어지는 처리] 섹션이 가리키는 정책 행을 찾는다
   * 섹션 줄은 나중에 도는 작업의 정책 안내를 그대로 옮겨 적으므로, 정책 안내 첫 줄 앞부분이 섹션에 들어 있는 행을 고른다
   * 질문 낱말과 겹치지 않는 예약 작업 행도 흐름 답변에 함께 붙이려는 것이다
   */
  retrieveDeferredProcedureLinks(
    sections: readonly string[],
    limit: number = PROCEDURE_DEFERRED_EVIDENCE_LIMIT,
  ): PolicyRetrievalCandidate[] {
    const texts = sections.map((section) => section.trim()).filter(Boolean);
    if (texts.length === 0 || limit <= 0) {
      return [];
    }
    this.statementSummaries ??= this.chunks
      .filter((chunk) => chunk.contextKind === 'policy')
      .map((chunk) => ({
        chunk,
        summary: procedureStatementSummary(chunk.text),
      }))
      .filter(
        ({ summary }) =>
          Array.from(summary).length >= DEFERRED_LINK_MIN_SUMMARY_CHARS,
      );
    return this.statementSummaries
      .map(({ chunk, summary }) => ({
        chunk,
        position: Math.min(
          ...texts.map((text) => {
            const index = text.indexOf(summary);
            return index < 0 ? Number.MAX_SAFE_INTEGER : index;
          }),
        ),
      }))
      .filter(({ position }) => position < Number.MAX_SAFE_INTEGER)
      .sort((left, right) => left.position - right.position)
      .slice(0, positiveInteger(limit))
      .map(({ chunk }, index) => lexicalCandidate(chunk, index));
  }

  /**
   * 질문을 임베딩해 벡터 색인에서 찾는다. 임베더나 색인이 없으면 undefined 를 돌려준다
   * 실패는 던지지 않고 까닭과 함께 돌려줘, 검색이 BM25 만으로 이어지게 한다
   */
  private async searchDense(
    query: string,
    limit: number,
    contextKinds: readonly PolicyContextKind[],
  ): Promise<{ ranking: PolicyChunk[]; error?: Error } | undefined> {
    if (!this.embedder || !this.index) {
      return undefined;
    }
    try {
      const [vector] = await this.embedder.embed([query]);
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error('Embedder returned no vector for the query.');
      }
      return {
        ranking: await this.index.search(vector, limit, { contextKinds }),
      };
    } catch (error) {
      return { ranking: [], error: toError(error) };
    }
  }
}

/**
 * 질문 낱말(질문 말투 낱말 제외)을 하나도 담지 않은 BM25 후보를 버린다
 * 동의어로만 걸린 후보가 질문 핵심어 없이 남지 않게 한다
 */
function filterLexicallyRelevantCandidates(
  query: string,
  candidates: PolicyChunk[],
  vocabulary: Vocabulary,
): PolicyChunk[] {
  const genericTokens = genericQueryTokens(vocabulary);
  const anchors = tokenizePolicySearchQuery(query, vocabulary).filter(
    (token) => !genericTokens.has(token),
  );
  if (anchors.length === 0) {
    return candidates;
  }
  return candidates.filter((candidate) => {
    const documentTokens = new Set(
      tokenizePolicySearchText(candidate.searchText, vocabulary),
    );
    return anchors.some((anchor) => documentTokens.has(anchor));
  });
}

/**
 * 목록·비교 질문은 이미 고른 후보의 high claim 과 같은 묶음의 형제 행을 더 붙인다
 * 묶음 요약, 질문이 원하는 claim 종류, 질문 낱말을 많이 담은 행 순서로 붙이고, 이름만 비슷한 다른 묶음 행은 붙이지 않는다
 */
function expandSamePolicyGroupCandidates(
  query: string,
  candidates: PolicyRetrievalCandidate[],
  chunks: readonly PolicyChunk[],
  contextKinds: ReadonlySet<PolicyContextKind>,
  limit: number,
  vocabulary: Vocabulary,
): PolicyRetrievalCandidate[] {
  if (candidates.length >= limit) {
    return candidates;
  }
  const expanded = [...candidates];
  const selectedIds = new Set(
    candidates.map((candidate) => candidate.chunk.id),
  );
  const anchorGroups = new Set(
    candidates
      .flatMap((candidate) =>
        highConfidenceClaims(candidate.chunk).map((claim) => claim.policyGroup),
      )
      .filter((group): group is string => Boolean(group)),
  );
  if (anchorGroups.size === 0) {
    return candidates;
  }

  const preferredFacets = preferredPolicyClaimFacets(query);
  const queryAnchors = tokenizePolicySearchQuery(query, vocabulary);
  const siblings = chunks
    .map((chunk, index) => ({ chunk, index }))
    .filter(
      ({ chunk }) =>
        !selectedIds.has(chunk.id) &&
        contextKinds.has(chunk.contextKind) &&
        highConfidenceClaims(chunk).some(
          (claim) =>
            claim.policyGroup !== undefined &&
            anchorGroups.has(claim.policyGroup),
        ),
    )
    .map(({ chunk, index }) => ({
      chunk,
      index,
      summary: isPolicyGroupSummary(chunk),
      facetPriority: siblingFacetPriority(chunk, preferredFacets),
      affinity: queryAffinity(queryAnchors, chunk, vocabulary),
    }))
    .sort(
      (left, right) =>
        Number(right.summary) - Number(left.summary) ||
        right.facetPriority - left.facetPriority ||
        right.affinity - left.affinity ||
        left.index - right.index,
    );

  for (const { chunk } of siblings) {
    if (expanded.length >= limit) {
      break;
    }
    expanded.push({ chunk, fusedScore: 0 });
    selectedIds.add(chunk.id);
  }
  return expanded;
}

function isPolicyGroupSummary(chunk: PolicyChunk): boolean {
  return highConfidenceClaims(chunk).some((claim) =>
    claim.claimId.startsWith(POLICY_GROUP_SUMMARY_CLAIM_ID_PREFIX),
  );
}

function siblingFacetPriority(
  chunk: PolicyChunk,
  preferredFacets: PreferredPolicyClaimFacets,
): number {
  const facets = highConfidenceClaims(chunk).map((claim) => claim.facet);
  if (facets.some((facet) => preferredFacets.primary.includes(facet))) {
    return 2;
  }
  if (facets.some((facet) => preferredFacets.secondary.includes(facet))) {
    return 1;
  }
  return 0;
}

/**
 * 질문 낱말을 가장 많이 덮는 정책 묶음 안의 후보만 남기고, 새 claim 과 질문이 원하는 종류를 더 많이 보태는 후보부터 줄 세운다
 * 질문이 묶음 이름이나 별칭(vocabulary.groupAliases) 을 직접 부르면 그 묶음만 남긴다
 */
function selectCoverageCandidates(
  query: string,
  candidates: PolicyRetrievalCandidate[],
  coverageMode: PolicyCoverageMode,
  vocabulary: Vocabulary,
): PolicyRetrievalCandidate[] {
  const preferredFacets = preferredPolicyClaimFacets(query);
  const queryAnchors = coverageQueryAnchors(query, vocabulary);
  const domainOverview = isPolicyDomainOverviewQuery(query);
  const denseOverviewGroup = domainOverview
    ? candidates.find(
        (candidate) =>
          candidate.denseRank === 1 &&
          queryAnchorFrequencyAffinity(
            queryAnchors,
            candidate.chunk,
            vocabulary,
          ) > 0,
      )?.chunk.policyGroup
    : undefined;
  const explicitGroups = explicitPolicyGroups(query, vocabulary);
  const relevantPolicyGroups = relevantCoveragePolicyGroups(
    candidates,
    coverageMode,
    queryAnchors,
    domainOverview,
    explicitGroups,
    vocabulary,
  );
  const inRelevantScope = (candidate: PolicyRetrievalCandidate): boolean => {
    const claims = highConfidenceClaims(candidate.chunk);
    if (claims.length === 0) {
      return (
        !domainOverview ||
        queryAnchorFrequencyAffinity(
          queryAnchors,
          candidate.chunk,
          vocabulary,
        ) > 0 ||
        (Boolean(denseOverviewGroup) &&
          candidate.chunk.policyGroup === denseOverviewGroup &&
          candidate.denseRank !== undefined &&
          candidate.denseRank <= 2)
      );
    }
    return claims.some((claim) =>
      relevantPolicyGroups.has(
        effectivePolicyGroup(claim.policyGroup, candidate.chunk.policyGroup),
      ),
    );
  };
  // 질문이 묶음을 직접 불렀으면 그 묶음만 남긴다. 아니면 BM25 상위 후보가 다른 후보에 없는 질문 낱말을 담았을 때 지킨다
  const scopedCandidates =
    explicitGroups.size > 0
      ? candidates.filter(inRelevantScope)
      : keepUniquelyCoveringLexicalCandidates(
          queryAnchors,
          candidates,
          inRelevantScope,
          vocabulary,
        );

  // 고른 claim 에 따라 바뀌지 않는 점수는 후보마다 한 번만 센다
  const broadList = coverageMode === 'broad-list';
  const queryAffinityWeight = broadList && !domainOverview ? 100 : 10_000;
  const genericDomainOverview = GENERIC_DOMAIN_OVERVIEW_QUERY_PATTERN.test(
    query.trim(),
  );
  const remaining = scopedCandidates.map((candidate, index) => {
    const { chunk, denseRank } = candidate;
    const policyGroupSummaryBonus =
      broadList && isPolicyGroupSummary(chunk) ? 5_000 : 0;
    const denseEvidenceRetentionBonus =
      genericDomainOverview && denseRank !== undefined && denseRank <= 2
        ? 50_000 / denseRank
        : 0;
    const concreteTimingBonus =
      concreteTimingActionAffinity(query, chunk) * 20_000;
    return {
      candidate,
      index,
      claims: highConfidenceClaims(chunk).filter((claim) =>
        relevantPolicyGroups.has(
          effectivePolicyGroup(claim.policyGroup, chunk.policyGroup),
        ),
      ),
      fixedGain:
        policyGroupSummaryBonus +
        denseEvidenceRetentionBonus +
        concreteTimingBonus +
        claimQueryAffinity(queryAnchors, chunk, vocabulary) *
          queryAffinityWeight,
    };
  });
  const selected: PolicyRetrievalCandidate[] = [];
  const seenClaims = new Set<string>();
  const seenFacets = new Set<string>();
  const coverageGain = (entry: (typeof remaining)[number]): number => {
    const novelClaims = entry.claims.filter(
      (claim) => !seenClaims.has(claim.claimId),
    );
    const novelFacets = novelClaims.filter(
      (claim) => !seenFacets.has(claim.facet),
    );
    const facetScoringClaims = broadList ? novelFacets : novelClaims;
    const primary = facetScoringClaims.filter((claim) =>
      preferredFacets.primary.includes(claim.facet),
    ).length;
    const secondary = facetScoringClaims.filter((claim) =>
      preferredFacets.secondary.includes(claim.facet),
    ).length;
    return (
      entry.fixedGain +
      primary * 1_000 +
      secondary * 500 +
      novelClaims.length * 100 +
      novelFacets.length * 25 +
      entry.candidate.fusedScore
    );
  };

  while (remaining.length > 0) {
    const gains = new Map(
      remaining.map((entry) => [entry, coverageGain(entry)]),
    );
    remaining.sort(
      (left, right) =>
        (gains.get(right) ?? 0) - (gains.get(left) ?? 0) ||
        left.index - right.index,
    );
    const next = remaining.shift();
    if (!next) {
      break;
    }
    selected.push(next.candidate);
    for (const claim of highConfidenceClaims(next.candidate.chunk)) {
      seenClaims.add(claim.claimId);
      seenFacets.add(claim.facet);
    }
  }

  return selected;
}

/** 시점 질문에서, 질문의 행위와 구체적인 날짜·시간 표현을 함께 담은 시점 claim 을 앞에 둔다 */
function concreteTimingActionAffinity(
  query: string,
  chunk: PolicyChunk,
): number {
  if (!TIMING_QUESTION_PATTERN.test(query)) {
    return 0;
  }
  const requestedActions = [
    ...new Set(query.match(TIMING_ACTION_PATTERN) ?? []),
  ];
  let maximum = 0;
  for (const claim of highConfidenceClaims(chunk)) {
    if (claim.facet !== 'schedule' && claim.facet !== 'duration') {
      continue;
    }
    if (!CONCRETE_TIMING_PATTERN.test(claim.statement)) {
      continue;
    }
    if (requestedActions.length === 0) {
      maximum = Math.max(maximum, 1);
      continue;
    }
    const matchedActions = requestedActions.filter((action) =>
      claim.statement.includes(action),
    ).length;
    maximum = Math.max(maximum, matchedActions);
  }
  return maximum;
}

/**
 * 묶음 범위 밖 후보는 버리되, BM25 상위 후보가 남은 후보 어디에도 없는 질문 낱말을 담고 있으면 남긴다
 * 묶음은 질문 낱말을 몇 개 담았는지로 고르므로 "몇"·"있어요" 같은 질문 말투 낱말을 더 담은 묶음이 이길 수 있다
 * 그러면 핵심어를 담은 유일한 후보가 통째로 빠져 근거 부족으로 끝난다. 이미 남은 후보가 덮는 낱말만 담은 후보는 그대로 버린다
 */
function keepUniquelyCoveringLexicalCandidates(
  queryAnchors: readonly string[],
  candidates: PolicyRetrievalCandidate[],
  inScope: (candidate: PolicyRetrievalCandidate) => boolean,
  vocabulary: Vocabulary,
): PolicyRetrievalCandidate[] {
  const scoped = candidates.filter(inScope);
  // 이긴 묶음이 없으면 밀어낸 쪽도 없으므로 범위 밖 후보를 모두 버린다
  if (scoped.length === 0) {
    return scoped;
  }
  const covered = new Set(
    scoped.flatMap((candidate) =>
      matchedQueryAnchors(queryAnchors, candidate.chunk, vocabulary),
    ),
  );
  return candidates.filter((candidate) => {
    if (inScope(candidate)) {
      return true;
    }
    if (
      candidate.lexicalRank === undefined ||
      candidate.lexicalRank > POLICY_COVERAGE_PROTECTED_LEXICAL_RANK
    ) {
      return false;
    }
    const uncovered = matchedQueryAnchors(
      queryAnchors,
      candidate.chunk,
      vocabulary,
    ).filter((anchor) => !covered.has(anchor));
    uncovered.forEach((anchor) => covered.add(anchor));
    return uncovered.length > 0;
  });
}

function matchedQueryAnchors(
  queryAnchors: readonly string[],
  chunk: PolicyChunk,
  vocabulary: Vocabulary,
): string[] {
  if (queryAnchors.length === 0) {
    return [];
  }
  const documentTokens = new Set(
    tokenizePolicySearchText(chunk.searchText, vocabulary),
  );
  return queryAnchors.filter((anchor) => documentTokens.has(anchor));
}

/**
 * 후보 중 질문 낱말을 가장 많이 덮는 정책 묶음을 고른다. 비교 질문은 질문 낱말을 덮는 묶음을 모두 고른다
 * 개요 질문은 BM25 후보 중 claim 문장이 질문 낱말을 가장 많이 담은 후보의 묶음을 먼저 따른다
 * 질문이 묶음을 직접 불렀으면 그 묶음 밖은 고르지 않는다
 */
function relevantCoveragePolicyGroups(
  candidates: PolicyRetrievalCandidate[],
  coverageMode: PolicyCoverageMode,
  queryAnchors: readonly string[],
  domainOverview: boolean,
  explicitGroups: ReadonlySet<string>,
  vocabulary: Vocabulary,
): Set<string> {
  if (domainOverview) {
    const lexicalAnchor = candidates
      .filter(
        (candidate) =>
          candidate.lexicalRank !== undefined &&
          highConfidenceClaims(candidate.chunk).some((claim) =>
            Boolean(claim.policyGroup),
          ),
      )
      .map((candidate) => ({
        candidate,
        affinity: claimQueryAffinity(queryAnchors, candidate.chunk, vocabulary),
      }))
      .sort(
        (left, right) =>
          right.affinity - left.affinity ||
          (left.candidate.lexicalRank ?? Number.MAX_SAFE_INTEGER) -
            (right.candidate.lexicalRank ?? Number.MAX_SAFE_INTEGER),
      )[0]?.candidate;
    const lexicalGroups = new Set(
      (lexicalAnchor ? highConfidenceClaims(lexicalAnchor.chunk) : [])
        .map((claim) => claim.policyGroup)
        .filter((group): group is string => Boolean(group)),
    );
    if (lexicalGroups.size > 0) {
      return lexicalGroups;
    }
  }
  const groupScores = new Map<string, number>();
  for (const candidate of candidates) {
    const affinity = domainOverview
      ? queryAnchorFrequencyAffinity(queryAnchors, candidate.chunk, vocabulary)
      : queryAffinity(queryAnchors, candidate.chunk, vocabulary);
    if (affinity === 0) {
      continue;
    }
    for (const claim of highConfidenceClaims(candidate.chunk)) {
      const policyGroup = effectivePolicyGroup(
        claim.policyGroup,
        candidate.chunk.policyGroup,
      );
      if (policyGroup) {
        groupScores.set(
          policyGroup,
          Math.max(groupScores.get(policyGroup) ?? 0, affinity),
        );
      }
    }
  }
  // 질문 낱말을 덮는 묶음이 없고 BM25 후보도 없으면 dense 1 위 claim 의 묶음을 따른다
  if (
    groupScores.size === 0 &&
    !candidates.some((candidate) => candidate.lexicalRank !== undefined)
  ) {
    const firstChunk = candidates
      .filter(
        (candidate) =>
          candidate.denseRank !== undefined &&
          highConfidenceClaims(candidate.chunk).length > 0,
      )
      .sort(
        (left, right) =>
          (left.denseRank ?? Number.MAX_SAFE_INTEGER) -
          (right.denseRank ?? Number.MAX_SAFE_INTEGER),
      )[0]?.chunk;
    for (const claim of firstChunk ? highConfidenceClaims(firstChunk) : []) {
      const policyGroup = effectivePolicyGroup(
        claim.policyGroup,
        firstChunk?.policyGroup,
      );
      if (policyGroup) {
        groupScores.set(policyGroup, 1);
      }
    }
  }
  const eligibleGroupScores = [...groupScores].filter(
    ([group]) => explicitGroups.size === 0 || explicitGroups.has(group),
  );
  if (coverageMode === 'comparison') {
    return new Set(eligibleGroupScores.map(([group]) => group));
  }
  const maximumAffinity = Math.max(
    0,
    ...eligibleGroupScores.map(([, affinity]) => affinity),
  );
  return new Set(
    eligibleGroupScores
      .filter(([, affinity]) => affinity === maximumAffinity)
      .map(([group]) => group),
  );
}

/**
 * 질문이 이름이나 별칭으로 직접 부른 정책 묶음. 별칭은 `vocabulary.groupAliases` 에서만 온다
 * 띄어쓰기와 대소문자는 가리지 않는다. 비었으면 묶음은 질문 낱말을 덮은 정도로만 고른다
 */
export function explicitPolicyGroups(
  query: string,
  vocabulary: Vocabulary = DEFAULT_KOREAN_VOCABULARY,
): Set<string> {
  const compactQuery = compactText(query);
  const groups = new Set<string>();
  for (const [group, aliases] of Object.entries(vocabulary.groupAliases)) {
    const named = [group, ...aliases].some((name) => {
      const compactName = compactText(name);
      return compactName.length > 0 && compactQuery.includes(compactName);
    });
    if (named) {
      groups.add(group);
    }
  }
  return groups;
}

function compactText(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(/\s+/g, '');
}

function effectivePolicyGroup(
  claimGroup: string | undefined,
  chunkGroup: string | undefined,
): string {
  return claimGroup ?? chunkGroup ?? '';
}

/** 조각 검색 글이 담은 질문 낱말 종류 수 */
function queryAffinity(
  queryAnchors: readonly string[],
  chunk: PolicyChunk,
  vocabulary: Vocabulary,
): number {
  if (queryAnchors.length === 0) {
    return 0;
  }
  const documentTokens = new Set(
    tokenizePolicySearchText(chunk.searchText, vocabulary),
  );
  return queryAnchors.filter((anchor) => documentTokens.has(anchor)).length;
}

/** 조각 검색 글에 질문 낱말이 나온 횟수. 개요 질문에서 대상 이름을 되풀이한 요약 행을 앞에 둔다 */
function queryAnchorFrequencyAffinity(
  queryAnchors: readonly string[],
  chunk: PolicyChunk,
  vocabulary: Vocabulary,
): number {
  if (queryAnchors.length === 0) {
    return 0;
  }
  const documentTokens = tokenizePolicySearchText(chunk.searchText, vocabulary);
  return documentTokens.filter((token) => queryAnchors.includes(token)).length;
}

/** high claim 문장이 담은 질문 낱말 종류 수. claim 이 없으면 검색 글로 센다 */
function claimQueryAffinity(
  queryAnchors: readonly string[],
  chunk: PolicyChunk,
  vocabulary: Vocabulary,
): number {
  const claims = highConfidenceClaims(chunk);
  if (claims.length === 0) {
    return queryAffinity(queryAnchors, chunk, vocabulary);
  }
  const claimTokens = new Set(
    tokenizePolicySearchText(
      claims.map((claim) => claim.statement).join(' '),
      vocabulary,
    ),
  );
  return queryAnchors.filter((anchor) => claimTokens.has(anchor)).length;
}

function highConfidenceClaims(chunk: PolicyChunk): PolicyClaimProps[] {
  return chunk.policyClaims.filter((claim) => claim.confidence === 'high');
}

/** 질문 말투라 핵심어로 치지 않는 낱말(사전의 불용어) */
function genericQueryTokens(vocabulary: Vocabulary): ReadonlySet<string> {
  let tokens = genericQueryTokenSets.get(vocabulary);
  if (!tokens) {
    tokens = new Set(vocabulary.stopwords);
    genericQueryTokenSets.set(vocabulary, tokens);
  }
  return tokens;
}

/** 묶음 범위를 고를 때 쓰는 질문 낱말. 불용어와 어느 묶음에나 흔한 낱말을 뺀다 */
function coverageQueryAnchors(query: string, vocabulary: Vocabulary): string[] {
  const exclusions = coverageGenericTokens(vocabulary);
  return tokenizePolicySearchQuery(query, vocabulary).filter(
    (token) => !exclusions.has(token),
  );
}

function coverageGenericTokens(vocabulary: Vocabulary): ReadonlySet<string> {
  let tokens = coverageGenericTokenSets.get(vocabulary);
  if (!tokens) {
    tokens = new Set([
      ...genericQueryTokens(vocabulary),
      ...COVERAGE_GENERIC_QUERY_TOKENS,
    ]);
    coverageGenericTokenSets.set(vocabulary, tokens);
  }
  return tokens;
}

/** dense 순위의 조각을 검색기가 가진 현재 조각으로 바꾼다. 지금 없는 조각과 범위 밖 종류는 뺀다 */
function hydrateDenseRanking(
  denseRanking: readonly PolicyChunk[],
  chunkById: ReadonlyMap<string, PolicyChunk>,
  contextKinds: ReadonlySet<PolicyContextKind>,
): PolicyChunk[] {
  return denseRanking
    .map((chunk) => chunkById.get(chunk.id))
    .filter(
      (chunk): chunk is PolicyChunk =>
        chunk !== undefined && contextKinds.has(chunk.contextKind),
    );
}

function lexicalCandidate(
  chunk: PolicyChunk,
  index: number,
): PolicyRetrievalCandidate {
  return { chunk, lexicalRank: index + 1, fusedScore: 0 };
}

function normalizeOptions(options: RetrievalOptions): RetrievalOptions {
  return {
    denseLimit: positiveInteger(options.denseLimit),
    lexicalLimit: positiveInteger(options.lexicalLimit),
    fusedLimit: positiveInteger(options.fusedLimit),
  };
}

function positiveInteger(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
