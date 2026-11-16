import { describe, expect, it } from 'vitest';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  ExtractedSymbol,
  GraphConfig,
  HttpCallDetection,
  PresetContext,
} from '../../types.js';
import { FETCH_PRESET } from './fetch.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  cwd: '/',
  output: '/out',
  cache: '/cache',
  repositories: [],
  defaultExcludes: [],
  presets: ['fetch'],
  hints: {},
  detectors: [],
  entities: { foreignKeySuffixes: [] },
  groups: {},
  extractorModules: [],
  presetModules: [],
} satisfies GraphConfig;

async function calls(
  files: Record<string, string>,
): Promise<HttpCallDetection[]> {
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
    .flatMap((symbol) => FETCH_PRESET.detect(symbol, context))
    .filter((item): item is HttpCallDetection => item.kind === 'http-call');
}

describe('FETCH_PRESET', () => {
  it('주소의 기준 식별자·호스트·경로와 옵션의 메서드를 읽는다', async () => {
    const found = await calls({
      'src/orders/order.api.ts': `const SHOP_API_URL = process.env.NEXT_PUBLIC_SHOP_API_URL;

export async function cancelOrder(orderId: string) {
  // fetch('/api/orders/commented');
  const note = "fetch('/api/orders/quoted')";
  return fetch(\`\${SHOP_API_URL}/orders/\${orderId}/cancel\`, { method: 'POST', body: note });
}

export function listCoupons() {
  return window.fetch('/api/coupons?page=1');
}

export function chargePoints(body) {
  return fetch('https://Pay.Example.com/v1/charges', { method: body.method, body });
}

export function loadNext(url: string) {
  return fetch(url);
}

export function pointBalance(memberId: string) {
  return fetch(new URL(\`/members/\${memberId}/points\`, SHOP_API_URL));
}
`,
    });

    expect(
      found.map((call) => ({
        symbol: call.symbol,
        method: call.method,
        path: call.path,
        host: call.host,
        baseIdentifiers: call.baseIdentifiers,
        dynamic: call.dynamic,
        confidence: call.confidence,
      })),
    ).toEqual([
      {
        symbol: 'cancelOrder',
        method: 'POST',
        path: '/orders/:param/cancel',
        host: undefined,
        baseIdentifiers: ['SHOP_API_URL'],
        dynamic: true,
        confidence: 0.8,
      },
      {
        symbol: 'listCoupons',
        method: 'GET',
        path: '/api/coupons',
        host: undefined,
        baseIdentifiers: [],
        dynamic: false,
        confidence: 0.9,
      },
      {
        symbol: 'chargePoints',
        method: '*',
        path: '/v1/charges',
        host: 'pay.example.com',
        baseIdentifiers: [],
        dynamic: false,
        confidence: 0.9,
      },
      {
        symbol: 'loadNext',
        method: 'GET',
        path: undefined,
        host: undefined,
        baseIdentifiers: ['url'],
        dynamic: true,
        confidence: 0.6,
      },
      {
        symbol: 'pointBalance',
        method: 'GET',
        path: '/members/:param/points',
        host: undefined,
        baseIdentifiers: ['SHOP_API_URL'],
        dynamic: true,
        confidence: 0.8,
      },
    ]);
    expect(found[0]).toMatchObject({
      repository: 'shop-web',
      filePath: 'src/orders/order.api.ts',
      line: 6,
      detector: 'fetch',
      evidence: 'fetch at line 6; path partly built at runtime',
    });
  });

  it('같은 파일에 fetch 라는 함수를 따로 만들었으면 그 호출은 보지 않는다', async () => {
    const found = await calls({
      'src/points/fetch.ts': `export function fetch(memberId: string) {
  return { memberId };
}

export function loadPoints() {
  return fetch('/points');
}
`,
    });

    expect(found).toEqual([]);
  });
});
