import { describe, expect, it } from 'vitest';
import type { PolicyClaimProps } from '../domain/types.js';
import { guardGeneratedAnswer } from './answer-guard.js';
import { NO_EVIDENCE_ANSWER } from './constants.js';
import { deterministicPolicyFallback } from './fallback.js';
import type { PolicyEvidence } from './types.js';

const claim = (
  claimId: string,
  statement: string,
  overrides: Partial<PolicyClaimProps> = {},
): PolicyClaimProps => ({
  claimId,
  facet: 'outcome',
  statement,
  confidence: 'high',
  provenanceChunkIds: [claimId],
  ...overrides,
});

const refundEvidence: PolicyEvidence[] = [
  {
    chunkId: 'refund',
    policyCode: 'DOTORI-REFUND',
    section: '단순 변심 환불',
    internalSource: 'shop/policies.csv#refund',
    sourceLabel: 'policies.csv',
    text: '',
    policyGroup: 'refund',
    policyClaims: [
      claim(
        'refund-window',
        '단순 변심 환불은 상품을 받고 10 일 안에 신청할 수 있다.',
        { facet: 'duration' },
      ),
      claim('refund-custom', '각인을 새긴 맞춤 상품은 환불하지 않는다.', {
        facet: 'exception',
      }),
      claim('refund-desk', '교환과 환불 접수는 고객센터 채팅으로 받는다.', {
        facet: 'procedure',
      }),
    ],
  },
];

const shippingEvidence: PolicyEvidence[] = [
  {
    chunkId: 'shipping',
    policyCode: 'DOTORI-SHIP',
    section: '배송비',
    internalSource: 'shop/policies.csv#shipping',
    sourceLabel: 'policies.csv',
    text: '',
    policyGroup: 'shipping',
    policyClaims: [
      claim('free', '4만 원 이상 주문은 배송비가 무료다.', { facet: 'amount' }),
    ],
  },
];

const fallbackFor = (question: string, evidence = refundEvidence) =>
  deterministicPolicyFallback({ question, evidence });

