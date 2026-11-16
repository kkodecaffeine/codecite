/** 공개 답변 정제 선택 사항 */
export interface PublicAnswerSanitizerOptions {
  /**
   * 코드 식별자 → 공개 이름(예: `expireJob` → `적립금 만료 처리`)
   * 없는 식별자는 이름 모양으로 정한 역할 낱말("내부 처리", "내부 항목")로 바꾼다
   */
  identifierGlossary?: Readonly<Record<string, string>>;
}
