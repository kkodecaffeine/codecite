import { describe, expect, it } from 'vitest';
import type { ExecutionFact } from '../../extensions/code-knowledge.js';
import { parseGraphConfig } from '../config.js';
import { buildRepositoryRecords, stableSymbolId } from '../records.js';
import type {
  ClassMember,
  Detection,
  EntityDeclarationDetection,
  ExtractedSymbol,
  FieldWriteDetection,
  GraphBuildState,
  RepositoryBuild,
} from '../types.js';
import { MAX_WRITERS_PER_FIELD } from './constants.js';
import {
  buildFieldWriterIndex,
  fieldWriterModule,
  pickAcrossModules,
} from './field-writers.js';

const COMMIT = 'd'.repeat(40);
const COMMITTED_AT = '2026-11-09T03:20:00.000Z';
const config = parseGraphConfig(
  {
    repositories: [
      { name: 'shop-api', url: 'https://example.com/shop-api.git' },
    ],
  },
  '/work/dotori',
);

function method(
  filePath: string,
  name: string,
  line: number,
  facts: ExecutionFact[],
  kind = 'method',
): ExtractedSymbol {
  return {
    filePath,
    language: filePath.endsWith('.py') ? 'python' : 'typescript',
    symbol: name,
    kind,
    content: `// ${name}`,
    lineStart: line,
    lineEnd: line + 20,
    relations: [],
    executionFacts: facts,
  };
}

const assigns = (
  line: number,
  subject: string,
  value: string,
  conditions?: string[],
): ExecutionFact => ({
  line,
  kind: 'assigns',
  subject,
  value,
  ...(conditions ? { conditions } : {}),
});

const member = (name: string, type: string): ClassMember => ({
  name,
  type,
  line: 3,
  parameter: true,
  decorators: [],
});

function entity(
  filePath: string,
  className: string,
  table: string,
): EntityDeclarationDetection {
  return {
    kind: 'entity-declaration',
    repository: 'shop-api',
    filePath,
    symbol: className,
    line: 2,
    detector: 'typeorm',
    confidence: 0.95,
    evidence: `@Entity ${className}`,
    table,
    className,
    columns: [],
    relations: [],
  };
}

function fieldWrite(
  filePath: string,
  symbol: string,
  line: number,
  field: string,
  extra: Partial<FieldWriteDetection> = {},
): FieldWriteDetection {
  return {
    kind: 'field-write',
    repository: 'shop-api',
    filePath,
    symbol,
    line,
    detector: 'typeorm',
    confidence: 0.9,
    evidence: `update sets ${field}`,
    field,
    writeKind: 'update-call',
    valueSummary: '<literal>',
    ...extra,
  };
}

