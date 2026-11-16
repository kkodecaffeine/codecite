import { describe, expect, it } from 'vitest';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  ExtractedSymbol,
  GraphConfig,
  HttpRouteDetection,
  PresetContext,
} from '../../types.js';
import { FASTIFY_PRESET } from './fastify.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  cwd: '/',
  output: '/out',
  cache: '/cache',
  repositories: [],
  defaultExcludes: [],
  presets: ['fastify'],
  hints: {},
  detectors: [],
  entities: { foreignKeySuffixes: [] },
  groups: {},
  extractorModules: [],
  presetModules: [],
} satisfies GraphConfig;

async function routes(
  files: Record<string, string>,
): Promise<HttpRouteDetection[]> {
  const result = await typescriptExtractor().extract(
    Object.entries(files).map(([filePath, content]) => ({
      repository: 'shop-api',
      filePath,
      content,
    })),
    { repository: 'shop-api', logger },
  );
  expect(result.failures).toEqual([]);
  const symbols: readonly ExtractedSymbol[] = result.symbols;
  const context: PresetContext = {
    repository: 'shop-api',
    config,
    logger,
    resolveConstant: () => undefined,
    symbols,
  };
  return symbols
    .flatMap((symbol) => FASTIFY_PRESET.detect(symbol, context))
    .filter((item): item is HttpRouteDetection => item.kind === 'http-route');
}

describe('FASTIFY_PRESET', () => {
  it('플러그인의 단축 등록, 옵션 객체가 낀 등록, route({…}) 등록을 읽는다', async () => {
    const found = await routes({
      'src/points/point.routes.ts': `import type { FastifyInstance } from 'fastify';

async function listPoints() {
  return [];
}

export default async function pointRoutes(fastify: FastifyInstance) {
  fastify.get('/points', listPoints);
  fastify.post('/points/:memberId', { schema: {} }, async (request) => request.body);
  fastify.route({
    method: ['PUT', 'PATCH'],
    url: '/points/:memberId/adjust',
    handler: listPoints,
  });
}
`,
    });

    expect(
      found.map((route) => [
        route.symbol,
        route.method,
        route.path,
        route.confidence,
      ]),
    ).toEqual([
      ['listPoints', 'GET', '/points', 0.9],
      ['pointRoutes', 'POST', '/points/:param', 0.9],
      ['listPoints', 'PUT', '/points/:param/adjust', 0.9],
      ['listPoints', 'PATCH', '/points/:param/adjust', 0.9],
    ]);
  });

  it('Fastify() 로 만든 인스턴스의 최상위 등록은 높은 신뢰도로 모듈 심볼에 단다', async () => {
    const found = await routes({
      'src/server.ts': `import Fastify from 'fastify';
import { pointRoutes } from './points/point.routes';

const server = Fastify();
server.get('/health', async () => 'ok');
server.register(pointRoutes, { prefix: '/v1' });
`,
    });

    expect(found).toEqual([
      expect.objectContaining({
        symbol: '<module>',
        method: 'GET',
        path: '/health',
        confidence: 0.95,
      }),
    ]);
  });

  it('가져오기가 없는 JavaScript 플러그인은 fastify 이름 관례로만 받는다', async () => {
    const found = await routes({
      'src/coupons/coupon.routes.js': `module.exports = async function (fastify) {
  fastify.delete('/coupons/:couponId', async () => null);
};
`,
      'src/coupons/coupon.other.js': `module.exports = async function (app) {
  app.delete('/coupons/:couponId', async () => null);
};
`,
    });

    expect(found.map((route) => [route.filePath, route.path])).toEqual([
      ['src/coupons/coupon.routes.js', '/coupons/:param'],
    ]);
  });
});
