/** 한글과 영어가 붙어 있으면 답변과 근거 문서에서 읽기 좋게 한 칸 띄운다 */
export function normalizeKoreanEnglishSpacing(value: string): string {
  return value
    .replace(/([가-힣])([A-Za-z])/g, '$1 $2')
    .replace(/([A-Za-z])([가-힣])/g, '$1 $2');
}
