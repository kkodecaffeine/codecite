import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildRepositoryRecords,
  policyGroupFor,
  stableSymbolId,
  toCurrentSymbolRecord,
  validateCurrentSymbolRecord,
} from './records.js';
import type { ExtractedSymbol, RecordContext } from './types.js';

const COMMIT = 'a'.repeat(40);
const context: RecordContext = {
  repository: 'shop-api',
  commitSha: COMMIT,
  committedAt: '2026-11-02T03:04:05.000Z',
  groups: {
    shop: ['shop-api:**'],
    points: ['shop-api:src/points/**'],
    refund: ['shop-api:src/refund/**', 'shop-web:src/refund/**'],
  },
};

const symbol = (overrides: Partial<ExtractedSymbol> = {}): ExtractedSymbol => ({
  filePath: 'src/points/earn.ts',
  language: 'typescript',
  symbol: 'earnPoints',
  kind: 'function',
  content:
    'export function earnPoints(amount: number) {\n  return amount / 100;\n}',
  lineStart: 3,
  lineEnd: 5,
  relations: [
    { type: 'CALLS', target: { repository: 'shop-api', symbol: 'roundDown' } },
    { type: 'CALLS', target: { repository: 'shop-api', symbol: 'roundDown' } },
  ],
  ...overrides,
});

describe('stableSymbolId', () => {
  it('저장소·경로·심볼 이름의 sha256 이고 경로 구분자에 흔들리지 않는다', () => {
    const expected = createHash('sha256')
      .update('shop-api\0src/points/earn.ts\0earnPoints')
      .digest('hex');
    expect(stableSymbolId('shop-api', 'src/points/earn.ts', 'earnPoints')).toBe(
      expected,
    );
    expect(
      stableSymbolId('shop-api', 'src\\points\\earn.ts', 'earnPoints'),
    ).toBe(expected);
  });
});

describe('policyGroupFor', () => {
  it('여러 묶음에 걸리면 좁은 glob 을 고른다', () => {
    expect(
      policyGroupFor('shop-api', 'src/points/earn.ts', context.groups),
    ).toBe('points');
    expect(policyGroupFor('shop-api', 'src/cart/cart.ts', context.groups)).toBe(
      'shop',
    );
    expect(
      policyGroupFor('shop-web', 'src/refund/form.tsx', context.groups),
    ).toBe('refund');
    expect(policyGroupFor('shop-worker', 'jobs/sync.py', context.groups)).toBe(
      undefined,
    );
  });
});

describe('toCurrentSymbolRecord', () => {
  it('계약 모양의 레코드를 고정된 키 순서로 만든다', () => {
    const record = toCurrentSymbolRecord(
      symbol({
        description: '주문 금액의 1 퍼센트를 도토리 적립금으로 쌓는다',
        triggeredBy: ['order.paid', 'order.paid'],
        executionFacts: [{ line: 4, kind: 'returns', value: 'amount / 100' }],
      }),
      context,
    );

    expect(Object.keys(record)).toEqual([
      'schemaVersion',
      'recordType',
      'repository',
      'filePath',
      'language',
      'symbol',
      'stableSymbolId',
      'kind',
      'commitSha',
      'committedAt',
      'contentHash',
      'content',
      'lineStart',
      'lineEnd',
      'description',
      'relations',
      'triggeredBy',
      'policyGroup',
      'executionFacts',
    ]);
    expect(record.policyGroup).toBe('points');
    expect(record.relations).toHaveLength(1);
    expect(record.triggeredBy).toEqual(['order.paid']);
    expect(record.contentHash).toBe(
      createHash('sha256').update(symbol().content).digest('hex'),
    );
  });

  it('원문 해시는 가리기 전 원문으로 만들고 저장하는 원문과 실행 사실 값은 가린다', () => {
    const secret = ['acorn', 'Pass', '42'].join('');
    const content = `const shopPassword = '${secret}';`;
    const record = toCurrentSymbolRecord(
      symbol({
        content,
        executionFacts: [
          {
            line: 3,
            kind: 'assigns',
            subject: 'shopPassword',
            value: `'${secret}'`,
          },
        ],
      }),
      context,
    );
    expect(record.content).toBe("const shopPassword = '[REDACTED]';");
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(record.contentHash).toBe(
      createHash('sha256').update(content).digest('hex'),
    );
  });

  it('추출기가 더한 중간 데이터는 레코드에 들어가지 않는다', () => {
    const withSites = {
      ...symbol(),
      sites: [
        {
          kind: 'call',
          name: 'acornQueue.push',
          line: 1,
          args: [{ text: '<literal>', literal: 'refund' }],
        },
      ],
      parserState: { depth: 2 },
    } as ExtractedSymbol;
    const record = toCurrentSymbolRecord(withSites, context);
    expect(record).not.toHaveProperty('sites');
    expect(record).not.toHaveProperty('parserState');
    expect(JSON.stringify(record)).not.toContain('acornQueue');
  });

  it('묶음 설정이 없으면 policyGroup 을 비우고, 빈 목록은 쓰지 않는다', () => {
    const record = toCurrentSymbolRecord(
      symbol({ relations: [], triggeredBy: [], executionFacts: [] }),
      { ...context, groups: {} },
    );
    expect(record).not.toHaveProperty('policyGroup');
    expect(record).not.toHaveProperty('triggeredBy');
    expect(record).not.toHaveProperty('executionFacts');
    expect(record.relations).toEqual([]);
  });

  it('계약에 맞지 않는 추출 결과는 어느 심볼인지 밝혀 거절한다', () => {
    expect(() =>
      toCurrentSymbolRecord(symbol({ lineStart: 0 }), context),
    ).toThrow(/shop-api src\/points\/earn\.ts earnPoints: lineStart/);
    expect(() =>
      toCurrentSymbolRecord(
        symbol({ filePath: '/home/dev/shop-api/src/a.ts' }),
        context,
      ),
    ).toThrow(/repository-relative/);
    expect(() =>
      toCurrentSymbolRecord(
        symbol({
          relations: [
            {
              type: 'IMPORTS',
              target: { repository: 'shop-api', filePath: '../shared/x.ts' },
            },
          ],
        }),
        context,
      ),
    ).toThrow(/relations\[0\]\.target\.filePath/);
    expect(() =>
      toCurrentSymbolRecord(symbol({ lineStart: 9, lineEnd: 4 }), context),
    ).toThrow(/lineEnd/);
  });
});

