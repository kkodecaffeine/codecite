import { describe, expect, it } from 'vitest';
import type { EntityTableNode } from '../../extensions/code-knowledge.js';
import { parseGraphConfig } from '../config.js';
import { buildRepositoryRecords } from '../records.js';
import type {
  Detection,
  EntityDeclarationDetection,
  ExtractedSymbol,
  GraphBuildState,
  RepositoryBuild,
} from '../types.js';
import {
  buildEntityRelationGraph,
  createEntityTableResolver,
} from './entities.js';
import { pluralize } from './naming.js';

const COMMITS: Record<string, [string, string]> = {
  'shop-api': ['a'.repeat(40), '2026-11-02T09:00:00.000Z'],
  'shop-admin': ['c'.repeat(40), '2026-11-05T12:15:00.000Z'],
  'shop-worker': ['b'.repeat(40), '2026-11-04T07:45:00.000Z'],
};

const config = parseGraphConfig(
  {
    repositories: Object.keys(COMMITS).map((name) => ({
      name,
      url: `https://example.com/${name}.git`,
    })),
    groups: {
      points: ['shop-api:src/points/**'],
      refund: ['shop-admin:src/refund/**'],
    },
  },
  '/work/dotori',
);

function entitySymbol(filePath: string, name: string, line: number) {
  return {
    filePath,
    language: filePath.endsWith('.py') ? 'python' : 'typescript',
    symbol: name,
    kind: 'entity',
    content: `// ${name}`,
    lineStart: line,
    lineEnd: line + 9,
    relations: [],
  } satisfies ExtractedSymbol;
}

function declaration(
  repository: string,
  filePath: string,
  className: string,
  table: string,
  extra: Partial<EntityDeclarationDetection> = {},
): EntityDeclarationDetection {
  return {
    kind: 'entity-declaration',
    repository,
    filePath,
    symbol: className,
    line: 3,
    detector: 'typeorm',
    confidence: 0.95,
    evidence: `@Entity ${className}`,
    table,
    className,
    columns: [],
    relations: [],
    ...extra,
  };
}

function build(name: string, symbols: ExtractedSymbol[]): RepositoryBuild {
  const [commitSha, committedAt] = COMMITS[name];
  const { records } = buildRepositoryRecords(symbols, {
    repository: name,
    commitSha,
    committedAt,
    groups: config.groups,
  });
  return {
    snapshot: {
      repository: name,
      branch: 'main',
      commitSha,
      committedAt,
      reused: false,
    },
    manifest: {
      name,
      branch: 'main',
      commitSha,
      committedAt,
      inputFingerprint: 'sha256:0',
      symbolsFile: `symbols/${name}.jsonl`,
      symbolCount: records.length,
      fileCount: 0,
      skippedFiles: {
        floor: 0,
        defaultExcludes: 0,
        exclude: 0,
        notIncluded: 0,
        unsupported: 0,
        binary: 0,
        tooLarge: 0,
      },
      failures: [],
    },
    records,
    extracted: symbols,
  };
}

function stateOf(
  detections: Record<string, Detection[]>,
  symbols: Record<string, ExtractedSymbol[]> = {},
  suffixes = ['Id', '_id'],
): GraphBuildState {
  const repositories = Object.keys(COMMITS)
    .sort()
    .map((name) => build(name, symbols[name] ?? []));
  return {
    config: { ...config, entities: { foreignKeySuffixes: suffixes } },
    repositories,
    records: repositories.flatMap((item) => item.records),
    detections: new Map(Object.entries(detections)),
    artifacts: new Map(),
  };
}

const tableOf = (tables: EntityTableNode[], name: string, store?: string) =>
  tables.find((table) => table.table === name && table.store === store);

describe('pluralize', () => {
  it('s, es, ies 규칙과 예외 낱말로 복수형을 만든다', () => {
    expect(pluralize('order')).toBe('orders');
    expect(pluralize('Coupon')).toBe('coupons');
    expect(pluralize('address')).toBe('addresses');
    expect(pluralize('box')).toBe('boxes');
    expect(pluralize('branch')).toBe('branches');
    expect(pluralize('category')).toBe('categories');
    expect(pluralize('delivery')).toBe('deliveries');
    expect(pluralize('day')).toBe('days');
    expect(pluralize('person')).toBe('people');
    expect(pluralize('shelf')).toBe('shelves');
    expect(pluralize('data')).toBe('data');
  });
});

