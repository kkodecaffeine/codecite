import type { PolicyAnswerMode, PolicyContextPackingOptions } from './types.js';

/** 프롬프트에서 근거와 근거 사이에 두는 구분선 */
export const POLICY_EVIDENCE_SEPARATOR = '\n\n---\n\n';

/** 사용자용 근거 글에서 빼는 섹션. 기능 머리말, 내부 항목, 검색 보조 표현, 실행 경로 같은 색인 메타데이터다 */
export const PUBLIC_HIDDEN_HEADINGS: ReadonlySet<string> = new Set([
  '기능',
  '내부 항목',
  '질문 예시',
  '사용자 질문 예시',
  '검색 키워드',
  '검색 표현',
  '실행 연결',
  '실행 경로',
  '검증 출처',
  '기술 검증 정보',
]);

/** 사용자용 근거 글에서 바꿔 쓰는 섹션 이름. 빈 값이면 이름 없이 본문만 남긴다 */
export const PUBLIC_HEADING_LABELS: Readonly<Record<string, string>> = {
  '서비스 정책': '',
  '코드로 확인된 조건': '적용 조건',
  '필수 답변 상세': '함께 확인할 내용',
};

/** 근거 묶기 기본 한도. 근거가 많을수록 핵심이 묻히고 비용이 늘어 개수와 글자 수를 함께 묶는다 */
export const DEFAULT_POLICY_CONTEXT_PACKING_OPTIONS: Readonly<PolicyContextPackingOptions> =
  Object.freeze({ maxTotalChars: 6500, maxItemChars: 2200, maxItems: 5 });

/**
 * 정책 문장으로 바로 답하는 노출·한도·자격·시점 질문
 * 이런 질문은 기준 근거 하나로 끝내지 않고 질문 낱말을 덮는 정책 근거를 몇 개 더 앞자리에 둔다
 */
export const POLICY_FIRST_QUESTION_PATTERN =
  /(?:노출|보이(?:나|는|냐|지|고|면)|보여|표시|숨(?:겨|기|김)|최대|최소|한도|제한|상한|하한|얼마|까지|부터|이상|이하|초과|미만|몇\s*(?:개|건|회|번|명|일|시간|분|원|%)|누구|대상|자격|조건|허용|가능|(?:쓸|할|받을|볼|살|고를)\s*수\s*(?:있|없)|언제|어떤\s*(?:경우|때|회원)|무슨\s*경우)/u;

/** 문장 끝. 뒤에 공백이나 글 끝이 오는 마침표·물음표·느낌표만 본다. `0.5%` 같은 소수점은 문장 끝이 아니다 */
export const COMPLETED_SENTENCE_PATTERN = /.+?[.!?。](?=\s|$)/gu;

/** 근거 글을 줄일 때 문장으로 쪼개지 않고 줄 전체를 한 단위로 남기는 꼴 */
export const WHOLE_LINE_UNIT_PATTERNS: readonly RegExp[] = [
  /^[-*•]\s+\S/u,
  // "2. 결제 취소" 같은 번호 목록 줄. 번호 뒤 마침표를 문장 끝으로 읽으면 번호만 남는다
  /^\d{1,2}[.)]\s+\S/u,
  /^(?:정책명|정책 코드|섹션|상태|조건|결정|출처):\s*\S/u,
  /[.!?。]$/u,
];

/** 근거 글의 섹션 머리 꼴 */
export const EVIDENCE_HEADING_PATTERNS: readonly RegExp[] = [
  /^\[[^\]]+\]$/u,
  /^#{1,6}\s+\S/u,
];

/** 이 머리 바로 다음 줄은 구두점이 없어도 한 단위로 남긴다 */
export const EVIDENCE_BODY_HEADING_PATTERN =
  /^\[(?:설명|정책|동작|기능|검증)\]$/u;

/** 묶인 근거 글에서 지우는 내부 출처 줄 */
export const INTERNAL_SOURCE_LINE_PATTERN = /^출처:\s*/u;

/** 줄인 근거 글에서 먼저 남기는 정책 단위와 뒤로 미루는 배경 단위 */
export const POLICY_UNIT_PATTERN = /(정책|조건|예외|단서|취소|회수|만료)/u;
export const BACKGROUND_UNIT_PATTERN =
  /(구현|동작|배경|background|로그|테이블)/iu;

/** 상세 설명을 요청하는 질문. 답변 항목을 더 허용한다 */
export const DETAILED_ANSWER_QUERY_PATTERN =
  /(자세|상세|구체적|길게|detail|step by step|아는\s*대로|다\s*말해|전부\s*말해)/iu;

/** 목록·비교를 요청하는 질문 */
export const LIST_ANSWER_QUERY_PATTERN =
  /(목록|리스트|항목|비교|표로|bullet)/iu;

/** 답변 모드마다 남기는 항목 수. 기본 답변은 고객 응대에 맞게 짧게 둔다 */
export const ANSWER_ITEM_LIMITS: Readonly<Record<PolicyAnswerMode, number>> =
  Object.freeze({ default: 3, list: 4, detailed: 12 });

/** 기본 답변을 줄일 때 마지막에 따로 남기는 예외·한계 항목 */
export const FINAL_EXCEPTION_ITEM_PATTERN =
  /(예외|단서|다만|단,|제외|한계|확인되지)/u;

/**
 * 줄머리의 목록 기호. 기호 뒤에 공백이 있거나 공백 없이 바로 글자가 이어지는 꼴(`-무료 배송 기준`)을 모두 기호로 본다
 * 기호 바로 뒤에 숫자가 오면 음수나 범위(`-15%`)라서, 줄표 두 개(`--`)는 구분선이라서 목록 기호로 보지 않는다
 */
export const LEADING_BULLET_PATTERN = /^[-*•](?:\s+|(?=[^\s\d*•-]))/u;

/** 답변 항목으로 세는 완결 문장. 숫자 뒤 마침표(`1.`, `0.5`)는 문장 끝이 아니다 */
export const ANSWER_SENTENCE_PATTERN = /.+?(?:[!?。]|(?<!\d)\.(?=\s|$))/gu;

/** 근거가 하나도 없을 때의 결정적 답변 */
export const NO_EVIDENCE_ANSWER = '관련 정책 근거를 찾지 못했습니다.';

/** 근거는 있지만 답으로 내보낼 완결 문장이 없을 때의 결정적 답변 */
export const UNANSWERED_EVIDENCE_ANSWER =
  '관련 근거는 찾았지만 질문에 바로 답하는 문장은 찾지 못했습니다.';

/** 결정적 답변에 올리지 않는 문장. 색인 메타데이터, 내부 구현 요약, 코드 비교식, `xxx 정책:` 꼴 기계 요약이다 */
export const INTERNAL_FALLBACK_STATEMENT_PATTERNS: readonly RegExp[] = [
  /(?:관련\s*코드\s*근거|내부\s*(?:항목|구현)|인덱스\s*전략|색인\s*메타)/iu,
  /(?:===|!==|\w\[\d+\]|\b(?:DTO|Entity|Repository|Reader|Domain)\b)/iu,
  /^[a-z][\w-]*\s+정책\s*:/iu,
];

/** 결정적 답변으로 올리는 근거 줄의 끝맺음 */
export const STATEMENT_ENDING_PATTERN =
  /(?:[.!?。]|합니다|됩니다|주세요|않습니다)$/u;
