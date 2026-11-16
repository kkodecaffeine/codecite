import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GRAPH_DEFAULT_EXCLUDES } from './constants.js';
import {
  compileGlob,
  isFloorExcluded,
  matchesGlob,
  matchingExtension,
  readSourceFiles,
  selectSourceFiles,
  validateGlob,
} from './files.js';

describe('matchesGlob', () => {
  it('`/` 가 있는 glob 은 저장소 뿌리부터, `**` 는 여러 단계를 맞춘다', () => {
    expect(matchesGlob('src/order/cart.service.ts', 'src/**')).toBe(true);
    expect(matchesGlob('lib/src/order.ts', 'src/**')).toBe(false);
    expect(matchesGlob('src/order/cart.spec.ts', '**/*.spec.ts')).toBe(true);
    expect(matchesGlob('cart.spec.ts', '**/*.spec.ts')).toBe(true);
    expect(matchesGlob('src/order/cart.ts', 'src/*.ts')).toBe(false);
  });

  it('`/` 가 없는 glob 은 경로의 어느 조각에든 맞춘다', () => {
    expect(
      matchesGlob('packages/web/node_modules/x/index.js', 'node_modules'),
    ).toBe(true);
    expect(matchesGlob('src/review/review.spec.ts', '*.spec.ts')).toBe(true);
    expect(matchesGlob('src/review/review.ts', '*.spec.ts')).toBe(false);
  });

  it('폴더에 맞으면 그 아래 파일도 맞는다', () => {
    expect(matchesGlob('src/legacy/coupon/old.ts', 'src/legacy')).toBe(true);
    expect(matchesGlob('src/legacy-coupon/new.ts', 'src/legacy')).toBe(false);
  });

  it('중괄호·글자 묶음·물음표를 받는다', () => {
    expect(matchesGlob('src/points/earn.tsx', 'src/**/*.{ts,tsx}')).toBe(true);
    expect(matchesGlob('src/points/earn.js', 'src/**/*.{ts,tsx}')).toBe(false);
    expect(matchesGlob('src/v2/refund.ts', 'src/v[0-9]/*.ts')).toBe(true);
    expect(matchesGlob('src/vx/refund.ts', 'src/v[!x]/*.ts')).toBe(false);
    expect(matchesGlob('src/a1.ts', 'src/a?.ts')).toBe(true);
  });

  it('이어진 `**` 조각은 하나로 보고, 깊은 경로도 한 번에 맞춘다', () => {
    const deep = `${'a/'.repeat(200)}cart.spec.ts`;
    expect(matchesGlob(deep, '**/**/**/*.spec.*')).toBe(true);
    expect(matchesGlob(`${'a/'.repeat(200)}cart.ts`, '**/**/**/*.spec.*')).toBe(
      false,
    );
    expect(matchesGlob('src/a/b/legacy/x.ts', 'src/**/**/legacy')).toBe(true);
  });

  it('정규식 특수 글자는 글자 그대로 본다', () => {
    expect(matchesGlob('src/(shop)/page.tsx', 'src/(shop)/*.tsx')).toBe(true);
    expect(matchesGlob('src/shopXpage.tsx', 'src/shop.page.tsx')).toBe(false);
  });

  it('짝이 맞지 않는 괄호와 저장소 밖 glob 은 거절한다', () => {
    expect(() => compileGlob('src/{a,b')).toThrow(/unclosed/);
    expect(() => compileGlob('src/[ab')).toThrow(/unclosed/);
    expect(() => validateGlob('../shop-web/**')).toThrow(
      /inside the repository/,
    );
    expect(() => validateGlob('/srv/shop/**')).toThrow(/inside the repository/);
    expect(() => validateGlob('src/**')).not.toThrow();
  });
});

