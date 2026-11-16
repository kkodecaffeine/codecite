import type { PolicyChunk } from '../domain/policy-chunk.js';
import type { PolicyClaimFacet, PolicyContextKind } from '../domain/types.js';
import type { PolicyEvidence } from '../generation/types.js';
import type { Embedder, Logger, VectorIndex } from '../ports.js';
import type { Vocabulary } from '../text/types.js';

/** 검색 후보 하나. 순위는 1 부터 세고, 그 검색에서 나오지 않았으면 비어 있다 */
export interface PolicyRetrievalCandidate {
  chunk: PolicyChunk;
  denseRank?: number;
  lexicalRank?: number;
  fusedScore: number;
}

/** dense·lexical 검색에서 각각 뽑을 후보 수와 합친 뒤 남길 후보 수 */
export interface RetrievalOptions {
  denseLimit: number;
  lexicalLimit: number;
  fusedLimit: number;
}

/** 낱말 하나가 나온 문서 번호와 그 문서 안의 빈도. 두 배열은 같은 순서다 */
export interface Bm25Posting {
  documents: Int32Array;
  frequencies: Int32Array;
}

/**
 * 같은 조각 배열로 BM25 를 다시 돌릴 때 문서 토큰화를 건너뛰려고 한 번만 만드는 역색인
 * chunks 는 만들 때의 배열 사본이라 호출자가 배열을 바꿨는지 대조하는 데 쓴다
 */
export interface PreparedBm25Corpus {
  chunks: readonly PolicyChunk[];
  documentLengths: number[];
  averageLength: number;
  postings: Map<string, Bm25Posting>;
}

/** 정책 질문인지, 기술 구현 근거까지 열어야 하는 질문인지 */
export type PolicyQueryIntent = 'policy' | 'technical';

/** 한 가지 사실을 묻는지(focused), 목록·개요를 묻는지(broad-list), 둘을 견주는지(comparison) */
export type PolicyCoverageMode = 'focused' | 'broad-list' | 'comparison';

/** 질문 하나를 검색할 조각 종류와 덮을 범위 */
export interface PolicyRetrievalScope {
  intent: PolicyQueryIntent;
  contextKinds: PolicyContextKind[];
  coverageMode: PolicyCoverageMode;
}

/** 질문이 먼저 원하는 claim 종류와 그다음으로 쓸 만한 종류 */
export interface PreferredPolicyClaimFacets {
  primary: PolicyClaimFacet[];
  secondary: PolicyClaimFacet[];
}

/** 근거 하나가 질문 낱말을 얼마나 덮는지. subjectMatched 는 claim 주제와 기능 이름만 본 수다 */
export interface QuestionCoverage {
  item: PolicyEvidence;
  index: number;
  matched: number;
  coverage: number;
  subjectMatched: number;
}

/** 수량 질문이 묻는 단위. 개수·금액·비율을 가려 같은 단위의 claim 만 답으로 본다 */
export type AmountUnitIntent = 'count' | 'money' | 'rate' | 'unspecified';

/** 시간 질문이 묻는 모양. 시각 범위·시각 하나·걸리는 기간을 가린다 */
export type TimeUnitIntent =
  'clock-range' | 'clock-point' | 'duration' | 'unspecified';

/** 검색이 어떤 경로로 돌았는지. 임베더·벡터 색인이 없거나 dense 검색이 실패하면 bm25 다 */
export type RetrievalMode = 'hybrid' | 'bm25';

/** 하이브리드 검색 결과. 허브는 mode 를 trace.retrieval 에 남기고, denseError 가 있으면 경고를 남긴다 */
export interface HybridRetrievalResult {
  candidates: PolicyRetrievalCandidate[];
  mode: RetrievalMode;
  /** dense 검색이 실패한 까닭. 임베더나 벡터 색인이 없어 처음부터 BM25 만 돈 경우에는 비어 있다 */
  denseError?: Error;
}

/** 하이브리드 검색기를 만드는 재료 */
export interface HybridRetrieverOptions {
  /** 활성 정책 조각 전체. BM25 와 같은 묶음 형제 확장이 이 안에서 찾는다 */
  chunks: readonly PolicyChunk[];
  /** 임베더와 벡터 색인이 둘 다 있을 때만 dense 검색을 돌린다 */
  embedder?: Embedder;
  index?: VectorIndex;
  /** 낱말 나누기와 묶음 별칭(groupAliases) 에 쓰는 사전. 없으면 한국어 기본 사전을 쓴다 */
  vocabulary?: Vocabulary;
  logger?: Logger;
}
