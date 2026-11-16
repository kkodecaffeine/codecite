import { describe, expect, it } from 'vitest';
import {
  tokenizePolicyDocumentText,
  tokenizePolicySearchQuery,
  tokenizePolicySearchText,
} from './tokenizer.js';
import { DEFAULT_KOREAN_VOCABULARY, mergeVocabulary } from './vocabulary.js';

/** 도토리 마켓이 설정 파일로 더하는 서비스 낱말 */
const dotoriVocabulary = mergeVocabulary(DEFAULT_KOREAN_VOCABULARY, {
  synonyms: {
    배송비쿠폰: ['배송비', '쿠폰', 'shippingcoupon'],
    새벽배송: ['dawndelivery'],
    배송: ['shipping'],
    무료배송: ['hasfreeshipping'],
    hasfreeshipping: ['무료배송', '무료'],
  },
});

describe('policy search tokenizer', () => {
  it('객체 프로토타입 이름을 동의어 목록으로 다루지 않는다', () => {
    expect(tokenizePolicyDocumentText('__proto__ 주문')).toEqual([
      '__proto__',
      '주문',
    ]);
    expect(tokenizePolicySearchText('__proto__ __proto__')).toEqual([
      '__proto__',
    ]);
  });

  it('질문에서 조사와 질문 말투 낱말을 걷어 내고 붙여 쓴 낱말을 펼친다', () => {
    const tokens = tokenizePolicySearchQuery(
      '이번 달 배송비쿠폰을 받으려면 뭐가 있어야 돼',
      dotoriVocabulary,
    );

    expect(tokens).toEqual(
      expect.arrayContaining([
        '배송비쿠폰',
        '배송비',
        '쿠폰',
        'shippingcoupon',
      ]),
    );
    expect(tokens).not.toContain('뭐가');
    expect(tokens).not.toContain('배송비쿠폰을');
  });

  it('짧은 정의 어미를 걷어 내되 보통 낱말은 깨뜨리지 않는다', () => {
    expect(
      tokenizePolicySearchQuery(
        '새벽 배송이란 정확히 어떤 거야',
        dotoriVocabulary,
      ),
    ).toEqual(expect.arrayContaining(['새벽', '배송', 'shipping']));
    expect(
      tokenizePolicySearchQuery(
        '새벽배송이란 정확히 어떤 거야',
        dotoriVocabulary,
      ),
    ).toEqual(expect.arrayContaining(['새벽배송', 'dawndelivery']));
    expect(tokenizePolicySearchQuery('우유')).toEqual(['우유']);
  });

  it('대조 어미나 조사 뒤의 짧은 명사를 지나치게 깎지 않는다', () => {
    expect(tokenizePolicySearchQuery('우유말고')).toEqual(['우유']);
    expect(tokenizePolicySearchQuery('우유는')).toEqual(['우유']);
  });

  it('한국어 표현과 코드의 불리언 필드 이름을 잇는다', () => {
    expect(
      tokenizePolicySearchQuery('제주도도 무료배송 돼?', dotoriVocabulary),
    ).toEqual(expect.arrayContaining(['무료배송', 'hasfreeshipping']));
    expect(
      tokenizePolicyDocumentText('order.hasFreeShipping', dotoriVocabulary),
    ).toEqual(expect.arrayContaining(['hasfreeshipping', '무료배송', '무료']));
  });

  it('구어체 동사 끝을 걷어 내 구매 같은 업무 낱말만 남긴다', () => {
    expect(
      tokenizePolicySearchQuery('지난주에 운동화 구매했지만 적립금이 안 보여'),
    ).toEqual(expect.arrayContaining(['운동화', '구매', '적립금']));
  });

  it('익일 표현을 전날·다음날 표현과 잇는다', () => {
    expect(tokenizePolicySearchQuery('반품 환불은 익일 처리되나')).toEqual(
      expect.arrayContaining(['익일', '전날', '다음날']),
    );
  });

  it('한국어 업무 낱말을 코드 경로의 영문 이름과 잇는다', () => {
    expect(
      tokenizePolicySearchQuery('셀러 판매 이력도 리뷰 쓸 때 검증해?'),
    ).toEqual(
      expect.arrayContaining(['sale', 'history', 'review', 'validation']),
    );
  });

  it('구어체 시점 질문에서 언제와 업무 낱말을 남긴다', () => {
    expect(tokenizePolicySearchQuery('웰컴 쿠폰 발급 언제돼')).toEqual(
      expect.arrayContaining(['쿠폰', '발급', '언제']),
    );
    expect(
      tokenizePolicySearchQuery('웰컴 쿠폰이 언제 발급되는지 궁금'),
    ).toEqual(expect.arrayContaining(['쿠폰', '언제', '발급']));
  });

  it('사람을 가리키는 낱말에서 대조 어미를 떼어 낸다', () => {
    expect(
      tokenizePolicySearchQuery('배송지 수정은 본인말고 가족이 해도 되나'),
    ).toEqual(expect.arrayContaining(['배송지', '수정', '본인']));
  });

  it('붙여 쓴 낱말 안의 동의어 낱말을 펼치고 요청 말투 낱말은 뺀다', () => {
    const tokens = tokenizePolicySearchQuery(
      '적립취소 프로세스 다 말해봐, 아는대로!',
    );

    expect(tokens).toEqual(
      expect.arrayContaining(['적립취소', '적립', '취소', 'cancel']),
    );
    for (const filler of ['프로세스', '아는대로', '아는대', '다', '말해봐']) {
      expect(tokens).not.toContain(filler);
    }
  });
});

describe('사전 주입', () => {
  it('사전을 주지 않으면 한국어 기본 사전을 쓴다', () => {
    const question = '쿠폰 유효기간 지나면 어떻게 돼요? 알려주세요';

    expect(tokenizePolicySearchQuery(question)).toEqual(
      tokenizePolicySearchQuery(question, DEFAULT_KOREAN_VOCABULARY),
    );
    expect(tokenizePolicyDocumentText(question)).toEqual(
      tokenizePolicyDocumentText(question, DEFAULT_KOREAN_VOCABULARY),
    );
  });

  it('서비스 동의어를 더하면 그 낱말도 함께 검색한다', () => {
    const vocabulary = mergeVocabulary(DEFAULT_KOREAN_VOCABULARY, {
      synonyms: { 적립금: ['포인트', '리워드'] },
    });

    expect(
      tokenizePolicySearchQuery('적립금 다 쓰면 다시 쌓여?', vocabulary),
    ).toEqual(expect.arrayContaining(['적립금', '포인트', '리워드']));
    expect(
      tokenizePolicySearchQuery('적립금 다 쓰면 다시 쌓여?'),
    ).not.toContain('포인트');
  });

  it('서비스 불용어는 어미를 걷어 낸 모양까지 뺀다', () => {
    const vocabulary = mergeVocabulary(DEFAULT_KOREAN_VOCABULARY, {
      stopwords: ['궁금해요'],
    });

    expect(tokenizePolicySearchQuery('교환 궁금해요', vocabulary)).toEqual([
      '교환',
    ]);
    expect(tokenizePolicySearchQuery('교환 궁금해요')).toContain('궁금');
  });

  it('기본 사전 없이 빈 사전만 주면 질문 말투 낱말도 남는다', () => {
    const empty = { synonyms: {}, stopwords: [], groupAliases: {} };

    expect(tokenizePolicySearchQuery('교환 뭐가 있어', empty)).toEqual([
      '교환',
      '뭐가',
      '있어',
    ]);
  });
});
