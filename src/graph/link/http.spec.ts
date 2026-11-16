import { describe, expect, it } from 'vitest';
import type { HttpCallDetection } from '../types.js';
import { externalEntry, isTrivialPath, routeKey, targetHint } from './http.js';

const call = (fields: Partial<HttpCallDetection> = {}): HttpCallDetection => ({
  kind: 'http-call',
  repository: 'shop-web',
  filePath: 'src/cart/checkout.ts',
  symbol: 'checkout',
  line: 4,
  detector: 'fetch',
  confidence: 0.9,
  evidence: 'fetch at line 4',
  method: 'POST',
  path: '/carts/:param/checkout',
  baseIdentifiers: [],
  dynamic: false,
  ...fields,
});

describe('routeKey', () => {
  it('호스트·질의·끝 `/` 를 떼고 매개변수 꼴을 모두 `:param` 하나로 맞춘다', () => {
    expect(
      routeKey('https://shop.example.com/carts/:cartId/items/?page=2'),
    ).toBe('/carts/:param/items');
    expect(routeKey('carts/{cart_id}/items/<int:item>')).toBe(
      '/carts/:param/items/:param',
    );
    expect(routeKey('/carts/[id]/coupon-${code}#top')).toBe(
      '/carts/:param/:param',
    );
    expect(routeKey('//')).toBe('/');
  });
});

describe('isTrivialPath', () => {
  it('`/`, 매개변수뿐인 경로, 흔한 조각 하나는 흔한 경로이고, 조각이 둘 이상이면 아니다', () => {
    expect(
      ['/', '/:param', '/:param/:param', '/Health', '/ping'].map(isTrivialPath),
    ).toEqual([true, true, true, true, true]);
    expect(
      ['/coupons', '/health/deep', '/carts/:param'].map(isTrivialPath),
    ).toEqual([false, false, false]);
  });
});

describe('targetHint', () => {
  it('긴 프록시 접두어가 먼저 맞고, 주소 변수가 서로 다른 저장소를 가리키면 힌트가 없다', () => {
    const hints = {
      proxyPrefixes: { '/api': 'shop-web', '/api/shop/': 'shop-api' },
      baseUrls: { SHOP_API_URL: 'shop-api', WORKER_URL: 'shop-worker' },
    };
    expect(targetHint(call(), '/api/shop/carts/:param', hints)).toEqual({
      repository: 'shop-api',
      path: '/carts/:param',
      note: 'proxy prefix /api/shop points to shop-api',
    });
    expect(
      targetHint(
        call({ baseIdentifiers: ['process.env.SHOP_API_URL', 'WORKER_URL'] }),
        '/carts',
        hints,
      ),
    ).toBeUndefined();
  });
});

describe('externalEntry', () => {
  it('하위 호스트까지 맞추고, 이름은 주소 변수와, `/` 로 시작하면 경로 접두어와 맞춘다', () => {
    expect(
      externalEntry(call({ host: 'pay.payments.example.com' }), [
        'payments.example.com',
      ]),
    ).toBe('payments.example.com');
    expect(
      externalEntry(call({ host: 'notpayments.example.com' }), [
        'payments.example.com',
      ]),
    ).toBeUndefined();
    expect(
      externalEntry(call({ baseIdentifiers: ['os.environ.PG_URL'] }), [
        'PG_URL',
      ]),
    ).toBe('PG_URL');
    expect(
      externalEntry(call({ path: '/carts' }), ['/carts/partner']),
    ).toBeUndefined();
  });
});
