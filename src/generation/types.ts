import type {
  PolicyClaimFacet,
  PolicyClaimProps,
  PolicyContextKind,
} from '../domain/types.js';
import type { Logger } from '../ports.js';
import type { Vocabulary } from '../text/types.js';

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

/** 답변 길이 모드. 기본은 짧게 두고, 상세 요청과 목록 요청만 항목을 더 허용한다 */
export type PolicyAnswerMode = 'default' | 'detailed' | 'list';

/** 근거 묶기 한도. 글자 수는 직렬화한 근거와 구분선을 코드 포인트로 센다 */
export interface PolicyContextPackingOptions {
  maxTotalChars: number;
  maxItemChars: number;
  maxItems: number;
}

/**
 * 근거 자리 순서를 정할 때의 선택 사항
 * 상한은 첫 번째 채우기에만 걸린다. 다른 묶음·종류 근거가 없으면 남은 자리는 검색 순서대로 다시 채운다
 */
export interface EvidenceSlotOptions {
  /** 기준 근거 뒤 자리를 채울 때 한 정책 묶음이 먼저 차지할 수 있는 자리 수 */
  maxItemsPerGroup?: number;
  /** 같은 방식으로 한 조각 종류(정책·기술)가 먼저 차지할 수 있는 자리 수 */
  maxItemsPerKind?: number;
  vocabulary?: Vocabulary;
}

/** 근거 묶기 진입점의 선택 사항. 한도와 자리 순서 선택을 함께 받는다 */
export type AnswerEvidencePackingOptions =
  Partial<PolicyContextPackingOptions> & EvidenceSlotOptions;

/** 한도 안에 묶인 근거와, 묶지 못한 근거·claim 의 수와 id */
export interface PackedPolicyContext {
  evidence: PolicyEvidence[];
  omittedItemCount: number;
  omittedHighConfidenceClaimCount: number;
  oversizedClaimCount: number;
  omittedHighConfidenceClaimIds: string[];
  oversizedClaimIds: string[];
}

/** 근거 글을 줄일 때 고르는 완결 단위(문장, 목록 줄, 섹션 머리) */
export interface ExtractivePolicyUnit {
  text: string;
  index: number;
  relevance: number;
  policyPriority: number;
}

/** 답변 계약이 세는 항목 하나. 목록 줄 하나나 완결 문장 하나다 */
export interface AnswerItem {
  text: string;
}

/** 결정적 답변 입력. 모델을 부르지 않고 근거 문장만으로 답을 만든다 */
export interface DeterministicFallbackInput {
  question: string;
  evidence: readonly PolicyEvidence[];
  answerMode?: PolicyAnswerMode;
}

/** 답변 계약이 근거의 필수 상세와 숫자 조건을 되살릴 때의 입력 */
export interface RequiredEvidenceDetailsInput {
  question?: string;
  answer: string;
  evidence: readonly PolicyEvidence[];
}

/** 답변 검사가 모델 답을 결정적 답변으로 바꾼 까닭 */
export type AnswerGuardReason =
  | 'no_evidence'
  | 'empty'
  | 'evasive'
  | 'implementation_only'
  | 'invented_figure'
  | 'invented_condition';

/** 답변 검사 입력. evidence 는 모델에 넘긴 묶인 근거다 */
export interface AnswerGuardInput {
  question: string;
  answer: string;
  evidence: readonly PolicyEvidence[];
  /** 결정적 답변으로 바꿀 때 쓸 답변 길이 모드 */
  answerMode?: PolicyAnswerMode;
  /** 근거나 질문에 없으면 지어낸 것으로 보는 조건 낱말. 없으면 기본 목록을 쓴다 */
  inventedConditionTerms?: readonly string[];
}

/** 답변 검사 결과. replaced 면 answer 는 결정적 답변이고 reason 에 까닭이 있다 */
export interface AnswerGuardResult {
  answer: string;
  replaced: boolean;
  reason?: AnswerGuardReason;
}

/** 답변 프롬프트 재료. evidence 는 근거 묶기를 거친 것만 넘긴다 */
export interface PolicyAnswerPromptInput {
  question: string;
  evidence: readonly PolicyEvidence[];
  /** 답 길이 모드. 답변 계약과 같은 항목 수 상한을 프롬프트에 적는다. 없으면 default */
  answerMode?: PolicyAnswerMode;
}

/** 답변 모델에 보낼 지시문과 사용자 글 한 벌 */
export interface PolicyAnswerPrompt {
  system: string;
  user: string;
}

/** 질문 계획. 검색에 더할 낱말과 질문이 원하는 claim 종류(중요한 순서) */
export interface QuestionPlan {
  searchTerms: string[];
  facets: PolicyClaimFacet[];
}

/** 질문 계획을 부를 때의 선택 사항 */
export interface QuestionPlanOptions {
  /** 호출자가 계획을 끊을 때 쓴다 */
  signal?: AbortSignal;
  /** 계획을 기다리는 최대 시간(밀리초). 없으면 기본값을 쓴다 */
  timeoutMs?: number;
  /** 계획이 실패한 까닭을 남긴다. 질문 본문은 남기지 않는다 */
  logger?: Logger;
}
