import { describe, expect, it } from 'vitest';
import { inferPolicyFacet } from './facet-inference.js';

describe('inferPolicyFacet', () => {
  it.each([
    ['적립금은 적립일부터 1 년 뒤 소멸한다', 'expiration'],
    ['쿠폰 유효 기간이 지나면 쓸 수 없다', 'expiration'],
    ['주문을 취소하면 사용한 적립금을 되돌린다', 'reversal'],
    ['배송 완료 즉시 구매 적립 작업을 등록한다', 'schedule'],
    ['적립금은 구매 확정 다음 날 지급된다', 'schedule'],
    ['추천 상품 노출 기준과 갱신 주기를 정한다', 'schedule'],
    ['교환 신청은 수령 후 며칠 안에 해야 한다', 'duration'],
    ['골드 등급 회원만 무료 배송 대상이다', 'eligibility'],
    ['한 주문에 쓸 수 있는 적립금 한도를 둔다', 'amount'],
    ['재고가 없으면 주문을 거부한다', 'exception'],
    ['배송지 정보를 저장한다', 'procedure'],
  ])('%s → %s', (description, facet) => {
    expect(inferPolicyFacet(description)).toBe(facet);
  });

  it('앞 규칙이 먼저 이긴다', () => {
    expect(inferPolicyFacet('주문 취소 시 적립금 소멸')).toBe('expiration');
    expect(inferPolicyFacet('환불 금액 한도')).toBe('reversal');
  });

  it('claim 문장도 함께 본다', () => {
    expect(
      inferPolicyFacet('리뷰 작성', [
        {
          statement: '사진 리뷰는 작성 다음 날 적립된다',
          facet: 'outcome',
        },
      ]),
    ).toBe('schedule');
  });

  it('예외를 던지는 claim 은 exception 으로 본다', () => {
    expect(
      inferPolicyFacet('쿠폰 적용', [
        { statement: 'apply coupon', predicate: 'throws', facet: 'outcome' },
      ]),
    ).toBe('exception');
  });

  it('어디에도 맞지 않으면 첫 claim 의 종류나 outcome 을 쓴다', () => {
    expect(
      inferPolicyFacet('배송 안내', [
        { statement: '택배사 안내', facet: 'amount' },
      ]),
    ).toBe('amount');
    expect(inferPolicyFacet('배송 안내')).toBe('outcome');
  });
});
