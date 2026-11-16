import { describe, expect, it } from 'vitest';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  Detection,
  ExtractedSymbol,
  GraphConfig,
  PresetContext,
} from '../../types.js';
import { NESTJS_HTTP_PRESET } from './nestjs.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  cwd: '/',
  output: '/out',
  cache: '/cache',
  repositories: [],
  defaultExcludes: [],
  presets: ['nestjs'],
  hints: {},
  detectors: [],
  entities: { foreignKeySuffixes: [] },
  groups: {},
  extractorModules: [],
  presetModules: [],
} satisfies GraphConfig;

async function extract(files: Record<string, string>) {
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

function detect(
  symbols: readonly ExtractedSymbol[],
  options: { constants?: Record<string, string>; index?: boolean } = {},
): Detection[] {
  const context: PresetContext = {
    repository: 'shop-api',
    config,
    logger,
    resolveConstant: (name) => options.constants?.[name],
    ...(options.index === false ? {} : { symbols }),
  };
  return symbols.flatMap((symbol) =>
    NESTJS_HTTP_PRESET.detect(symbol, context),
  );
}

const ORDER_CONTROLLER = `import { Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ORDER_ARCHIVE } from './order.constants';

@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  // @Get('drafts')
  @Get()
  list(@Query('page') page: number) {
    return this.orderService.list(page, '@Post("/orders/hidden")');
  }

  @Get(':orderId')
  find(@Param('orderId') orderId: string) {
    return this.orderService.find(orderId);
  }

  @Post([':orderId/cancel', ':orderId/refund-request'])
  cancel(@Param('orderId') orderId: string) {
    return this.orderService.cancel(orderId);
  }

  @Delete(\`\${ORDER_ARCHIVE}/:orderId\`)
  archive(@Param('orderId') orderId: string) {
    return this.orderService.archive(orderId);
  }
}
`;

describe('NESTJS_HTTP_PRESET', () => {
  it('메서드 경로 앞에 같은 파일 컨트롤러의 기본 경로를 붙이고 경로 매개변수를 :param 으로 바꾼다', async () => {
    const symbols = await extract({
      'src/orders/order.controller.ts': ORDER_CONTROLLER,
    });
    const routes = detect(symbols, { constants: { ORDER_ARCHIVE: 'archive' } });

    expect(
      routes.map((route) =>
        route.kind === 'http-route'
          ? [route.symbol, route.method, route.path, route.confidence]
          : [],
      ),
    ).toEqual([
      ['OrderController.list', 'GET', '/orders', 0.99],
      ['OrderController.find', 'GET', '/orders/:param', 0.99],
      ['OrderController.cancel', 'POST', '/orders/:param/cancel', 0.99],
      ['OrderController.cancel', 'POST', '/orders/:param/refund-request', 0.99],
      ['OrderController.archive', 'DELETE', '/orders/archive/:param', 0.99],
    ]);
    expect(routes[1]).toMatchObject({
      kind: 'http-route',
      repository: 'shop-api',
      filePath: 'src/orders/order.controller.ts',
      line: 14,
      detector: 'nestjs',
      evidence: "@Get(':orderId') under @Controller('orders')",
    });
  });

  it('주석과 문자열 안의 데코레이터 모양, 매개변수 데코레이터로는 라우트를 만들지 않는다', async () => {
    const symbols = await extract({
      'src/orders/order.controller.ts': ORDER_CONTROLLER,
    });
    const paths = detect(symbols, {
      constants: { ORDER_ARCHIVE: 'archive' },
    }).map((route) => (route.kind === 'http-route' ? route.path : ''));

    expect(paths).not.toContain('/orders/drafts');
    expect(paths).not.toContain('/orders/hidden');
    expect(paths.filter((path) => path === '/orders')).toHaveLength(1);
  });

  it('객체·빈 컨트롤러 경로와 모든 메서드 데코레이터를 읽는다', async () => {
    const symbols = await extract({
      'src/coupons/coupon.controller.ts': `import { All, Controller, Patch } from '@nestjs/common';

@Controller({ path: 'coupons', version: '2' })
export class CouponController {
  @Patch(':couponId')
  update() {
    return null;
  }
}

@Controller()
export class PingController {
  @All('ping')
  ping() {
    return 'pong';
  }
}
`,
    });

    expect(
      detect(symbols).map((route) =>
        route.kind === 'http-route' ? `${route.method} ${route.path}` : '',
      ),
    ).toEqual(['PATCH /coupons/:param', '* /ping']);
  });

  it('저장소 심볼 목록이 없으면 기본 경로 없이 낮은 신뢰도로 낸다', async () => {
    const symbols = await extract({
      'src/orders/order.controller.ts': ORDER_CONTROLLER,
    });
    const [first] = detect(symbols, { index: false });

    expect(first).toMatchObject({
      symbol: 'OrderController.list',
      path: '/',
      confidence: 0.93,
      evidence: "@Get(''); controller base path not found",
    });
  });

  it('경로를 정적으로 읽지 못하는 라우트는 내지 않는다', async () => {
    const symbols = await extract({
      'src/orders/order.controller.ts': ORDER_CONTROLLER,
    });

    expect(
      detect(symbols).some(
        (route) => route.symbol === 'OrderController.archive',
      ),
    ).toBe(false);
  });
});