describe('validateCurrentSymbolRecord', () => {
  const valid = () =>
    JSON.parse(
      JSON.stringify(toCurrentSymbolRecord(symbol(), context)),
    ) as Record<string, unknown>;

  it('같은 값의 레코드를 키 순서를 고정해 돌려준다', () => {
    const shuffled = Object.fromEntries(Object.entries(valid()).reverse());
    expect(JSON.stringify(validateCurrentSymbolRecord(shuffled))).toBe(
      JSON.stringify(valid()),
    );
  });

  it('변경 원문·비밀값 키와 계약에 없는 키를 거절한다', () => {
    expect(() =>
      validateCurrentSymbolRecord({ ...valid(), raw_patch: 'x' }),
    ).toThrow(/forbidden field raw_patch/);
    expect(() =>
      validateCurrentSymbolRecord({
        ...valid(),
        relations: [
          {
            type: 'CALLS',
            target: { repository: 'shop-api', symbol: 'a', secretValue: 'x' },
          },
        ],
      }),
    ).toThrow(/forbidden field secretValue/);
    expect(() =>
      validateCurrentSymbolRecord({ ...valid(), owner: 'x' }),
    ).toThrow(/unknown field owner/);
  });

  it('경로·이름과 맞지 않는 id 와 틀린 날짜·커밋 모양을 거절한다', () => {
    expect(() =>
      validateCurrentSymbolRecord({ ...valid(), symbol: 'other' }),
    ).toThrow(/stableSymbolId does not match/);
    expect(() =>
      validateCurrentSymbolRecord({
        ...valid(),
        committedAt: '2026-11-02 03:04',
      }),
    ).toThrow(/committedAt/);
    expect(() =>
      validateCurrentSymbolRecord({ ...valid(), commitSha: 'main' }),
    ).toThrow(/commitSha/);
  });
});

describe('buildRepositoryRecords', () => {
  it('파일·줄 순서로 정렬하고 같은 심볼이 겹치면 앞 줄 것만 남기고 실패로 적는다', () => {
    const result = buildRepositoryRecords(
      [
        symbol({
          filePath: 'src/refund/refund.ts',
          symbol: 'refund',
          lineStart: 20,
          lineEnd: 30,
        }),
        symbol({
          filePath: 'src/refund/refund.ts',
          symbol: 'refund',
          lineStart: 2,
          lineEnd: 8,
        }),
        symbol(),
      ],
      context,
    );
    expect(
      result.records.map((record) => [record.filePath, record.lineStart]),
    ).toEqual([
      ['src/points/earn.ts', 3],
      ['src/refund/refund.ts', 2],
    ]);
    expect(result.failures).toEqual([
      {
        filePath: 'src/refund/refund.ts',
        message: 'duplicate symbol refund at line 20; kept the first one',
      },
    ]);
  });
});
