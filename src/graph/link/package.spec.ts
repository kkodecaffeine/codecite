import { describe, expect, it } from 'vitest';
import { matchPackage } from './package.js';

describe('matchPackage', () => {
  it('패키지 이름·범위·`/*` 항목을 긴 것부터 맞추고 패키지 이름과 하위 경로를 나눈다', () => {
    const packages = {
      '@dotori': 'shop-api',
      '@dotori/ui/*': 'shop-web',
      dotori_shared: 'shop-worker',
    };
    expect(matchPackage('@dotori/money/format', packages)).toEqual({
      key: '@dotori',
      repository: 'shop-api',
      packageName: '@dotori/money',
      subpath: 'format',
    });
    expect(matchPackage('@dotori/ui/button', packages)).toMatchObject({
      key: '@dotori/ui/*',
      repository: 'shop-web',
      packageName: '@dotori/ui',
      subpath: 'button',
    });
    expect(matchPackage('dotori_shared.coupons', packages)).toEqual({
      key: 'dotori_shared',
      repository: 'shop-worker',
      packageName: 'dotori_shared',
      subpath: 'coupons',
    });
    expect(matchPackage('@dotorix/money', packages)).toBeUndefined();
  });
});
