import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../ports.js';
import { createConstantResolver } from './constant-resolver.js';
import { SILENT_LOGGER } from './constants.js';
import { pythonExtractor } from './extractors/python.js';
import { typescriptExtractor } from './extractors/typescript.js';
import type { ExtractedSymbol, SourceFile } from './types.js';

const hasPython =
  spawnSync('python3', [
    '-c',
    'import sys; sys.exit(sys.version_info < (3, 9))',
  ]).status === 0;

async function extract(
  extractor: 'typescript' | 'python',
  files: Record<string, string>,
): Promise<ExtractedSymbol[]> {
  const sources: SourceFile[] = Object.entries(files).map(
    ([filePath, content]) => ({ repository: 'shop-api', filePath, content }),
  );
  const run =
    extractor === 'typescript' ? typescriptExtractor() : pythonExtractor();
  const result = await run.extract(sources, {
    repository: 'shop-api',
    logger: SILENT_LOGGER,
  });
  expect(result.failures).toEqual([]);
  return result.symbols;
}

const symbolIn = (
  symbols: ExtractedSymbol[],
  filePath: string,
  name: string,
) => {
  const found = symbols.find(
    (symbol) => symbol.filePath === filePath && symbol.symbol === name,
  );
  if (!found) {
    throw new Error(`missing ${filePath} ${name}`);
  }
  return found;
};

/** 추출기 없이 손으로 만든 상수 심볼. assign 자리가 없으니 원문을 읽는다 */
const handMade = (
  filePath: string,
  symbol: string,
  kind: string,
  language: string,
  content: string,
): ExtractedSymbol => ({
  filePath,
  language,
  symbol,
  kind,
  content,
  lineStart: 1,
  lineEnd: content.split('\n').length,
  relations: [],
});

