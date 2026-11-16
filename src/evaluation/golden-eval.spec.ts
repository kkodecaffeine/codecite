import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { policiesFromClaimCsv } from '../adapters/csv-policy-source.js';
import type { CodeciteAnswer, CodeciteCitation } from '../types.js';
import {
  collectClaimIds,
  compareWithBaseline,
  createGoldenBaseline,
  findUnknownClaimIds,
  formatGoldenReport,
  parseGoldenBaseline,
  parseGoldenQuestions,
  readGoldenBaseline,
  runGoldenQuestions,
  scoreGoldenAnswer,
  writeGoldenBaseline,
} from './golden-eval.js';
import type { GoldenQuestion, GoldenQuestionResult } from './types.js';

const citation = (claimId: string): CodeciteCitation => ({
  claimId,
  policyGroup: 'shipping',
  statement: `${claimId} 문장`,
});

const answer = (
  status: CodeciteAnswer['status'],
  claimIds: string[] = [],
): CodeciteAnswer => ({
  status,
  answer: '답',
  citations: claimIds.map(citation),
  trace: {
    retrieval: 'bm25',
    generation: 'deterministic',
    candidates: claimIds.length,
    packed: claimIds.length,
  },
});

const WEEKEND: GoldenQuestion = {
  id: 'shipping-01',
  question: '토요일 밤에 주문하면 언제 출고돼요?',
  expectedClaimIds: ['claim-weekend', 'claim-weekend-holiday'],
};

const NO_EVIDENCE: GoldenQuestion = {
  id: 'none-01',
  question: '도토리 마켓 창고는 몇 층 건물이에요?',
  expectedClaimIds: [],
  expectStatus: 'insufficient_evidence',
};

const result = (
  id: string,
  checks: Partial<GoldenQuestionResult> = {},
): GoldenQuestionResult => {
  const base = {
    id,
    hitAny: true,
    hitAll: true,
    status: 'answered' as const,
    statusMatch: null,
    ...checks,
  };
  return {
    ...base,
    passed: [base.hitAny, base.hitAll, base.statusMatch].every(
      (value) => value !== false,
    ),
  };
};

describe('scoreGoldenAnswer', () => {
  it('기대 claim 이 일부만 인용되면 hitAny 는 맞고 hitAll 은 틀린다', () => {
    expect(
      scoreGoldenAnswer(WEEKEND, answer('answered', ['claim-weekend', 'x'])),
    ).toEqual({
      id: 'shipping-01',
      passed: false,
      hitAny: true,
      hitAll: false,
      status: 'answered',
      statusMatch: null,
    });
  });

  it('기대 claim 이 모두 인용되면 맞는다. 인용 순서와 다른 claim 은 상관없다', () => {
    const scored = scoreGoldenAnswer(
      WEEKEND,
      answer('answered', [
        'claim-other',
        'claim-weekend-holiday',
        'claim-weekend',
      ]),
    );

    expect(scored).toMatchObject({ passed: true, hitAny: true, hitAll: true });
  });

  it('기대 claim 이 없는 질문은 status 만 재고 hit 항목은 null 로 둔다', () => {
    expect(
      scoreGoldenAnswer(NO_EVIDENCE, answer('insufficient_evidence')),
    ).toEqual({
      id: 'none-01',
      passed: true,
      hitAny: null,
      hitAll: null,
      status: 'insufficient_evidence',
      statusMatch: true,
    });
    expect(
      scoreGoldenAnswer(NO_EVIDENCE, answer('answered', ['claim-weekend'])),
    ).toMatchObject({ passed: false, statusMatch: false });
  });

  it('expectStatus 와 기대 claim 이 함께 있으면 둘 다 맞아야 한다', () => {
    const question = { ...WEEKEND, expectStatus: 'answered' as const };

    expect(
      scoreGoldenAnswer(
        question,
        answer('answered', ['claim-weekend', 'claim-weekend-holiday']),
      ),
    ).toMatchObject({ passed: true, statusMatch: true });
    expect(
      scoreGoldenAnswer(question, answer('insufficient_evidence')),
    ).toMatchObject({
      passed: false,
      hitAny: false,
      hitAll: false,
      statusMatch: false,
    });
  });
});

