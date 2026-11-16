import { describe, expect, it } from 'vitest';
import type { PolicyClaimProps } from '../domain/types.js';
import type { PolicyEvidence } from '../generation/types.js';
import {
  DEFAULT_KOREAN_VOCABULARY,
  mergeVocabulary,
} from '../text/vocabulary.js';
import { isPolicyEvidenceSufficient } from './evidence-sufficiency.js';

const COUPON_BOX_COUNT = '쿠폰함에 쿠폰 몇 개까지 들어가?';
const CHAT_HOURS = '고객센터 채팅은 몇 시부터 몇 시까지 해?';
const FREE_RETURN_CRITERION = '무료 반품 대상인지 무엇으로 판단해?';

describe('isPolicyEvidenceSufficient', () => {
  it('근거가 없으면 부족하다', () => {
    expect(isPolicyEvidenceSufficient(COUPON_BOX_COUNT, [])).toBe(false);
  });

  it('개수 질문에 개수 근거가 없으면 부족하다', () => {
    expect(
      isPolicyEvidenceSufficient(COUPON_BOX_COUNT, [
        evidence('쿠폰함 화면에서 받은 쿠폰을 확인한다.'),
      ]),
    ).toBe(false);
  });

  it('개수 질문에 amount claim 이 있으면 충분하다', () => {
    expect(
      isPolicyEvidenceSufficient(COUPON_BOX_COUNT, [
        withClaim('쿠폰함에는 쿠폰을 30개까지 보관한다.', {
          claimId: 'coupon-box-capacity',
          facet: 'amount',
        }),
      ]),
    ).toBe(true);
  });

  it('기술 질문은 정책 근거만으로 충분하다고 보지 않는다', () => {
    expect(
      isPolicyEvidenceSufficient('반품 API 응답 코드는 뭐가 있어?', [
        evidence('반품 요청을 받는다.'),
      ]),
    ).toBe(false);
  });

  it('질문 낱말만 겹치는 내부 구현 설명은 충분한 정책 근거로 보지 않는다', () => {
    expect(
      isPolicyEvidenceSufficient('새벽배송 권역이 어디야?', [
        evidence('shipping 정책: 새벽배송 권역 코드를 배송 목록 맨 위에 둔다.'),
      ]),
    ).toBe(false);
  });

  it('내부 구현 설명에 개수가 있어도 claim 이 없으면 부족하다', () => {
    expect(
      isPolicyEvidenceSufficient(COUPON_BOX_COUNT, [
        {
          ...evidence('쿠폰함 내부 캐시는 최대 50개 항목을 둔다.'),
          contextKind: 'technical',
        },
      ]),
    ).toBe(false);
  });

  it('다른 기능의 수량 claim 은 지금 질문의 근거로 쓰지 않는다', () => {
    expect(
      isPolicyEvidenceSufficient(COUPON_BOX_COUNT, [
        withClaim('장바구니에는 상품을 50개까지 담는다.', {
          claimId: 'cart-capacity',
          facet: 'amount',
        }),
      ]),
    ).toBe(false);
  });

  it('개수 질문에 금액 claim 만 있으면 부족하다', () => {
    expect(
      isPolicyEvidenceSufficient(COUPON_BOX_COUNT, [
        withClaim('쿠폰함 쿠폰은 최대 할인 금액을 함께 보여 준다.', {
          claimId: 'coupon-box-discount',
          facet: 'amount',
          subject: '쿠폰함 쿠폰 할인 금액',
        }),
      ]),
    ).toBe(false);
  });

  it('개수 질문에 보관 수량 claim 이 있으면 충분하다', () => {
    expect(
      isPolicyEvidenceSufficient(COUPON_BOX_COUNT, [
        withClaim('쿠폰함 보관 수량은 최대 30개다.', {
          claimId: 'coupon-box-quantity',
          facet: 'amount',
          subject: '쿠폰함 보관 수량',
        }),
      ]),
    ).toBe(true);
  });

  it('시각 범위 질문에 시각이 없는 claim 만 있으면 부족하다', () => {
    expect(
      isPolicyEvidenceSufficient(CHAT_HOURS, [
        withClaim('고객센터 채팅은 상담원이 들어온 순서대로 답한다.', {
          claimId: 'chat-order',
          facet: 'outcome',
          subject: '고객센터 채팅',
        }),
      ]),
    ).toBe(false);
  });

  it('시각 범위 질문에 분 단위 대기 시간만 있으면 부족하다', () => {
    expect(
      isPolicyEvidenceSufficient(CHAT_HOURS, [
        withClaim('고객센터 채팅 대기 시간은 보통 15분 안팎이다.', {
          claimId: 'chat-wait',
          facet: 'schedule',
          subject: '고객센터 채팅 대기',
        }),
      ]),
    ).toBe(false);
  });

  it('시각 범위 질문에 시작과 끝 시각이 있는 schedule claim 이면 충분하다', () => {
    expect(
      isPolicyEvidenceSufficient(CHAT_HOURS, [
        withClaim('고객센터 채팅은 오전 10시에 열고 오후 6시에 닫는다.', {
          claimId: 'chat-hours',
          facet: 'schedule',
          subject: '고객센터 채팅 운영 시각',
        }),
      ]),
    ).toBe(true);
  });

  it('판단 기준 질문은 대상 이름만 겹치는 근거로 충분하다고 보지 않는다', () => {
    expect(
      isPolicyEvidenceSufficient(FREE_RETURN_CRITERION, [
        withClaim('무료 반품 대상 상품은 상세 페이지에 표시한다.', {
          claimId: 'free-return-badge',
          facet: 'outcome',
          subject: '무료 반품 대상',
        }),
      ]),
    ).toBe(false);
  });

  it('판단 기준 질문은 절차 claim 만으로 충분하다고 보지 않는다', () => {
    expect(
      isPolicyEvidenceSufficient(FREE_RETURN_CRITERION, [
        withClaim('무료 반품 판단은 반품 정책 모듈이 맡는다.', {
          claimId: 'free-return-owner',
          facet: 'procedure',
          subject: '무료 반품 판단',
        }),
      ]),
    ).toBe(false);
  });

  it('판단 기준 질문에 조건을 가진 자격 claim 이 있으면 충분하다', () => {
    expect(
      isPolicyEvidenceSufficient(FREE_RETURN_CRITERION, [
        withClaim(
          '받은 지 7일 안이고 상품 하자가 확인되면 무료 반품으로 본다.',
          {
            claimId: 'free-return-rule',
            facet: 'eligibility',
            subject: '무료 반품 판단 기준',
            conditions: ['받은 지 7일 안', '상품 하자 확인'],
          },
        ),
      ]),
    ).toBe(true);
  });

  it('내부 운영 지식 claim 은 답의 근거로 세지 않는다', () => {
    expect(
      isPolicyEvidenceSufficient(COUPON_BOX_COUNT, [
        withClaim('쿠폰함 보관 수량은 최대 30개다.', {
          claimId: 'coupon-box-quantity-internal',
          facet: 'amount',
          subject: '쿠폰함 보관 수량',
          knowledgeKind: 'internal-operation',
        }),
      ]),
    ).toBe(false);
  });

  it('서비스 사전의 동의어로 질문 낱말과 claim 을 잇는다', () => {
    const question = '포인트 한도는 얼마야?';
    const evidenceList = [
      withClaim('적립금은 주문 하나에 3,000 원까지만 쓴다.', {
        claimId: 'points-usage-cap',
        facet: 'amount',
      }),
    ];
    const vocabulary = mergeVocabulary(DEFAULT_KOREAN_VOCABULARY, {
      synonyms: { 포인트: ['적립금'] },
    });

    expect(isPolicyEvidenceSufficient(question, evidenceList)).toBe(false);
    expect(isPolicyEvidenceSufficient(question, evidenceList, vocabulary)).toBe(
      true,
    );
  });
});

function evidence(text: string): PolicyEvidence {
  return {
    chunkId: 'fixture',
    policyCode: 'FIXTURE',
    section: '정책',
    internalSource: 'fixture.csv',
    sourceLabel: '정책 문서',
    text,
    contextKind: 'policy',
  };
}

function withClaim(
  statement: string,
  claim: Omit<
    PolicyClaimProps,
    'statement' | 'confidence' | 'provenanceChunkIds'
  >,
): PolicyEvidence {
  return {
    ...evidence(statement),
    policyClaims: [
      {
        ...claim,
        statement,
        confidence: 'high',
        provenanceChunkIds: ['fixture'],
      },
    ],
  };
}
