import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { CodeSite } from '../types.js';
import { createTypeScriptFactProjector } from './facts-typescript.js';
import { createTypeScriptSiteReader } from './sites-typescript.js';

const reader = createTypeScriptSiteReader(
  ts,
  createTypeScriptFactProjector(ts),
);

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile(
    '/shop-web/src/sample.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/** 첫 함수 선언의 자리 */
function sitesOf(source: string): CodeSite[] {
  const sourceFile = parse(source);
  const declaration = sourceFile.statements.find(ts.isFunctionDeclaration);
  if (!declaration) {
    throw new Error('no function in sample');
  }
  return reader.sites(sourceFile, declaration);
}

describe('createTypeScriptSiteReader', () => {
  it('클래스에는 클래스 데코레이터만, 메서드에는 메서드·매개변수 데코레이터와 본문 호출을 준다', () => {
    const sourceFile = parse(`@Controller('coupons')
export class CouponController {
  @Get(':id')
  @UseGuards(MemberGuard)
  find(@Param('id') id: string) {
    return this.couponService.find(id);
  }
}`);
    const declaration = sourceFile.statements[0] as ts.ClassDeclaration;
    const method = declaration.members[0];

    expect(reader.decoratorSites(sourceFile, declaration)).toEqual([
      {
        kind: 'decorator',
        name: 'Controller',
        line: 1,
        args: [{ text: '<literal>', literal: 'coupons' }],
      },
    ]);
    expect(reader.sites(sourceFile, method)).toEqual([
      {
        kind: 'decorator',
        name: 'Get',
        line: 3,
        args: [{ text: '<literal>', literal: ':id' }],
      },
      {
        kind: 'decorator',
        name: 'UseGuards',
        line: 4,
        args: [{ text: 'MemberGuard', identifier: 'MemberGuard' }],
      },
      {
        kind: 'decorator',
        name: 'Param',
        line: 5,
        args: [{ text: '<literal>', literal: 'id' }],
      },
      {
        kind: 'call',
        name: 'this.couponService.find',
        line: 6,
        args: [{ text: 'id', identifier: 'id' }],
      },
    ]);
  });

  it('주소 인자를 문자열·템플릿·이름·문자열 더하기로 나눠 읽는다', () => {
    const sites = sitesOf(`async function loadCoupons(memberId: string) {
  await fetch('/api/coupons');
  await fetch(\`\${SHOP_API}/members/\${memberId}/coupons\`);
  await axios.get(COUPON_LIST_URL);
  await this.http.post(process.env.SHOP_API_URL + '/coupons/' + memberId);
}`);

    expect(sites.map((site) => [site.kind, site.name, site.args[0]])).toEqual([
      ['call', 'fetch', { text: '<literal>', literal: '/api/coupons' }],
      [
        'call',
        'fetch',
        {
          text: '<literal>',
          template: ['', '/members/', '/coupons'],
          substitutions: [
            { text: 'SHOP_API', identifier: 'SHOP_API' },
            { text: 'memberId', identifier: 'memberId' },
          ],
        },
      ],
      [
        'call',
        'axios.get',
        { text: 'COUPON_LIST_URL', identifier: 'COUPON_LIST_URL' },
      ],
      [
        'call',
        'this.http.post',
        {
          text: '<env> + <literal> + memberId',
          template: ['', '/coupons/', ''],
          substitutions: [
            { text: '<env>', identifier: 'process.env.SHOP_API_URL' },
            { text: 'memberId', identifier: 'memberId' },
          ],
        },
      ],
    ]);
  });

  it('객체·배열 인자는 속성과 원소로 펼친다', () => {
    const [site] = sitesOf(`function redeem(memberId: string, codes: string[]) {
  axios.request({ method: 'POST', url: REDEEM_URL, memberId, tags: ['coupon', kind] });
}`);

    expect(site.args).toEqual([
      {
        text: '{ method: <literal>, url: REDEEM_URL, memberId, tags: [<literal>, kind] }',
        properties: {
          method: { text: '<literal>', literal: 'POST' },
          url: { text: 'REDEEM_URL', identifier: 'REDEEM_URL' },
          memberId: { text: 'memberId', identifier: 'memberId' },
          tags: {
            text: '[<literal>, kind]',
            elements: [
              { text: '<literal>', literal: 'coupon' },
              { text: 'kind', identifier: 'kind' },
            ],
          },
        },
      },
    ]);
  });

  it('큐 이름은 상수 이름 그대로 남겨 탐지기가 상수를 따라가게 한다', () => {
    const sites = sitesOf(`function requestRefund(order: Order) {
  refundQueue.send(Queues.REFUND_REQUESTED, { orderId: order.id });
  const worker = new Worker(REFUND_QUEUE, handleRefund);
}`);

    expect(
      sites.map((site) => [
        site.kind,
        site.name,
        site.line,
        site.args[0].identifier,
      ]),
    ).toEqual([
      ['call', 'refundQueue.send', 2, 'Queues.REFUND_REQUESTED'],
      ['new', 'Worker', 3, 'REFUND_QUEUE'],
    ]);
  });

  it('콜백 안의 호출은 넣고, 안쪽 클래스와 모듈을 읽는 호출은 뺀다', () => {
    const sites = sitesOf(`function settle(orders: Order[]) {
  const rules = require('./refund-rules');
  orders.forEach((order) => ledger.reverse(order.id));
  class LocalCache { load() { return cache.read(KEY); } }
}`);

    expect(sites.map((site) => site.name)).toEqual([
      'ledger.reverse',
      'orders.forEach',
    ]);
  });
});