describe('runGoldenQuestions', () => {
  it('질문을 순서대로 하나씩 묻고 결과를 같은 순서로 돌려준다', async () => {
    const asked: string[] = [];
    const answers = new Map([
      [WEEKEND.question, answer('answered', ['claim-weekend'])],
      [NO_EVIDENCE.question, answer('insufficient_evidence')],
    ]);

    const results = await runGoldenQuestions(
      {
        ask: async (question) => {
          asked.push(question);
          return answers.get(question) ?? answer('insufficient_evidence');
        },
      },
      [WEEKEND, NO_EVIDENCE],
    );

    expect(asked).toEqual([WEEKEND.question, NO_EVIDENCE.question]);
    expect(results.map((item) => [item.id, item.passed])).toEqual([
      ['shipping-01', false],
      ['none-01', true],
    ]);
  });
});

describe('compareWithBaseline', () => {
  const baseline = createGoldenBaseline([
    result('coupon-01'),
    result('coupon-02', { hitAll: false }),
    result('none-01', {
      hitAny: null,
      hitAll: null,
      status: 'insufficient_evidence',
      statusMatch: true,
    }),
  ]);

  it('결과가 기준선과 같으면 회귀도 개선도 없다', () => {
    expect(compareWithBaseline(baseline.questions, baseline)).toEqual({
      regressions: [],
      improvements: [],
      added: [],
    });
  });

  it('기준선에서 맞던 항목이 틀려지면 항목마다 회귀로 센다', () => {
    const comparison = compareWithBaseline(
      [
        result('coupon-01', { hitAny: false, hitAll: false }),
        result('coupon-02', { hitAll: false }),
        result('none-01', {
          hitAny: null,
          hitAll: null,
          statusMatch: false,
        }),
      ],
      baseline,
    );

    expect(comparison.regressions).toEqual([
      { id: 'coupon-01', check: 'hitAny' },
      { id: 'coupon-01', check: 'hitAll' },
      { id: 'none-01', check: 'statusMatch' },
    ]);
    expect(comparison.improvements).toEqual([]);
  });

  it('기준선의 질문이 결과에 없으면 회귀, 새 질문은 따로 알린다', () => {
    const comparison = compareWithBaseline(
      [result('coupon-01'), result('coupon-02'), result('coupon-03')],
      baseline,
    );

    expect(comparison.regressions).toEqual([
      { id: 'none-01', check: 'missing' },
    ]);
    expect(comparison.added).toEqual(['coupon-03']);
  });

  it('맞던 항목을 더는 재지 않게 되어도 회귀로 센다', () => {
    const comparison = compareWithBaseline(
      [
        result('coupon-01', { hitAny: null, hitAll: null, statusMatch: true }),
        result('coupon-02', { hitAll: false }),
        baseline.questions[2],
      ],
      baseline,
    );

    expect(comparison.regressions).toEqual([
      { id: 'coupon-01', check: 'hitAny' },
      { id: 'coupon-01', check: 'hitAll' },
    ]);
    expect(comparison.improvements).toEqual([
      { id: 'coupon-01', check: 'statusMatch' },
    ]);
  });

  it('틀리던 항목이 맞으면 개선으로 알리고 회귀로 세지 않는다', () => {
    const comparison = compareWithBaseline(
      [result('coupon-01'), result('coupon-02'), baseline.questions[2]],
      baseline,
    );

    expect(comparison.regressions).toEqual([]);
    expect(comparison.improvements).toEqual([
      { id: 'coupon-02', check: 'hitAll' },
    ]);
  });
});

describe('findUnknownClaimIds', () => {
  it('정책 데이터에 없는 claim id 를 기대하는 질문만 골라낸다', async () => {
    const policies = policiesFromClaimCsv(
      [
        'policy_group,feature_name,claim_statement,claim_facet,claim_id',
        'shipping,주말 주문 출고,토요일과 일요일에 들어온 주문은 다음 평일에 출고한다.,schedule,claim-weekend',
      ].join('\n'),
    );
    const known = await collectClaimIds({ loadPolicies: async () => policies });

    expect(known).toEqual(new Set(['claim-weekend']));
    expect(findUnknownClaimIds([WEEKEND, NO_EVIDENCE], known)).toEqual([
      { id: 'shipping-01', claimIds: ['claim-weekend-holiday'] },
    ]);
  });
});

