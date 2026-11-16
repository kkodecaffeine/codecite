import { describe, expect, it } from 'vitest';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  Detection,
  DetectionPreset,
  ExtractedSymbol,
  GraphConfig,
  GraphHints,
  PresetContext,
} from '../../types.js';
import { graphqlDocumentExtractor } from './extractor.js';
import {
  APOLLO_CLIENT_PRESET,
  GRAPHQL_CODEGEN_PRESET,
  NESTJS_GRAPHQL_PRESET,
} from './graphql.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function configWith(presets: string[], hints: GraphHints = {}): GraphConfig {
  return {
    cwd: '/',
    output: '/out',
    cache: '/cache',
    repositories: [],
    defaultExcludes: [],
    presets,
    hints,
    detectors: [],
    entities: { foreignKeySuffixes: [] },
    groups: {},
    extractorModules: [],
    presetModules: [],
  };
}

async function extract(
  repository: string,
  files: Record<string, string>,
): Promise<ExtractedSymbol[]> {
  const sources = Object.entries(files).map(([filePath, content]) => ({
    repository,
    filePath,
    content,
  }));
  const symbols: ExtractedSymbol[] = [];
  for (const extractor of [typescriptExtractor(), graphqlDocumentExtractor()]) {
    const result = await extractor.extract(
      sources.filter((file) =>
        extractor.extensions.some((extension) =>
          file.filePath.endsWith(extension),
        ),
      ),
      { repository, logger },
    );
    expect(result.failures).toEqual([]);
    symbols.push(...result.symbols);
  }
  return symbols;
}

function detect(
  preset: DetectionPreset,
  repository: string,
  symbols: readonly ExtractedSymbol[],
  config: GraphConfig,
): Detection[] {
  const context: PresetContext = {
    repository,
    config,
    logger,
    resolveConstant: () => undefined,
    symbols,
  };
  return symbols
    .filter((symbol) => preset.languages?.includes(symbol.language) ?? true)
    .flatMap((symbol) => preset.detect(symbol, context));
}

describe('NESTJS_GRAPHQL_PRESET', () => {
  it('리졸버 메서드의 루트 필드와 타입 필드를 읽고 HTTP 매개변수 데코레이터는 무시한다', async () => {
    const symbols = await extract('shop-api', {
      'src/orders/order.resolver.ts': `import { Args, Mutation, Parent, Query, ResolveField, Resolver, Subscription } from '@nestjs/graphql';

@Resolver(() => Order)
export class OrderResolver {
  @Query(() => Order, { name: 'order' })
  findOrder(@Args('orderId') orderId: string) {
    return this.orders.find(orderId);
  }

  @Query(() => [Order])
  orders() {
    return [];
  }

  @Mutation('cancelOrder')
  cancel(@Args('orderId') orderId: string) {
    return orderId;
  }

  @Subscription(() => Order)
  orderUpdated() {
    return null;
  }

  @ResolveField('lineItems', () => [LineItem])
  items(@Parent() order: Order) {
    return order;
  }

  @ResolveField()
  total(@Parent() order: Order) {
    return order;
  }
}
`,
      'src/coupons/coupon.controller.ts': `import { Controller, Get, Query } from '@nestjs/common';

@Controller('coupons')
export class CouponController {
  @Get()
  list(@Query('page') page: number) {
    return page;
  }
}
`,
    });
    const found = detect(
      NESTJS_GRAPHQL_PRESET,
      'shop-api',
      symbols,
      configWith(['nestjs']),
    );

    expect(
      found.map((item) =>
        item.kind === 'graphql-resolver'
          ? [item.symbol, item.operationType, item.field, item.confidence]
          : [],
      ),
    ).toEqual([
      ['OrderResolver.findOrder', 'query', 'order', 0.98],
      ['OrderResolver.orders', 'query', 'orders', 0.98],
      ['OrderResolver.cancel', 'mutation', 'cancelOrder', 0.98],
      ['OrderResolver.orderUpdated', 'subscription', 'orderUpdated', 0.98],
      ['OrderResolver.items', 'query', 'Order.lineItems', 0.95],
      ['OrderResolver.total', 'query', 'Order.total', 0.95],
    ]);
    expect(found[0]).toMatchObject({
      repository: 'shop-api',
      filePath: 'src/orders/order.resolver.ts',
      line: 5,
      detector: 'nestjs',
      evidence: '@Query order',
    });
  });
});

