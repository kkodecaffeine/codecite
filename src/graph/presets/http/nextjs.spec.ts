import { describe, expect, it } from 'vitest';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  ExtractedSymbol,
  GraphConfig,
  HttpRouteDetection,
  PresetContext,
} from '../../types.js';
import { appRouterPath, NEXTJS_PRESET, pagesApiPath } from './nextjs.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  cwd: '/',
  output: '/out',
  cache: '/cache',
  repositories: [],
  defaultExcludes: [],
  presets: ['nextjs'],
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
      repository: 'shop-web',
      filePath,
      content,
    })),
    { repository: 'shop-web', logger },
  );
  expect(result.failures).toEqual([]);
  const symbols: readonly ExtractedSymbol[] = result.symbols;
  const context: PresetContext = {
    repository: 'shop-web',
    config,
    logger,
    resolveConstant: () => undefined,
    symbols,
  };
  return symbols
    .flatMap((symbol) => NEXTJS_PRESET.detect(symbol, context))
    .filter((item): item is HttpRouteDetection => item.kind === 'http-route');
}

describe('NEXTJS_PRESET', () => {
  it('app 라우트 파일에서 내보낸 메서드 함수마다 라우트를 낸다', async () => {
    const found = await routes({
      'src/app/api/orders/[orderId]/route.ts': `import { withMember } from '../../../member';

export async function GET(request: Request) {
  return Response.json({ path: '/api/orders/hidden' });
}

export const POST = withMember(async (request: Request) => Response.json({}));

function PATCH() {
  return null;
}

export function toOrderView(order: unknown) {
  return order;
}
`,
      'app/(shop)/coupons/route.ts': `export function DELETE() {
  return new Response(null, { status: 204 });
}
`,
      'app/_internal/route.ts': `export function GET() {
  return new Response('ok');
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
      ['DELETE', 'DELETE', '/coupons', 0.97],
      ['GET', 'GET', '/api/orders/:param', 0.97],
      ['POST', 'POST', '/api/orders/:param', 0.97],
    ]);
  });

  it('pages/api 파일의 기본 내보내기 처리기 하나에 모든 메서드 라우트를 단다', async () => {
    const found = await routes({
      'pages/api/points/index.ts': `export default async function handler(req, res) {
  res.status(200).json({ balance: 0 });
}
`,
      'src/pages/api/refunds/[refundId].js': `const handler = (req, res) => {
  res.end();
};

export default handler;
`,
      'pages/api/_middleware.ts': `export default function middleware() {
  return null;
}
`,
      'pages/orders.tsx': `export default function OrdersPage() {
  return null;
}
`,
    });

    expect(
      found.map((route) => [
        route.filePath,
        route.symbol,
        route.method,
        route.path,
        route.confidence,
      ]),
    ).toEqual([
      ['pages/api/points/index.ts', 'handler', '*', '/api/points', 0.97],
      [
        'src/pages/api/refunds/[refundId].js',
        'handler',
        '*',
        '/api/refunds/:param',
        0.85,
      ],
    ]);
  });

  it('파일 경로에서 라우트 경로를 만든다', () => {
    expect(appRouterPath('app/route.ts')).toBe('/');
    expect(appRouterPath('src/app/(shop)/@modal/orders/route.js')).toBe(
      '/orders',
    );
    expect(appRouterPath('app/orders/page.tsx')).toBeUndefined();
    expect(appRouterPath('apps/web/lib/route.ts')).toBeUndefined();
    expect(pagesApiPath('pages/api/orders/[...slug].ts')).toBe(
      '/api/orders/[...slug]',
    );
    expect(pagesApiPath('pages/api/index.ts')).toBe('/api');
    expect(pagesApiPath('pages/orders/api.ts')).toBeUndefined();
  });
});