describe('buildEntityRelationGraph: 노드 묶기', () => {
  it('저장소가 달라도 테이블 이름이 대소문자 없이 같으면 한 노드로 묶고 선언 자리를 모두 남긴다', () => {
    const graph = buildEntityRelationGraph(
      stateOf(
        {
          'shop-api': [
            declaration(
              'shop-api',
              'src/order/order.entity.ts',
              'Order',
              'orders',
              {
                columns: [{ name: 'status' }, { name: 'memo' }],
              },
            ),
          ],
          'shop-admin': [
            declaration(
              'shop-admin',
              'src/order/order-row.ts',
              'OrderRow',
              'Orders',
              {
                columns: [
                  { name: 'status', dataType: 'varchar', comment: '주문 상태' },
                ],
              },
            ),
          ],
        },
        {
          'shop-api': [entitySymbol('src/order/order.entity.ts', 'Order', 3)],
          'shop-admin': [entitySymbol('src/order/order-row.ts', 'OrderRow', 2)],
        },
      ),
    );

    expect(graph.tables).toHaveLength(1);
    const [orders] = graph.tables;
    expect(orders.table).toBe('Orders');
    expect(orders.entityNames).toEqual(['Order', 'OrderRow']);
    expect(orders.sources.map((source) => source.repository)).toEqual([
      'shop-admin',
      'shop-api',
    ]);
    expect(orders.sources[1]).toEqual({
      repository: 'shop-api',
      filePath: 'src/order/order.entity.ts',
      symbol: 'Order',
      lineStart: 3,
      lineEnd: 12,
    });
    expect(orders.columns).toEqual([
      { name: 'status', dataType: 'varchar', comment: '주문 상태' },
      { name: 'memo' },
    ]);
    expect(graph.generatedAt).toBe('2026-11-05T12:15:00.000Z');
  });

  it('이름이 같아도 문서 저장소 컬렉션과 관계형 테이블은 따로 둔다', () => {
    const graph = buildEntityRelationGraph(
      stateOf({
        'shop-api': [
          declaration(
            'shop-api',
            'src/review/review.entity.ts',
            'Review',
            'reviews',
          ),
        ],
        'shop-worker': [
          declaration(
            'shop-worker',
            'src/review/review.schema.ts',
            'ReviewDocument',
            'reviews',
            {
              store: 'document',
              detector: 'mongoose',
            },
          ),
        ],
      }),
    );

    expect(graph.tables.map((table) => [table.table, table.store])).toEqual([
      ['reviews', undefined],
      ['reviews', 'document'],
    ]);
  });

  it('선언한 심볼 레코드의 정책 묶음을 모은다', () => {
    const graph = buildEntityRelationGraph(
      stateOf(
        {
          'shop-api': [
            declaration(
              'shop-api',
              'src/points/point-ledger.entity.ts',
              'PointLedger',
              'point_ledgers',
            ),
            declaration(
              'shop-api',
              'src/order/order.entity.ts',
              'Order',
              'orders',
            ),
          ],
          'shop-admin': [
            declaration(
              'shop-admin',
              'src/refund/point-ledger.ts',
              'PointLedgerRow',
              'point_ledgers',
            ),
          ],
        },
        {
          'shop-api': [
            entitySymbol('src/points/point-ledger.entity.ts', 'PointLedger', 4),
            entitySymbol('src/order/order.entity.ts', 'Order', 3),
          ],
        },
      ),
    );

    expect(tableOf(graph.tables, 'point_ledgers')?.policyGroups).toEqual([
      'points',
      'refund',
    ]);
    expect(tableOf(graph.tables, 'orders')?.policyGroups).toEqual([]);
  });
});

