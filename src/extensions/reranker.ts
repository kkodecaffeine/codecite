// 재정렬 계약. 재정렬기는 검색 후보의 순서만 바꾼다. 후보를 더하거나 근거를 지어내거나 판정을 대신하지 않는다.
// 새 재정렬기는 먼저 shadow 로 붙여 원래 순서와 나란히 견주고, 묶인 근거가 나아진 것을 확인한 뒤에만 on 으로 켠다.
// shadow 는 사용자가 받는 답을 바꾸지 않는다. 비교 기록만 남긴다.
// 재정렬기가 실패하면 던지지 않고 unavailable 과 까닭을 돌려준다. 부르는 쪽은 원래 순서를 그대로 쓴다.
// 기준 근거(anchor)는 재정렬 결과와 상관없이 앞자리를 지킨다. 재정렬기가 후보를 거의 다 버려도 핵심 claim 이 남아야 하기 때문이다.
import type { PolicyRetrievalCandidate } from '../retrieval/types.js';

/** off 는 부르지 않음, shadow 는 비교만, on 은 재정렬 순서를 실제로 씀 */
export type RerankMode = 'off' | 'shadow' | 'on';

/** 재정렬된 후보 하나. candidate 는 받은 후보 객체 그대로다 */
export interface RerankedItem {
  candidate: PolicyRetrievalCandidate;
  score: number;
}

/**
 * 재정렬 결과
 * - applied·shadow: items 는 받은 후보의 부분 집합을 새 순서로 담는다
 * - unavailable: 모델 오류, 시간 초과, 응답 형식 오류 같은 까닭으로 순서를 내지 못했다
 */
export type RerankResult =
  | {
      status: 'applied' | 'shadow';
      items: RerankedItem[];
    }
  | {
      status: 'unavailable';
      reason: string;
    };

/** 검색 후보 재정렬기. mode 는 만들 때 정하고 실행 중에 바꾸지 않는다 */
export interface Reranker {
  readonly mode: RerankMode;
  rerank(
    query: string,
    candidates: PolicyRetrievalCandidate[],
  ): Promise<RerankResult>;
}

/** shadow 비교 기록 속 후보 하나. 후보 내용 대신 해시만 남긴다 */
export interface RerankShadowCandidate {
  candidateHash: string;
  originalRank: number;
  /** 재정렬기가 버린 후보면 null */
  rerankedRank: number | null;
  score: number | null;
  /** 재정렬 순서였다면 묶인 근거에 들어갔는지 */
  selected: boolean;
}

/** shadow 모드 비교 기록 한 건. 질문 본문 대신 해시를 남긴다 */
export interface RerankShadowRecord {
  schemaVersion: 1;
  requestId: string;
  queryHash: string;
  status: 'shadow' | 'unavailable';
  reason?: string;
  candidates: RerankShadowCandidate[];
  rerankLatencyMs: number;
  /** 원래 순서로 낸 답과 그때까지 걸린 시간 */
  baselineAnswer: string;
  baselineEndToEndMs: number;
  /** 재정렬 순서로 다시 만든 답. 사용자에게는 나가지 않는다 */
  rerankedAnswer?: string;
  rerankedEndToEndMs?: number;
}