describe('isFloorExcluded', () => {
  it.each([
    '.env',
    'config/.env.local',
    'deploy/shop.env',
    'deploy/staging.env.json',
    'data/coupons.csv',
    'data/coupons.csv.gz',
    'data/COUPONS.CSV',
    'packages/web/node_modules/lib/index.js',
    'src/.git/config',
    'config/secrets/payment.ts',
    'src/delivery/courier-credentials.ts',
    'keys/server.pem',
    'keys/id_ed25519',
    '.npmrc',
  ])('%s 는 늘 뺀다', (filePath) => {
    expect(isFloorExcluded(filePath)).toBe(true);
  });

  it.each([
    'src/order/order.service.ts',
    'src/membership/grade.ts',
    'src/review/review.controller.ts',
    'src/environment/region.ts',
  ])('%s 는 바닥 규칙에 걸리지 않는다', (filePath) => {
    expect(isFloorExcluded(filePath)).toBe(false);
  });
});

describe('selectSourceFiles', () => {
  const tracked = [
    'src/points/earn.ts',
    'src/points/earn.spec.ts',
    'src/refund/refund.ts',
    'src/refund/__tests__/refund.ts',
    'src/legacy/old-coupon.ts',
    'examples/demo.ts',
    'migrations/0001-orders.ts',
    'scripts/seed.py',
    'docs/shipping.md',
    '.env.production',
    'data/members.csv',
  ];

  it('바닥 규칙 → 기본 제외 → exclude → include → 추출기 순서로 고르고 까닭별로 센다', () => {
    const selection = selectSourceFiles(tracked, {
      include: ['src/**', 'scripts/**'],
      exclude: ['src/legacy'],
      defaultExcludes: [...GRAPH_DEFAULT_EXCLUDES],
      extensions: ['.ts'],
    });
    expect(selection.selected).toEqual([
      'src/points/earn.ts',
      'src/refund/refund.ts',
    ]);
    expect(selection.skipped).toEqual({
      floor: 2,
      defaultExcludes: 4,
      exclude: 1,
      notIncluded: 1,
      unsupported: 1,
      binary: 0,
      tooLarge: 0,
    });
  });

  it('기본 제외는 끌 수 있지만 바닥 규칙은 끌 수 없다', () => {
    const selection = selectSourceFiles(tracked, { defaultExcludes: [] });
    expect(selection.selected).toContain('src/points/earn.spec.ts');
    expect(selection.selected).toContain('migrations/0001-orders.ts');
    expect(selection.selected).not.toContain('.env.production');
    expect(selection.selected).not.toContain('data/members.csv');
    expect(selection.skipped.floor).toBe(2);
  });

  it('결과는 실행 환경과 상관없이 같은 순서다', () => {
    const forward = selectSourceFiles(tracked, { defaultExcludes: [] });
    const backward = selectSourceFiles([...tracked].reverse(), {
      defaultExcludes: [],
    });
    expect(backward).toEqual(forward);
  });
});

describe('matchingExtension', () => {
  it('맞는 확장자 가운데 가장 긴 것을 대소문자 없이 고른다', () => {
    expect(matchingExtension('src/a.d.ts', ['.ts', '.d.ts'])).toBe('.d.ts');
    expect(matchingExtension('src/Cart.TSX', ['.tsx'])).toBe('.tsx');
    expect(matchingExtension('src/cart.py', ['.ts'])).toBeUndefined();
  });
});

describe('readSourceFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codecite-files-'));
    await mkdir(join(root, 'src'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('글 파일만 읽고 글이 아닌 파일·링크는 건너뛰고 센다', async () => {
    await writeFile(join(root, 'src/grade.ts'), '﻿export const grade = 1;\n');
    await writeFile(
      join(root, 'src/logo.ts'),
      Buffer.from([0x89, 0x50, 0x00, 0x01]),
    );
    await writeFile(
      join(root, 'src/broken.ts'),
      Buffer.from([0xff, 0xfe, 0xfd]),
    );
    await symlink(join(root, 'src/grade.ts'), join(root, 'src/link.ts'));

    const result = await readSourceFiles(root, 'shop-api', [
      'src/grade.ts',
      'src/logo.ts',
      'src/broken.ts',
      'src/link.ts',
    ]);

    expect(result.files).toEqual([
      {
        repository: 'shop-api',
        filePath: 'src/grade.ts',
        content: 'export const grade = 1;\n',
      },
    ]);
    expect(result.skipped).toEqual({ binary: 3, tooLarge: 0 });
  });
});
