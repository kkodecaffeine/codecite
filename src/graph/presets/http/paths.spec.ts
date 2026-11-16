import { describe, expect, it } from 'vitest';
import { hostOf, joinHttpPaths, normalizeHttpPath } from './paths.js';

describe('normalizeHttpPath', () => {
  it.each([
    ['orders', '/orders'],
    ['/orders/', '/orders'],
    ['', '/'],
    ['/', '/'],
    ['/orders///items', '/orders/items'],
    ['/orders/:orderId', '/orders/:param'],
    ['/orders/:orderId?', '/orders/:param'],
    ['/orders/:orderId(\\d+)/items', '/orders/:param/items'],
    ['/members/{member_id}/points', '/members/:param/points'],
    ['/files/{file_path:path}', '/files/:param'],
    ['/refunds/<int:refund_id>', '/refunds/:param'],
    ['/refunds/<refund_id>/memo', '/refunds/:param/memo'],
    ['/coupons/[couponId]', '/coupons/:param'],
    ['/coupons/[...rest]', '/coupons/:param'],
    ['/coupons/[[...rest]]', '/coupons/:param'],
    ['/orders/${order.id}/items', '/orders/:param/items'],
    ['/orders/${fn({ a: 1 })}', '/orders/:param'],
    ['/orders/:orderId.json', '/orders/:param.json'],
    ['/orders?page=2', '/orders'],
    ['/orders#summary', '/orders'],
    ['https://shop-api.example.com/v1/orders/', '/v1/orders'],
    ['https://shop-api.example.com', '/'],
    ['//cdn.example.com/coupons?size=2', '/coupons'],
    ['*', '/*'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeHttpPath(input)).toBe(expected);
  });
});

describe('joinHttpPaths', () => {
  it('기준 경로와 하위 경로를 슬래시 하나로 잇는다', () => {
    expect(joinHttpPaths('orders', ':orderId/cancel')).toBe(
      '/orders/:param/cancel',
    );
    expect(joinHttpPaths('/api/', '/points/')).toBe('/api/points');
    expect(joinHttpPaths('', '')).toBe('/');
    expect(joinHttpPaths('', '/orders')).toBe('/orders');
    expect(joinHttpPaths('/', '/orders/:orderId')).toBe('/orders/:param');
  });
});

describe('hostOf', () => {
  it('스킴이 있는 주소의 호스트를 소문자로, 계정 정보와 포트를 떼고 돌려준다', () => {
    expect(hostOf('https://Pay.Example.com:8443/v1/charges')).toBe(
      'pay.example.com',
    );
    expect(hostOf('http://user@shop-api.internal/orders')).toBe(
      'shop-api.internal',
    );
    expect(hostOf('//cdn.example.com/a.png')).toBe('cdn.example.com');
  });

  it('호스트가 없거나 실행 중에 정해지면 undefined', () => {
    expect(hostOf('/orders')).toBeUndefined();
    expect(hostOf('shop-api.example.com/orders')).toBeUndefined();
    expect(hostOf('https://${}/orders')).toBeUndefined();
  });
});
