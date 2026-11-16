import { describe, expect, it } from 'vitest';
import { pythonExtractor } from '../../extractors/python.js';
import type {
  ExtractedSymbol,
  GraphConfig,
  HttpRouteDetection,
  PresetContext,
} from '../../types.js';
import { FASTAPI_PRESET } from './fastapi.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  cwd: '/',
  output: '/out',
  cache: '/cache',
  repositories: [],
  defaultExcludes: [],
  presets: ['fastapi'],
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
    .flatMap((symbol) => FASTAPI_PRESET.detect(symbol, context))
    .filter((item): item is HttpRouteDetection => item.kind === 'http-route');
}

describe('FASTAPI_PRESET', () => {
  it('APIRouter 접두어를 붙이고, 가져온 라우터와 FastAPI 앱의 데코레이터 라우트를 읽는다', async () => {
    const found = await routes({
      'app/routers/orders.py': `from fastapi import APIRouter

router = APIRouter(prefix="/orders", tags=["orders"])


# @router.get("/commented")
@router.get("/{order_id}")
async def read_order(order_id: int):
    note = '@router.post("/quoted")'
    return {"id": order_id, "note": note}


@router.api_route("/{order_id}/refund", methods=["POST", "PUT"])
def request_refund(order_id: int):
    return {}
`,
      'app/deps.py': `from fastapi import APIRouter

points_router = APIRouter(prefix="/points")
`,
      'app/routers/points.py': `from app.deps import points_router as router


@router.post(path="/{member_id}")
def add_points(member_id: int):
    return {}
`,
      'app/main.py': `from fastapi import FastAPI
from .routers import orders

app = FastAPI()
app.include_router(orders.router, prefix="/v1")


@app.get("/health")
def health():
    return {"ok": True}
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
      ['app/main.py', 'health', 'GET', '/health', 0.99],
      ['app/routers/orders.py', 'read_order', 'GET', '/orders/:param', 0.99],
      [
        'app/routers/orders.py',
        'request_refund',
        'POST',
        '/orders/:param/refund',
        0.99,
      ],
      [
        'app/routers/orders.py',
        'request_refund',
        'PUT',
        '/orders/:param/refund',
        0.99,
      ],
      ['app/routers/points.py', 'add_points', 'POST', '/points/:param', 0.99],
    ]);
    expect(found[1]?.evidence).toBe(
      "router.get at line 7; router from APIRouter in app/routers/orders.py with prefix '/orders'",
    );
  });

  it('받는 쪽을 못 찾으면 fastapi 를 가져온 파일에서만 접두어 없이 낮은 신뢰도로 낸다', async () => {
    const found = await routes({
      'app/coupons.py': `from fastapi import Depends
from shared.routing import coupon_router


@coupon_router.get("/coupons/{code}")
def read_coupon(code: str, user=Depends()):
    return {}
`,
      'app/cache.py': `from shared.cache import cache


@cache.get("/coupons/{code}")
def cached_coupon(code: str):
    return {}
`,
    });

    expect(found).toEqual([
      expect.objectContaining({
        symbol: 'read_coupon',
        path: '/coupons/:param',
        confidence: 0.93,
        evidence:
          'coupon_router.get at line 5; coupon_router not found, prefix unknown',
      }),
    ]);
  });
});
