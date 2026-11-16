import { describe, expect, it } from 'vitest';
import {
  projectKnowledgeText,
  projectPolicyChunks,
} from './chunk-projector.js';
import { PolicyCode } from './policy-code.js';
import { PolicyStatus } from './policy-status.js';
import { Policy } from './policy.js';

describe('policy chunk projector', () => {
  it('답변 근거를 기술 섹션과 검색 전용 섹션에서 떼어 낸다', () => {
    const projections = projectKnowledgeText(
      [
        '[기능]',
        '부분 환불',
        '',
        '[요약]',
        '- 묶음 주문에서 상품 일부만 돌려받을 수 있다.',
        '',
        '[정책]',
        '- 남은 상품 금액이 쿠폰 최소 금액보다 작아지면 쿠폰 할인을 뺀다.',
        '',
        '[동작]',
        '1. 고른 상품만 환불 금액을 다시 셈한다.',
        '',
        '[검증]',
        '- 주문 번호가 비면 요청을 받지 않는다.',
        '',
        '[API]',
        '- POST /refunds/partial',
        '',
        '[외부 연동]',
        '- Payment Gateway',
        '',
        '[질문 예시]',
        '- 두 개 중 하나만 반품해도 되나요?',
        '',
        '[검색 키워드]',
        '부분 환불, 쿠폰 재계산',
        '',
        '[내부 항목]',
        'PartialRefundHandler',
        '',
        '[사용자 질문 예시]',
        '- 하나만 돌려보내면 돈은 얼마 와요?',
        '',
        '[검색 표현]',
        '일부 반품 | 쪼개서 환불',
        '',
        '[실행 연결]',
        'RefundController -> PaymentClient',
        '',
        '[검증 출처]',
        'internal/checkout/refund',
      ].join('\n'),
      '부분 환불',
      'partial_refund',
    );

    expect(projections).toHaveLength(2);
    const policy = projections.find((item) => item.contextKind === 'policy');
    const technical = projections.find(
      (item) => item.contextKind === 'technical',
    );

    expect(policy?.text).toContain('[정책]');
    expect(policy?.text).toContain('[동작]');
    expect(policy?.text).not.toContain('[API]');
    expect(policy?.text).not.toContain('[질문 예시]');
    expect(policy?.text).not.toContain('[내부 항목]');
    expect(policy?.text).not.toContain('[사용자 질문 예시]');
    expect(policy?.text).not.toContain('[검색 표현]');
    expect(policy?.text).not.toContain('[실행 연결]');
    expect(policy?.text).not.toContain('[검증 출처]');
    expect(policy?.searchText).toContain('[질문 예시]');
    expect(policy?.searchText).toContain('[사용자 질문 예시]');
    expect(policy?.searchText).toContain('[검색 표현]');
    expect(policy?.searchText).toContain('도메인: partial_refund');
    expect(technical?.text).not.toContain('[동작]');
    expect(technical?.text).toContain('[검증]');
    expect(technical?.text).toContain('[외부 연동]');
    expect(technical?.text).toContain('[실행 연결]');
    expect(technical?.text).toContain('[검증 출처]');
    expect(technical?.text).not.toContain('[정책]');
    expect(technical?.searchText).toContain('[검색 키워드]');
  });

  it('모르는 정책 섹션, 기능만 있는 글, 머리말 없는 글을 그대로 정책 조각으로 둔다', () => {
    expect(
      projectKnowledgeText(
        '[기능]\n교환\n\n[상담 메모]\n- 상담원이 사진을 보고 정한다.',
        '교환',
        'cs',
      ),
    ).toEqual([
      expect.objectContaining({
        contextKind: 'policy',
        text: expect.stringContaining('[상담 메모]'),
      }),
    ]);
    expect(
      projectKnowledgeText('[기능]\n제목 한 줄뿐인 메모', '메모', 'old'),
    ).toEqual([
      expect.objectContaining({
        contextKind: 'policy',
        text: '[기능]\n제목 한 줄뿐인 메모',
      }),
    ]);
    expect(
      projectKnowledgeText(
        '머리말을 붙이기 전에 쓴 옛 안내문',
        '옛 안내',
        'old',
      ),
    ).toEqual([
      expect.objectContaining({
        contextKind: 'policy',
        text: '머리말을 붙이기 전에 쓴 옛 안내문',
      }),
    ]);
  });

  it('처리 순서와 앞뒤 흐름 섹션은 답변 근거 글에만 두고 검색 글에서는 뺀다', () => {
    const [policy] = projectKnowledgeText(
      [
        '[정책 안내]',
        '배송 정책: 출고 전 주소 변경.',
        '[처리 순서]',
        '1. 출고 상태 확인',
        '2. 새 주소로 송장 다시 발급',
        '[실행되는 때]',
        '- 고객이 마이페이지에서 받는 곳을 고치면 돈다',
        '[이어지는 처리]',
        '- 바뀐 주소 기준으로 도착 예정일 다시 계산',
      ].join('\n'),
      'shipping: AddressChangeService.change',
      'shipping',
    );

    expect(policy.text).toContain(
      '[처리 순서]\n1. 출고 상태 확인\n2. 새 주소로 송장 다시 발급',
    );
    expect(policy.text).toContain('[이어지는 처리]');
    expect(policy.searchText).toContain('배송 정책: 출고 전 주소 변경.');
    expect(policy.searchText).not.toMatch(
      /처리 순서|출고 상태 확인|실행되는 때|이어지는 처리/u,
    );
  });

  it('정책 조각과 기술 조각이 정책 코드 하나와 안정적인 id 를 함께 쓴다', () => {
    const source = 'rules.csv#row-9';
    const policy = Policy.create({
      name: '쿠폰 사용',
      decision: '한 주문에 쿠폰은 한 장',
      status: PolicyStatus.of('Active'),
      section: 'coupon',
      code: PolicyCode.of('COUPON-007'),
      source,
      knowledgeText:
        '[기능]\n쿠폰 사용\n\n[정책]\n- 쿠폰은 주문마다 한 장.\n\n[API]\n- POST /coupons/apply',
    });

    const chunks = projectPolicyChunks(policy);

    expect(chunks.map((chunk) => chunk.policyCode)).toEqual([
      'COUPON-007',
      'COUPON-007',
    ]);
    expect(chunks.map((chunk) => chunk.id)).toEqual([
      `${source}#COUPON-007`,
      `${source}#COUPON-007#technical`,
    ]);
  });

  it('코드 심볼 문서는 기술 조각 하나로 만든다', () => {
    const projections = projectKnowledgeText(
      '[심볼]\nShippingFeeCalculator.total\n\n[설명]\n묶음 상자 수로 배송비를 더한다.\n\n[구조]\n- 종류: 함수\n\n[관계]\n- READS: shipping_rates\n\n[호출됨]\n- CheckoutService.place\n\n[소스 코드]\ntotal() { return 0; }',
      'ShippingFeeCalculator.total',
      'shipping',
    );

    expect(projections).toEqual([
      expect.objectContaining({
        contextKind: 'technical',
        text: expect.stringContaining('READS: shipping_rates'),
        searchText: expect.stringContaining('ShippingFeeCalculator.total'),
      }),
    ]);
  });
});