function stateOf(
  symbols: ExtractedSymbol[],
  detections: Detection[],
): GraphBuildState {
  const { records } = buildRepositoryRecords(symbols, {
    repository: 'shop-api',
    commitSha: COMMIT,
    committedAt: COMMITTED_AT,
    groups: {},
  });
  const build: RepositoryBuild = {
    snapshot: {
      repository: 'shop-api',
      branch: 'main',
      commitSha: COMMIT,
      committedAt: COMMITTED_AT,
      reused: false,
    },
    manifest: {
      name: 'shop-api',
      branch: 'main',
      commitSha: COMMIT,
      committedAt: COMMITTED_AT,
      inputFingerprint: 'sha256:0',
      symbolsFile: 'symbols/shop-api.jsonl',
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
  return {
    config,
    repositories: [build],
    records,
    detections: new Map([['shop-api', detections]]),
    artifacts: new Map(),
  };
}

const ENTITIES: Detection[] = [
  entity('src/order/order.entity.ts', 'Order', 'orders'),
  entity('src/coupon/coupon.entity.ts', 'Coupon', 'coupons'),
  entity('src/member/member.entity.ts', 'Member', 'members'),
];

describe('buildFieldWriterIndex: 모으기', () => {
  it('ORM 탐지는 프리셋이 낸 방식으로 담고, 엔티티 클래스 이름은 테이블 이름으로 푼다', () => {
    const index = buildFieldWriterIndex(
      stateOf(
        [method('src/order/order.service.ts', 'OrderService.cancel', 10, [])],
        [
          ...ENTITIES,
          fieldWrite(
            'src/order/order.service.ts',
            'OrderService.cancel',
            14,
            'status',
            {
              entity: 'Order',
              conditions: [
                'order.paid',
                'NOT (order.shipped)',
                'reason !== <literal>',
              ],
            },
          ),
          fieldWrite(
            'src/order/order.service.ts',
            'OrderService.cancel',
            15,
            'memo',
            {
              entity: 'gift_cards',
              writeKind: 'update-builder',
              valueSummary: "reason ?? 'none'",
            },
          ),
        ],
      ),
    );

    expect(index.writers['shop-api:status']).toEqual([
      {
        symbolId: stableSymbolId(
          'shop-api',
          'src/order/order.service.ts',
          'OrderService.cancel',
        ),
        symbol: 'OrderService.cancel',
        filePath: 'src/order/order.service.ts',
        lineStart: 14,
        kind: 'update-call',
        entity: 'orders',
        valueSummary: '<literal>',
        conditions: ['order.paid', 'NOT (order.shipped)'],
      },
    ]);
    expect(index.writers['shop-api:memo'][0]).toMatchObject({
      kind: 'update-builder',
      entity: 'gift_cards',
      valueSummary: 'reason ?? <literal>',
    });
    expect(index.generatedAt).toBe(COMMITTED_AT);
    expect(index.maxWritersPerField).toBe(MAX_WRITERS_PER_FIELD);
  });

  it('실행 사실의 속성 대입을 모으고, 받는 쪽 타입을 알면 엔티티를 단다', () => {
    const symbols = [
      {
        ...method('src/coupon/coupon.entity.ts', 'Coupon', 1, [], 'entity'),
        executionFacts: undefined,
      },
      method('src/coupon/coupon.entity.ts', 'Coupon.expire', 8, [
        assigns(9, 'this.expiresAt', 'now'),
      ]),
      {
        ...method(
          'src/coupon/coupon.service.ts',
          'CouponService',
          1,
          [],
          'class',
        ),
        executionFacts: undefined,
        members: [member('coupon', 'Coupon'), member('wallet', 'PointWallet')],
      },
      method('src/coupon/coupon.service.ts', 'CouponService.use', 6, [
        assigns(7, 'this.coupon.usedAt', 'clock.now()', ['coupon.usable']),
        assigns(8, 'this.wallet.balance', '-= coupon.amount'),
        assigns(9, 'order.couponCode', 'process.env.DEFAULT_CODE'),
        assigns(10, 'this.coupon.owner.grade', 'grade'),
      ]),
      method('shop_api/members.py', 'MemberModel.add_points', 4, [
        assigns(5, 'self.points', '+= earned'),
      ]),
    ];
    const index = buildFieldWriterIndex(stateOf(symbols, ENTITIES));

    expect(index.writers['shop-api:expiresAt'][0]).toMatchObject({
      kind: 'assignment',
      entity: 'coupons',
      lineStart: 9,
      valueSummary: 'now',
    });
    expect(index.writers['shop-api:usedAt'][0]).toMatchObject({
      entity: 'coupons',
      conditions: ['coupon.usable'],
    });
    expect(index.writers['shop-api:balance'][0].entity).toBeUndefined();
    expect(index.writers['shop-api:couponCode'][0]).toMatchObject({
      valueSummary: '<env>',
    });
    expect(index.writers['shop-api:couponCode'][0].entity).toBeUndefined();
    expect(index.writers['shop-api:grade'][0].entity).toBeUndefined();
    expect(index.writers['shop-api:points'][0].entity).toBeUndefined();
  });

  it('같은 자리·같은 필드를 ORM 탐지가 냈으면 대입 사실은 버린다', () => {
    const index = buildFieldWriterIndex(
      stateOf(
        [
          method('src/order/order.service.ts', 'OrderService.ship', 3, [
            assigns(5, 'order.status', '<literal>'),
          ]),
        ],
        [
          ...ENTITIES,
          fieldWrite(
            'src/order/order.service.ts',
            'OrderService.ship',
            5,
            'status',
            {
              entity: 'Order',
              writeKind: 'assignment',
            },
          ),
        ],
      ),
    );

    expect(index.writers['shop-api:status']).toHaveLength(1);
    expect(index.writers['shop-api:status'][0].entity).toBe('orders');
  });

  it('지역 변수 하나, 전역 객체, 환경 변수, 내보내기, 생성자 주입, 선언, 테스트 경로는 뺀다', () => {
    const index = buildFieldWriterIndex(
      stateOf(
        [
          method('src/cart/cart.service.ts', 'CartService.total', 2, [
            assigns(3, 'total', '0'),
            assigns(4, 'window.cartCount', 'count'),
            assigns(5, 'process.env.CART_MODE', '<literal>'),
            assigns(6, 'module.exports.helper', 'helper'),
            assigns(7, 'exports.cart', 'cart'),
            assigns(8, 'os.environ.REGION', '<literal>'),
            assigns(9, 'items[0].price', '0'),
            assigns(10, 'Cart.prototype.clear', 'clear'),
            assigns(11, 'cart?.discount', 'coupon.amount'),
          ]),
          method('src/cart/cart.service.ts', 'CartService.constructor', 1, [
            assigns(1, 'this.carts', 'carts'),
            assigns(1, 'this.limit', '30'),
          ]),
          method(
            'src/cart/cart.constants.ts',
            'CART_RULES',
            1,
            [assigns(1, 'CART_RULES.max', '9')],
            'constant',
          ),
          method(
            'src/cart/cart.ts',
            '<module>',
            1,
            [assigns(2, 'app.locals.cart', 'cart')],
            'module',
          ),
          method(
            'src/cart/__tests__/cart.ts',
            'fakeCart',
            1,
            [assigns(2, 'cart.total', '1')],
            'function',
          ),
          method(
            'src/cart/cart.stories.tsx',
            'CartStory',
            1,
            [assigns(2, 'cart.total', '1')],
            'function',
          ),
        ],
        [fieldWrite('src/cart/cart.mock.ts', 'mockCart', 3, 'total')],
      ),
    );

    expect(Object.keys(index.writers)).toEqual([
      'shop-api:discount',
      'shop-api:limit',
    ]);
  });
});

describe('buildFieldWriterIndex: 자르기', () => {
  it('키 하나가 한도를 넘으면 모듈을 돌아가며 고르고 자르기 전 수를 남긴다', () => {
    const symbols: ExtractedSymbol[] = [];
    for (let index = 0; index < 120; index += 1) {
      symbols.push(
        method(
          'src/order/order.service.ts',
          `OrderService.step${index}`,
          index * 30 + 1,
          [assigns(index * 30 + 2, 'order.status', `${index}`)],
        ),
      );
    }
    symbols.push(
      method('jobs/refund/refund.job.ts', 'RefundJob.run', 1, [
        assigns(2, 'order.status', 'refunded'),
      ]),
      method(
        'worker/points/expire.ts',
        'expirePoints',
        1,
        [assigns(3, 'order.status', 'expired')],
        'function',
      ),
    );
    const index = buildFieldWriterIndex(stateOf(symbols, []));
    const kept = index.writers['shop-api:status'];

    expect(kept).toHaveLength(MAX_WRITERS_PER_FIELD);
    expect(index.truncated).toEqual({ 'shop-api:status': 122 });
    expect(kept.map((entry) => fieldWriterModule(entry.filePath))).toContain(
      'jobs/refund',
    );
    expect(kept.map((entry) => fieldWriterModule(entry.filePath))).toContain(
      'worker/points',
    );
    expect(kept[0].filePath).toBe('jobs/refund/refund.job.ts');
  });

  it('pickAcrossModules 는 한도 안이면 그대로 둔다', () => {
    const entries = buildFieldWriterIndex(
      stateOf(
        [
          method(
            'src/a/x.ts',
            'run',
            1,
            [assigns(2, 'cart.total', '1')],
            'function',
          ),
        ],
        [],
      ),
    ).writers['shop-api:total'];

    expect(pickAcrossModules(entries, 5)).toEqual(entries);
  });

  it('값 요약은 120 자로 자르고 같은 쓰기는 한 번만 담는다', () => {
    const long = `${'amount + '.repeat(20)}fee`;
    const index = buildFieldWriterIndex(
      stateOf(
        [
          method('src/points/ledger.ts', 'Ledger.add', 1, [
            assigns(2, 'ledger.balance', long),
            assigns(2, 'ledger.balance', long),
          ]),
        ],
        [],
      ),
    );
    const [entry] = index.writers['shop-api:balance'];

    expect(index.writers['shop-api:balance']).toHaveLength(1);
    expect(entry.valueSummary).toHaveLength(120);
    expect(entry.valueSummary.endsWith('…')).toBe(true);
  });

  it('같은 입력이면 같은 결과를 낸다', () => {
    const symbols = [
      method('src/b/b.ts', 'B.run', 1, [assigns(2, 'review.rating', '5')]),
      method('src/a/a.ts', 'A.run', 1, [assigns(2, 'review.rating', '4')]),
    ];
    const first = JSON.stringify(buildFieldWriterIndex(stateOf(symbols, [])));
    const second = JSON.stringify(
      buildFieldWriterIndex(stateOf([...symbols].reverse(), [])),
    );

    expect(second).toBe(first);
  });
});
