import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  CsvFormatError,
  csvPolicySource,
  policiesFromClaimCsv,
} from './adapters/csv-policy-source.js';
import { createCodecite } from './codecite.js';
import type { Codecite, CodeciteOptions } from './types.js';
import { INSUFFICIENT_EVIDENCE_ANSWER } from './constants.js';
import type {
  Embedder,
  LlmClient,
  LlmCompletionRequest,
  LogFields,
  Logger,
  PolicySource,
} from './ports.js';

const HEADER =
  'policy_group,feature_name,claim_statement,claim_facet,claim_conditions,claim_exceptions,claim_value,user_question_examples,search_aliases,source';

/** 도토리 마켓 claim 네 줄. 적립금과 묶음 포장 행만 공개 출처를 적었다 */
const DOTORI_ROWS = [
  'points,적립금 소멸 기한,적립금은 쌓인 날부터 2 년이 지나면 자동으로 사라진다.,expiration,,,쌓인 날부터 2 년,모아 둔 적립금도 없어지나요?,적립금 소멸;포인트 유효 기간,적립금 이용 안내 4 조',
  'refund,반품 접수 기한,반품은 상품을 받은 날부터 9 일 안에 접수해야 한다.,duration,포장을 뜯지 않은 상품만 접수한다,이름을 새긴 상품은 반품을 받지 않는다,받은 날부터 9 일,반품은 며칠까지 받아 줘요?,반품 기한;반품 접수,',
  'coupon,장바구니 쿠폰 사용 조건,"장바구니 쿠폰은 결제 금액이 25,000 원 이상일 때 쓸 수 있다.",eligibility,,,"결제 금액 25,000 원 이상",장바구니 쿠폰은 얼마부터 써져요?,장바구니 쿠폰;쿠폰 사용 조건,',
  'shipping,묶음 포장,같은 날 결제한 상품은 한 상자에 담아 보낸다.,outcome,,,,따로 산 상품도 같이 와요?,묶음 포장;합포장,창고 출고 기준표',
];
const DOTORI_CSV = [HEADER, ...DOTORI_ROWS].join('\n');

const POINTS_QUESTION = '쌓아 둔 적립금도 사라지나요?';
const REFUND_QUESTION = '반품은 며칠 안에 접수해야 해요?';
/** 반품 행은 있지만 반품 배송비를 말하는 claim 은 없다 */
const UNANSWERABLE_QUESTION = '반품 배송비는 얼마예요?';

const inlineSource = (csv = DOTORI_CSV): PolicySource => ({
  loadPolicies: async () => policiesFromClaimCsv(csv, { file: 'dotori.csv' }),
});

/** 질문 계획 요청(json)과 답변 요청을 나눠 받는 가짜 답변 모델 */
const fakeLlm = (handlers: {
  plan?: (request: LlmCompletionRequest) => Promise<string>;
  answer: (request: LlmCompletionRequest) => Promise<string>;
}) => {
  const requests: LlmCompletionRequest[] = [];
  const llm: LlmClient = {
    complete: vi.fn(async (request: LlmCompletionRequest) => {
      requests.push(request);
      if (request.json) {
        return handlers.plan
          ? handlers.plan(request)
          : '{"searchTerms": [], "facets": []}';
      }
      return handlers.answer(request);
    }),
  };
  return {
    llm,
    planRequests: () => requests.filter((request) => request.json),
    answerRequests: () => requests.filter((request) => !request.json),
  };
};

/** 글자를 16 칸에 나눠 센 벡터. 같은 글자를 많이 나눠 가진 글끼리 가깝다 */
const bucketVector = (text: string): number[] => {
  const vector = new Array<number>(16).fill(0);
  vector[0] = 1;
  for (const character of text) {
    vector[(character.codePointAt(0) ?? 0) % 16] += 1;
  }
  return vector;
};

const fakeEmbedder = (
  embed: Embedder['embed'] = async (texts) => texts.map(bucketVector),
): Embedder => ({
  fingerprint: 'fake:buckets',
  embed: vi.fn<Embedder['embed']>(embed),
});

