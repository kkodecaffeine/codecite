import { describe, expect, it } from 'vitest';
import { pythonExtractor } from '../../extractors/python.js';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  DetectionPreset,
  ExtractedSymbol,
  GraphConfig,
  HttpRouteDetection,
  PresetContext,
  SymbolExtractor,
} from '../../types.js';
import { EXPRESS_PRESET } from './express.js';
import { FASTAPI_PRESET } from './fastapi.js';
import { FASTIFY_PRESET } from './fastify.js';
import { FLASK_PRESET } from './flask.js';
import { NESTJS_HTTP_PRESET } from './nestjs.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  cwd: '/',
  output: '/out',
  cache: '/cache',
  repositories: [],
  defaultExcludes: [],
  presets: [],
  hints: {},
  detectors: [],
  entities: { foreignKeySuffixes: [] },
  groups: {},
  extractorModules: [],
  presetModules: [],
} satisfies GraphConfig;

async function routes(
  extractor: SymbolExtractor,
  preset: DetectionPreset,
  files: Record<string, string>,
): Promise<HttpRouteDetection[]> {
  const result = await extractor.extract(
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
    .flatMap((symbol) => preset.detect(symbol, context))
    .filter((item): item is HttpRouteDetection => item.kind === 'http-route');
}

const summary = (found: readonly HttpRouteDetection[]) =>
  found.map((route) => [
    route.symbol,
    route.method,
    route.path,
    route.confidence,
  ]);

describe('Express 마운트 접두어', () => {
  it('다른 파일에서 가져온 라우터를 겹쳐 붙이고, 여러 곳에 붙인 라우터는 접두어마다 경로를 낸다', async () => {
    const found = await routes(typescriptExtractor(), EXPRESS_PRESET, {
      'src/app.ts': `import express from 'express';
import { apiRouter } from './api';
import { couponRouter } from './coupons/coupon.routes';

const API_BASE = '/api';
const app = express();
app.use(API_BASE, apiRouter);
app.use('/legacy', couponRouter);
`,
      'src/api.ts': `import { Router } from 'express';
import { couponRouter } from './coupons/coupon.routes';
import orders from './orders/order.routes';

export const apiRouter = Router();
apiRouter.use('/v1', requireMember, couponRouter);
apiRouter.use(orders);

function requireMember(req, res, next) {
  next();
}
`,
      'src/coupons/coupon.routes.ts': `import { Router } from 'express';

export const couponRouter = Router();

function listCoupons(req, res) {
  res.json([]);
}

couponRouter.get('/coupons', listCoupons);
`,
      'src/orders/order.routes.ts': `import { Router } from 'express';

const router = Router();
router.get('/orders/:orderId', (req, res) => res.json({}));

export default router;
`,
    });

    expect(summary(found)).toEqual([
      ['listCoupons', 'GET', '/api/v1/coupons', 0.93],
      ['listCoupons', 'GET', '/legacy/coupons', 0.93],
      ['<module>', 'GET', '/api/orders/:param', 0.93],
    ]);
    expect(found[0]?.evidence).toBe(
      "route on handler listCoupons; registered by couponRouter.get at line 9 in <module>; mounted at '/api/v1' via app.use at src/app.ts:7 > apiRouter.use at src/api.ts:6",
    );
  });

  it('같은 파일 안 함수가 만든 라우터는 신뢰도를 낮추지 않는다', async () => {
    const found = await routes(typescriptExtractor(), EXPRESS_PRESET, {
      'src/app.ts': `import express, { Router } from 'express';

function createPointRouter() {
  const points = Router();
  points.post('/earn', (req, res) => res.end());
  return points;
}

export function createApp() {
  const app = express();
  app.use('/points', createPointRouter());
  return app;
}
`,
    });

    expect(summary(found)).toEqual([
      ['createPointRouter', 'POST', '/points/earn', 0.95],
    ]);
  });

  it('접두어를 못 읽은 마운트는 경로를 그대로 두고 근거에 남기며, 순환 마운트에서 멈춘다', async () => {
    const found = await routes(typescriptExtractor(), EXPRESS_PRESET, {
      'src/app.ts': `import express, { Router } from 'express';

const app = express();
const refunds = Router();
const loopA = Router();
const loopB = Router();

refunds.get('/refunds', (req, res) => res.end());
app.use(process.env.REFUND_BASE, refunds);

loopA.use('/a', loopB);
loopB.use('/b', loopA);
loopB.get('/loop', (req, res) => res.end());
`,
    });

    expect(summary(found)).toEqual([
      ['<module>', 'GET', '/refunds', 0.95],
      ['<module>', 'GET', '/a/loop', 0.95],
    ]);
    expect(found[0]?.evidence).toContain(
      'mount app.use at src/app.ts:9 has unreadable prefix <env>',
    );
    expect(found[1]?.evidence).toContain(
      'mount cycle at loopB.use at src/app.ts:12',
    );
  });
});

describe('Fastify 마운트 접두어', () => {
  it('register 의 prefix 를 다른 파일 플러그인과 그 안의 플러그인 라우트에 붙인다', async () => {
    const found = await routes(typescriptExtractor(), FASTIFY_PRESET, {
      'src/server.ts': `import Fastify from 'fastify';
import pointRoutes from './points/point.routes';

const server = Fastify();
server.register(pointRoutes, { prefix: '/points' });
`,
      'src/points/point.routes.ts': `import type { FastifyInstance } from 'fastify';

async function historyRoutes(fastify: FastifyInstance) {
  fastify.get('/history', async () => []);
}

export default async function pointRoutes(fastify: FastifyInstance) {
  fastify.get('/balance', async () => 0);
  fastify.register(historyRoutes, { prefix: '/members/:memberId' });
}
`,
    });

    expect(summary(found)).toEqual([
      ['historyRoutes', 'GET', '/points/members/:param/history', 0.88],
      ['pointRoutes', 'GET', '/points/balance', 0.88],
    ]);
  });
});

describe('FastAPI 마운트 접두어', () => {
  it('include_router 를 겹쳐 붙이고 라우터 자기 접두어를 그 뒤에 둔다', async () => {
    const found = await routes(pythonExtractor(), FASTAPI_PRESET, {
      'app/main.py': `from fastapi import FastAPI
from app.api import api_router

app = FastAPI()
app.include_router(api_router, prefix="/api")
app.include_router(api_router, prefix="/v2")
`,
      'app/api.py': `from fastapi import APIRouter
from app.routers.refunds import router as refund_router

api_router = APIRouter()
api_router.include_router(refund_router)
`,
      'app/routers/refunds.py': `from fastapi import APIRouter

router = APIRouter(prefix="/refunds")


@router.post("/{refund_id}/approve")
def approve_refund(refund_id: int):
    return {}
`,
    });

    expect(summary(found)).toEqual([
      ['approve_refund', 'POST', '/api/refunds/:param/approve', 0.97],
      ['approve_refund', 'POST', '/v2/refunds/:param/approve', 0.97],
    ]);
  });
});

describe('Flask 마운트 접두어', () => {
  it('register_blueprint 의 url_prefix 가 Blueprint 자기 접두어를 대신하고, 겹친 Blueprint 는 이어 붙인다', async () => {
    const found = await routes(pythonExtractor(), FLASK_PRESET, {
      'app/__init__.py': `from flask import Flask, Blueprint
from app.coupons import coupons_bp

app = Flask(__name__)
shop_bp = Blueprint("shop", __name__, url_prefix="/shop")
shop_bp.register_blueprint(coupons_bp)
app.register_blueprint(shop_bp)
app.register_blueprint(coupons_bp, url_prefix="/coupons")
`,
      'app/coupons.py': `from flask import Blueprint

coupons_bp = Blueprint("coupons", __name__, url_prefix="/c")


@coupons_bp.get("/<code>")
def read_coupon(code):
    return code
`,
    });

    expect(summary(found)).toEqual([
      ['read_coupon', 'GET', '/shop/c/:param', 0.97],
      ['read_coupon', 'GET', '/coupons/:param', 0.97],
    ]);
  });
});

describe('NestJS 앞머리', () => {
  it('전역 접두어와 RouterModule 모듈 경로를 붙이고 exclude 라우트에는 전역 접두어를 붙이지 않는다', async () => {
    const found = await routes(typescriptExtractor(), NESTJS_HTTP_PRESET, {
      'src/main.ts': `import { RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });
  await app.listen(3000);
}
bootstrap();
`,
      'src/app.module.ts': `import { Module } from '@nestjs/common';
import { RouterModule, Routes } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { AdminOrdersModule } from './admin/admin-orders.module';
import { HealthController } from './health.controller';

const routes: Routes = [
  { path: 'admin', module: AdminModule, children: [{ path: 'orders', module: AdminOrdersModule }] },
];

@Module({
  imports: [AdminModule, RouterModule.register(routes)],
  controllers: [HealthController],
})
export class AppModule {}
`,
      'src/admin/admin-orders.module.ts': `import { Module } from '@nestjs/common';
import { AdminOrderController } from './admin-order.controller';

@Module({ controllers: [AdminOrderController] })
export class AdminOrdersModule {}
`,
      'src/admin/admin-order.controller.ts': `import { Controller, Get } from '@nestjs/common';

@Controller('refund-requests')
export class AdminOrderController {
  @Get()
  list() {
    return [];
  }
}
`,
      'src/health.controller.ts': `import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  check() {
    return 'ok';
  }
}
`,
    });

    expect(summary(found)).toEqual([
      [
        'AdminOrderController.list',
        'GET',
        '/api/admin/orders/refund-requests',
        0.97,
      ],
      ['HealthController.check', 'GET', '/health', 0.99],
    ]);
    expect(found[0]?.evidence).toBe(
      "@Get('') under @Controller('refund-requests'); RouterModule path '/admin/orders' in src/app.module.ts; global prefix 'api' from app.setGlobalPrefix at src/main.ts:7",
    );
  });

  it('앱마다 전역 접두어가 다르면 짐작하지 않고 근거에 남긴다', async () => {
    const found = await routes(typescriptExtractor(), NESTJS_HTTP_PRESET, {
      'apps/shop/main.ts': `export async function startShop(app) {
  app.setGlobalPrefix('shop');
}
`,
      'apps/admin/main.ts': `export async function startAdmin(app) {
  app.setGlobalPrefix('admin');
}
`,
      'apps/shop/order.controller.ts': `import { Controller, Get } from '@nestjs/common';

@Controller('orders')
export class OrderController {
  @Get()
  list() {
    return [];
  }
}
`,
    });

    expect(summary(found)).toEqual([
      ['OrderController.list', 'GET', '/orders', 0.99],
    ]);
    expect(found[0]?.evidence).toContain(
      'several global prefixes (admin, shop), none applied',
    );
  });
});