describe('buildEntityRelationGraph: 관계', () => {
  const coupon = declaration(
    'shop-api',
    'src/coupon/coupon.entity.ts',
    'Coupon',
    'coupons',
    {
      columns: [
        { name: 'memberId' },
        { name: 'orderId' },
        { name: 'issuedCampaignId' },
      ],
      relations: [
        { targetClass: 'Member', kind: 'many-to-one', property: 'member' },
      ],
    },
  );
  const member = declaration(
    'shop-api',
    'src/member/member.entity.ts',
    'Member',
    'members',
    {
      columns: [{ name: 'memberId' }, { name: 'grade' }],
    },
  );
  const order = declaration(
    'shop-api',
    'src/order/order.entity.ts',
    'Order',
    'orders',
  );
  const campaign = declaration(
    'shop-api',
    'src/coupon/campaign.entity.ts',
    'Campaign',
    'campaigns',
  );

  it('관계 선언은 상대 클래스를 테이블로 풀어 declared 로 단다', () => {
    const graph = buildEntityRelationGraph(
      stateOf({ 'shop-api': [coupon, member, order, campaign] }),
    );
    const relations = tableOf(graph.tables, 'coupons')?.relations ?? [];

    expect(
      relations.filter((relation) => relation.source === 'declared'),
    ).toEqual([
      {
        targetTable: 'members',
        kind: 'many-to-one',
        source: 'declared',
        property: 'member',
      },
    ]);
  });

  it('선언이 덮지 않은 연결 컬럼만 이름 규칙으로 잇고, 앞 낱말을 떼어서라도 후보가 하나일 때 naming 으로 단다', () => {
    const graph = buildEntityRelationGraph(
      stateOf({ 'shop-api': [coupon, member, order, campaign] }),
    );
    const naming = (tableOf(graph.tables, 'coupons')?.relations ?? []).filter(
      (relation) => relation.source === 'naming',
    );

    // memberId 는 컬럼을 적지 않은 member 관계가 덮는다
    expect(naming).toEqual([
      {
        targetTable: 'campaigns',
        kind: 'many-to-one',
        source: 'naming',
        column: 'issuedCampaignId',
      },
      {
        targetTable: 'orders',
        kind: 'many-to-one',
        source: 'naming',
        column: 'orderId',
      },
    ]);
    // 자기 테이블을 가리키는 키(members.memberId)는 잇지 않는다
    expect(tableOf(graph.tables, 'members')?.relations).toEqual([]);
  });

  it('snake 꼴 끝말과 복수형·예외 복수형 테이블도 찾는다', () => {
    const graph = buildEntityRelationGraph(
      stateOf({
        'shop-worker': [
          declaration('shop-worker', 'app/models.py', 'Delivery', 'delivery', {
            columns: [{ name: 'order_id' }, { name: 'courier_person_id' }],
          }),
          declaration('shop-worker', 'app/models.py', 'Order', 'order'),
          declaration('shop-worker', 'app/models.py', 'Person', 'people'),
        ],
      }),
    );

    expect(tableOf(graph.tables, 'delivery')?.relations).toEqual([
      {
        targetTable: 'order',
        kind: 'many-to-one',
        source: 'naming',
        column: 'order_id',
      },
      {
        targetTable: 'people',
        kind: 'many-to-one',
        source: 'naming',
        column: 'courier_person_id',
      },
    ]);
  });

  it('후보 테이블이 여럿이면 이름 규칙 관계를 버린다', () => {
    const graph = buildEntityRelationGraph(
      stateOf({
        'shop-api': [
          declaration('shop-api', 'src/cart/cart.entity.ts', 'Cart', 'carts', {
            columns: [{ name: 'productId' }],
          }),
          declaration(
            'shop-api',
            'src/product/product.entity.ts',
            'Product',
            'product',
          ),
          declaration(
            'shop-api',
            'src/product/products.entity.ts',
            'ProductRow',
            'products',
          ),
        ],
      }),
    );

    expect(tableOf(graph.tables, 'carts')?.relations).toEqual([]);
  });

  it('설정 끝말에 맞지 않는 컬럼은 추정하지 않는다', () => {
    const graph = buildEntityRelationGraph(
      stateOf({ 'shop-api': [coupon, member, order, campaign] }, {}, ['_ref']),
    );

    expect(
      (tableOf(graph.tables, 'coupons')?.relations ?? []).map(
        (relation) => relation.source,
      ),
    ).toEqual(['declared']);
  });

  it('상대 클래스는 같은 저장소를 먼저 보고, 같은 범위에서 테이블이 여럿이면 잇지 않는다', () => {
    const graph = buildEntityRelationGraph(
      stateOf({
        'shop-api': [
          declaration(
            'shop-api',
            'src/refund/refund.entity.ts',
            'Refund',
            'refunds',
            {
              relations: [
                {
                  targetClass: 'Order',
                  kind: 'many-to-one',
                  property: 'order',
                  column: 'order_ref',
                },
                {
                  targetClass: 'Ledger',
                  kind: 'many-to-one',
                  property: 'ledger',
                  column: 'ledger_ref',
                },
              ],
            },
          ),
          declaration(
            'shop-api',
            'src/order/order.entity.ts',
            'Order',
            'orders',
          ),
          declaration(
            'shop-api',
            'src/points/a/ledger.entity.ts',
            'Ledger',
            'point_ledgers',
          ),
          declaration(
            'shop-api',
            'src/points/b/ledger.entity.ts',
            'Ledger',
            'coupon_ledgers',
          ),
        ],
        'shop-admin': [
          declaration(
            'shop-admin',
            'src/order/order.entity.ts',
            'Order',
            'admin_orders',
          ),
        ],
      }),
    );

    expect(tableOf(graph.tables, 'refunds')?.relations).toEqual([
      {
        targetTable: 'orders',
        kind: 'many-to-one',
        source: 'declared',
        column: 'order_ref',
        property: 'order',
      },
    ]);
  });
});

