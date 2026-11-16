import { describe, expect, it, vi } from 'vitest';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  Detection,
  DetectionPreset,
  ExtractedSymbol,
  GraphConfig,
  PresetContext,
} from '../../types.js';
import { nestjsMessagingPreset } from './nestjs.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const config: GraphConfig = {
  cwd: '/work/dotori',
  output: '/work/dotori/.codecite/graph',
  cache: '/work/dotori/.codecite/cache',
  repositories: [{ name: 'shop-api', path: '../shop-api' }],
  defaultExcludes: [],
  presets: ['nestjs'],
  hints: {},
  detectors: [],
  entities: { foreignKeySuffixes: ['Id'] },
  groups: {},
  extractorModules: [],
  presetModules: [],
};

async function extract(
  files: Record<string, string>,
): Promise<ExtractedSymbol[]> {
  const result = await typescriptExtractor().extract(
    Object.entries(files).map(([filePath, content]) => ({
      repository: 'shop-api',
      filePath,
      content,
    })),
    { repository: 'shop-api', logger },
  );
  expect(result.failures).toEqual([]);
  return result.symbols;
}

/** 상수 심볼의 assign 자리에서 문자열 값을 푸는 시험용 문맥 */
function contextFor(
  symbols: ExtractedSymbol[],
  options: { withSymbols?: boolean } = {},
): PresetContext {
  const constants = new Map<string, string>();
  for (const symbol of symbols) {
    for (const site of symbol.sites ?? []) {
      const value = site.kind === 'assign' ? site.args[0] : undefined;
      if (value?.literal !== undefined) {
        constants.set(site.name, value.literal);
      }
      for (const [key, inner] of Object.entries(value?.properties ?? {})) {
        if (inner.literal !== undefined) {
          constants.set(`${site.name}.${key}`, inner.literal);
        }
      }
    }
  }
  return {
    repository: 'shop-api',
    config,
    logger,
    resolveConstant: (identifier) => constants.get(identifier),
    ...(options.withSymbols === false ? {} : { symbols }),
  };
}

function detectAll(
  preset: DetectionPreset,
  symbols: ExtractedSymbol[],
  context: PresetContext,
): Detection[] {
  return symbols.flatMap((symbol) => preset.detect(symbol, context));
}

const ORDER_EVENTS = `export const OrderEvents = {
  PAID: 'order.paid',
  REFUNDED: 'order.refunded',
} as const;
export const REFUND_QUEUE = 'refunds';
`;

const ORDER_SERVICE = `import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bull';
import { ClientProxy, EventPattern, MessagePattern } from '@nestjs/microservices';
import { Queue } from 'bull';
import { OrderEvents, REFUND_QUEUE } from './order.events';

@Injectable()
export class OrderService {
  private readonly pendingIds = new Set<string>();

  constructor(
    private readonly events: EventEmitter2,
    @InjectQueue(REFUND_QUEUE) private readonly refundQueue: Queue,
    @InjectQueue('coupons') private readonly couponQueue: Queue,
    @Inject('POINT_SERVICE') private readonly points: ClientProxy,
    private readonly socket: ShopGateway,
  ) {}

  async pay(orderId: string) {
    this.pendingIds.add(orderId);
    const tags = new Set<string>();
    tags.add('paid');
    // this.events.emit('order.ghost', orderId);
    const note = "this.events.emit('order.fake')";
    this.socket.emit('order.screen', { orderId });
    this.events.emit(OrderEvents.PAID, { orderId, note });
    await this.points.emit('points.earned', { orderId });
    return this.points.send({ cmd: 'points.balance' }, orderId);
  }

  async refund(orderId: string) {
    await this.refundQueue.add('refund-order', { orderId });
    await this.couponQueue.addBulk([{ data: { orderId } }]);
  }

  @OnEvent(OrderEvents.REFUNDED)
  onRefunded(orderId: string) {
    return orderId;
  }

  @OnEvent(['coupon.used', 'coupon.expired'])
  onCouponChanged() {}

  @EventPattern({ cmd: 'order.shipped', version: '2' })
  onShipped() {}

  @MessagePattern(\`points.\${ORDER_KIND}\`)
  onPoints() {}
}
`;

describe('nestjsMessagingPreset events', () => {
  it('reads handler names from literals, constants, arrays and object patterns', async () => {
    const symbols = await extract({
      'src/order/order.events.ts': ORDER_EVENTS,
      'src/order/order.service.ts': ORDER_SERVICE,
    });
    const handled = detectAll(
      nestjsMessagingPreset,
      symbols,
      contextFor(symbols),
    )
      .filter((item) => item.kind === 'event-handle')
      .map(
        (item) =>
          item.kind === 'event-handle' && [
            item.symbol,
            item.name,
            item.dynamic,
          ],
      );
    expect(handled).toEqual([
      ['OrderService.onRefunded', 'order.refunded', false],
      ['OrderService.onCouponChanged', 'coupon.used', false],
      ['OrderService.onCouponChanged', 'coupon.expired', false],
      [
        'OrderService.onShipped',
        '{"cmd":"order.shipped","version":"2"}',
        false,
      ],
      ['OrderService.onPoints', 'points.${ORDER_KIND}', true],
    ]);
  });

  it('publishes only through members typed as an event emitter or a client proxy', async () => {
    const symbols = await extract({
      'src/order/order.events.ts': ORDER_EVENTS,
      'src/order/order.service.ts': ORDER_SERVICE,
    });
    const published = detectAll(
      nestjsMessagingPreset,
      symbols,
      contextFor(symbols),
    ).filter((item) => item.kind === 'event-publish');
    expect(
      published.map(
        (item) =>
          item.kind === 'event-publish' && [
            item.name,
            item.line,
            item.confidence,
          ],
      ),
    ).toEqual([
      ['order.paid', 27, 0.9],
      ['points.earned', 28, 0.9],
      ['{"cmd":"points.balance"}', 29, 0.9],
    ]);
    // 주석과 문자열 안의 emit, 다른 타입 멤버의 emit 은 잡지 않는다
    expect(published.map((item) => item.evidence).join(' ')).not.toMatch(
      /ghost|fake|screen/,
    );
    expect(published[0]).toMatchObject({
      repository: 'shop-api',
      filePath: 'src/order/order.service.ts',
      symbol: 'OrderService.pay',
      detector: 'nestjs',
    });
  });
});

