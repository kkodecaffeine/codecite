import type { PolicyContextKind } from './types.js';

export const POLICY_CONTEXT_KINDS = [
  'policy',
  'technical',
] as const satisfies readonly PolicyContextKind[];

/** 기술 구현 조각으로 보내는 context_text 섹션 */
export const TECHNICAL_HEADINGS = new Set([
  '검증',
  'API',
  '외부 연동',
  '실행 연결',
  '실행 경로',
  '검증 출처',
  '기술 검증 정보',
]);

/** 답변 근거에는 넣지 않고 검색 글에만 붙이는 섹션 */
export const SEARCH_ONLY_HEADINGS = new Set([
  '질문 예시',
  '사용자 질문 예시',
  '검색 키워드',
  '검색 표현',
  '내부 항목',
]);

/** 정책 조각과 기술 조각 양쪽 머리에 함께 두는 섹션 */
export const SHARED_HEADINGS = new Set(['기능']);

/** 코드 심볼 문서임을 알리는 섹션. 하나라도 있으면 기술 조각 하나로 만든다 */
export const CODE_SYMBOL_HEADINGS = new Set([
  '심볼',
  '설명',
  '구조',
  '관계',
  '호출됨',
  '소스 코드',
]);

/**
 * 처리 단계와 앞뒤 흐름을 담는 정책 행 섹션 이름
 * 실행 흐름 질문에서는 이 섹션이 있는 행을 절차 근거로 보고 질문 낱말로 골라 앞자리에 둔다
 */
export const POLICY_PROCEDURE_STEPS_HEADING = '처리 순서';
export const POLICY_PROCEDURE_CALLERS_HEADING = '실행되는 때';
export const POLICY_PROCEDURE_CALLEES_HEADING = '이어지는 처리';

/**
 * 호출이 아니라 데이터로 이어지는 나중 처리. 이 처리가 남긴 표시를 예약 작업이 조건으로 읽는다
 * 예: 주문 취소는 취소 표시만 남기고, 다음 날 정산 작업이 그 표시를 읽어 적립금을 회수한다
 */
export const POLICY_PROCEDURE_DEFERRED_HEADING = '나중에 이어지는 처리';

/**
 * 답변 근거 글에는 남기고 검색 글(BM25·embedding)에서는 빼는 섹션
 * 처리 순서까지 검색 글에 넣으면 행이 길어져 BM25 길이 보정 때문에 그 행이 다른 질문에서 밀린다
 */
export const EVIDENCE_ONLY_HEADINGS = new Set([
  POLICY_PROCEDURE_STEPS_HEADING,
  POLICY_PROCEDURE_CALLERS_HEADING,
  POLICY_PROCEDURE_CALLEES_HEADING,
  POLICY_PROCEDURE_DEFERRED_HEADING,
]);
