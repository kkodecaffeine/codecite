import { describe, expect, it, vi } from 'vitest';
import { pythonExtractor } from '../../extractors/python.js';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  Detection,
  ExtractedSymbol,
  GraphConfig,
  GraphDetectorRule,
  PresetContext,
  SymbolExtractor,
} from '../../types.js';
import { rulesPreset } from './rules.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const RULES: GraphDetectorRule[] = [
  { kind: 'queue-publisher', call: 'acornQueue.push', nameArgument: 0 },
  { kind: 'queue-consumer', decorator: 'AcornHandler' },
  { kind: 'event-publisher', call: 'publishShopEvent', nameArgument: 1 },
  { kind: 'scheduler', decorator: 'Nightly', nameArgument: 0 },
  { kind: 'http-client', call: 'shopApi.post', nameArgument: 0 },
  { kind: 'http-client', call: 'shopApi.request', nameArgument: 0 },
  { kind: 'queue-publisher', call: 'acorn_bus.send' },
  { kind: 'event-handler', decorator: 'on_shop_event' },
];

const config: GraphConfig = {
  cwd: '/work/dotori',
  output: '/work/dotori/.codecite/graph',
  cache: '/work/dotori/.codecite/cache',
  repositories: [{ name: 'shop-api', path: '../shop-api' }],
  defaultExcludes: [],
  presets: [],
  hints: {},
  detectors: RULES,
  entities: { foreignKeySuffixes: ['Id'] },
  groups: {},
  extractorModules: [],
  presetModules: [],
};

async function extract(
  extractor: SymbolExtractor,
  files: Record<string, string>,
): Promise<ExtractedSymbol[]> {
  const result = await extractor.extract(
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

const context: PresetContext = {
  repository: 'shop-api',
  config,
  logger,
  resolveConstant: (identifier) =>
    ({ REFUND_TOPIC: 'refund-requests', 'Topics.POINTS': 'point-events' })[
      identifier
    ],
};

function detectAll(symbols: ExtractedSymbol[]): Detection[] {
  const preset = rulesPreset(RULES);
  return symbols.flatMap((symbol) => preset.detect(symbol, context));
}

describe('rulesPreset', () => {
  it('turns call and decorator rules into message and schedule detections', async () => {
    const symbols = await extract(typescriptExtractor(), {
      'src/refund/refund.service.ts': `export class RefundService {
  constructor(private readonly acornQueue: AcornQueue) {}

  async request(orderId: string, items: string[]) {
    items.push('refund');
    await this.acornQueue.push(REFUND_TOPIC, { orderId });
    await this.acornQueue.push(Topics.POINTS, { orderId });
    await this.acornQueue.push(\`refund-\${region}\`, { orderId });
    await this.acornQueue.push();
    publishShopEvent(this.ctx, 'refund.requested');
    // this.acornQueue.push('ghost-queue', {});
    return 'this.acornQueue.push("fake-queue")';
  }

  @AcornHandler('coupon-requests')
  onCoupon() {}

  @Nightly('0 2 * * *')
  settle() {}

  @Nightly(this.settings.time)
  cleanUp() {}
}
`,
    });
    const found = detectAll(symbols).map((item) => {
      if (item.kind === 'schedule') {
        return [item.detector, item.symbol, item.kind, item.expression];
      }
      if (item.kind === 'http-call') {
        return [item.detector, item.kind];
      }
      return 'name' in item
        ? [item.detector, item.symbol, item.kind, item.name, item.dynamic]
        : [item.detector];
    });
    expect(found).toEqual([
      [
        'rule:0',
        'RefundService.request',
        'queue-publish',
        'refund-requests',
        false,
      ],
      [
        'rule:0',
        'RefundService.request',
        'queue-publish',
        'point-events',
        false,
      ],
      [
        'rule:0',
        'RefundService.request',
        'queue-publish',
        'refund-${region}',
        true,
      ],
      ['rule:0', 'RefundService.request', 'queue-publish', '', true],
      [
        'rule:2',
        'RefundService.request',
        'event-publish',
        'refund.requested',
        false,
      ],
      [
        'rule:1',
        'RefundService.onCoupon',
        'queue-consume',
        'coupon-requests',
        false,
      ],
      ['rule:3', 'RefundService.settle', 'schedule', '0 2 * * *'],
      ['rule:3', 'RefundService.cleanUp', 'schedule', 'runtime'],
    ]);
    expect(detectAll(symbols)[0]).toMatchObject({
      confidence: 0.9,
      filePath: 'src/refund/refund.service.ts',
      line: 6,
    });
  });

  it('reads method, base identifiers, host and path for http-client rules', async () => {
    const symbols = await extract(typescriptExtractor(), {
      'src/order/order.client.ts': `export async function cancelOrder(id: string) {
  await shopApi.post(\`\${SHOP_API_URL}/orders/\${id}/cancel/\`);
  await shopApi.request('https://pay.example.test/v1/charges?retry=1');
  await shopApi.post(ORDER_URL);
}
`,
    });
    const calls = detectAll(symbols).map((item) =>
      item.kind === 'http-call'
        ? [
            item.method,
            item.path,
            item.baseIdentifiers,
            item.host,
            item.dynamic,
          ]
        : [],
    );
    expect(calls).toEqual([
      // 경로 일부가 실행 중에 정해지면 HTTP 프리셋과 같이 dynamic 이다
      ['POST', '/orders/:param/cancel', ['SHOP_API_URL'], undefined, true],
      ['*', '/v1/charges', [], 'pay.example.test', false],
      ['POST', undefined, ['ORDER_URL'], undefined, true],
    ]);
  });

  it('applies the same rules to Python call and decorator sites', async () => {
    const symbols = await extract(pythonExtractor(), {
      'shop_worker/points.py': `from shop_worker.bus import acorn_bus, on_shop_event


@on_shop_event('order.paid')
def earn_points(event):
    acorn_bus.send('point-events', {'order_id': event.order_id})
    # acorn_bus.send('ghost-events', {})
    return "acorn_bus.send('fake-events')"
`,
    });
    expect(
      detectAll(symbols).map((item) =>
        'name' in item ? [item.detector, item.kind, item.name] : [],
      ),
    ).toEqual([
      ['rule:7', 'event-handle', 'order.paid'],
      ['rule:6', 'queue-publish', 'point-events'],
    ]);
  });

  it('detects nothing without rules', async () => {
    const symbols = await extract(typescriptExtractor(), {
      'src/a.ts': `export function a() { acornQueue.push('orders'); }`,
    });
    const preset = rulesPreset([]);
    expect(symbols.flatMap((symbol) => preset.detect(symbol, context))).toEqual(
      [],
    );
  });
});
