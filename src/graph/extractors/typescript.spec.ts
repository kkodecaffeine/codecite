import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../ports.js';
import type { ExtractedSymbol, SourceFile } from '../types.js';
import { typescriptExtractor } from './typescript.js';

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const context = { repository: 'shop-api', logger };

const file = (filePath: string, content: string): SourceFile => ({
  repository: 'shop-api',
  filePath,
  content,
});

const bySymbol = (symbols: ExtractedSymbol[], symbol: string) => {
  const found = symbols.find((item) => item.symbol === symbol);
  if (!found) {
    throw new Error(`missing symbol ${symbol}`);
  }
  return found;
};

const targets = (item: ExtractedSymbol, type: string) =>
  item.relations
    .filter((relation) => relation.type === type)
    .map((relation) => relation.target.symbol);

const ORDER_CONTROLLER = `import { Controller, Post, Param, Inject } from '@nestjs/common';
import { OrderService } from './order.service';

/** 도토리 마켓 주문 창구 */
@Controller('orders')
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 주문을 취소한다 */
  @Post(':id/cancel')
  async cancel(@Param('id') id: string) {
    return this.orderService.cancel(id, this.clock.now());
  }

  get pending(): number {
    return 0;
  }

  set pending(value: number) {}

  private readonly retryLimit = 3;

  onRefund = (orderId: string) => this.orderService.refund(orderId);
}

export function formatPrice(won: number): string {
  return won.toLocaleString();
}

/** 결제 금액을 적립금으로 바꾼다 */
export const toPoints = (won: number) => Math.floor(won / 100);

export const COUPON_LIMIT = 3;

export enum CouponType {
  Fixed,
  Rate,
}

export interface OrderSummary {
  id: string;
}

export type OrderId = string;
`;

