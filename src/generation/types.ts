import type { PolicyClaimProps, PolicyContextKind } from '../domain/types.js';

/**
 * 답변 모델과 결정적 답변에 넘기는 근거 하나
 * internalSource 는 내부 출처라 답에 내보내지 않고, 인용에는 공개해도 되는 sourceLabel 만 쓴다
 */
export interface PolicyEvidence {
  chunkId: string;
  policyCode: string;
  section: string;
  internalSource: string;
  sourceLabel: string;
  text: string;
  /** 색인 메타데이터와 검색 보조 섹션을 뺀 사용자용 근거 글. 정책 조각에만 있다 */
  publicText?: string;
  contextKind?: PolicyContextKind;
  policyGroup?: string;
  policyClaims?: PolicyClaimProps[];
}
