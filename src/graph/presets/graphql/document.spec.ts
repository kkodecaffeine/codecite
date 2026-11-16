import { describe, expect, it } from 'vitest';
import { parseGraphqlDocument, tokenizeGraphql } from './document.js';

describe('parseGraphqlDocument', () => {
  it('루트 필드는 별칭을 실제 필드로 바꾸고 fragment·지시문·주석·문자열 속 글자는 빼고 읽는다', () => {
    const parsed = parseGraphqlDocument(`# query Hidden { secretField }
query GetOrderDetail($orderId: ID!, $withItems: Boolean = true) @cached(ttl: 30) {
  latest: order(id: $orderId, memo: "{ notAField }") {
    id
    items @include(if: $withItems) {
      sku
    }
  }
  ...ShopSummary
  ... on Query {
    couponCount
  }
  memberPoints(memberId: $orderId) @skip(if: false)
  __typename
}
`);

    expect(parsed).toEqual({
      operations: [
        {
          operationType: 'query',
          operationName: 'GetOrderDetail',
          rootFields: ['order', 'memberPoints'],
          lineStart: 2,
          lineEnd: 15,
          start: 31,
          end: expect.any(Number),
          closed: true,
        },
      ],
    });
  });

  it('여러 연산을 읽고 fragment 와 이름 없는 연산은 건너뛴다', () => {
    const parsed = parseGraphqlDocument(`fragment ShopSummary on Query {
  shopName
}

{ ping }

mutation IssueCoupon($input: CouponInput!) {
  issueCoupon(input: $input) { code }
  refreshPoints
}

subscription OnRefundUpdated { refundUpdated { id } }

query { anonymousField }
`);

    expect(
      parsed.operations.map((operation) => [
        operation.operationType,
        operation.operationName,
        operation.rootFields,
        operation.lineStart,
        operation.lineEnd,
      ]),
    ).toEqual([
      ['mutation', 'IssueCoupon', ['issueCoupon', 'refreshPoints'], 7, 10],
      ['subscription', 'OnRefundUpdated', ['refundUpdated'], 12, 12],
    ]);
    expect(parsed.error).toBeUndefined();
  });

  it('스키마 정의만 있는 문서에서는 연산을 내지 않는다', () => {
    const parsed = parseGraphqlDocument(`"""
Order { query }
"""
type Query {
  order(id: ID!): Order
  coupons(first: Int = 10): [Coupon!]!
}

schema {
  query: Query
  mutation: Mutation
}

scalar DateTime
union SearchResult = Order | Coupon
extend type Query { points: Int }
directive @cached(ttl: Int) on QUERY | FIELD
input CouponInput { code: String }
enum Grade { BRONZE SILVER }
`);

    expect(parsed).toEqual({ operations: [] });
  });

  it('닫히지 않은 연산은 이름과 함께 closed false 로 돌려주고 오류 줄을 남긴다', () => {
    const parsed = parseGraphqlDocument(`query ListRefunds {
  refunds(first: 5) {
    id
`);

    expect(parsed.operations).toEqual([
      expect.objectContaining({
        operationName: 'ListRefunds',
        rootFields: ['refunds'],
        closed: false,
      }),
    ]);
    expect(parsed.error).toEqual({
      line: 1,
      message: 'query ListRefunds is not closed',
    });
  });

  it('끝나지 않은 문자열과 모르는 글자는 줄 번호와 함께 오류로 돌려준다', () => {
    expect(parseGraphqlDocument('query A {\n  a(x: "open\n}')).toEqual({
      operations: [],
      error: { line: 2, message: 'unterminated string' },
    });
    expect(parseGraphqlDocument('query A { a % b }').error).toEqual({
      line: 1,
      message: 'unexpected character "%"',
    });
  });
});

describe('tokenizeGraphql', () => {
  it('블록 문자열의 줄 바꿈을 세어 다음 토큰의 줄 번호를 맞춘다', () => {
    const tokens = tokenizeGraphql('"""\nfirst\nsecond\n"""\nquery');
    expect(tokens.map((token) => [token.kind, token.line])).toEqual([
      ['string', 1],
      ['name', 5],
    ]);
  });
});
