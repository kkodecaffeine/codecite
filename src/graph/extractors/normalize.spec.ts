import { describe, expect, it } from 'vitest';
import type { ExtractedSymbol } from '../types.js';
import {
  boundDeclarationContent,
  collapseText,
  compareText,
  finalizeExtraction,
  finalizeFacts,
  finalizeRelations,
  hasExtension,
  importTarget,
  negateCondition,
} from './normalize.js';
import type { RawRelation } from './types.js';

const symbol = (
  filePath: string,
  name: string,
  lineStart: number,
): ExtractedSymbol => ({
  filePath,
  language: 'typescript',
  symbol: name,
  kind: 'function',
  content: '',
  lineStart,
  lineEnd: lineStart,
  relations: [],
});

describe('collapseText', () => {
  it('공백을 한 칸으로 줄이고 한도를 넘으면 표시와 함께 자른다', () => {
    expect(collapseText('  order.total\n\t  >   0 ')).toBe('order.total > 0');
    expect(collapseText('a'.repeat(20), 10)).toBe(`${'a'.repeat(9)}…`);
    expect(collapseText('a'.repeat(10), 10)).toBe('a'.repeat(10));
  });

  it('서로게이트 쌍 가운데서 자르지 않는다', () => {
    const clipped = collapseText(`${'a'.repeat(8)}🌰🌰`, 10);

    expect(clipped).toBe(`${'a'.repeat(8)}…`);
  });
});

describe('negateCondition', () => {
  it('조건을 NOT 으로 감싸고, 이름 하나를 뒤집은 조건은 ! 만 뗀다', () => {
    expect(negateCondition('cart.total > 0')).toBe('NOT (cart.total > 0)');
    expect(negateCondition('!coupon')).toBe('coupon');
    expect(negateCondition('!member?.profile.isVip')).toBe(
      'member?.profile.isVip',
    );
    expect(negateCondition('!coupon || expired')).toBe(
      'NOT (!coupon || expired)',
    );
  });
});

describe('finalizeFacts', () => {
  it('빈 칸을 빼고 같은 사실을 합친 뒤 줄 번호로 정렬하되 같은 줄은 들어온 순서를 지킨다', () => {
    const facts = finalizeFacts([
      { line: 4, kind: 'returns', value: 'refund', conditions: [] },
      { line: 2, kind: 'calls', subject: 'points.add', value: '' },
      { line: 2, kind: 'condition', value: ' member.isVip ' },
      { line: 2, kind: 'calls', subject: 'points.add', conditions: [] },
    ]);

    expect(facts).toEqual([
      { line: 2, kind: 'calls', subject: 'points.add' },
      { line: 2, kind: 'condition', value: 'member.isVip' },
      { line: 4, kind: 'returns', value: 'refund' },
    ]);
    expect(Object.keys(facts[0])).toEqual(['line', 'kind', 'subject']);
  });
});

describe('finalizeRelations', () => {
  it('저장소를 붙이고 같은 관계를 합쳐 종류·대상 순으로 정렬한다', () => {
    const relations: RawRelation[] = [
      { type: 'CALLS', symbol: 'this.couponService.issue' },
      { type: 'IMPORTS', symbol: 'CouponService from ./coupon.service' },
      { type: 'CALLS', symbol: 'this.couponService.issue' },
      { type: 'DECORATED_BY', symbol: 'Get' },
      { type: 'CALLS', symbol: 'Math.max' },
      { type: 'CALLS', symbol: '' },
    ];

    expect(finalizeRelations('shop-api', relations)).toEqual([
      {
        type: 'IMPORTS',
        target: {
          repository: 'shop-api',
          symbol: 'CouponService from ./coupon.service',
        },
      },
      {
        type: 'DECORATED_BY',
        target: { repository: 'shop-api', symbol: 'Get' },
      },
      { type: 'CALLS', target: { repository: 'shop-api', symbol: 'Math.max' } },
      {
        type: 'CALLS',
        target: { repository: 'shop-api', symbol: 'this.couponService.issue' },
      },
    ]);
  });

  it('CALLS 만 한도에서 자르고 다른 관계는 남긴다', () => {
    const calls: RawRelation[] = Array.from({ length: 320 }, (_, index) => ({
      type: 'CALLS',
      symbol: `step${String(index).padStart(3, '0')}`,
    }));
    const result = finalizeRelations('shop-api', [
      ...calls,
      { type: 'INJECTS', symbol: 'CouponRepository' },
    ]);

    expect(result.filter((relation) => relation.type === 'CALLS')).toHaveLength(
      300,
    );
    expect(result[0]).toEqual({
      type: 'INJECTS',
      target: { repository: 'shop-api', symbol: 'CouponRepository' },
    });
    expect(result.at(-1)?.target.symbol).toBe('step299');
  });
});

describe('boundDeclarationContent', () => {
  it('선언 원문이 길면 앞뒤만 남기고 함수 원문은 자르지 않는다', () => {
    const long = `${'x'.repeat(15_000)}${'y'.repeat(10_000)}`;
    const bounded = boundDeclarationContent(long, 'constant', {
      open: '#',
      close: '',
    });

    expect(bounded.startsWith('x'.repeat(15_000))).toBe(true);
    expect(bounded.endsWith('y'.repeat(5_000))).toBe(true);
    expect(bounded).toContain('\n# 5000 characters omitted \n');
    expect(
      boundDeclarationContent(long, 'method', { open: '#', close: '' }),
    ).toBe(long);
    expect(
      boundDeclarationContent('short', 'class', { open: '/*', close: '*/' }),
    ).toBe('short');
  });
});

describe('finalizeExtraction', () => {
  it('경로·줄 순으로 정렬하고 같은 파일의 겹치는 이름에 꼬리를 붙인다', () => {
    const result = finalizeExtraction({
      symbols: [
        symbol('src/b.ts', 'ship', 1),
        symbol('src/a.ts', 'refund', 9),
        symbol('src/a.ts', 'refund', 3),
        symbol('src/b.ts', 'refund', 5),
      ],
      failures: [
        { filePath: 'src/z.ts', message: 'line 1: x' },
        { filePath: 'src/c.ts', message: 'line 2: y' },
      ],
    });

    expect(
      result.symbols.map((item) => `${item.filePath}:${item.symbol}`),
    ).toEqual([
      'src/a.ts:refund',
      'src/a.ts:refund~2',
      'src/b.ts:ship',
      'src/b.ts:refund',
    ]);
    expect(result.failures.map((failure) => failure.filePath)).toEqual([
      'src/c.ts',
      'src/z.ts',
    ]);
  });
});

describe('importTarget', () => {
  it('가져온 꼴과 모듈 지정자를 잇고, 가져온 꼴이 없으면 모듈 전체로 적는다', () => {
    expect(importTarget('../refund', 'refundOrder as refund')).toBe(
      'refundOrder as refund from ../refund',
    );
    expect(importTarget('./point-rules')).toBe('* from ./point-rules');
  });
});

describe('compareText·hasExtension', () => {
  it('로캘과 상관없이 코드 포인트로 비교하고 확장자는 대소문자를 가리지 않는다', () => {
    expect(['b', 'B', 'a'].sort(compareText)).toEqual(['B', 'a', 'b']);
    expect(hasExtension('src/Order.TSX', ['.tsx'])).toBe(true);
    expect(hasExtension('src/order.ts.bak', ['.ts'])).toBe(false);
  });
});