describe('createEntityTableResolver', () => {
  const state = stateOf({
    'shop-api': [
      declaration('shop-api', 'src/order/order.entity.ts', 'Order', 'orders'),
      declaration(
        'shop-api',
        'src/review/review.entity.ts',
        'Review',
        'reviews',
      ),
    ],
    'shop-worker': [
      declaration('shop-worker', 'app/models.py', 'Order', 'shop_orders'),
      declaration('shop-worker', 'app/models.py', 'ReviewDoc', 'reviews', {
        store: 'document',
      }),
    ],
  });
  const resolver = createEntityTableResolver(state);

  it('클래스 이름을 같은 저장소의 테이블로 풀고, 같은 저장소에 없으면 모든 저장소에서 하나일 때만 푼다', () => {
    expect(resolver.resolveClass('shop-api', 'Order')).toBe('orders');
    expect(resolver.resolveClass('shop-worker', 'Order')).toBe('shop_orders');
    expect(resolver.resolveClass('shop-admin', 'Order')).toBeUndefined();
    expect(resolver.resolveClass('shop-admin', 'Review')).toBe('reviews');
    expect(resolver.resolveClass('shop-api', 'Coupon')).toBeUndefined();
  });

  it('읽기·쓰기 대상을 토폴로지와 같은 규칙으로 푼다', () => {
    expect(resolver.resolveTarget('shop-api', 'Order', 'class')).toBe('orders');
    expect(resolver.resolveTarget('shop-api', 'Coupon', 'class')).toBe(
      'Coupon',
    );
    expect(
      resolver.resolveTarget('shop-admin', 'Order', 'class'),
    ).toBeUndefined();
    expect(resolver.resolveTarget('shop-api', 'ORDERS', 'table')).toBe(
      'orders',
    );
    expect(resolver.resolveTarget('shop-api', 'reviews', 'table')).toBe(
      'reviews',
    );
    expect(resolver.resolveTable('reviews')).toBeUndefined();
    expect(
      resolver.resolveTarget('shop-api', 'cart:summary', 'key'),
    ).toBeUndefined();
  });
});

describe('buildEntityRelationGraph: 결정성', () => {
  it('저장소와 탐지 순서가 달라도 같은 결과를 낸다', () => {
    const api = [
      declaration(
        'shop-api',
        'src/coupon/coupon.entity.ts',
        'Coupon',
        'coupons',
        {
          columns: [{ name: 'orderId' }],
        },
      ),
      declaration('shop-api', 'src/order/order.entity.ts', 'Order', 'orders'),
    ];
    const worker = [
      declaration('shop-worker', 'app/models.py', 'OrderModel', 'orders'),
    ];
    const first = buildEntityRelationGraph(
      stateOf({ 'shop-api': api, 'shop-worker': worker }),
    );
    const second = buildEntityRelationGraph(
      stateOf({ 'shop-worker': worker, 'shop-api': api }),
    );

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
