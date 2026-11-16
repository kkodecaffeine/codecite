import { describe, expect, it } from 'vitest';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  ExtractedSymbol,
  GraphConfig,
  HttpRouteDetection,
  PresetContext,
} from '../../types.js';
import { EXPRESS_PRESET } from './express.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  cwd: '/',
  output: '/out',
  cache: '/cache',
  repositories: [],
  defaultExcludes: [],
  presets: ['express'],
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

function routes(symbols: readonly ExtractedSymbol[]): HttpRouteDetection[] {
  const context: PresetContext = {
    repository: 'shop-api',
    config,
    logger,
    resolveConstant: () => undefined,
    symbols,
  };
  return symbols
    .flatMap((symbol) => EXPRESS_PRESET.detect(symbol, context))
    .filter((item): item is HttpRouteDetection => item.kind === 'http-route');
}

describe('EXPRESS_PRESET', () => {
  it('파일 최상위 등록은 같은 파일 처리 함수에 달고, 인라인 처리기는 모듈 심볼에 단다', async () => {
    const symbols = await extract({
      'src/orders/order.routes.ts': `import { Router } from 'express';

export const orderRouter = Router();
const ROUTE_NOTE = "orderRouter.get('/orders/hidden', listOrders)";

// orderRouter.delete('/orders/:orderId', removeOrder);
function listOrders(req, res) {
  res.json([]);
}

orderRouter.get('/orders', listOrders);
orderRouter.post('/orders/:orderId/cancel', async (req, res) => {
  res.status(202).end();
});
`,
    });
    const found = routes(symbols);

    expect(
      found.map((route) => [
        route.symbol,
        route.method,
        route.path,
        route.line,
      ]),
    ).toEqual([
      ['listOrders', 'GET', '/orders', 7],
      ['<module>', 'POST', '/orders/:param/cancel', 12],
    ]);
    expect(found[0]).toMatchObject({
      confidence: 0.95,
      evidence:
        'route on handler listOrders; registered by orderRouter.get at line 11 in <module>',
    });
    expect(found[1]?.evidence).toBe(
      'route on registering symbol (inline or wrapped handler); registered by orderRouter.post at line 12 in <module>',
    );
  });

  it('함수 안 등록과 route() 연쇄를 읽고, express 를 가져온 파일에서는 app 이름 관례로 받는다', async () => {
    const symbols = await extract({
      'src/points/point.routes.ts': `import type { Express } from 'express';
import { findCoupon } from '../coupons/coupon.handlers';

export function registerPointRoutes(app: Express) {
  app.get('/coupons/:couponId', findCoupon);
  app.route('/points').get(listPoints).post(addPoints);
  app.all('/points/*', rejectPoints);
}

function listPoints(req, res) {
  res.json([]);
}
`,
    });

    expect(
      routes(symbols).map((route) => [
        route.symbol,
        route.method,
        route.path,
        route.confidence,
      ]),
    ).toEqual([
      ['registerPointRoutes', 'GET', '/coupons/:param', 0.9],
      ['listPoints', 'GET', '/points', 0.9],
      ['registerPointRoutes', 'POST', '/points', 0.9],
      ['registerPointRoutes', '*', '/points/*', 0.9],
    ]);
  });

  it('CommonJS 에서 express.Router() 로 만든 라우터를 알아본다', async () => {
    const symbols = await extract({
      'src/refunds/refund.routes.js': `const express = require('express');
const router = express.Router();

function removeRefund(req, res) {
  res.end();
}

router.delete('/refunds/:refundId', removeRefund);
module.exports = router;
`,
    });

    expect(routes(symbols)).toEqual([
      expect.objectContaining({
        symbol: 'removeRefund',
        method: 'DELETE',
        path: '/refunds/:param',
        confidence: 0.95,
      }),
    ]);
  });

  it('express 근거가 없는 같은 모양 호출(클라이언트, 다른 이름의 받는 쪽)은 라우트로 보지 않는다', async () => {
    const symbols = await extract({
      'src/orders/order.client.ts': `export async function syncOrders(api, payload) {
  await api.post('/orders', payload);
  return api.get('/orders', { params: { page: 1 } });
}
`,
      'src/orders/order.proxy.ts': `import express from 'express';

export function forward(client, done) {
  client.get('/orders', done);
}
`,
    });

    expect(routes(symbols)).toEqual([]);
  });
});
