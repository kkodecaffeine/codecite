import type { KoreanParticle } from './types.js';

/** 받침 있는 모양과 받침 없는 모양 */
export const KOREAN_PARTICLE_PAIRS: Readonly<
  Record<KoreanParticle, readonly [string, string]>
> = {
  은: ['은', '는'],
  이: ['이', '가'],
  을: ['을', '를'],
  으로: ['으로', '로'],
};

/** 조사 모양 → 받침 있는 쪽 기본형 */
export const KOREAN_PARTICLE_BASE: Readonly<Record<string, KoreanParticle>> = {
  은: '은',
  는: '은',
  이: '이',
  가: '이',
  을: '을',
  를: '을',
  으로: '으로',
  로: '으로',
};

/** 완성형 한글 음절 범위와 ㄹ 받침 번호. `으로` 는 ㄹ 받침 뒤에서도 `로` 가 된다 */
export const HANGUL_SYLLABLE_START = 0xac00;
export const HANGUL_SYLLABLE_END = 0xd7a3;
export const HANGUL_RIEUL_FINAL = 8;

/** 자동으로 만든 질문 예시에서 주제 바로 뒤 조사를 찾는 패턴 */
export const TEMPLATE_QUESTION_PARTICLE_PATTERN =
  /^(.*?[가-힣])(으로|로|은|는|이|가|을|를) (?=어떻게|적용되지|실패하거나|얼마를|언제|얼마나|취소하거나|만료 처리)/u;

/** 질문 말투라 검색어에서 빼는 낱말 */
export const DEFAULT_KOREAN_STOPWORDS: readonly string[] = [
  '정책',
  '정책에',
  '설명',
  '알려줘',
  '알려주세요',
  '알려',
  '대해서',
  '관해서',
  '관한',
  '좀',
  '뭐야',
  '무엇',
  '뭐',
  '뭐가',
  '어떤',
  '무슨',
  '프로세스',
  '아는대로',
  '아는대',
  '다',
  '말해봐',
  '말해줘',
  '있어',
  '있나요',
  '있지',
  '줘',
  '주세요',
  '인가요',
  '일까',
  '왜',
  '사용자',
  '못',
  '받지',
];

/**
 * 특정 서비스와 무관한 기본 동의어. 붙여 쓴 말과 띄어 쓴 말, 날짜·시간 표현,
 * 흔한 정책 낱말과 그 영문 코드 이름을 잇는다
 */
export const DEFAULT_KOREAN_SYNONYMS: Readonly<
  Record<string, readonly string[]>
> = {
  탈퇴회원: ['회원탈퇴', '회원', '탈퇴'],
  회원탈퇴: ['탈퇴회원', '회원', '탈퇴'],
  탈퇴: ['withdrawal', 'withdraw'],
  상품평: ['review', 'product-review'],
  리뷰: ['review', 'product-review'],
  검증: ['validation', 'validate'],
  문자열: ['string', 'length'],
  판매: ['sale'],
  이력: ['history'],
  푸시: ['push', 'notification'],
  시부터: ['time', 'hour'],
  시까지: ['time', 'hour'],
  적립: ['earn', '지급'],
  취소: ['cancel', '회수', '차감'],
  회수: ['cancel', '취소', '차감', 'deduct'],
  만료: ['expire', '소멸'],
  알림: ['notification', 'push'],
  익일: ['전날', '다음날'],
  전날: ['익일', '다음날'],
  다음날: ['익일', '전날'],
};
