import { jsonIndexCache } from './adapters/json-index-cache.js';
import type { PolicyChunk } from './domain/policy-chunk.js';
import {
  DEFAULT_ANSWER_TIMEOUT_MS,
  INSUFFICIENT_EVIDENCE_ANSWER,
} from './constants.js';
import {
  enforcePolicyAnswerContract,
  ensureRequiredEvidenceDetails,
  policyAnswerMode,
} from './generation/answer-contract.js';
import { guardGeneratedAnswer } from './generation/answer-guard.js';
import { DEFAULT_POLICY_CONTEXT_PACKING_OPTIONS } from './generation/constants.js';
import {
  packAnswerEvidence,
  selectLeadingEvidence,
} from './generation/context-packer.js';
import { policyEvidenceFromChunk } from './generation/evidence.js';
import { deterministicPolicyFallback } from './generation/fallback.js';
import { buildPolicyAnswerPrompt, planQuestion } from './generation/prompts.js';
import type {
  PolicyAnswerMode,
  PolicyContextPackingOptions,
  PolicyEvidence,
} from './generation/types.js';
import { noopLogger } from './logger.js';
import type { Embedder, LlmClient, Logger, VectorIndex } from './ports.js';
import { DEFAULT_RETRIEVAL_OPTIONS } from './retrieval/constants.js';
import { isPolicyEvidenceSufficient } from './retrieval/evidence-sufficiency.js';
import {
  HybridPolicyRetriever,
  loadActivePolicyChunks,
} from './retrieval/hybrid-retriever.js';
import type {
  PolicyRetrievalCandidate,
  RetrievalOptions,
} from './retrieval/types.js';
import { InMemoryVectorIndex } from './retrieval/vector-index.js';
import { sanitizePublicPolicyAnswer } from './safety/public-answer-sanitizer.js';
import { normalizeKoreanEnglishSpacing } from './text/korean-english-spacing.js';
import type { Vocabulary } from './text/types.js';
import {
  DEFAULT_KOREAN_VOCABULARY,
  mergeVocabulary,
} from './text/vocabulary.js';
import type {
  Codecite,
  CodeciteAnswer,
  CodeciteCitation,
  CodeciteIndexSummary,
  CodeciteLimits,
  CodeciteOptions,
  CodeciteTrace,
} from './types.js';

/**
 * 정책 소스를 읽어 색인을 만들고, 질문을 근거 답변으로 잇는 엔진을 돌려준다
 * 단계 순서는 여기 한 곳에서 고정한다. 모델이 쓴 답이든 결정적 답변이든 같은 답변 계약과 공개 정보 정제를 지난다
 * CSV 형식 오류는 행 번호와 함께 throw 한다. 임베딩이 실패하면 경고를 남기고 BM25 만으로 돈다
 */
