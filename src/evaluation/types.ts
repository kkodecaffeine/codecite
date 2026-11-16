import type { CodeciteAnswer } from '../types.js';

/** 골든 질문 하나. 사람이 고치는 `golden-questions.json` 의 항목이다 */
export interface GoldenQuestion {
  id: string;
  question: string;
  /** 답변 모델에 넘길 근거에 들어가야 하는 claim id. 비어 있으면 hitAny·hitAll 을 재지 않는다 */
  expectedClaimIds: string[];
  /** 있으면 답의 status 가 이 값이어야 맞다. 근거가 없는 질문은 `insufficient_evidence` 를 적는다 */
  expectStatus?: CodeciteAnswer['status'];
}

/** 질문별로 재는 항목. 기준선과 이 항목끼리 비교한다 */
export type GoldenCheck = 'hitAny' | 'hitAll' | 'statusMatch';

/** 질문 하나를 돌린 결과. 재지 않는 항목은 null 이다 */
export interface GoldenQuestionResult {
  id: string;
  /** 잰 항목이 모두 맞았는지 */
  passed: boolean;
  /** 기대 claim 이 하나라도 인용에 들어갔는지 */
  hitAny: boolean | null;
  /** 기대 claim 이 모두 인용에 들어갔는지 */
  hitAll: boolean | null;
  /** 실제로 나온 status */
  status: CodeciteAnswer['status'];
  /** status 가 expectStatus 와 같은지 */
  statusMatch: boolean | null;
}

/** `baseline.json` 의 모양. 사람이 PR 로만 바꾼다 */
export interface GoldenBaseline {
  schemaVersion: 1;
  total: number;
  passed: number;
  questions: GoldenQuestionResult[];
}

/** 기준선과 달라진 항목 하나. missing 은 기준선의 질문이 결과에 없다는 뜻이다 */
export interface GoldenChange {
  id: string;
  check: GoldenCheck | 'missing';
}

/** 기준선과 질문별로 비교한 결과 */
export interface GoldenComparison {
  /** 기준선에서 맞던 항목이 틀려졌거나 질문이 사라졌다. 하나라도 있으면 실패다 */
  regressions: GoldenChange[];
  /** 기준선에서 틀리던 항목이 맞았다. 보고만 한다 */
  improvements: GoldenChange[];
  /** 기준선에 없는 새 질문 */
  added: string[];
}

/** 정책 데이터에 없는 claim id 를 기대하는 질문 */
export interface GoldenUnknownClaims {
  id: string;
  claimIds: string[];
}
