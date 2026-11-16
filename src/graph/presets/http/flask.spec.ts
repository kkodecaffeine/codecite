import { describe, expect, it } from 'vitest';
import { pythonExtractor } from '../../extractors/python.js';
import type {
  ExtractedSymbol,
  GraphConfig,
  HttpRouteDetection,
  PresetContext,
} from '../../types.js';
import { FLASK_PRESET } from './flask.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  cwd: '/',
  output: '/out',
  cache: '/cache',
  repositories: [],
  defaultExcludes: [],
  presets: ['flask'],
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
    .flatMap((symbol) => FLASK_PRESET.detect(symbol, context))
    .filter((item): item is HttpRouteDetection => item.kind === 'http-route');
}

describe('FLASK_PRESET', () => {
  it('Blueprint 접두어, route 의 methods, 단축 데코레이터, add_url_rule 등록을 읽는다', async () => {
    const found = await routes({
      'app/refunds/views.py': `from flask import Blueprint

bp = Blueprint("refunds", __name__, url_prefix="/refunds")


@bp.route("/<int:refund_id>", methods=["POST", "PUT"])
def update_refund(refund_id):
    return ""


@bp.route("/")
def list_refunds():
    return "[]"


@bp.delete("/<refund_id>")
def delete_refund(refund_id):
    return ""


def coupon_view(code):
    return code


bp.add_url_rule("/coupons/<code>", view_func=coupon_view, methods=["GET", "HEAD"])
`,
      'app/main.py': `from flask import Flask

app = Flask(__name__)


@app.get("/ping")
def ping():
    return "pong"
`,
    });

    expect(
      found.map((route) => [route.symbol, route.method, route.path]),
    ).toEqual([
      ['ping', 'GET', '/ping'],
      ['update_refund', 'POST', '/refunds/:param'],
      ['update_refund', 'PUT', '/refunds/:param'],
      ['list_refunds', 'GET', '/refunds'],
      ['delete_refund', 'DELETE', '/refunds/:param'],
      ['coupon_view', 'GET', '/refunds/coupons/:param'],
      ['coupon_view', 'HEAD', '/refunds/coupons/:param'],
    ]);
    expect(found.at(-1)).toMatchObject({
      line: 21,
      confidence: 0.99,
      evidence:
        "bp.add_url_rule at line 25; bp from Blueprint in app/refunds/views.py with prefix '/refunds'; route on handler coupon_view; registered by bp.add_url_rule at line 25 in <module>",
    });
  });

  it('flask 근거가 없는 같은 모양 데코레이터는 라우트로 보지 않는다', async () => {
    const found = await routes({
      'app/tasks.py': `from shared.events import bus


@bus.route("/orders/created")
def on_order_created(event):
    return event
`,
    });

    expect(found).toEqual([]);
  });
});
