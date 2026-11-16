import type { PolicyChunk } from '../domain/policy-chunk.js';
import type { PolicyClaimFacet, PolicyContextKind } from '../domain/types.js';

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