const ORDER_DOCUMENTS = `query GetOrder($id: ID!) {
  order(id: $id) { id }
}

mutation cancel_order($id: ID!) {
  cancelOrder(id: $id)
}
`;

const ORDER_PAGE = `import { useGetOrderLazyQuery, useGetOrderQuery, useCancelOrderMutation, ListCouponsDocument } from '../generated/graphql';
import { useQuery } from '@apollo/client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useOrderSummaryQuery } from './useOrderSummaryQuery';

export function OrderPage({ id }) {
  const { data } = useGetOrderQuery({ variables: { id } });
  const [load] = useGetOrderLazyQuery();
  const [cancel] = useCancelOrderMutation();
  const coupons = useQuery(ListCouponsDocument, { variables: { first: 5 } });
  const feed = useInfiniteQuery({ queryKey: ['orders'] });
  const note = 'useHiddenOrderQuery()';
  // useCommentedOrderQuery();
  return [data, load, cancel, coupons, feed, note, useOrderSummaryQuery(id)];
}
`;

describe('GRAPHQL_CODEGEN_PRESET', () => {
  it('생성된 훅·문서 상수 이름에서 연산 이름을 읽고 저장소 문서와 맞춘다', async () => {
    const symbols = await extract('shop-web', {
      'src/graphql/orders.graphql': ORDER_DOCUMENTS,
      'src/orders/OrderPage.tsx': ORDER_PAGE,
      'src/orders/useOrderSummaryQuery.ts': `export function useOrderSummaryQuery(id: string) {
  return { id };
}
`,
    });
    const found = detect(
      GRAPHQL_CODEGEN_PRESET,
      'shop-web',
      symbols,
      configWith(['graphql-codegen']),
    );

    expect(
      found
        .filter((item) => item.kind === 'graphql-client-call')
        .map((item) =>
          item.kind === 'graphql-client-call'
            ? [item.operationName, item.line, item.confidence, item.evidence]
            : [],
        ),
    ).toEqual([
      ['GetOrder', 7, 0.9, 'generated hook useGetOrderQuery at line 7'],
      ['GetOrder', 8, 0.9, 'generated hook useGetOrderLazyQuery at line 8'],
      [
        'cancel_order',
        9,
        0.9,
        'generated hook useCancelOrderMutation at line 9',
      ],
      [
        'ListCoupons',
        10,
        0.75,
        'generated document ListCouponsDocument at line 10; operation document not found in repository',
      ],
    ]);
  });

  it('.graphql 연산을 문서 탐지로 내고, 설정 스키마 범위 안 문서에 스키마 이름을 단다', async () => {
    const symbols = await extract('shop-web', {
      'src/graphql/orders.graphql': ORDER_DOCUMENTS,
    });
    const found = detect(
      GRAPHQL_CODEGEN_PRESET,
      'shop-web',
      symbols,
      configWith(['graphql-codegen'], {
        graphqlSchemas: {
          shop: { repository: 'shop-web', paths: ['src/graphql'] },
          admin: { repository: 'shop-api' },
        },
      }),
    );

    expect(found).toEqual([
      {
        kind: 'graphql-document',
        repository: 'shop-web',
        filePath: 'src/graphql/orders.graphql',
        symbol: 'GetOrder',
        line: 1,
        detector: 'graphql-codegen',
        confidence: 0.99,
        evidence: 'query GetOrder in document src/graphql/orders.graphql',
        operationType: 'query',
        operationName: 'GetOrder',
        rootFields: ['order'],
        schema: 'shop',
      },
      expect.objectContaining({
        symbol: 'cancel_order',
        line: 5,
        operationType: 'mutation',
        rootFields: ['cancelOrder'],
        schema: 'shop',
      }),
    ]);
  });
});

