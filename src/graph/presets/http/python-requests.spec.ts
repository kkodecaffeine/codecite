import { describe, expect, it } from 'vitest';
import { pythonExtractor } from '../../extractors/python.js';
import type {
  ExtractedSymbol,
  GraphConfig,
  HttpCallDetection,
  PresetContext,
} from '../../types.js';
import { PYTHON_REQUESTS_PRESET } from './python-requests.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  cwd: '/',
  output: '/out',
  cache: '/cache',
  repositories: [],
  defaultExcludes: [],
  presets: ['python-requests'],
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
  const result = await pythonExtractor().extract(
    Object.entries(files).map(([filePath, content]) => ({
      repository: 'shop-worker',
      filePath,
      content,
    })),
    { repository: 'shop-worker', logger },
  );
  expect(result.failures).toEqual([]);
  const symbols: readonly ExtractedSymbol[] = result.symbols;
  const context: PresetContext = {
    repository: 'shop-worker',
    config,
    logger,
    resolveConstant: () => undefined,
    symbols,
  };
  return symbols
    .flatMap((symbol) => PYTHON_REQUESTS_PRESET.detect(symbol, context))
    .filter((item): item is HttpCallDetection => item.kind === 'http-call');
}

describe('PYTHON_REQUESTS_PRESET', () => {
  it('모듈 함수, 세션·클라이언트 인스턴스, with 문 클라이언트의 base_url 을 읽는다', async () => {
    const found = await calls({
      'worker/points_sync.py': `import os
import requests
import httpx

SHOP_API = os.environ["SHOP_API_URL"]


class PointsSync:
    def __init__(self):
        self.session = requests.Session()
        self.client = httpx.AsyncClient(base_url=os.getenv("SHOP_API_URL"))

    async def push(self, member_id):
        # requests.get("/commented")
        await self.client.post(f"/members/{member_id}/points", json={})
        return self.session.get(f"{SHOP_API}/coupons")


def expire_coupons():
    requests.request("DELETE", SHOP_API + "/coupons/expired")
    with httpx.Client(base_url="https://pay.example.com") as pay:
        pay.post("/v1/refunds", json={"reason": "expired"})
    local = httpx.Client(base_url=SHOP_API)
    local.get("/orders", params={"page": 1})
    cache = {}
    return cache.get("/orders")
`,
    });

    expect(
      found.map((call) => [
        call.symbol,
        call.method,
        call.path,
        call.host,
        call.baseIdentifiers,
        call.dynamic,
      ]),
    ).toEqual([
      [
        'PointsSync.push',
        'POST',
        '/members/:param/points',
        undefined,
        ['os.environ.SHOP_API_URL'],
        true,
      ],
      ['PointsSync.push', 'GET', '/coupons', undefined, ['SHOP_API'], false],
      [
        'expire_coupons',
        'DELETE',
        '/coupons/expired',
        undefined,
        ['SHOP_API'],
        false,
      ],
      ['expire_coupons', 'POST', '/v1/refunds', 'pay.example.com', [], false],
      ['expire_coupons', 'GET', '/orders', undefined, ['SHOP_API'], false],
    ]);
    expect(found[0]?.evidence).toBe(
      'self.client.post at line 15; instance from httpx.AsyncClient in PointsSync.__init__; path partly built at runtime',
    );
  });

  it('별칭으로 가져온 모듈과 url 키워드를 읽는다', async () => {
    const found = await calls({
      'worker/refunds.py': `import requests as http


def fetch_refund(refund_id):
    return http.get(url=f"https://shop-api.example.com/refunds/{refund_id}", timeout=3)
`,
    });

    expect(found).toEqual([
      expect.objectContaining({
        method: 'GET',
        path: '/refunds/:param',
        host: 'shop-api.example.com',
        dynamic: true,
        confidence: 0.8,
      }),
    ]);
  });
});
