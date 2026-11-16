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