describe('guardGeneratedAnswer', () => {
  it('근거에 맞는 답은 그대로 통과시킨다', () => {
    const answer = '상품을 받은 지 10 일 안이면 환불을 신청할 수 있어요.';

    expect(
      guardGeneratedAnswer({
        question: '환불은 며칠 안에 해야 해요?',
        answer,
        evidence: refundEvidence,
      }),
    ).toEqual({ answer, replaced: false });
  });

  it('근거에 없는 숫자를 쓰면 결정적 답변으로 바꾼다', () => {
    const question = '환불은 며칠 안에 해야 해요?';

    const result = guardGeneratedAnswer({
      question,
      answer: '받은 날부터 14 일 안에 환불을 신청하면 돼요.',
      evidence: refundEvidence,
    });

    expect(result).toEqual({
      answer: fallbackFor(question),
      replaced: true,
      reason: 'invented_figure',
    });
    expect(result.answer).toContain('10 일');
  });

  it('질문에 나온 숫자와 표기만 다른 근거 숫자는 지어낸 것으로 보지 않는다', () => {
    expect(
      guardGeneratedAnswer({
        question: '받은 지 12 일 지났는데 환불돼요?',
        answer: '12 일이 지나 10 일 기한을 넘겼으니 단순 변심 환불은 어려워요.',
        evidence: refundEvidence,
      }).replaced,
    ).toBe(false);
    expect(
      guardGeneratedAnswer({
        question: '배송비 무료 기준은?',
        answer: '40,000원 이상 주문하면 배송비가 없어요.',
        evidence: shippingEvidence,
      }).replaced,
    ).toBe(false);
  });

  it('줄머리 번호는 숫자로 세지 않는다', () => {
    expect(
      guardGeneratedAnswer({
        question: '환불 규칙 정리해 줘',
        answer:
          '1. 받고 10 일 안에 신청해요.\n2. 각인 맞춤 상품은 환불이 안 돼요.',
        evidence: refundEvidence,
      }).replaced,
    ).toBe(false);
  });

  it('근거가 있는데 고객센터로 떠넘기면 답을 피한 것으로 본다', () => {
    const result = guardGeneratedAnswer({
      question: '배송비 무료 기준은?',
      answer: '자세한 기준은 고객센터에 문의하세요.',
      evidence: shippingEvidence,
    });

    expect(result.replaced).toBe(true);
    expect(result.reason).toBe('evasive');
    expect(result.answer).toBe(
      fallbackFor('배송비 무료 기준은?', shippingEvidence),
    );
  });

  it('근거가 그 창구를 안내하면 창구를 말해도 답으로 본다', () => {
    expect(
      guardGeneratedAnswer({
        question: '환불은 어디로 접수해요?',
        answer: '고객센터로 연락해 채팅으로 접수하면 돼요.',
        evidence: refundEvidence,
      }).replaced,
    ).toBe(false);
  });

  it('근거가 있는데 첫 문장부터 확인되지 않는다고 하면 결정적 답변으로 바꾼다', () => {
    expect(
      guardGeneratedAnswer({
        question: '환불 기간은?',
        answer: '관련 내용은 정책 자료에서 확인되지 않습니다.',
        evidence: refundEvidence,
      }).reason,
    ).toBe('evasive');
  });

  it('결론을 말한 뒤 나머지를 확인하지 못했다고 하는 것은 피한 답이 아니다', () => {
    expect(
      guardGeneratedAnswer({
        question: '환불 기간과 반품 택배비는?',
        answer:
          '받고 10 일 안에 환불을 신청할 수 있어요. 반품 택배비는 자료로 확인할 수 없었어요.',
        evidence: refundEvidence,
      }).replaced,
    ).toBe(false);
  });

  it('자세한 조건은 알려 줄 수 없다고 비켜 가면 결정적 답변으로 바꾼다', () => {
    expect(
      guardGeneratedAnswer({
        question: '환불 기간은?',
        answer: '환불은 가능합니다. 구체적인 조건은 안내해 드리기 어렵습니다.',
        evidence: refundEvidence,
      }).reason,
    ).toBe('evasive');
  });

  it('끝에 붙은 상담형 마무리 말은 떼고 통과시킨다', () => {
    expect(
      guardGeneratedAnswer({
        question: '환불 기간은?',
        answer:
          '받고 10 일 안에 환불을 신청할 수 있어요. 더 궁금한 점이 있으면 고객센터로 문의해 주세요.',
        evidence: refundEvidence,
      }),
    ).toEqual({
      answer: '받고 10 일 안에 환불을 신청할 수 있어요.',
      replaced: false,
    });
  });

  it('마무리 말만 있으면 빈 답으로 보고 결정적 답변으로 바꾼다', () => {
    expect(
      guardGeneratedAnswer({
        question: '환불 기간은?',
        answer: '도움이 되셨길 바랍니다.',
        evidence: refundEvidence,
      }).reason,
    ).toBe('empty');
  });

  it('고객이 얻는 결과 없이 구현 작업만 말하면 결정적 답변으로 바꾼다', () => {
    expect(
      guardGeneratedAnswer({
        question: '배송비 무료 기준은?',
        answer: '주문 레코드를 조회한 뒤 플래그를 업데이트합니다.',
        evidence: shippingEvidence,
      }).reason,
    ).toBe('implementation_only');
  });

  it('기술 구현을 묻는 질문에는 구현 작업 답을 막지 않는다', () => {
    expect(
      guardGeneratedAnswer({
        question: '배송비 계산 스케줄러는 어떻게 동작해?',
        answer: '주문 레코드를 조회한 뒤 플래그를 업데이트합니다.',
        evidence: shippingEvidence,
      }).replaced,
    ).toBe(false);
  });

  it('근거와 질문에 없는 조건 낱말을 덧붙이면 결정적 답변으로 바꾼다', () => {
    expect(
      guardGeneratedAnswer({
        question: '환불 기간은?',
        answer: '영업일 기준으로 10 일 안에 환불을 신청해야 해요.',
        evidence: refundEvidence,
      }).reason,
    ).toBe('invented_condition');
    expect(
      guardGeneratedAnswer({
        question: '환불 기간은?',
        answer: '받고 10 일 안에 신청하면 되지만 상품에 따라 다를 수 있어요.',
        evidence: refundEvidence,
      }).reason,
    ).toBe('invented_condition');
  });

  it('조건 낱말이 근거나 질문에 있으면 지어낸 것이 아니다', () => {
    expect(
      guardGeneratedAnswer({
        question: '환불 기간은 영업일 기준이에요?',
        answer: '영업일이 아니라 받은 날부터 10 일이에요.',
        evidence: refundEvidence,
      }).replaced,
    ).toBe(false);
  });

  it('지어낸 조건으로 볼 낱말을 바꿀 수 있다', () => {
    const result = guardGeneratedAnswer({
      question: '환불 기간은?',
      answer: '포장 상태가 좋으면 10 일 안에 환불돼요.',
      evidence: refundEvidence,
      inventedConditionTerms: ['포장 상태'],
    });

    expect(result.reason).toBe('invented_condition');
  });

  it('근거가 없으면 모델 답을 쓰지 않는다', () => {
    expect(
      guardGeneratedAnswer({
        question: '매장 픽업 돼요?',
        answer: '네, 모든 매장에서 됩니다.',
        evidence: [],
      }),
    ).toEqual({
      answer: NO_EVIDENCE_ANSWER,
      replaced: true,
      reason: 'no_evidence',
    });
  });

  it('바꿀 때 답변 길이 모드를 결정적 답변에 넘긴다', () => {
    const result = guardGeneratedAnswer({
      question: '환불 규칙 자세히',
      answer: '30 일 안에 환불돼요.',
      evidence: refundEvidence,
      answerMode: 'detailed',
    });

    expect(result.answer.split('\n')).toHaveLength(3);
  });
});
