import { describe, expect, it, vi } from 'vitest';
import { projectPolicyChunks } from '../domain/chunk-projector.js';
import { PolicyChunk } from '../domain/policy-chunk.js';
import { PolicyCode } from '../domain/policy-code.js';
import { PolicyStatus } from '../domain/policy-status.js';
import { Policy } from '../domain/policy.js';
import type { PolicyClaimFacet } from '../domain/types.js';
import type { Embedder, Logger, PolicySource, VectorIndex } from '../ports.js';
import {
  DEFAULT_KOREAN_VOCABULARY,
  mergeVocabulary,
} from '../text/vocabulary.js';
import {
  HybridPolicyRetriever,
  explicitPolicyGroups,
  loadActivePolicyChunks,
} from './hybrid-retriever.js';
import type { PolicyRetrievalCandidate } from './types.js';
import { InMemoryVectorIndex } from './vector-index.js';

function claimPolicy(
  code: string,
  policyGroup: string,
  statement: string,
  options: { facet?: PolicyClaimFacet; claimId?: string } = {},
): Policy {
  return Policy.create({
    name: statement,
    decision: statement,
    status: PolicyStatus.of('Active'),
    section: '정책',
    code: PolicyCode.of(code),
    source: 'claims.csv',
    policyGroup,
    policyClaims: [
      {
        claimId: options.claimId ?? code,
        policyGroup,
        facet: options.facet ?? 'outcome',
        statement,
        confidence: 'high',
        provenanceChunkIds: [],
      },
    ],
  });
}

function sectionPolicy(code: string, knowledgeText: string): Policy {
  return Policy.create({
    name: code,
    decision: knowledgeText,
    status: PolicyStatus.of('Active'),
    section: '정책',
    code: PolicyCode.of(code),
    source: 'claims.csv',
    knowledgeText,
  });
}

const chunksOf = (...policies: Policy[]): PolicyChunk[] =>
  policies.flatMap((policy) => projectPolicyChunks(policy));

const codes = (candidates: PolicyRetrievalCandidate[]): string[] =>
  candidates.map((candidate) => candidate.chunk.policyCode);

/** 질문마다 같은 벡터를 돌려주는 임베더와, 정해 둔 순위를 돌려주는 벡터 색인 */
function fixedDense(ranking: PolicyChunk[]) {
  const embedder = {
    fingerprint: 'fixed:1',
    embed: vi.fn<Embedder['embed']>(async (texts) => texts.map(() => [1, 0])),
  } satisfies Embedder;
  const index = {
    rebuild: vi.fn<VectorIndex['rebuild']>(async () => undefined),
    search: vi.fn<VectorIndex['search']>(async () => ranking),
  } satisfies VectorIndex;
  return { embedder, index };
}

const sameDayZone = claimPolicy(
  'same-day-zone',
  'shipping',
  '당일 출고 지역은 수도권 일부 구로 한정한다',
);
const sameDayCutoff = claimPolicy(
  'same-day-cutoff',
  'shipping',
  '당일 출고 상품은 오후 두 시 전에 결제한 주문까지 묶어 보낸다',
);
const bulkyParcel = claimPolicy(
  'bulky-parcel',
  'shipping',
  '부피가 큰 가구는 화물 택배로 따로 보낸다',
);
const shippingQuestion = '당일 출고 가능 지역';

describe('loadActivePolicyChunks', () => {
  it('정책 소스에서 활성 정책만 골라 검색 조각으로 나눈다', async () => {
    const paused = Policy.create({
      name: '쿠폰 자동 발급',
      decision: '첫 주문 뒤 쿠폰을 자동으로 보낸다',
      status: PolicyStatus.of('Inactive'),
      section: '정책',
      code: PolicyCode.of('coupon-auto'),
      source: 'claims.csv',
    });
    const source: PolicySource = {
      loadPolicies: vi.fn(async () => [sameDayZone, paused]),
    };

    const chunks = await loadActivePolicyChunks(source);

    expect(chunks.map((chunk) => chunk.policyCode)).toEqual(['same-day-zone']);
  });
});