export async function createCodecite(
  options: CodeciteOptions,
): Promise<Codecite> {
  const logger = options.logger ?? noopLogger;
  // BM25·낱말 나누기 캐시가 사전 객체마다 만들어지므로 사전은 한 번만 만들어 모든 단계에 같은 객체를 넘긴다
  const vocabulary = mergeVocabulary(
    DEFAULT_KOREAN_VOCABULARY,
    options.vocabulary,
  );
  const retrievalLimits = retrievalOptions(options.limits);
  const packingLimits = packingOptions(options.limits);
  const answerTimeoutMs = positiveNumber(
    options.limits?.answerTimeoutMs,
    DEFAULT_ANSWER_TIMEOUT_MS,
  );

  let retriever: HybridPolicyRetriever;
  let indexSummary: CodeciteIndexSummary;

  const reindex = async (): Promise<CodeciteIndexSummary> => {
    const chunks = await loadActivePolicyChunks(options.source);
    const dense = options.embedder
      ? await buildDenseIndex(chunks, options.embedder, options, logger)
      : undefined;
    // 색인과 요약을 한 번에 바꿔, 다시 만드는 동안 들어온 질문은 앞 색인으로 답한다
    retriever = new HybridPolicyRetriever({
      chunks,
      embedder: dense?.embedder,
      index: dense?.index,
      vocabulary,
      logger,
    });
    indexSummary = {
      chunks: chunks.length,
      retrieval: dense ? 'hybrid' : 'bm25',
      reusedVectors: dense?.reused ?? false,
    };
    logger.info('policy index ready', { ...indexSummary });
    return indexSummary;
  };

  const ask = async (question: string): Promise<CodeciteAnswer> => {
    if (typeof question !== 'string' || !question.trim()) {
      throw new TypeError('codecite: question must be a non-empty string.');
    }
    const startedAt = Date.now();
    const result = await answerQuestion(question.trim(), {
      retriever,
      llm: options.llm,
      vocabulary,
      retrievalLimits,
      packingLimits,
      answerTimeoutMs,
      logger,
    });
    // 질문 본문은 남기지 않는다. 길이와 경로만으로 답 하나를 추적한다
    logger.info('question answered', {
      status: result.status,
      ...result.trace,
      citations: result.citations.length,
      questionLength: question.trim().length,
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  };

  await reindex();
  return {
    ask,
    reindex,
    get indexSummary() {
      return indexSummary;
    },
  };
}

/**
 * 조각 벡터를 캐시에서 꺼내거나 새로 임베딩해 벡터 색인을 채운다
 * 실패하면 경고만 남기고 undefined 를 돌려줘, 빈 색인을 두고 hybrid 라고 답하는 대신 처음부터 BM25 로 돌게 한다
 */
async function buildDenseIndex(
  chunks: readonly PolicyChunk[],
  embedder: Embedder,
  options: CodeciteOptions,
  logger: Logger,
): Promise<
  { embedder: Embedder; index: VectorIndex; reused: boolean } | undefined
> {
  const index = options.index ?? new InMemoryVectorIndex();
  try {
    const cache = jsonIndexCache({ path: options.indexCachePath, logger });
    const { vectors, reused } = await cache.vectorsFor(chunks, embedder);
    await index.rebuild(chunks, vectors);
    return { embedder, index, reused };
  } catch (error) {
    logger.warn('embedding failed; searching with BM25 only', {
      error: errorMessage(error),
    });
    return undefined;
  }
}

interface AnswerContext {
  retriever: HybridPolicyRetriever;
  llm?: LlmClient;
  vocabulary: Vocabulary;
  retrievalLimits: RetrievalOptions;
  packingLimits: PolicyContextPackingOptions;
  answerTimeoutMs: number;
  logger: Logger;
}

/**
 * 질문 하나를 답으로 바꾼다
 * 1. 질문 계획(답변 모델이 있을 때만). 계획 낱말은 검색어에만 더하고, 기준 근거와 충분성은 질문 원문으로 본다
 * 2. 하이브리드 검색. 묶음 범위와 근거 우선순위는 검색기 안에서 정한다
 * 3. 기준 근거. 질문 원문만으로 BM25 를 다시 돌려, 계획 낱말에 끌려간 후보가 앞자리를 뺏지 못하게 한다
 * 4. 충분성 판정. 모자라면 답변 모델을 부르지 않는다
 * 5. 근거 묶기 → 답변 생성과 답변 검사(또는 결정적 답변) → 답변 계약 → 공개 정보 정제
 */
async function answerQuestion(
  question: string,
  context: AnswerContext,
): Promise<CodeciteAnswer> {
  const { retriever, llm, vocabulary, logger } = context;
  const answerMode = policyAnswerMode(question);

  const plan = llm ? await planQuestion(llm, question, { logger }) : undefined;
  const searchQuery = [question, ...(plan?.searchTerms ?? [])].join(' ');

  const { candidates, mode, denseError } = await retriever.retrieve(
    searchQuery,
    context.retrievalLimits,
  );
  if (denseError) {
    logger.warn('dense retrieval failed; searching with BM25 only', {
      error: denseError.message,
    });
  }

  const ranked = withLeadingEvidence(
    question,
    candidates.map((candidate) => policyEvidenceFromChunk(candidate.chunk)),
    retriever.retrieveLexical(question, context.retrievalLimits.lexicalLimit),
    vocabulary,
  );
  const trace: CodeciteTrace = {
    retrieval: mode,
    generation: 'deterministic',
    candidates: ranked.length,
    packed: 0,
  };
  if (!isPolicyEvidenceSufficient(question, ranked, vocabulary)) {
    return insufficientEvidence(trace);
  }

  const packed = packAnswerEvidence(question, ranked, {
    ...context.packingLimits,
    vocabulary,
  });
  if (packed.evidence.length === 0) {
    return insufficientEvidence(trace);
  }
  trace.packed = packed.evidence.length;

  const generated = llm
    ? await generateAnswer(llm, question, packed.evidence, answerMode, context)
    : undefined;
  trace.generation = generated ? 'llm' : 'deterministic';
  const draft =
    generated ??
    deterministicPolicyFallback({
      question,
      evidence: packed.evidence,
      answerMode,
    });

  // 어느 경로의 답이든 같은 관문을 지난다: 답변 계약 → 공개 정보 정제 → 한글·영어 띄어쓰기
  // 기본 답은 문단으로, 목록·자세히를 원한 답만 목록 기호로 쓴다(프롬프트의 목록 기호 규칙과 같다)
  const answer = normalizeKoreanEnglishSpacing(
    sanitizePublicPolicyAnswer(
      enforcePolicyAnswerContract(
        ensureRequiredEvidenceDetails({
          question,
          answer: draft,
          evidence: packed.evidence,
        }),
        answerMode,
        undefined,
        answerMode === 'default' ? 'prose' : 'bullets',
      ),
    ),
  );
  return {
    status: 'answered',
    answer,
    citations: citationsFor(packed.evidence),
    trace,
  };
}

/**
 * 검색 후보에 기준 근거를 앞세운다
 * 기준 근거는 검색 후보와 질문 원문만으로 돌린 BM25 후보를 함께 놓고 고른다. 검색 후보에 기준 근거가 있어도 늘 함께 본다
 * BM25 후보는 기준 근거 자리에만 쓰고, 나머지 자리는 검색 후보 순서를 그대로 둔다
 */
function withLeadingEvidence(
  question: string,
  base: readonly PolicyEvidence[],
  lexical: readonly PolicyRetrievalCandidate[],
  vocabulary: Vocabulary,
): PolicyEvidence[] {
  const baseIds = new Set(base.map((item) => item.chunkId));
  const lexicalOnly = lexical
    .filter((candidate) => !baseIds.has(candidate.chunk.id))
    .map((candidate) => policyEvidenceFromChunk(candidate.chunk));
  const leading = selectLeadingEvidence(
    question,
    [...base, ...lexicalOnly],
    vocabulary,
  );
  const leadingIds = new Set(leading.map((item) => item.chunkId));
  return [...leading, ...base.filter((item) => !leadingIds.has(item.chunkId))];
}

/**
 * 묶인 근거로 답변 모델을 부르고 답변 검사를 거친다
 * 모델이 실패하거나 시간을 넘기거나 답변 검사에 걸리면 undefined 를 돌려줘 결정적 답변으로 물러나게 한다
 * 물러난 경로에서는 모델을 다시 부르지 않는다. 같은 장애를 또 만나 시간만 쓰기 때문이다
 */
async function generateAnswer(
  llm: LlmClient,
  question: string,
  evidence: readonly PolicyEvidence[],
  answerMode: PolicyAnswerMode,
  context: AnswerContext,
): Promise<string | undefined> {
  const signal = AbortSignal.timeout(context.answerTimeoutMs);
  let output: string;
  try {
    output = await untilAborted(
      llm.complete({
        ...buildPolicyAnswerPrompt({ question, evidence, answerMode }),
        signal,
      }),
      signal,
    );
  } catch (error) {
    context.logger.warn('answer model failed; using deterministic answer', {
      error: errorMessage(error),
      timedOut: signal.aborted,
    });
    return undefined;
  }
  const guarded = guardGeneratedAnswer({
    question,
    answer: output,
    evidence,
    answerMode,
  });
  if (guarded.replaced) {
    context.logger.warn('generated answer failed the answer guard', {
      reason: guarded.reason,
    });
    return undefined;
  }
  return guarded.answer;
}

function insufficientEvidence(trace: CodeciteTrace): CodeciteAnswer {
  return {
    status: 'insufficient_evidence',
    answer: INSUFFICIENT_EVIDENCE_ANSWER,
    citations: [],
    trace: { ...trace, generation: 'deterministic', packed: 0 },
  };
}

/** 묶인 근거의 claim 을 인용으로 바꾼다. 출처는 공개해도 된다고 적힌 것만 내보낸다 */
function citationsFor(evidence: readonly PolicyEvidence[]): CodeciteCitation[] {
  const seen = new Set<string>();
  const citations: CodeciteCitation[] = [];
  for (const item of evidence) {
    for (const claim of item.policyClaims ?? []) {
      if (seen.has(claim.claimId)) {
        continue;
      }
      seen.add(claim.claimId);
      const source = claim.provenance?.find(
        (provenance) => provenance.publicAnswerSafe,
      )?.sourceLabel;
      citations.push({
        claimId: claim.claimId,
        policyGroup: claim.policyGroup ?? item.policyGroup ?? '',
        statement: claim.statement,
        ...(source ? { source } : {}),
      });
    }
  }
  return citations;
}

/** signal 을 무시하는 모델 어댑터가 있어도 시간 한도에서 기다림을 끊는다 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function retrievalOptions(limits: CodeciteLimits = {}): RetrievalOptions {
  return {
    denseLimit: positiveNumber(
      limits.denseLimit,
      DEFAULT_RETRIEVAL_OPTIONS.denseLimit,
    ),
    lexicalLimit: positiveNumber(
      limits.lexicalLimit,
      DEFAULT_RETRIEVAL_OPTIONS.lexicalLimit,
    ),
    fusedLimit: positiveNumber(
      limits.fusedLimit,
      DEFAULT_RETRIEVAL_OPTIONS.fusedLimit,
    ),
  };
}

function packingOptions(
  limits: CodeciteLimits = {},
): PolicyContextPackingOptions {
  return {
    maxItems: positiveNumber(
      limits.maxItems,
      DEFAULT_POLICY_CONTEXT_PACKING_OPTIONS.maxItems,
    ),
    maxTotalChars: positiveNumber(
      limits.maxTotalChars,
      DEFAULT_POLICY_CONTEXT_PACKING_OPTIONS.maxTotalChars,
    ),
    maxItemChars: positiveNumber(
      limits.maxItemChars,
      DEFAULT_POLICY_CONTEXT_PACKING_OPTIONS.maxItemChars,
    ),
  };
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