describe('nestjsMessagingPreset queues', () => {
  it('binds add and addBulk to InjectQueue members and ignores plain add calls', async () => {
    const symbols = await extract({
      'src/order/order.events.ts': ORDER_EVENTS,
      'src/order/order.service.ts': ORDER_SERVICE,
    });
    const published = detectAll(
      nestjsMessagingPreset,
      symbols,
      contextFor(symbols),
    ).filter((item) => item.kind === 'queue-publish');
    expect(
      published.map(
        (item) =>
          item.kind === 'queue-publish' && [
            item.symbol,
            item.name,
            item.dynamic,
          ],
      ),
    ).toEqual([
      ['OrderService.refund', 'refunds', false],
      ['OrderService.refund', 'coupons', false],
    ]);
    expect(published[0].evidence).toContain('refund-order');
  });

  it('does not bind members when other symbols are not visible', async () => {
    const symbols = await extract({
      'src/order/order.events.ts': ORDER_EVENTS,
      'src/order/order.service.ts': ORDER_SERVICE,
    });
    const context = contextFor(symbols, { withSymbols: false });
    const kinds = detectAll(nestjsMessagingPreset, symbols, context).map(
      (item) => item.kind,
    );
    expect(kinds).not.toContain('queue-publish');
    expect(kinds).not.toContain('event-publish');
    expect(kinds).toContain('event-handle');
  });

  it('reads the queue of Bull processors from the class and the job handler from the method', async () => {
    const symbols = await extract({
      'src/refund/refund.processor.ts': `import { Process, Processor } from '@nestjs/bull';

@Processor('refunds')
export class RefundProcessor {
  @Process('refund-order')
  async handle(job: Job) {
    return job.data;
  }

  @Process('refund-coupon')
  async handleCoupon(job: Job) {
    return job.data;
  }
}
`,
      'src/coupon/coupon.worker.ts': `import { Processor, WorkerHost } from '@nestjs/bullmq';

@Processor({ name: 'coupons' })
export class CouponWorker extends WorkerHost {
  async process(job: Job) {
    return job.name;
  }
}
`,
      'src/point/point.consumer.ts': `@Processor('points')
export class PointConsumer {}
`,
    });
    const consumed = detectAll(
      nestjsMessagingPreset,
      symbols,
      contextFor(symbols),
    )
      .filter((item) => item.kind === 'queue-consume')
      .map(
        (item) =>
          item.kind === 'queue-consume' && [item.symbol, item.name, item.line],
      );
    expect(consumed).toEqual([
      ['CouponWorker.process', 'coupons', 5],
      ['PointConsumer', 'points', 1],
      ['RefundProcessor.handle', 'refunds', 5],
      ['RefundProcessor.handleCoupon', 'refunds', 10],
    ]);
  });

  it('falls back to one consumer on the processor class without other symbols', async () => {
    const symbols = await extract({
      'src/refund/refund.processor.ts': `@Processor('refunds')
export class RefundProcessor {
  @Process('refund-order')
  async handle(job: Job) {}
}
`,
    });
    const consumed = detectAll(
      nestjsMessagingPreset,
      symbols,
      contextFor(symbols, { withSymbols: false }),
    ).filter((item) => item.kind === 'queue-consume');
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({
      symbol: 'RefundProcessor',
      name: 'refunds',
    });
  });
});

describe('nestjsMessagingPreset schedules', () => {
  it('reads cron, interval and timeout schedules', async () => {
    const symbols = await extract({
      'src/coupon/coupon.scheduler.ts': `import { Cron, CronExpression, Interval, Timeout } from '@nestjs/schedule';

const EXPIRE_CRON = '0 30 4 * * *';

export class CouponScheduler {
  @Cron('0 0 3 * * *', { name: 'expire-coupons' })
  expireCoupons() {}

  @Cron(CronExpression.EVERY_HOUR)
  settlePoints() {}

  @Cron(EXPIRE_CRON)
  expireOrders() {}

  @Cron(process.env.REFUND_CRON)
  retryRefunds() {}

  @Interval('sync-stock', 30000)
  syncStock() {}

  @Timeout(5000)
  warmUp() {}
}
`,
    });
    const schedules = detectAll(
      nestjsMessagingPreset,
      symbols,
      contextFor(symbols),
    ).map((item) => item.kind === 'schedule' && [item.symbol, item.expression]);
    expect(schedules).toEqual([
      ['CouponScheduler.expireCoupons', '0 0 3 * * *'],
      ['CouponScheduler.settlePoints', 'CronExpression.EVERY_HOUR'],
      ['CouponScheduler.expireOrders', '0 30 4 * * *'],
      ['CouponScheduler.retryRefunds', 'runtime'],
      ['CouponScheduler.syncStock', 'interval(30000)'],
      ['CouponScheduler.warmUp', 'timeout(5000)'],
    ]);
  });
});