describe('typescriptExtractor', () => {
  it('클래스·멤버·함수·화살표 함수 상수·상수·열거형을 심볼로 만든다', async () => {
    const { symbols, failures } = await typescriptExtractor().extract(
      [file('src/order/order.controller.ts', ORDER_CONTROLLER)],
      context,
    );

    expect(failures).toEqual([]);
    expect(
      symbols.map((item) => [
        item.symbol,
        item.kind,
        item.lineStart,
        item.lineEnd,
      ]),
    ).toEqual([
      ['OrderController', 'controller', 5, 27],
      ['OrderController.constructor', 'method', 7, 10],
      ['OrderController.cancel', 'method', 13, 16],
      ['OrderController.pending:get', 'method', 18, 20],
      ['OrderController.pending:set', 'method', 22, 22],
      ['OrderController.retryLimit', 'constant', 24, 24],
      ['OrderController.onRefund', 'method', 26, 26],
      ['formatPrice', 'function', 29, 31],
      ['toPoints', 'function', 34, 34],
      ['COUPON_LIMIT', 'constant', 36, 36],
      ['CouponType', 'enum', 38, 41],
    ]);
    expect(symbols.every((item) => item.language === 'typescript')).toBe(true);
    expect(bySymbol(symbols, 'OrderController').description).toBe(
      '도토리 마켓 주문 창구',
    );
    expect(bySymbol(symbols, 'OrderController.cancel').description).toBe(
      '주문을 취소한다',
    );
    expect(bySymbol(symbols, 'toPoints').description).toBe(
      '결제 금액을 적립금으로 바꾼다',
    );
    expect(bySymbol(symbols, 'formatPrice').description).toBeUndefined();
    expect(bySymbol(symbols, 'OrderController.cancel').content).toMatch(
      /^@Post\(':id\/cancel'\)\n {2}async cancel/,
    );
    expect(bySymbol(symbols, 'toPoints').content).toBe(
      'export const toPoints = (won: number) => Math.floor(won / 100);',
    );
  });

  it('함수·메서드는 실행 사실을 늘 갖고, 상수·열거형은 대입 사실을, 클래스는 갖지 않는다', async () => {
    const { symbols } = await typescriptExtractor().extract(
      [file('src/order/order.controller.ts', ORDER_CONTROLLER)],
      context,
    );

    expect(bySymbol(symbols, 'OrderController').executionFacts).toBeUndefined();
    expect(
      bySymbol(symbols, 'OrderController.pending:set').executionFacts,
    ).toEqual([]);
    expect(bySymbol(symbols, 'OrderController.cancel').executionFacts).toEqual([
      {
        line: 15,
        kind: 'returns',
        value: 'this.orderService.cancel(id, this.clock.now())',
      },
      { line: 15, kind: 'calls', subject: 'this.clock.now' },
      {
        line: 15,
        kind: 'calls',
        subject: 'this.orderService.cancel',
        value: 'id, this.clock.now()',
      },
    ]);
    expect(bySymbol(symbols, 'COUPON_LIMIT').executionFacts).toEqual([
      { line: 36, kind: 'assigns', subject: 'COUPON_LIMIT', value: '3' },
    ]);
    expect(
      bySymbol(symbols, 'CouponType').executionFacts?.map(
        (fact) => `${fact.subject}=${fact.value}`,
      ),
    ).toEqual(['CouponType.Fixed=0', 'CouponType.Rate=1']);
  });

  it('관계를 풀지 않은 원문으로 남기고, IMPORTS 는 심볼이 실제로 쓰는 이름만 단다', async () => {
    const { symbols } = await typescriptExtractor().extract(
      [
        file(
          'src/points/point.service.ts',
          `import Decimal from 'decimal.js';
import * as money from '../money';
import { PointLedger as Ledger, unusedHelper } from './point-ledger';
import { BaseService } from '../common/base.service';
import './polyfill';

@Injectable()
export class PointService extends BaseService implements Earner, Spender {
  constructor(private readonly ledger: Ledger) {
    super();
  }

  @Transactional()
  earn(memberId: string, won: number) {
    const amount = new Decimal(won).mul(money.POINT_RATE);
    return this.ledger.add(memberId, amount.toNumber());
  }

  async loadRules() {
    const { rules } = await import('./point-rules');
    return rules;
  }
}
`,
        ),
      ],
      context,
    );

    const service = bySymbol(symbols, 'PointService');
    expect(service.kind).toBe('class');
    expect(targets(service, 'IMPORTS')).toEqual([
      '* as money from ../money',
      '* from ./point-rules',
      'BaseService from ../common/base.service',
      'PointLedger as Ledger from ./point-ledger',
      'default as Decimal from decimal.js',
    ]);
    expect(targets(service, 'EXTENDS')).toEqual(['BaseService']);
    expect(targets(service, 'IMPLEMENTS')).toEqual(['Earner', 'Spender']);
    expect(targets(service, 'DECORATED_BY')).toEqual(['Injectable']);
    expect(targets(service, 'INJECTS')).toEqual(['Ledger']);
    expect(targets(service, 'CALLS')).toEqual([]);

    const earn = bySymbol(symbols, 'PointService.earn');
    expect(targets(earn, 'DECORATED_BY')).toEqual(['Transactional']);
    expect(targets(earn, 'CALLS')).toEqual([
      'amount.toNumber',
      'new Decimal().mul',
      'this.ledger.add',
    ]);
    expect(targets(earn, 'IMPORTS')).toEqual([
      '* as money from ../money',
      'default as Decimal from decimal.js',
    ]);
    // 풀지 않은 원문은 저장소 기준 경로 자리(filePath)에 넣지 않는다
    expect(
      earn.relations.every(
        (relation) =>
          relation.target.repository === 'shop-api' &&
          relation.target.filePath === undefined,
      ),
    ).toBe(true);
    expect(
      targets(bySymbol(symbols, 'PointService.loadRules'), 'IMPORTS'),
    ).toEqual(['* from ./point-rules']);
  });

  it('JavaScript 파일(JSX, CommonJS, ES 모듈)도 읽는다', async () => {
    const { symbols, failures } = await typescriptExtractor().extract(
      [
        file(
          'web/src/CouponBadge.js',
          `import { useCoupon } from './useCoupon';
export function CouponBadge({ id }) {
  const coupon = useCoupon(id);
  if (!coupon) return null;
  return <span className="badge">{coupon.name}</span>;
}
`,
        ),
        file(
          'web/server/points.cjs',
          `const express = require('express');
const { earnPoints: earn } = require('./points-store');
exports.earnHandler = async (req, res) => {
  if (req.body.amount <= 0) {
    return res.status(400).end();
  }
  await earn(req.user.id, req.body.amount);
};
module.exports.DAILY_CAP = 1000;
module.exports = function shippingRouter() {
  return express.Router();
};
`,
        ),
        file(
          'web/src/membership.mjs',
          'export const gradeOf = (total) => (total > 100000 ? 2 : 1);\n',
        ),
      ],
      context,
    );

    expect(failures).toEqual([]);
    expect(
      symbols.map((item) => [
        item.filePath,
        item.symbol,
        item.kind,
        item.language,
      ]),
    ).toEqual([
      ['web/server/points.cjs', 'earnHandler', 'function', 'javascript'],
      ['web/server/points.cjs', 'DAILY_CAP', 'constant', 'javascript'],
      ['web/server/points.cjs', 'default', 'function', 'javascript'],
      ['web/src/CouponBadge.js', 'CouponBadge', 'function', 'javascript'],
      ['web/src/membership.mjs', 'gradeOf', 'function', 'javascript'],
    ]);
    const handler = bySymbol(symbols, 'earnHandler');
    expect(targets(handler, 'IMPORTS')).toEqual([
      'earnPoints as earn from ./points-store',
    ]);
    expect(handler.executionFacts?.at(-1)).toEqual({
      line: 7,
      kind: 'calls',
      subject: 'earn',
      value: 'req.user.id, req.body.amount',
      conditions: ['NOT (req.body.amount <= 0)'],
    });
    expect(targets(bySymbol(symbols, 'default'), 'IMPORTS')).toEqual([
      '* as express from express',
    ]);
    expect(
      bySymbol(symbols, 'CouponBadge').executionFacts?.find(
        (fact) => fact.kind === 'returns' && fact.conditions?.[0] === 'coupon',
      )?.value,
    ).toBe('<span className=<literal>>{coupon.name}</span>');
  });

  it('구문 오류가 있는 파일은 실패로 남기고 나머지 파일은 계속 읽는다', async () => {
    const { symbols, failures } = await typescriptExtractor().extract(
      [
        file('src/cart/broken.ts', 'export function addToCart( {\n  if (\n'),
        file('src/cart/cart.ts', 'export const MAX_CART_ITEMS = 50;\n'),
        file('src/cart/flow-typed.js', 'export const total: number = 0;\n'),
      ],
      context,
    );

    expect(symbols.map((item) => item.symbol)).toEqual([
      'MAX_CART_ITEMS',
      'total',
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0].filePath).toBe('src/cart/broken.ts');
    expect(failures[0].message).toMatch(/^line \d+: /);
  });

  it('선언 파일과 맡지 않는 확장자는 건너뛰고, 맡을 파일이 없으면 typescript 를 부르지 않는다', async () => {
    const loadTypeScript = vi.fn(async () => {
      throw new Error('should not load');
    });
    const result = await typescriptExtractor({ loadTypeScript }).extract(
      [
        file('src/types/shop.d.ts', 'declare const shopName: string;'),
        file('src/points/rules.py', 'RATE = 1'),
      ],
      context,
    );

    expect(result).toEqual({ symbols: [], failures: [] });
    expect(loadTypeScript).not.toHaveBeenCalled();
  });

  it('typescript 가 없으면 저장소 이름과 설치 방법을 담은 오류를 던진다', async () => {
    const missing = Object.assign(new Error('Cannot find package'), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const extractor = typescriptExtractor({
      loadTypeScript: async () => {
        throw missing;
      },
    });

    await expect(
      extractor.extract([file('src/a.ts', 'export const a = 1;')], context),
    ).rejects.toThrow(
      /typescript is not installed.*"shop-api".*npm i -D typescript/,
    );
  });

  it('같은 입력이면 파일 순서와 상관없이 같은 결과를 낸다', async () => {
    const files = [
      file('src/b/refund.ts', 'export function refund() { return 1; }'),
      file('src/a/coupon.ts', ORDER_CONTROLLER),
      file('src/a/shipping.js', 'export function ship() { pack(); }'),
    ];
    const first = await typescriptExtractor().extract(files, context);
    const second = await typescriptExtractor().extract(
      [...files].reverse(),
      context,
    );

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect([...new Set(first.symbols.map((item) => item.filePath))]).toEqual([
      'src/a/coupon.ts',
      'src/a/shipping.js',
      'src/b/refund.ts',
    ]);
  });

  it('같은 파일에서 이름이 겹치는 심볼에는 나온 순서대로 꼬리를 붙인다', async () => {
    const { symbols } = await typescriptExtractor().extract(
      [
        file(
          'legacy/coupon.js',
          'function applyCoupon() { return 1; }\nfunction applyCoupon() { return 2; }\n',
        ),
      ],
      context,
    );

    expect(symbols.map((item) => item.symbol)).toEqual([
      'applyCoupon',
      'applyCoupon~2',
    ]);
  });

  it('이름 없는 기본 내보내기는 default 라는 이름으로 읽는다', async () => {
    const { symbols } = await typescriptExtractor().extract(
      [
        file(
          'src/pages/api/shipping.ts',
          'export default async function (req: Req, res: Res) { res.json(await quote(req.query)); }',
        ),
        file(
          'src/pages/api/coupons.ts',
          'export default (req: Req) => listCoupons(req.query);',
        ),
      ],
      context,
    );

    expect(
      symbols.map((item) => [item.filePath, item.symbol, item.kind]),
    ).toEqual([
      ['src/pages/api/coupons.ts', 'default', 'function'],
      ['src/pages/api/shipping.ts', 'default', 'function'],
    ]);
  });

  it('긴 상수 원문은 앞뒤만 남기고 함수 원문은 그대로 둔다', async () => {
    const rows = Array.from(
      { length: 3000 },
      (_, index) => `  zone${index}: ${index},`,
    ).join('\n');
    const body = Array.from(
      { length: 3000 },
      (_, index) => `  total += ${index};`,
    ).join('\n');
    const { symbols } = await typescriptExtractor().extract(
      [
        file(
          'src/shipping/zones.ts',
          `export const ZONE_FEES = {\n${rows}\n};\nexport function sumFees() {\n  let total = 0;\n${body}\n  return total;\n}\n`,
        ),
      ],
      context,
    );

    const zones = bySymbol(symbols, 'ZONE_FEES');
    expect(zones.content.length).toBeLessThan(20_100);
    expect(zones.content).toMatch(/\/\* \d+ characters omitted \*\//);
    expect(zones.content.endsWith('};')).toBe(true);
    expect(bySymbol(symbols, 'sumFees').content).toContain('total += 2999;');
  });

  it('호출·데코레이터 자리를 그 심볼에 붙이고, 비밀값 모양 인자는 가려서 내보낸다', async () => {
    // 저장소의 비밀값 검사에 걸리지 않도록 조각을 실행 중에 잇는다
    const fakeLiveKey = ['sk', 'live', 'Dotori1Acorn2Market3Shop4'].join('_');
    const { symbols } = await typescriptExtractor().extract(
      [
        file(
          'src/coupons/coupon.controller.ts',
          `@Controller('coupons')
export class CouponController {
  @Post(':id/redeem')
  redeem(@Param('id') id: string) {
    return couponGateway.charge('${fakeLiveKey}', { couponId: id });
  }
}

export const couponClient = axios.create({ baseURL: process.env.COUPON_API_URL });

export enum CouponState {
  Open,
  Used,
}
`,
        ),
      ],
      context,
    );

    expect(bySymbol(symbols, 'CouponController').sites).toEqual([
      {
        kind: 'decorator',
        name: 'Controller',
        line: 1,
        args: [{ text: '<literal>', literal: 'coupons' }],
      },
    ]);
    const redeem = bySymbol(symbols, 'CouponController.redeem');
    expect(redeem.sites?.map((site) => [site.kind, site.name])).toEqual([
      ['decorator', 'Post'],
      ['decorator', 'Param'],
      ['call', 'couponGateway.charge'],
    ]);
    expect(redeem.sites?.[2].args[0]).toEqual({
      text: '<literal>',
      literal: '<redacted>',
    });
    expect(JSON.stringify(symbols.map((item) => item.sites))).not.toContain(
      fakeLiveKey,
    );
    const clientSites = bySymbol(symbols, 'couponClient').sites ?? [];
    expect(clientSites.map((site) => [site.kind, site.name])).toEqual([
      ['assign', 'couponClient'],
      ['call', 'axios.create'],
    ]);
    expect(clientSites[1].args[0]).toEqual({
      text: '{ baseURL: <env> }',
      properties: {
        baseURL: { text: '<env>', identifier: 'process.env.COUPON_API_URL' },
      },
    });
    expect(bySymbol(symbols, 'CouponState').sites).toBeUndefined();
  });

  it('파일 최상위의 실행 문장을 <module> 심볼 하나로 모으고, 이미 심볼이 된 선언은 겹치지 않는다', async () => {
    // 저장소의 비밀값 검사에 걸리지 않도록 조각을 실행 중에 잇는다
    const fakeLiveKey = ['sk', 'live', 'Dotori1Acorn2Market3Shop4'].join('_');
    const { symbols } = await typescriptExtractor().extract(
      [
        file(
          'src/server.ts',
          `'use strict';
import express from 'express';
import { couponRouter } from './coupons/coupon.router';

const app = express();
const { port } = loadShopConfig();
app.get('/orders', listOrders);
app.use('/api/coupons', couponRouter);
app.post('/refunds', async (req, res) => {
  await refundService.request(req.body.orderId);
});
fastify.register(pointRoutes, { prefix: '/points' });
cron.schedule('0 3 * * *', () => pointService.expire());
new Worker(REFUND_QUEUE, (job) => refundService.process(job.data));
app.locals.currency = 'KRW';
paymentClient.configure({ apiKey: '${fakeLiveKey}' });

export function listOrders() {
  return [];
}
export default app;
`,
        ),
      ],
      context,
    );

    expect(symbols.map((item) => [item.symbol, item.kind])).toEqual([
      ['app', 'constant'],
      ['<module>', 'module'],
      ['listOrders', 'function'],
    ]);
    const moduleSymbol = bySymbol(symbols, '<module>');
    expect([moduleSymbol.lineStart, moduleSymbol.lineEnd]).toEqual([6, 16]);
    expect(moduleSymbol.content.split('\n')[0]).toBe(
      'const { port } = loadShopConfig();',
    );
    expect(moduleSymbol.content).not.toContain('express()');
    expect(moduleSymbol.content).not.toContain('use strict');
    expect(targets(moduleSymbol, 'IMPORTS')).toEqual([
      'couponRouter from ./coupons/coupon.router',
    ]);
    expect(targets(moduleSymbol, 'CALLS')).toEqual([
      'app.get',
      'app.post',
      'app.use',
      'cron.schedule',
      'fastify.register',
      'loadShopConfig',
      'paymentClient.configure',
      'pointService.expire',
      'refundService.process',
      'refundService.request',
    ]);
    expect(
      moduleSymbol.executionFacts?.find((fact) => fact.subject === 'app.get'),
    ).toEqual({
      line: 7,
      kind: 'calls',
      subject: 'app.get',
      value: '<literal>, listOrders',
    });
    const sites = moduleSymbol.sites ?? [];
    expect(
      sites.map((site) => [site.kind, site.name, site.line, site.args[0]]),
    ).toEqual([
      ['call', 'loadShopConfig', 6, undefined],
      ['call', 'app.get', 7, { text: '<literal>', literal: '/orders' }],
      ['call', 'app.use', 8, { text: '<literal>', literal: '/api/coupons' }],
      ['call', 'app.post', 9, { text: '<literal>', literal: '/refunds' }],
      [
        'call',
        'refundService.request',
        10,
        { text: 'req.body.orderId', identifier: 'req.body.orderId' },
      ],
      [
        'call',
        'fastify.register',
        12,
        { text: 'pointRoutes', identifier: 'pointRoutes' },
      ],
      ['call', 'pointService.expire', 13, undefined],
      [
        'call',
        'cron.schedule',
        13,
        { text: '<literal>', literal: '0 3 * * *' },
      ],
      [
        'call',
        'refundService.process',
        14,
        { text: 'job.data', identifier: 'job.data' },
      ],
      [
        'new',
        'Worker',
        14,
        { text: 'REFUND_QUEUE', identifier: 'REFUND_QUEUE' },
      ],
      [
        'assign',
        'app.locals.currency',
        15,
        { text: '<literal>', literal: 'KRW' },
      ],
      [
        'call',
        'paymentClient.configure',
        16,
        {
          text: '{ apiKey: <literal> }',
          properties: { apiKey: { text: '<literal>', literal: '<redacted>' } },
        },
      ],
    ]);
    expect(JSON.stringify(sites)).not.toContain(fakeLiveKey);
  });

  it('선언·가져오기·내보내기만 있는 파일에는 모듈 심볼을 만들지 않고, 상수·열거형 값은 assign 자리로 낸다', async () => {
    const { symbols } = await typescriptExtractor().extract(
      [
        file(
          'src/refund/refund.types.ts',
          `import type { Order } from '../order';
export interface RefundRequest {
  order: Order;
}
export type RefundId = string;
export const REFUND_QUEUE = 'refund-requested';
export enum RefundChannel {
  Card = 'card',
  Points,
}
export * from './refund.errors';
`,
        ),
      ],
      context,
    );

    expect(symbols.map((item) => item.symbol)).toEqual([
      'REFUND_QUEUE',
      'RefundChannel',
    ]);
    expect(bySymbol(symbols, 'REFUND_QUEUE').sites).toEqual([
      {
        kind: 'assign',
        name: 'REFUND_QUEUE',
        line: 6,
        args: [{ text: '<literal>', literal: 'refund-requested' }],
      },
    ]);
    expect(bySymbol(symbols, 'RefundChannel').sites).toEqual([
      {
        kind: 'assign',
        name: 'RefundChannel.Card',
        line: 8,
        args: [{ text: '<literal>', literal: 'card' }],
      },
    ]);
  });
});

describe('typescriptExtractor 클래스 멤버', () => {
  it('엔티티 필드는 데코레이터와 함께, 데코레이터 없는 필드도 멤버로 남긴다', async () => {
    // 저장소의 비밀값 검사에 걸리지 않도록 조각을 실행 중에 잇는다
    const fakeLiveKey = ['sk', 'live', 'Dotori1Acorn2Market3Shop4'].join('_');
    const { symbols } = await typescriptExtractor().extract(
      [
        file(
          'src/order/order.entity.ts',
          `@Entity('orders')
export class Order {
  @Column({ enum: OrderStatus })
  status: OrderStatus;

  @ManyToOne(() => Member)
  @JoinColumn({ name: 'member_id' })
  member: Member;

  memo?: string;

  @Column({ default: '${fakeLiveKey}' })
  couponCode: string;

  cancel() {
    this.status = OrderStatus.Cancelled;
  }
}
`,
        ),
      ],
      context,
    );

    const order = bySymbol(symbols, 'Order');
    expect(order.kind).toBe('entity');
    expect(order.members).toEqual([
      {
        name: 'status',
        type: 'OrderStatus',
        line: 4,
        decorators: [
          {
            kind: 'decorator',
            name: 'Column',
            line: 3,
            args: [
              {
                text: '{ enum: OrderStatus }',
                properties: {
                  enum: { text: 'OrderStatus', identifier: 'OrderStatus' },
                },
              },
            ],
          },
        ],
      },
      {
        name: 'member',
        type: 'Member',
        line: 8,
        decorators: [
          {
            kind: 'decorator',
            name: 'ManyToOne',
            line: 6,
            args: [{ text: '() => Member' }],
          },
          {
            kind: 'decorator',
            name: 'JoinColumn',
            line: 7,
            args: [
              {
                text: '{ name: <literal> }',
                properties: {
                  name: { text: '<literal>', literal: 'member_id' },
                },
              },
            ],
          },
        ],
      },
      { name: 'memo', type: 'string', line: 10, decorators: [] },
      {
        name: 'couponCode',
        type: 'string',
        line: 13,
        decorators: [
          {
            kind: 'decorator',
            name: 'Column',
            line: 12,
            args: [
              {
                text: '{ default: <literal> }',
                properties: {
                  default: { text: '<literal>', literal: '<redacted>' },
                },
              },
            ],
          },
        ],
      },
    ]);
    expect(JSON.stringify(order.members)).not.toContain(fakeLiveKey);
    expect(bySymbol(symbols, 'Order.cancel').members).toBeUndefined();
  });

  it('생성자 매개변수 속성과 데코레이터가 붙은 매개변수를 parameter 멤버로 남긴다', async () => {
    const { symbols } = await typescriptExtractor().extract(
      [
        file(
          'src/refund/refund.service.ts',
          `@Injectable()
export class RefundService {
  private readonly retryLimit = 3;

  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectQueue('refunds') private readonly refundQueue: Queue,
    private readonly events: EventEmitter2,
    clock: Clock,
  ) {}
}
`,
        ),
      ],
      context,
    );

    expect(bySymbol(symbols, 'RefundService').members).toEqual([
      { name: 'retryLimit', line: 3, decorators: [] },
      {
        name: 'orders',
        type: 'Repository<Order>',
        line: 6,
        parameter: true,
        decorators: [
          {
            kind: 'decorator',
            name: 'InjectRepository',
            line: 6,
            args: [{ text: 'Order', identifier: 'Order' }],
          },
        ],
      },
      {
        name: 'refundQueue',
        type: 'Queue',
        line: 7,
        parameter: true,
        decorators: [
          {
            kind: 'decorator',
            name: 'InjectQueue',
            line: 7,
            args: [{ text: '<literal>', literal: 'refunds' }],
          },
        ],
      },
      {
        name: 'events',
        type: 'EventEmitter2',
        line: 8,
        parameter: true,
        decorators: [],
      },
    ]);
  });
});