describe('parseGoldenQuestions', () => {
  it('올바른 질문 목록을 그대로 돌려준다', () => {
    expect(parseGoldenQuestions([WEEKEND, NO_EVIDENCE])).toEqual([
      WEEKEND,
      NO_EVIDENCE,
    ]);
  });

  it.each([
    [{ question: '배송비는?' }, 'entry 1 needs an id'],
    [{ ...WEEKEND, question: ' ' }, 'shipping-01: question must be'],
    [
      { ...WEEKEND, expectedClaimIds: 'claim-weekend' },
      'expectedClaimIds must',
    ],
    [{ ...WEEKEND, expectStatus: 'unknown' }, 'expectStatus must be one of'],
    [{ ...WEEKEND, expectedClaimIds: [] }, 'needs expectedClaimIds or'],
  ])('틀린 항목 %j 은 질문 id 를 적어 throw 한다', (entry, message) => {
    expect(() => parseGoldenQuestions([entry])).toThrow(message);
  });

  it('id 가 겹치면 throw 하고, 오류 문장에 질문 본문을 넣지 않는다', () => {
    expect(() => parseGoldenQuestions([WEEKEND, WEEKEND])).toThrow(
      'golden-questions.json: shipping-01: id is used by another question.',
    );
    expect(() =>
      parseGoldenQuestions([{ ...WEEKEND, expectedClaimIds: [] }]),
    ).not.toThrow(WEEKEND.question);
  });

  it('배열이 아니면 throw 한다', () => {
    expect(() => parseGoldenQuestions({ questions: [] })).toThrow(
      'must be an array of questions',
    );
  });
});

describe('기준선 파일', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'codecite-golden-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('쓴 기준선을 다시 읽으면 같다. 파일이 없으면 undefined', async () => {
    const path = join(folder, 'baseline.json');
    const baseline = createGoldenBaseline([
      result('coupon-01'),
      result('coupon-02', { hitAll: false }),
    ]);

    expect(await readGoldenBaseline(path)).toBeUndefined();
    await writeGoldenBaseline(path, baseline);

    expect(await readGoldenBaseline(path)).toEqual(baseline);
    expect(baseline).toMatchObject({ schemaVersion: 1, total: 2, passed: 1 });
  });

  it('합계는 질문 결과로 다시 세고, 틀린 모양은 throw 한다', () => {
    const baseline = createGoldenBaseline([result('coupon-01')]);

    expect(
      parseGoldenBaseline({ ...baseline, total: 9, passed: 9 }),
    ).toMatchObject({ total: 1, passed: 1 });
    expect(() =>
      parseGoldenBaseline({ ...baseline, schemaVersion: 2 }),
    ).toThrow('schemaVersion must be 1');
    expect(() =>
      parseGoldenBaseline({
        ...baseline,
        questions: [{ ...baseline.questions[0], hitAll: 'yes' }],
      }),
    ).toThrow('baseline.json: coupon-01: hitAll must be true, false or null.');
    expect(() =>
      parseGoldenBaseline({
        ...baseline,
        questions: [baseline.questions[0], baseline.questions[0]],
      }),
    ).toThrow('coupon-01 needs a unique id');
  });
});

describe('formatGoldenReport', () => {
  it('합계 표, 회귀, 개선, 새 질문, 틀린 질문, 모르는 claim 을 보인다', () => {
    const baseline = createGoldenBaseline([
      result('coupon-01'),
      result('coupon-02', { hitAll: false }),
      result('coupon-04'),
    ]);
    const results = [
      result('coupon-01', { hitAll: false }),
      result('coupon-02'),
      result('coupon-03', {
        hitAny: null,
        hitAll: null,
        status: 'insufficient_evidence',
        statusMatch: true,
      }),
    ];

    const report = formatGoldenReport({
      results,
      baseline,
      comparison: compareWithBaseline(results, baseline),
      unknown: [{ id: 'coupon-01', claimIds: ['claim-gone'] }],
    });

    expect(report).toBe(
      [
        'Golden questions: 3',
        '',
        '        now  baseline',
        'passed  2/3  2/3',
        'hitAny  2/2  3/3',
        'hitAll  1/2  2/3',
        'status  1/1  0/0',
        '',
        'Regressions: 2',
        '  coupon-01  hitAll: pass -> fail',
        '  coupon-04  missing from the results',
        'Improvements: 1',
        '  coupon-02  hitAll: fail -> pass',
        'New questions (not in the baseline): coupon-03',
        'Misses: coupon-01',
        'Claim ids not in the policy data:',
        '  coupon-01: claim-gone',
        '',
      ].join('\n'),
    );
  });

  it('기준선 없이 부르면 지금 결과만 보이고 틀린 질문이 없으면 none 이라고 쓴다', () => {
    expect(formatGoldenReport({ results: [result('coupon-01')] })).toBe(
      [
        'Golden questions: 1',
        '',
        '        now',
        'passed  1/1',
        'hitAny  1/1',
        'hitAll  1/1',
        'status  0/0',
        '',
        'Misses: none',
        '',
      ].join('\n'),
    );
  });
});