const QUERIES = `import { gql } from '@apollo/client';

export const ORDER_FIELDS = gql\`fragment OrderFields on Order { id total }\`;

export const GET_REFUND = gql\`
  query GetRefund($id: ID!) {
    refund(id: $id) { ...OrderFields }
  }
  \${ORDER_FIELDS}
\`;

export const REQUEST_REFUND = gql\`mutation RequestRefund($orderId: ID!) { requestRefund(orderId: $orderId) { id } }\`;

export const NOT_A_DOCUMENT = 'query FakeOperation { fake }';
`;

const REFUND_PAGE = `import { gql, useMutation, useQuery } from '@apollo/client';
import { GET_REFUND, NOT_A_DOCUMENT, REQUEST_REFUND } from '../graphql/queries';
import { graphql } from '../gql';
import { client } from '../apollo';

const MEMBER_POINTS = gql\`query MemberPoints { memberPoints }\`;

export function RefundPage({ id }) {
  const { data } = useQuery(GET_REFUND, { variables: { id } });
  const [request] = useMutation(REQUEST_REFUND);
  useQuery(NOT_A_DOCUMENT);
  return [data, request];
}

export async function loadPoints() {
  return client.query({ query: MEMBER_POINTS });
}

export async function loadCoupons() {
  return client.query({ query: graphql(\`query InlineCoupons { coupons { id } }\`) });
}
`;

describe('APOLLO_CLIENT_PRESET', () => {
  it('훅·클라이언트 메서드의 문서 인자를 같은 저장소 gql 상수로 풀어 연산 이름을 읽는다', async () => {
    const symbols = await extract('shop-web', {
      'src/graphql/queries.ts': QUERIES,
      'src/refunds/RefundPage.tsx': REFUND_PAGE,
    });
    const found = detect(
      APOLLO_CLIENT_PRESET,
      'shop-web',
      symbols,
      configWith(['apollo-client']),
    );

    expect(
      found
        .filter((item) => item.kind === 'graphql-client-call')
        .map((item) =>
          item.kind === 'graphql-client-call'
            ? [item.symbol, item.operationName, item.line, item.evidence]
            : [],
        ),
    ).toEqual([
      [
        'RefundPage',
        'GetRefund',
        9,
        'useQuery at line 9; document GET_REFUND in src/graphql/queries.ts',
      ],
      [
        'RefundPage',
        'RequestRefund',
        10,
        'useMutation at line 10; document REQUEST_REFUND in src/graphql/queries.ts',
      ],
      [
        'loadPoints',
        'MemberPoints',
        16,
        'client.query at line 16; document MEMBER_POINTS in src/refunds/RefundPage.tsx',
      ],
      [
        'loadCoupons',
        'InlineCoupons',
        20,
        'client.query at line 20; graphql() at line 20',
      ],
    ]);
    expect(
      found
        .filter((item) => item.kind === 'graphql-document')
        .map((item) =>
          item.kind === 'graphql-document'
            ? [item.symbol, item.operationName, item.line, item.rootFields]
            : [],
        ),
    ).toEqual([
      ['GET_REFUND', 'GetRefund', 6, ['refund']],
      ['REQUEST_REFUND', 'RequestRefund', 12, ['requestRefund']],
      ['MEMBER_POINTS', 'MemberPoints', 6, ['memberPoints']],
      ['loadCoupons', 'InlineCoupons', 20, ['coupons']],
    ]);
  });

  it('graphql-codegen 도 켜져 있으면 문서 탐지는 그쪽에 맡긴다', async () => {
    const symbols = await extract('shop-web', {
      'src/graphql/queries.ts': QUERIES,
    });

    expect(
      detect(
        APOLLO_CLIENT_PRESET,
        'shop-web',
        symbols,
        configWith(['apollo-client', 'graphql-codegen']),
      ),
    ).toEqual([]);
    expect(
      detect(
        GRAPHQL_CODEGEN_PRESET,
        'shop-web',
        symbols,
        configWith(['apollo-client', 'graphql-codegen']),
      ).map((item) => item.kind),
    ).toEqual(['graphql-document', 'graphql-document']);
  });
});
