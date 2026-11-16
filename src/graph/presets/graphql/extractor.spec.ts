import { describe, expect, it } from 'vitest';
import { graphqlDocumentExtractor } from './extractor.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

describe('graphqlDocumentExtractor', () => {
  it('이름 있는 연산마다 심볼을 내고, 스키마 정의 파일은 비워 두고, 읽다 막힌 파일은 까닭과 함께 건너뛴다', async () => {
    const extractor = graphqlDocumentExtractor();
    const result = await extractor.extract(
      [
        {
          repository: 'shop-web',
          filePath: 'src/graphql/orders.graphql',
          content: `fragment OrderLine on Order {
  id
}

query ListOrders($first: Int) {
  orders(first: $first) { ...OrderLine }
}

mutation CancelOrder($orderId: ID!) {
  cancelOrder(orderId: $orderId) { id }
}
`,
        },
        {
          repository: 'shop-web',
          filePath: 'src/graphql/schema.gql',
          content: 'type Query {\n  orders: [Order]\n}\n',
        },
        {
          repository: 'shop-web',
          filePath: 'src/graphql/refunds.graphql',
          content: 'query ListRefunds {\n  refunds {\n',
        },
        {
          repository: 'shop-web',
          filePath: 'src/orders/list.ts',
          content: 'export const x = 1;\n',
        },
      ],
      { repository: 'shop-web', logger },
    );

    expect(extractor.extensions).toEqual(['.graphql', '.gql']);
    expect(result).toEqual({
      symbols: [
        {
          filePath: 'src/graphql/orders.graphql',
          language: 'graphql',
          symbol: 'ListOrders',
          kind: 'operation',
          content:
            'query ListOrders($first: Int) {\n  orders(first: $first) { ...OrderLine }\n}',
          lineStart: 5,
          lineEnd: 7,
          description: 'query ListOrders: orders',
          relations: [],
        },
        {
          filePath: 'src/graphql/orders.graphql',
          language: 'graphql',
          symbol: 'CancelOrder',
          kind: 'operation',
          content:
            'mutation CancelOrder($orderId: ID!) {\n  cancelOrder(orderId: $orderId) { id }\n}',
          lineStart: 9,
          lineEnd: 11,
          description: 'mutation CancelOrder: cancelOrder',
          relations: [],
        },
      ],
      failures: [
        {
          filePath: 'src/graphql/refunds.graphql',
          message: 'line 1: query ListRefunds is not closed',
        },
      ],
    });
  });
});