describe('HybridPolicyRetriever.retrieve', () => {
  it('dense 와 BM25 를 따로 돌려 순위로 합친다', async () => {
    const chunks = chunksOf(sameDayZone, sameDayCutoff, bulkyParcel);
    const [zone, cutoff, bulky] = chunks;
    const { embedder, index } = fixedDense([cutoff, bulky]);
    const retriever = new HybridPolicyRetriever({ chunks, embedder, index });

    const result = await retriever.retrieve(shippingQuestion);

    expect(embedder.embed).toHaveBeenCalledWith([shippingQuestion]);
    expect(index.search).toHaveBeenCalledWith([1, 0], 30, {
      contextKinds: ['policy'],
    });
    expect(result.mode).toBe('hybrid');
    expect(result.denseError).toBeUndefined();
    expect(codes(result.candidates)).toEqual(
      expect.arrayContaining([
        'same-day-zone',
        'same-day-cutoff',
        'bulky-parcel',
      ]),
    );
    expect(
      result.candidates.find((candidate) => candidate.chunk.id === cutoff.id),
    ).toMatchObject({ denseRank: 1, lexicalRank: expect.any(Number) });
    const lexicalOnly = result.candidates.find(
      (candidate) => candidate.chunk.id === zone.id,
    );
    expect(lexicalOnly?.lexicalRank).toBe(1);
    expect(lexicalOnly?.denseRank).toBeUndefined();
  });

  it('임베더가 없으면 BM25 만으로 찾고 mode 를 bm25 로 남긴다', async () => {
    const chunks = chunksOf(sameDayZone, sameDayCutoff, bulkyParcel);
    const { index } = fixedDense(chunks);
    const retriever = new HybridPolicyRetriever({ chunks, index });

    const result = await retriever.retrieve(shippingQuestion);

    expect(index.search).not.toHaveBeenCalled();
    expect(result.mode).toBe('bm25');
    expect(result.denseError).toBeUndefined();
    expect(codes(result.candidates)).toEqual([
      'same-day-zone',
      'same-day-cutoff',
    ]);
  });

  it.each([
    [
      '임베더가 실패하면',
      (dense: { embedder: Embedder; index: VectorIndex }) => {
        dense.embedder.embed = vi.fn(async () => {
          throw new Error('embedding quota exceeded');
        });
      },
      'embedding quota exceeded',
    ],
    [
      '임베더가 벡터를 돌려주지 않으면',
      (dense: { embedder: Embedder; index: VectorIndex }) => {
        dense.embedder.embed = vi.fn(async () => []);
      },
      'no vector',
    ],
    [
      '벡터 색인이 실패하면',
      (dense: { embedder: Embedder; index: VectorIndex }) => {
        dense.index.search = vi.fn(async () => {
          throw new Error('vector store offline');
        });
      },
      'vector store offline',
    ],
  ])(
    '%s BM25 만으로 찾고 실패 까닭을 돌려준다',
    async (_label, breakDense, message) => {
      const chunks = chunksOf(sameDayZone, sameDayCutoff, bulkyParcel);
      const { embedder, index } = fixedDense([chunks[2]]);
      breakDense({ embedder, index });
      const retriever = new HybridPolicyRetriever({ chunks, embedder, index });

      const result = await retriever.retrieve(shippingQuestion);

      expect(result.mode).toBe('bm25');
      expect(result.denseError).toBeInstanceOf(Error);
      expect(result.denseError?.message).toContain(message);
      expect(codes(result.candidates)).toEqual([
        'same-day-zone',
        'same-day-cutoff',
      ]);
    },
  );

  it('검색 경로와 후보 수를 debug 로그로 남기고 질문 글은 남기지 않는다', async () => {
    const chunks = chunksOf(sameDayZone, sameDayCutoff, bulkyParcel);
    const { embedder, index } = fixedDense([chunks[1]]);
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const retriever = new HybridPolicyRetriever({
      chunks,
      embedder,
      index,
      logger,
    });

    await retriever.retrieve(shippingQuestion);

    expect(logger.debug).toHaveBeenCalledWith(
      'policy retrieval completed',
      expect.objectContaining({ mode: 'hybrid', dense: 1, lexical: 2 }),
    );
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(
      '출고',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('잘못된 한도는 1 로 맞추고 같은 id 는 한 번만 센다', async () => {
    const chunks = chunksOf(sameDayZone);
    const { embedder, index } = fixedDense([chunks[0], chunks[0]]);
    const retriever = new HybridPolicyRetriever({ chunks, embedder, index });

    const result = await retriever.retrieve(shippingQuestion, {
      denseLimit: 0,
      lexicalLimit: -3,
      fusedLimit: Number.NaN,
    });

    expect(index.search).toHaveBeenCalledWith([1, 0], 1, {
      contextKinds: ['policy'],
    });
    expect(result.candidates.map((candidate) => candidate.chunk.id)).toEqual([
      chunks[0].id,
    ]);
  });

  it('합친 후보는 fusedLimit 개까지만 돌려준다', async () => {
    const chunks = chunksOf(sameDayZone, sameDayCutoff, bulkyParcel);
    const { embedder, index } = fixedDense(chunks);
    const retriever = new HybridPolicyRetriever({ chunks, embedder, index });

    const result = await retriever.retrieve(shippingQuestion, {
      denseLimit: 3,
      lexicalLimit: 3,
      fusedLimit: 2,
    });

    expect(result.candidates).toHaveLength(2);
  });

  it('dense 결과는 검색기가 가진 현재 조각으로 바꾸고 지금 없는 조각은 버린다', async () => {
    const current = claimPolicy(
      'points-balance',
      'points',
      '적립금 잔액은 마이 페이지 지갑 메뉴에서 본다',
    );
    const [currentChunk] = chunksOf(current);
    const stale = PolicyChunk.rehydrate({
      ...currentChunk.toJSON(),
      text: '예전 적립금 잔액 안내',
    });
    const removed = PolicyChunk.rehydrate({
      ...currentChunk.toJSON(),
      id: 'claims.csv#retired-row',
    });
    const { embedder, index } = fixedDense([removed, stale]);
    const retriever = new HybridPolicyRetriever({
      chunks: [currentChunk],
      embedder,
      index,
    });

    const result = await retriever.retrieve('적립금 잔액 확인');

    expect(result.candidates.map((candidate) => candidate.chunk.id)).toEqual([
      currentChunk.id,
    ]);
    expect(result.candidates[0].chunk.text).toContain('지갑 메뉴');
    expect(result.candidates[0].denseRank).toBe(1);
  });

  it('일반 정책 질문은 기술 조각을 빼고, 기술 질문은 두 종류를 함께 찾는다', async () => {
    const exchange = sectionPolicy(
      'exchange-intake',
      [
        '[기능]\n교환 접수',
        '[정책]\n- 교환은 상품을 받은 날부터 열흘 안에 접수한다.',
        '[API]\n- POST /exchanges',
      ].join('\n\n'),
    );
    const chunks = chunksOf(exchange);
    const technical = chunks.find((chunk) => chunk.contextKind === 'technical');
    const policy = chunks.find((chunk) => chunk.contextKind === 'policy');
    if (!technical || !policy) {
      throw new Error('교환 접수 행이 두 조각으로 나뉘어야 한다');
    }
    const { embedder, index } = fixedDense([technical, policy]);
    const retriever = new HybridPolicyRetriever({ chunks, embedder, index });

    const ordinary = await retriever.retrieve('교환 접수 기한');
    const technicalQuestion = await retriever.retrieve('교환 접수 API 경로');

    expect(
      ordinary.candidates.map((candidate) => candidate.chunk.contextKind),
    ).toEqual(['policy']);
    expect(index.search).toHaveBeenLastCalledWith([1, 0], 30, {
      contextKinds: ['technical', 'policy'],
    });
    expect(
      technicalQuestion.candidates.map(
        (candidate) => candidate.chunk.contextKind,
      ),
    ).toEqual(['technical', 'policy']);
  });

  it('정책 질문에 맞는 정책 조각이 없으면 기술 조각에서 찾는다', async () => {
    const stock = sectionPolicy(
      'stock-sync',
      [
        '[기능]\n재고 맞추기',
        '[정책]\n- 품절 상품은 목록 맨 뒤로 보낸다.',
        '[검증]\n- 수량이 음수면 저장하지 않는다.',
      ].join('\n\n'),
    );
    const retriever = new HybridPolicyRetriever({ chunks: chunksOf(stock) });

    const result = await retriever.retrieve('수량 음수 저장');

    expect(
      result.candidates.map((candidate) => candidate.chunk.contextKind),
    ).toEqual(['technical']);
  });

  describe('같은 묶음 형제 확장', () => {
    const reviewReward = claimPolicy(
      'points-photo-review',
      'points',
      '사진 리뷰를 남기면 적립금 300 원을 준다',
      { facet: 'amount' },
    );
    const yearlyExpiry = claimPolicy(
      'points-yearly-expiry',
      'points',
      '쌓인 금액은 일 년 뒤 소멸한다',
      { facet: 'expiration' },
    );
    const lookalike = claimPolicy(
      'coupon-review-banner',
      'coupon',
      '리뷰 화면 상단에 쿠폰 배너를 띄운다',
    );
    const limits = { denseLimit: 1, lexicalLimit: 1, fusedLimit: 5 };

    it('목록 질문은 고른 후보와 같은 묶음의 형제만 더 붙인다', async () => {
      const chunks = chunksOf(reviewReward, yearlyExpiry, lookalike);
      const { embedder, index } = fixedDense([chunks[0]]);
      const retriever = new HybridPolicyRetriever({ chunks, embedder, index });

      const result = await retriever.retrieve(
        '적립금 받는 방법 뭐가 있어?',
        limits,
      );

      expect(codes(result.candidates)).toEqual(
        expect.arrayContaining(['points-photo-review', 'points-yearly-expiry']),
      );
      expect(codes(result.candidates)).not.toContain('coupon-review-banner');
    });

    it('한 가지 사실을 묻는 질문은 형제를 붙이지 않는다', async () => {
      const chunks = chunksOf(reviewReward, yearlyExpiry, lookalike);
      const { embedder, index } = fixedDense([chunks[0]]);
      const retriever = new HybridPolicyRetriever({ chunks, embedder, index });

      const result = await retriever.retrieve(
        '사진 리뷰 적립금은 얼마야?',
        limits,
      );

      expect(codes(result.candidates)).toEqual(['points-photo-review']);
    });

    it('형제 중 묶음 요약 claim 을 질문이 원하는 종류의 형제보다 먼저 붙인다', async () => {
      const confirmedOnly = claimPolicy(
        'points-confirmed-only',
        'points',
        '구매 확정이 끝난 주문만 대상이 된다',
        { facet: 'eligibility' },
      );
      const summary = claimPolicy(
        'points-overview',
        'points',
        '결제할 때 현금처럼 빼 쓰는 마켓 안 화폐',
        { claimId: 'group-summary-points' },
      );
      const chunks = chunksOf(reviewReward, confirmedOnly, summary);
      const { embedder, index } = fixedDense([chunks[0]]);
      const retriever = new HybridPolicyRetriever({ chunks, embedder, index });

      const result = await retriever.retrieve('적립금 받는 방법 뭐가 있어?', {
        denseLimit: 1,
        lexicalLimit: 1,
        fusedLimit: 1,
      });

      expect(codes(result.candidates)).toEqual(['points-overview']);
    });
  });

  it('개요 질문은 dense 가 세부 행만 찾아도 묶음 요약 claim 을 앞에 둔다', async () => {
    const summary = claimPolicy(
      'membership-overview',
      'membership',
      '멤버십 등급은 누적 구매 금액에 따라 새싹·나무·숲 세 단계로 나뉜다',
      { claimId: 'group-summary-membership' },
    );
    const badge = claimPolicy(
      'membership-badge',
      'membership',
      '멤버십 등급 아이콘은 프로필 이름 옆에 작게 그린다',
      { facet: 'procedure' },
    );
    const chunks = chunksOf(summary, badge);
    const { embedder, index } = fixedDense([chunks[1]]);
    const retriever = new HybridPolicyRetriever({ chunks, embedder, index });

    const result = await retriever.retrieve('멤버십 등급이란?', {
      denseLimit: 1,
      lexicalLimit: 1,
      fusedLimit: 2,
    });

    expect(result.candidates[0].chunk.policyCode).toBe('membership-overview');
  });

  it('시점 질문은 질문의 행위와 구체적인 날짜를 함께 담은 claim 을 앞에 둔다', async () => {
    const vague = claimPolicy(
      'refund-inquiry',
      'refund',
      '환불 금액 문의는 언제든 고객 센터 채팅으로 받는다',
      { facet: 'schedule' },
    );
    const concrete = claimPolicy(
      'refund-next-day',
      'refund',
      '환불 금액은 반품 상품이 물류 창고에 닿은 다음 날 결제 수단으로 돌려준다',
      { facet: 'schedule' },
    );
    const retriever = new HybridPolicyRetriever({
      chunks: chunksOf(vague, concrete),
    });

    const result = await retriever.retrieve('환불 금액은 언제 들어와요?');

    expect(result.candidates[0].chunk.policyCode).toBe('refund-next-day');
  });
});

describe('묶음 범위와 BM25 상위 보호', () => {
  const reviewLength = claimPolicy(
    'review-length',
    'review',
    '리뷰 본문은 최대 몇 자인지 입력창 아래 글자 수로 알려 준다',
  );
  const engraving = claimPolicy(
    'keyring-engraving',
    'product',
    '키링 각인은 영문 기준 열 자까지 새긴다',
  );
  const restock = claimPolicy(
    'keyring-restock',
    'stock',
    '키링 재고는 매주 월요일에 채운다',
  );
  const question = '키링 각인 글자는 최대 몇 자?';

  it('질문 말투 낱말을 더 담은 묶음이 이겨도 남은 후보에 없는 질문 낱말을 담은 BM25 상위 후보는 남긴다', async () => {
    const { embedder, index } = fixedDense([]);
    const retriever = new HybridPolicyRetriever({
      chunks: chunksOf(reviewLength, engraving, restock),
      embedder,
      index,
    });

    const fused = await retriever.retrieve(question);
    const lexical = retriever.retrieveLexical(question, 30);

    expect(codes(fused.candidates)).toEqual(
      expect.arrayContaining(['review-length', 'keyring-engraving']),
    );
    // 재고 행이 담은 "키링" 은 각인 행이 이미 덮었으므로 묶음 밖 후보로 남기지 않는다
    expect(codes(fused.candidates)).not.toContain('keyring-restock');
    expect(codes(lexical)).toContain('keyring-engraving');
  });

  it('질문이 묶음 별칭을 부르면 그 묶음 밖 후보는 BM25 1 위여도 버린다', async () => {
    const vocabulary = mergeVocabulary(DEFAULT_KOREAN_VOCABULARY, {
      groupAliases: { product: ['키링'] },
    });
    const retriever = new HybridPolicyRetriever({
      chunks: chunksOf(reviewLength, engraving, restock),
      vocabulary,
    });

    const result = await retriever.retrieve(question);

    expect(codes(result.candidates)).toEqual(['keyring-engraving']);
  });

  it('비교 질문은 직접 부른 묶음을 모두 남기고 부르지 않은 묶음은 뺀다', async () => {
    const vocabulary = mergeVocabulary(DEFAULT_KOREAN_VOCABULARY, {
      groupAliases: { points: ['적립금'], coupon: ['쿠폰'] },
    });
    const retriever = new HybridPolicyRetriever({
      chunks: chunksOf(
        claimPolicy(
          'points-as-cash',
          'points',
          '적립금은 결제할 때 현금처럼 빼서 쓴다',
        ),
        claimPolicy(
          'coupon-discount',
          'coupon',
          '쿠폰은 정해진 금액이나 비율만큼 상품 값을 깎는다',
        ),
        claimPolicy(
          'shipping-coupon',
          'shipping',
          '배송비 쿠폰은 묶음 배송 한 건에 한 장만 쓴다',
        ),
      ),
      vocabulary,
    });

    const result = await retriever.retrieve('적립금이랑 쿠폰 차이 알려줘', {
      denseLimit: 10,
      lexicalLimit: 10,
      fusedLimit: 5,
    });

    expect(
      result.candidates.map((candidate) => candidate.chunk.policyGroup),
    ).toEqual(expect.arrayContaining(['points', 'coupon']));
    expect(
      result.candidates.map((candidate) => candidate.chunk.policyGroup),
    ).not.toContain('shipping');
  });
});

describe('explicitPolicyGroups', () => {
  const vocabulary = mergeVocabulary(DEFAULT_KOREAN_VOCABULARY, {
    groupAliases: { membership: ['멤버십 등급', 'VIP'] },
  });

  it('띄어쓰기와 대소문자를 가리지 않고 묶음 이름과 별칭을 찾는다', () => {
    expect(explicitPolicyGroups('멤버십등급 올리는 법', vocabulary)).toEqual(
      new Set(['membership']),
    );
    expect(explicitPolicyGroups('vip 라운지 이용', vocabulary)).toEqual(
      new Set(['membership']),
    );
    expect(explicitPolicyGroups('Membership 안내', vocabulary)).toEqual(
      new Set(['membership']),
    );
    expect(explicitPolicyGroups('배송 조회', vocabulary)).toEqual(new Set());
  });

  it('기본 사전에는 묶음 별칭이 없어 아무 묶음도 고르지 않는다', () => {
    expect(explicitPolicyGroups('멤버십 등급 안내')).toEqual(new Set());
  });
});

describe('BM25 전용 검색', () => {
  const returnPickup = sectionPolicy(
    'return-pickup',
    [
      '[정책 안내]\n반품 정책: 반품을 접수하면 택배 기사가 상품을 가지러 온다.',
      '[처리 순서]\n1. 반품 사유를 고른다.\n2. 수거 날짜를 정한다.',
    ].join('\n\n'),
  );
  const returnCondition = claimPolicy(
    'return-sealed',
    'refund',
    '반품 상품은 포장을 뜯지 않았을 때만 받는다',
  );
  const pointsClawback = sectionPolicy(
    'points-clawback',
    '[정책 안내]\n정산 정책: 매일 새벽 취소 표시가 남은 주문의 적립금을 거둬들인다.',
  );
  const shortSummary = sectionPolicy(
    'short-summary',
    '[정책 안내]\n주문 정책: 취소 표시.',
  );

  it('retrieveLexical 은 dense 검색 없이 BM25 순위를 돌려준다', () => {
    const { embedder, index } = fixedDense([]);
    const retriever = new HybridPolicyRetriever({
      chunks: chunksOf(returnCondition, returnPickup),
      embedder,
      index,
    });

    const result = retriever.retrieveLexical('반품 포장 뜯으면', 5);

    expect(embedder.embed).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ lexicalRank: 1, fusedScore: 0 });
    expect(result[0].chunk.policyCode).toBe('return-sealed');
  });

  it('retrieveProcedureLexical 은 처리 순서 섹션이 있는 행만 놓고 찾는다', () => {
    const retriever = new HybridPolicyRetriever({
      chunks: chunksOf(returnCondition, returnPickup),
    });

    const result = retriever.retrieveProcedureLexical('반품 수거 순서');

    expect(codes(result)).toEqual(['return-pickup']);
    expect(result[0].lexicalRank).toBe(1);
  });

  it('retrieveDeferredProcedureLinks 는 섹션 줄에 정책 안내 앞부분이 들어 있는 행을 찾는다', () => {
    const retriever = new HybridPolicyRetriever({
      chunks: chunksOf(returnPickup, pointsClawback, shortSummary),
    });

    const result = retriever.retrieveDeferredProcedureLinks([
      '- 매일 새벽 취소 표시가 남은 주문의 적립금을 거둬들인다 (예약 작업)',
    ]);

    // 정책 안내가 너무 짧은 행은 아무 줄에나 들어 있으므로 잇지 않는다
    expect(codes(result)).toEqual(['points-clawback']);
    expect(retriever.retrieveDeferredProcedureLinks(['  ', ''])).toEqual([]);
  });
});

describe('메모리 벡터 색인과 함께 쓰기', () => {
  /** 같은 뜻의 낱말을 같은 차원으로 세는 흉내 임베더 */
  const conceptEmbedder: Embedder = {
    fingerprint: 'concept:2',
    embed: async (texts) =>
      texts.map((text) => [
        /적립금|포인트/.test(text) ? 1 : 0,
        /소멸|사라지/.test(text) ? 1 : 0,
      ]),
  };

  it('낱말이 겹치지 않는 바꿔 말한 질문도 dense 로 찾는다', async () => {
    const chunks = chunksOf(
      claimPolicy(
        'points-expiry',
        'points',
        '적립금은 쌓인 날부터 일 년이 지나면 소멸한다',
        { facet: 'expiration' },
      ),
      claimPolicy(
        'parcel-tracking',
        'shipping',
        '배송 조회는 주문 내역에서 한다',
      ),
    );
    const index = new InMemoryVectorIndex();
    await index.rebuild(
      chunks,
      await conceptEmbedder.embed(chunks.map((chunk) => chunk.searchText)),
    );
    const retriever = new HybridPolicyRetriever({
      chunks,
      embedder: conceptEmbedder,
      index,
    });

    const result = await retriever.retrieve('포인트 사라지는 시점이 궁금해');

    expect(result.mode).toBe('hybrid');
    expect(codes(result.candidates)).toEqual(['points-expiry']);
    expect(result.candidates[0].denseRank).toBe(1);
    expect(result.candidates[0].lexicalRank).toBeUndefined();
  });
});