/** 로그를 모두 모으는 로거. 질문 본문이 새지 않았는지 볼 때 쓴다 */
const recordingLogger = () => {
  const entries: Array<{ level: string; message: string; fields?: LogFields }> =
    [];
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields });
    };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
  return { logger, entries };
};

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'codecite-hub-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('createCodecite', () => {
  it('근거가 있으면 답변 모델의 답과 묶인 근거의 claim 인용을 돌려준다', async () => {
    const model = fakeLlm({
      answer: async () => '적립금은 쌓인 날부터 2 년이 지나면 사라집니다.',
    });
    const codecite = await createCodecite({
      source: inlineSource(),
      llm: model.llm,
    });

    const result = await codecite.ask(POINTS_QUESTION);

    expect(result.status).toBe('answered');
    expect(result.answer).toBe(
      '적립금은 쌓인 날부터 2 년이 지나면 사라집니다.',
    );
    expect(result.trace).toEqual({
      retrieval: 'bm25',
      generation: 'llm',
      candidates: 1,
      packed: 1,
    });
    expect(result.citations).toEqual([
      {
        claimId: expect.stringMatching(/^claim-/),
        policyGroup: 'points',
        statement: '적립금은 쌓인 날부터 2 년이 지나면 자동으로 사라진다.',
        source: '적립금 이용 안내 4 조',
      },
    ]);
    // 답변 모델은 묶인 근거만 받는다
    expect(model.answerRequests()).toHaveLength(1);
    expect(model.answerRequests()[0].user).toContain(
      '적립금은 쌓인 날부터 2 년이 지나면 자동으로 사라진다.',
    );
    expect(model.answerRequests()[0].user).not.toContain('장바구니 쿠폰');
  });

  it('공개 출처가 없는 claim 은 source 없이 인용한다', async () => {
    const codecite = await createCodecite({ source: inlineSource() });

    const result = await codecite.ask(REFUND_QUESTION);

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).not.toHaveProperty('source');
    expect(result.citations[0].policyGroup).toBe('refund');
  });

  it('답변 모델이 없으면 묶인 근거의 claim 문장으로 결정적인 답을 만든다', async () => {
    const codecite = await createCodecite({ source: inlineSource() });

    const result = await codecite.ask(REFUND_QUESTION);

    expect(result.status).toBe('answered');
    expect(result.answer).toContain('9 일 안에 접수');
    expect(result.trace.generation).toBe('deterministic');
    expect(result.trace.retrieval).toBe('bm25');
  });

  it('기본 답은 목록 기호 없이 문단으로, 목록을 원한 답은 목록 기호로 쓴다', async () => {
    const model = fakeLlm({
      answer: async () =>
        '- 반품은 상품을 받은 날부터 9 일 안에 접수합니다.\n- 9 일이 지나면 반품을 접수할 수 없습니다.',
    });
    const codecite = await createCodecite({
      source: inlineSource(),
      llm: model.llm,
    });

    const prose = await codecite.ask(REFUND_QUESTION);
    const listed = await codecite.ask('반품 접수 기한을 목록으로 정리해 줘');

    expect(prose.answer).not.toMatch(/^[-*•]\s/mu);
    expect(listed.answer).toMatch(/^[-*•]\s/mu);
  });

  it('근거가 모자라면 답변 모델을 부르지 않고 근거 부족 안내로 끝낸다', async () => {
    const model = fakeLlm({ answer: async () => '반품 배송비는 무료입니다.' });
    const codecite = await createCodecite({
      source: inlineSource(),
      llm: model.llm,
    });

    const result = await codecite.ask(UNANSWERABLE_QUESTION);

    expect(result).toEqual({
      status: 'insufficient_evidence',
      answer: INSUFFICIENT_EVIDENCE_ANSWER,
      citations: [],
      trace: {
        retrieval: 'bm25',
        generation: 'deterministic',
        candidates: expect.any(Number),
        packed: 0,
      },
    });
    // 검색은 반품 행을 찾았지만 충분성 판정에서 멈췄다
    expect(result.trace.candidates).toBeGreaterThan(0);
    expect(model.answerRequests()).toHaveLength(0);
  });

  it('답변 모델이 throw 하면 결정적 답변으로 물러난다', async () => {
    const model = fakeLlm({
      answer: async () => {
        throw new Error('model unavailable');
      },
    });
    const { logger, entries } = recordingLogger();
    const codecite = await createCodecite({
      source: inlineSource(),
      llm: model.llm,
      logger,
    });

    const result = await codecite.ask(REFUND_QUESTION);

    expect(result.status).toBe('answered');
    expect(result.trace.generation).toBe('deterministic');
    expect(result.answer).toContain('9 일 안에 접수');
    expect(model.answerRequests()).toHaveLength(1);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'answer model failed; using deterministic answer',
      }),
    );
  });

  it('답변 모델이 시간 한도를 넘기면 기다리지 않고 결정적 답변으로 물러난다', async () => {
    const model = fakeLlm({ answer: () => new Promise<string>(() => {}) });
    const codecite = await createCodecite({
      source: inlineSource(),
      llm: model.llm,
      limits: { answerTimeoutMs: 20 },
    });

    const result = await codecite.ask(REFUND_QUESTION);

    expect(result.trace.generation).toBe('deterministic');
    expect(result.answer).toContain('9 일 안에 접수');
    expect(model.answerRequests()[0].signal?.aborted).toBe(true);
  });

  it('모델이 근거에 없는 조건을 지어내면 결정적 답변으로 바꾼다', async () => {
    const model = fakeLlm({
      answer: async () =>
        '반품은 상품을 받은 날부터 9 일 안에 접수할 수 있고, 공휴일은 기한에서 빠집니다.',
    });
    const { logger, entries } = recordingLogger();
    const codecite = await createCodecite({
      source: inlineSource(),
      llm: model.llm,
      logger,
    });

    const result = await codecite.ask(REFUND_QUESTION);

    expect(result.status).toBe('answered');
    expect(result.trace.generation).toBe('deterministic');
    expect(result.answer).not.toContain('공휴일');
    expect(result.answer).toContain('9 일 안에 접수');
    expect(entries).toContainEqual(
      expect.objectContaining({
        message: 'generated answer failed the answer guard',
        fields: { reason: 'invented_condition' },
      }),
    );
  });

  it('모델 답에서 빠진 숫자 조건은 답변 계약이 근거로 되살린다', async () => {
    const model = fakeLlm({
      answer: async () => '적립금은 일정 기간이 지나면 사라집니다.',
    });
    const codecite = await createCodecite({
      source: inlineSource(),
      llm: model.llm,
    });

    const result = await codecite.ask(POINTS_QUESTION);

    expect(result.trace.generation).toBe('llm');
    expect(result.answer).toContain('2 년');
  });

  it('질문 계획이 실패해도 질문 원문으로 검색해 답한다', async () => {
    const model = fakeLlm({
      plan: async () => {
        throw new Error('plan model unavailable');
      },
      answer: async () => '반품은 상품을 받은 날부터 9 일 안에 접수합니다.',
    });
    const codecite = await createCodecite({
      source: inlineSource(),
      llm: model.llm,
    });

    const result = await codecite.ask(REFUND_QUESTION);

    expect(model.planRequests()).toHaveLength(1);
    expect(result.status).toBe('answered');
    expect(result.trace.generation).toBe('llm');
    expect(result.citations.map((citation) => citation.policyGroup)).toEqual([
      'refund',
    ]);
  });

  it('질문 계획의 검색어는 검색에 더하되 다른 묶음 근거가 답을 덮지 못한다', async () => {
    const model = fakeLlm({
      plan: async () =>
        '{"searchTerms": ["장바구니 쿠폰", "묶음 포장"], "facets": ["duration"]}',
      answer: async () => '반품은 상품을 받은 날부터 9 일 안에 접수합니다.',
    });
    const codecite = await createCodecite({
      source: inlineSource(),
      llm: model.llm,
    });

    const result = await codecite.ask(REFUND_QUESTION);

    expect(result.status).toBe('answered');
    expect(result.citations[0].policyGroup).toBe('refund');
    expect(model.answerRequests()[0].user).toContain(
      '반품은 상품을 받은 날부터 9 일 안에 접수해야 한다.',
    );
  });

  it('임베더가 있으면 dense 와 BM25 를 함께 돌리고 같은 내용은 다시 임베딩하지 않는다', async () => {
    const embedder = fakeEmbedder();
    const indexCachePath = join(folder, 'index.json');
    const codecite = await createCodecite({
      source: inlineSource(),
      embedder,
      indexCachePath,
    });

    expect(codecite.indexSummary).toEqual({
      chunks: 4,
      retrieval: 'hybrid',
      reusedVectors: false,
    });
    const result = await codecite.ask(POINTS_QUESTION);
    expect(result.trace.retrieval).toBe('hybrid');
    expect(result.citations[0].policyGroup).toBe('points');

    expect(await codecite.reindex()).toEqual({
      chunks: 4,
      retrieval: 'hybrid',
      reusedVectors: true,
    });
  });

  it('색인 때 임베딩이 실패하면 경고를 남기고 BM25 만으로 답한다', async () => {
    const embedder = fakeEmbedder(async () => {
      throw new Error('embedding service down');
    });
    const { logger, entries } = recordingLogger();
    const codecite = await createCodecite({
      source: inlineSource(),
      embedder,
      indexCachePath: join(folder, 'index.json'),
      logger,
    });

    expect(codecite.indexSummary.retrieval).toBe('bm25');
    const result = await codecite.ask(POINTS_QUESTION);
    expect(result.status).toBe('answered');
    expect(result.trace.retrieval).toBe('bm25');
    // 색인이 비었으므로 질문마다 임베딩을 다시 부르지 않는다
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'embedding failed; searching with BM25 only',
      }),
    );
  });

  it('질문 임베딩이 실패하면 그 질문은 BM25 만으로 답하고 경고를 남긴다', async () => {
    const embedder = fakeEmbedder(async (texts) => {
      if (texts.length === 1) {
        throw new Error('embedding timeout');
      }
      return texts.map(bucketVector);
    });
    const { logger, entries } = recordingLogger();
    const codecite = await createCodecite({
      source: inlineSource(),
      embedder,
      indexCachePath: join(folder, 'index.json'),
      logger,
    });

    expect(codecite.indexSummary.retrieval).toBe('hybrid');
    const result = await codecite.ask(POINTS_QUESTION);
    expect(result.status).toBe('answered');
    expect(result.trace.retrieval).toBe('bm25');
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'dense retrieval failed; searching with BM25 only',
        fields: { error: 'embedding timeout' },
      }),
    );
  });

  it('CSV 형식 오류는 만들 때 행 번호와 함께 throw 한다', async () => {
    const path = join(folder, 'claims.csv');
    await writeFile(
      path,
      [
        HEADER,
        DOTORI_ROWS[0],
        'coupon,쿠폰 묶음 사용,상품 쿠폰과 장바구니 쿠폰은 함께 쓸 수 있다.,stacking,,,,,,',
      ].join('\n'),
      'utf8',
    );

    const created = createCodecite({ source: csvPolicySource({ path }) });

    await expect(created).rejects.toBeInstanceOf(CsvFormatError);
    await expect(created).rejects.toMatchObject({ row: 3 });
    await expect(created).rejects.toThrow(/row 3/);
  });

  it('다시 색인할 때 CSV 가 틀렸으면 행 번호와 함께 throw 하고 앞 색인으로 계속 답한다', async () => {
    const path = join(folder, 'claims.csv');
    await writeFile(path, DOTORI_CSV, 'utf8');
    const codecite = await createCodecite({
      source: csvPolicySource({ path }),
    });
    await writeFile(
      path,
      [HEADER, DOTORI_ROWS[1], ',빈 묶음,묶음 이름이 빠진 행이다.,,,,,,,'].join(
        '\n',
      ),
      'utf8',
    );

    await expect(codecite.reindex()).rejects.toThrow(/row 3/);
    expect(codecite.indexSummary.chunks).toBe(4);
    expect((await codecite.ask(POINTS_QUESTION)).status).toBe('answered');
  });

  it('로그에는 질문 본문을 남기지 않는다', async () => {
    const { logger, entries } = recordingLogger();
    const planFails = fakeLlm({
      plan: async () => {
        throw new Error('plan model unavailable');
      },
      answer: async () =>
        '반품은 상품을 받은 날부터 9 일 안에 접수할 수 있고, 공휴일은 기한에서 빠집니다.',
    });
    const answerFails = fakeLlm({
      answer: async () => {
        throw new Error('model unavailable');
      },
    });
    const queryEmbeddingFails = fakeEmbedder(async (texts) => {
      if (texts.length === 1) {
        throw new Error('embedding timeout');
      }
      return texts.map(bucketVector);
    });
    const withPlanFailure = await createCodecite({
      source: inlineSource(),
      llm: planFails.llm,
      embedder: queryEmbeddingFails,
      indexCachePath: join(folder, 'index.json'),
      logger,
      limits: { answerTimeoutMs: 1_000 },
    });
    const withAnswerFailure = await createCodecite({
      source: inlineSource(),
      llm: answerFails.llm,
      logger,
    });
    const questions = [POINTS_QUESTION, REFUND_QUESTION, UNANSWERABLE_QUESTION];

    for (const question of questions) {
      await withPlanFailure.ask(question);
      await withAnswerFailure.ask(question);
    }

    const logged = JSON.stringify(entries);
    expect(entries.filter((entry) => entry.level === 'warn')).not.toEqual([]);
    expect(
      entries.filter((entry) => entry.message === 'question answered'),
    ).toHaveLength(questions.length * 2);
    for (const question of questions) {
      expect(logged).not.toContain(question);
      expect(logged).not.toContain(question.slice(0, 8));
    }
  });

  it('빈 질문은 받지 않는다', async () => {
    const codecite = await createCodecite({ source: inlineSource() });

    await expect(codecite.ask('   ')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('도토리 마켓 예제', () => {
  const exampleFolder = fileURLToPath(
    new URL('../examples/dotori-market/', import.meta.url),
  );
  const golden = JSON.parse(
    readFileSync(join(exampleFolder, 'golden-questions.json'), 'utf8'),
  ) as Array<{
    id: string;
    question: string;
    expectedClaimIds: string[];
    expectStatus?: string;
  }>;
  const goldenQuestion = (id: string) => {
    const found = golden.find((item) => item.id === id);
    if (!found) {
      throw new Error(`golden question ${id} is missing`);
    }
    return found;
  };
  // 예제 설정의 사전만 쓰고 답변 모델과 임베더는 붙이지 않는다(API 키 없는 모드)
  const { vocabulary } = JSON.parse(
    readFileSync(join(exampleFolder, 'codecite.config.json'), 'utf8'),
  ) as { vocabulary: CodeciteOptions['vocabulary'] };
  let codecite: Codecite;

  beforeAll(async () => {
    codecite = await createCodecite({
      source: csvPolicySource({ path: join(exampleFolder, 'policies.csv') }),
      vocabulary,
    });
  });

  it.each([
    'points-01',
    'points-05',
    'refund-03',
    'coupon-02',
    'shipping-01',
    'membership-01',
    'membership-04',
  ])(
    'API 키 없이 BM25 와 결정적 답변으로 %s 의 기대 claim 을 인용한다',
    async (id) => {
      const { question, expectedClaimIds } = goldenQuestion(id);

      const result = await codecite.ask(question);

      expect(result.status).toBe('answered');
      expect(result.trace).toMatchObject({
        retrieval: 'bm25',
        generation: 'deterministic',
      });
      expect(result.citations.map((citation) => citation.claimId)).toEqual(
        expect.arrayContaining(expectedClaimIds),
      );
    },
  );

  it.each(['insufficient-02', 'insufficient-04'])(
    '데이터에 답이 없는 %s 는 근거 부족으로 끝낸다',
    async (id) => {
      const result = await codecite.ask(goldenQuestion(id).question);

      expect(result.status).toBe('insufficient_evidence');
      expect(result.citations).toEqual([]);
    },
  );
});
