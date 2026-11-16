import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GraphReport } from '../types.js';
import { formatGraphReport, readGraphReport } from './report.js';

const report = (): GraphReport => ({
  schemaVersion: 1,
  generatedAt: '2026-11-05T10:00:00.000Z',
  coverage: {
    status: 'fail',
    expectedRepositories: ['shop-api', 'shop-web', 'shop-worker'],
    auditedRepositories: ['shop-api', 'shop-web'],
    relationCounts: { HTTP_CALLS: 2, SHARES_ENTITY: 1 },
    providerContracts: 4,
    linkedProviderContracts: 3,
    unresolvedProviderContracts: 1,
  },
  unresolvedRatio: 0.25,
  relations: { HTTP_CALLS: 2, SHARES_ENTITY: 1 },
  reasons: { 'ambiguous-provider': 1, 'no-caller': 2 },
  detectors: { nestjs: { 'http-route': 4 }, fetch: { 'http-call': 3 } },
  extractionFailures: [
    {
      repository: 'shop-web',
      filePath: 'src/legacy.ts',
      message: 'cannot parse',
    },
  ],
  unresolved: [
    {
      reason: 'ambiguous-provider',
      relation: 'HTTP_CALLS',
      repository: 'shop-web',
      filePath: 'src/cart/checkout.ts',
      symbol: 'checkout',
      line: 12,
      value: 'POST /carts/:param/checkout',
      candidates: [
        'shop-api:src/cart.ts#CartController.checkout',
        'shop-worker:src/cart.ts#checkout',
      ],
    },
    {
      reason: 'no-caller',
      relation: 'HTTP_CALLS',
      repository: 'shop-api',
      filePath: 'src/coupon.ts',
      symbol: 'CouponController.list',
      line: 8,
      value: 'GET /coupons',
    },
    {
      reason: 'no-caller',
      relation: 'GRAPHQL_CALLS',
      repository: 'shop-api',
      filePath: 'src/review.resolver.ts',
      symbol: 'ReviewResolver.reviews',
      line: 3,
      value: 'query reviews',
    },
  ],
});

describe('formatGraphReport', () => {
  it('요약, 까닭별 항목과 다음 할 일, 추출 실패, 탐지기별 수를 보인다', () => {
    const text = formatGraphReport(report());
    expect(text.split('\n').slice(0, 4)).toEqual([
      'Coverage: fail - 3 of 4 provider contracts linked, 1 unresolved (25.0%)',
      'Repositories: shop-api, shop-web; no symbols in shop-worker',
      'Links: HTTP_CALLS 2, SHARES_ENTITY 1',
      'Unresolved: 3 (ambiguous-provider 1, no-caller 2)',
    ]);
    expect(text).toContain(
      '  shop-web src/cart/checkout.ts:12 checkout HTTP_CALLS POST /carts/:param/checkout\n    candidates: shop-api:src/cart.ts#CartController.checkout, shop-worker:src/cart.ts#checkout\n',
    );
    expect(text).toMatch(
      /^ambiguous-provider \(1\): .+ Next: narrow the target/m,
    );
    expect(text).toContain(
      'Skipped files: 1\n  shop-web src/legacy.ts: cannot parse\n',
    );
    expect(
      text.endsWith('  nestjs: http-route 4\n  fetch: http-call 3\n'),
    ).toBe(true);
  });

  it('까닭마다 보일 항목 수를 넘으면 나머지는 수만 적는다', () => {
    const text = formatGraphReport(report(), { itemsPerReason: 1 });
    expect(text).toContain('HTTP_CALLS GET /coupons\n  ... and 1 more\n');
    expect(text).not.toContain('query reviews');
  });
});

describe('readGraphReport', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codecite-report-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('없으면 undefined, 있으면 읽고, 보고서 모양이 아니면 멈춘다', async () => {
    expect(await readGraphReport(root)).toBeUndefined();
    await writeFile(join(root, 'report.json'), JSON.stringify(report()));
    expect(await readGraphReport(root)).toEqual(report());
    await writeFile(
      join(root, 'report.json'),
      JSON.stringify({ unresolved: [] }),
    );
    await expect(readGraphReport(root)).rejects.toThrow(
      'report.json: not a graph report',
    );
  });
});