describe('createConstantResolver: TypeScript', () => {
  it('상수, 객체 상수 멤버, 문자열 열거형 멤버, static 필드, 템플릿과 다른 상수 참조를 assign 자리로 푼다', async () => {
    const symbols = await extract('typescript', {
      'src/messaging/queues.ts': [
        "export const ORDER_QUEUE = 'shop-orders';",
        "const PREFIX = 'dotori';",
        'export const POINTS_QUEUE = `${PREFIX}-points`;',
        'export const DEFAULT_QUEUE = ORDER_QUEUE;',
        'export const Queues = {',
        "  ORDER: 'shop-orders',",
        "  refund: { REQUESTED: 'refund-requested' },",
        '  POINTS: POINTS_QUEUE,',
        '} as const;',
        'export enum Topic {',
        "  ORDER_PLACED = 'order-placed',",
        '  RETRY_LIMIT = 3,',
        '}',
        'export class Channels {',
        "  static readonly COUPON = 'coupon-issued';",
        '}',
        'export const queueName = buildQueueName();',
        '',
      ].join('\n'),
    });
    const resolver = await createConstantResolver(symbols, {
      repository: 'shop-api',
      logger: SILENT_LOGGER,
    });

    expect(resolver.resolve('ORDER_QUEUE')).toBe('shop-orders');
    expect(resolver.resolve('POINTS_QUEUE')).toBe('dotori-points');
    expect(resolver.resolve('DEFAULT_QUEUE')).toBe('shop-orders');
    expect(resolver.resolve('Queues.ORDER')).toBe('shop-orders');
    expect(resolver.resolve('Queues.refund.REQUESTED')).toBe(
      'refund-requested',
    );
    expect(resolver.resolve('Queues.POINTS')).toBe('dotori-points');
    expect(resolver.resolve('Topic.ORDER_PLACED')).toBe('order-placed');
    expect(resolver.resolve('Channels.COUPON')).toBe('coupon-issued');

    // 문자열이 아닌 값, 실행 중에 정해지는 값, 인스턴스·환경 값, 없는 이름은 추측하지 않는다
    expect(resolver.resolve('Topic.RETRY_LIMIT')).toBeUndefined();
    expect(resolver.resolve('queueName')).toBeUndefined();
    expect(resolver.resolve('Queues')).toBeUndefined();
    expect(resolver.resolve('Queues.MISSING')).toBeUndefined();
    expect(resolver.resolve('this.queueName')).toBeUndefined();
    expect(resolver.resolve('process.env.ORDER_QUEUE')).toBeUndefined();
    expect(resolver.resolve('UNKNOWN_QUEUE')).toBeUndefined();
  });

  it('지금 보는 파일 → 가져온 파일 → 저장소 전체 순으로 찾고, 값이 갈리면 풀지 않는다', async () => {
    const symbols = await extract('typescript', {
      'src/order/order.queue.ts': [
        "export const QUEUE_NAME = 'order-events';",
        'export function publishOrder() { send(QUEUE_NAME); }',
        '',
      ].join('\n'),
      'src/refund/refund.queue.ts': [
        "export const QUEUE_NAME = 'refund-events';",
        '',
      ].join('\n'),
      'src/refund/refund.worker.ts': [
        "import { QUEUE_NAME as REFUND_QUEUE } from './refund.queue';",
        "import * as orderQueues from '../order/order.queue';",
        "import { SHARED_QUEUE } from '@dotori/shared';",
        'export function listen() {',
        '  consume(REFUND_QUEUE);',
        '  consume(orderQueues.QUEUE_NAME);',
        '  consume(SHARED_QUEUE);',
        '}',
        '',
      ].join('\n'),
      'src/shared.ts': "export const SHARED_QUEUE = 'local-copy';\n",
    });
    const resolver = await createConstantResolver(symbols, {
      repository: 'shop-api',
      logger: SILENT_LOGGER,
    });

    const publishOrder = symbolIn(
      symbols,
      'src/order/order.queue.ts',
      'publishOrder',
    );
    expect(resolver.resolve('QUEUE_NAME', publishOrder)).toBe('order-events');
    // 저장소 전체에서는 두 값으로 갈려 풀지 않는다
    expect(resolver.resolve('QUEUE_NAME')).toBeUndefined();

    const listen = symbolIn(symbols, 'src/refund/refund.worker.ts', 'listen');
    expect(resolver.resolve('REFUND_QUEUE', listen)).toBe('refund-events');
    expect(resolver.resolve('orderQueues.QUEUE_NAME', listen)).toBe(
      'order-events',
    );
    // 패키지에서 가져온 이름은 저장소 안의 같은 이름으로 넓혀 찾지 않는다
    expect(resolver.resolve('SHARED_QUEUE', listen)).toBeUndefined();
    expect(resolver.resolve('SHARED_QUEUE')).toBe('local-copy');
  });

  it('assign 자리가 없으면 원문을 구문 트리로 읽는다(static 이 아닌 필드는 이름으로 읽을 수 없다)', async () => {
    const symbols = [
      handMade(
        'src/messaging/channels.ts',
        'Channels.COUPON',
        'constant',
        'typescript',
        "static readonly COUPON = 'coupon-issued';",
      ),
      handMade(
        'src/messaging/channels.ts',
        'Channels.draft',
        'constant',
        'typescript',
        "draft = 'draft-channel';",
      ),
      handMade(
        'src/messaging/topic.ts',
        'Topic',
        'enum',
        'typescript',
        "export enum Topic {\n  SHIPPED = 'order-shipped',\n}",
      ),
      handMade(
        'src/messaging/queues.js',
        'REVIEW_QUEUE',
        'constant',
        'javascript',
        "exports.REVIEW_QUEUE = 'review-' + 'posted';",
      ),
      handMade(
        'src/messaging/queues.js',
        'CART_QUEUE',
        'constant',
        'javascript',
        "CART_QUEUE = Object.freeze('cart-updated')",
      ),
    ];
    const resolver = await createConstantResolver(symbols, {
      repository: 'shop-api',
      logger: SILENT_LOGGER,
    });

    expect(resolver.resolve('Channels.COUPON')).toBe('coupon-issued');
    expect(resolver.resolve('Channels.draft')).toBeUndefined();
    expect(resolver.resolve('Topic.SHIPPED')).toBe('order-shipped');
    expect(resolver.resolve('REVIEW_QUEUE')).toBe('review-posted');
    expect(resolver.resolve('CART_QUEUE')).toBe('cart-updated');
  });

  it('typescript 를 못 읽으면 경고하고 원문 상수는 풀지 않는다', async () => {
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const resolver = await createConstantResolver(
      [
        handMade(
          'src/messaging/queues.ts',
          'ORDER_QUEUE',
          'constant',
          'typescript',
          "export const ORDER_QUEUE = 'shop-orders';",
        ),
      ],
      {
        repository: 'shop-api',
        logger,
        loadTypeScript: () => Promise.reject(new Error('not installed')),
      },
    );
    expect(resolver.resolve('ORDER_QUEUE')).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('비밀값 이름의 상수는 풀지 않고, 값 안의 비밀값 모양은 가린다', async () => {
    const token = ['ghp', 'Acorn'.repeat(6)].join('_');
    const symbols = await extract('typescript', {
      'src/payments/config.ts': [
        `export const PAYMENT_API_TOKEN = 'plain-value';`,
        `export const PAYMENT_URL = 'https://payments.example.com/hook/${token}';`,
        '',
      ].join('\n'),
    });
    const resolver = await createConstantResolver(symbols, {
      repository: 'shop-api',
      logger: SILENT_LOGGER,
    });
    expect(resolver.resolve('PAYMENT_API_TOKEN')).toBeUndefined();
    const url = resolver.resolve('PAYMENT_URL');
    expect(url).toMatch(/^https:\/\/payments\.example\.com\/hook\//);
    expect(url).not.toContain(token);
  });
});

describe.runIf(hasPython)('createConstantResolver: Python', () => {
  it('모듈 상수, 클래스 속성(`Coupon.__tablename__`), 문자열 열거형 멤버를 assign 자리로 푼다', async () => {
    const symbols = await extract('python', {
      'shop_worker/queues.py': [
        'from enum import Enum',
        '',
        "ORDER_QUEUE = 'shop-orders'",
        'DEFAULT_QUEUE = ORDER_QUEUE',
        '',
        'class Coupon(Base):',
        "    __tablename__ = 'coupons'",
        '',
        'class Queues:',
        '    REFUND = "refund-requested"',
        '',
        'class Topic(str, Enum):',
        "    CREATED = 'order-created'",
        '    RETRIES = 3',
        '',
      ].join('\n'),
    });
    const resolver = await createConstantResolver(symbols, {
      repository: 'shop-worker',
      logger: SILENT_LOGGER,
    });
    expect(resolver.resolve('ORDER_QUEUE')).toBe('shop-orders');
    expect(resolver.resolve('DEFAULT_QUEUE')).toBe('shop-orders');
    expect(resolver.resolve('Coupon.__tablename__')).toBe('coupons');
    expect(resolver.resolve('Queues.REFUND')).toBe('refund-requested');
    expect(resolver.resolve('Topic.CREATED')).toBe('order-created');
    expect(resolver.resolve('Topic.RETRIES')).toBeUndefined();
  });

  it('가져온 모듈의 상수는 그 모듈에서 찾는다', async () => {
    const symbols = await extract('python', {
      'shop_worker/settings.py': "REVIEW_QUEUE = 'review-posted'\n",
      'shop_worker/other.py': "REVIEW_QUEUE = 'review-archived'\n",
      'shop_worker/consumer.py': [
        'from .settings import REVIEW_QUEUE',
        'import shop_worker.other as other',
        '',
        'def listen():',
        '    consume(REVIEW_QUEUE)',
        '    consume(other.REVIEW_QUEUE)',
        '',
      ].join('\n'),
    });
    const resolver = await createConstantResolver(symbols, {
      repository: 'shop-worker',
      logger: SILENT_LOGGER,
    });
    const listen = symbolIn(symbols, 'shop_worker/consumer.py', 'listen');
    expect(resolver.resolve('REVIEW_QUEUE', listen)).toBe('review-posted');
    expect(resolver.resolve('other.REVIEW_QUEUE', listen)).toBe(
      'review-archived',
    );
    expect(resolver.resolve('REVIEW_QUEUE')).toBeUndefined();
  });
});

describe('createConstantResolver: Python 원문 읽기', () => {
  it('assign 자리가 없으면 `NAME = 값` 과 열거형 몸통 줄을 읽는다', async () => {
    const resolver = await createConstantResolver(
      [
        handMade(
          'shop_worker/models.py',
          'Coupon.__tablename__',
          'constant',
          'python',
          "__tablename__ = 'coupons'  # 쿠폰 표",
        ),
        handMade(
          'shop_worker/queues.py',
          'POINTS_QUEUE',
          'constant',
          'python',
          "POINTS_QUEUE: Final[str] = r'points\\earned' 'v2'",
        ),
        handMade(
          'shop_worker/topics.py',
          'Topic',
          'enum',
          'python',
          [
            '@unique',
            'class Topic(str, Enum):',
            '    """주문 이벤트"""',
            "    SHIPPED = 'order-shipped'",
            '    DELAYED = f"order-{suffix}"',
            '',
            '    def label(self):',
            "        CANCELLED = 'not-a-member'",
          ].join('\n'),
        ),
      ],
      { repository: 'shop-worker', logger: SILENT_LOGGER },
    );
    expect(resolver.resolve('Coupon.__tablename__')).toBe('coupons');
    expect(resolver.resolve('POINTS_QUEUE')).toBe('points\\earnedv2');
    expect(resolver.resolve('Topic.SHIPPED')).toBe('order-shipped');
    expect(resolver.resolve('Topic.DELAYED')).toBeUndefined();
    expect(resolver.resolve('Topic.CANCELLED')).toBeUndefined();
  });
});
