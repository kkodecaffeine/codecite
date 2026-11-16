import { describe, expect, expectTypeOf, it } from 'vitest';
import { PolicyChunk } from '../domain/policy-chunk.js';
import type { PolicyEvidence } from '../generation/types.js';
import * as publicApi from '../index.js';
import type { PolicyRetrievalCandidate } from '../retrieval/types.js';
import type {
  CodeChangeEventRecord,
  CodeGraphEvidenceLookup,
  CodeKnowledgeRecord,
  CodeLocation,
  CodeSymbolLookup,
  CodeTopologySource,
  CrossRepositoryGraph,
  CurrentSymbolRecord,
  EntityRelationGraph,
  EntityRelationGraphSource,
  FieldWriterIndex,
  FieldWriterIndexSource,
  SystemTopologyGraph,
  TemporalCodeIndex,
} from './code-knowledge.js';
import type { Reranker } from './reranker.js';
import {
  DEFAULT_RESEARCH_BUDGET,
  DEFAULT_RESEARCH_PACKING,
  RESEARCH_FINISH_TOOL_NAME,
  RESEARCH_TOOL_NAMES,
} from './research.js';
import type {
  FinishResearchArgs,
  ResearchAgent,
  ResearchBrief,
  ResearchItem,
  ResearchMessage,
  ResearchOutcome,
  ResearchToolArgumentMap,
  ResearchToolbox,
  ResearchToolCall,
  ResearchToolName,
  ResearchTurnInput,
} from './research.js';

// ── 도토리 마켓 코드 지식 산출물 ──

const expiryJobLocation: CodeLocation = {
  repository: 'dotori-api',
  filePath: 'src/points/point-expiry.job.ts',
  symbol: 'PointExpiryJob.sweep',
  lineStart: 18,
  lineEnd: 42,
};

const expirySymbol: CurrentSymbolRecord = {
  schemaVersion: 1,
  recordType: 'current_symbol',
  repository: expiryJobLocation.repository,
  filePath: expiryJobLocation.filePath,
  language: 'typescript',
  symbol: expiryJobLocation.symbol,
  stableSymbolId: 'sym7f3a91c0-point-expiry',
  kind: 'method',
  commitSha: '4e1d2c9',
  committedAt: '2026-09-14T02:00:00Z',
  contentHash: 'c91ab',
  content: 'if (entry.earnedAt < cutoff) { entry.balance = 0; }',
  lineStart: 18,
  lineEnd: 42,
  relations: [
    {
      type: 'CALLS',
      target: { repository: 'dotori-api', symbol: 'PointLedger.close' },
    },
  ],
  triggeredBy: ['PointExpiryScheduler'],
  policyGroup: 'points',
  executionFacts: [
    { line: 21, kind: 'condition', subject: 'entry.earnedAt < cutoff' },
    {
      line: 22,
      kind: 'assigns',
      subject: 'entry.balance',
      value: '0',
      conditions: ['entry.earnedAt < cutoff'],
    },
  ],
};

const refundWindowChange: CodeChangeEventRecord = {
  schemaVersion: 1,
  recordType: 'change_event',
  repository: 'dotori-api',
  filePath: 'src/refund/refund-window.ts',
  language: 'typescript',
  symbol: 'RefundWindow.days',
  stableSymbolId: 'sym22c0de11-refund-window',
  kind: 'constant',
  commitSha: '9b0a771',
  committedAt: '2026-06-30T08:15:00Z',
  contentHash: 'c55e0',
  previousContentHash: 'c41d7',
  relations: [],
  changeKind: 'modify',
  metadata: {
    commitMessage: 'feat: 도토리 반품 접수 창을 넓힘',
    issueIds: ['DOT-208'],
    reviewRequestIds: ['77'],
  },
};

const systemTopology: SystemTopologyGraph = {
  schemaVersion: 1,
  generatedAt: '2026-11-01T00:00:00Z',
  repositories: ['dotori-api'],
  exclusions: ['**/.env*', '**/*.csv*'],
  nodes: [
    {
      id: 'n-scheduler',
      type: 'Scheduler',
      name: 'PointExpiryScheduler',
      repository: 'dotori-api',
      filePath: 'src/points/point-expiry.scheduler.ts',
      symbol: 'PointExpiryScheduler',
      lineStart: 5,
      lineEnd: 14,
    },
    { id: 'n-job', type: 'Function', name: 'sweep', ...expiryJobLocation },
  ],
  edges: [
    {
      from: 'n-scheduler',
      to: 'n-job',
      type: 'SCHEDULES',
      confidence: 0.9,
      evidence: ['scheduler registration'],
      ...expiryJobLocation,
    },
  ],
  localGraphs: [
    {
      repository: 'dotori-api',
      nodeIds: ['n-scheduler', 'n-job'],
      edgeIndexes: [0],
    },
  ],
};

const crossRepositoryGraph: CrossRepositoryGraph = {
  nodes: [
    {
      id: 'route:POST /coupons/apply',
      repositories: ['dotori-web', 'dotori-api'],
      symbols: ['applyCoupon', 'CouponController.apply'],
      recordTypes: ['current_symbol'],
    },
  ],
  edges: [
    {
      id: 'e-coupon-apply',
      relation: 'HTTP_CALLS',
      source: 'dotori-web:applyCoupon',
      target: 'dotori-api:CouponController.apply',
      extraction: {
        kind: 'route',
        locator: 'src/api/coupon-client.ts',
        value: 'POST /coupons/apply',
      },
      confidence: 'high',
      handlerConditions: [
        { line: 30, kind: 'condition', subject: 'coupon.stackable === false' },
      ],
    },
  ],
};

const entityGraph: EntityRelationGraph = {
  schemaVersion: 1,
  generatedAt: '2026-11-01T00:00:00Z',
  tables: [
    {
      table: 'coupon_wallet',
      entityNames: ['CouponWallet'],
      policyGroups: ['coupon'],
      sources: [
        {
          repository: 'dotori-api',
          filePath: 'src/coupon/coupon-wallet.entity.ts',
          symbol: 'CouponWallet',
          lineStart: 1,
          lineEnd: 40,
        },
      ],
      columns: [
        { name: 'member_id', dataType: 'bigint' },
        {
          name: 'redeemed_at',
          dataType: 'timestamp',
          comment: '결제에 붙인 때',
        },
      ],
      relations: [
        {
          targetTable: 'member',
          kind: 'many-to-one',
          source: 'declared',
          column: 'member_id',
          property: 'member',
        },
      ],
    },
  ],
};

const fieldWriterIndex: FieldWriterIndex = {
  schemaVersion: 1,
  generatedAt: '2026-11-01T00:00:00Z',
  maxWritersPerField: 30,
  writers: {
    'dotori-api:shippingFeeWaived': [
      {
        symbolId: 'sym-shipping-free',
        symbol: 'ShippingFeeRule.apply',
        filePath: 'src/shipping/shipping-fee.rule.ts',
        lineStart: 33,
        kind: 'assignment',
        valueSummary: 'true',
        conditions: ['order.total >= freeThreshold'],
      },
    ],
  },
  truncated: {},
};

// ── 조회 계약을 만족하는 최소 가짜 구현 ──

const codeSymbols: CodeSymbolLookup = {
  async findCurrentSymbols(query) {
    return [expirySymbol]
      .filter(
        (record) => !query.id || record.stableSymbolId.startsWith(query.id),
      )
      .filter((record) => !query.symbol || record.symbol === query.symbol)
      .filter(
        (record) => !query.repository || record.repository === query.repository,
      )
      .slice(0, query.limit);
  },
  async loadSymbolSource(record) {
    return record.content;
  },
};

const currentOnlyIndex: TemporalCodeIndex = {
  async searchCurrent(query, limit, repository) {
    return [expirySymbol]
      .filter((record) =>
        record.symbol.toLowerCase().includes(query.toLowerCase()),
      )
      .filter((record) => !repository || record.repository === repository)
      .slice(0, limit);
  },
};

const temporalIndex: TemporalCodeIndex = {
  ...currentOnlyIndex,
  async searchHistory(query, limit) {
    return [refundWindowChange]
      .filter((record) =>
        record.symbol.toLowerCase().includes(query.toLowerCase()),
      )
      .slice(0, limit);
  },
};

const topologySource: CodeTopologySource = {
  loadSystemTopology: async () => systemTopology,
  loadCrossRepositoryGraph: async () => crossRepositoryGraph,
};

const entitySource: EntityRelationGraphSource = {
  load: async () => entityGraph,
};
const emptyEntitySource: EntityRelationGraphSource = {
  load: async () => undefined,
};
const fieldWriterSource: FieldWriterIndexSource = {
  load: async () => fieldWriterIndex,
};

const codeGraphEvidence: CodeGraphEvidenceLookup = {
  async lookup({ seeds }) {
    return seeds.map((seed): PolicyEvidence => ({
      chunkId: `code:${seed.stableSymbolId}`,
      policyCode: seed.stableSymbolId,
      section: seed.symbol,
      internalSource: `${seed.repository}/${seed.filePath}`,
      sourceLabel: '도토리 마켓 서버 구현',
      text: `${seed.symbol} 를 따라간 처리 순서`,
      contextKind: 'technical',
      policyGroup:
        seed.record.recordType === 'current_symbol'
          ? seed.record.policyGroup
          : undefined,
    }));
  },
};

function recordLabel(record: CodeKnowledgeRecord): string {
  return record.recordType === 'current_symbol'
    ? `현재:${record.policyGroup}`
    : `변경:${record.changeKind}`;
}

describe('코드 지식 계약', () => {
  it('id 앞부분으로 현재 심볼을 찾고 원문은 따로 읽는다', async () => {
    const [found] = await codeSymbols.findCurrentSymbols({
      id: 'sym7f3a',
      limit: 3,
    });

    expect(found?.symbol).toBe('PointExpiryJob.sweep');
    expect(found?.executionFacts?.map((fact) => fact.kind)).toEqual([
      'condition',
      'assigns',
    ]);
    expect(found && (await codeSymbols.loadSymbolSource(found))).toContain(
      'entry.balance = 0',
    );
  });

  it('이력 색인이 없는 구현도 현재 코드 검색만으로 계약을 채운다', async () => {
    expect(currentOnlyIndex.searchHistory).toBeUndefined();
    expect(await currentOnlyIndex.searchCurrent('expiry', 5)).toHaveLength(1);
    expect(await temporalIndex.searchHistory?.('refund', 5)).toEqual([
      refundWindowChange,
    ]);
  });

  it('recordType 하나로 현재 심볼과 변경 이벤트를 가른다', () => {
    expect([expirySymbol, refundWindowChange].map(recordLabel)).toEqual([
      '현재:points',
      '변경:modify',
    ]);
  });

  it('산출물을 읽는 조회 계약은 없는 산출물을 undefined 로 알린다', async () => {
    expect((await topologySource.loadSystemTopology())?.edges[0]?.type).toBe(
      'SCHEDULES',
    );
    expect(await entitySource.load()).toBe(entityGraph);
    expect(await emptyEntitySource.load()).toBeUndefined();
    expect(
      (await fieldWriterSource.load())?.writers['dotori-api:shippingFeeWaived'],
    ).toHaveLength(1);
  });

  it('저장소 간 간선은 처리하는 쪽의 조건 실행 사실을 함께 싣는다', async () => {
    const graph = await topologySource.loadCrossRepositoryGraph();
    const [edge] = graph?.edges ?? [];

    expect(edge?.relation).toBe('HTTP_CALLS');
    expect(edge?.handlerConditions?.[0]?.subject).toContain('stackable');
  });

  it('코드 그래프 근거는 v0 근거 모양의 기술 근거로 돌아온다', async () => {
    const evidence = await codeGraphEvidence.lookup({
      question: '적립금이 사라지는 시점은 어디서 정하나요?',
      seeds: [
        {
          recordType: expirySymbol.recordType,
          repository: expirySymbol.repository,
          filePath: expirySymbol.filePath,
          symbol: expirySymbol.symbol,
          stableSymbolId: expirySymbol.stableSymbolId,
          commitSha: expirySymbol.commitSha,
          committedAt: expirySymbol.committedAt,
          record: expirySymbol,
        },
      ],
    });

    expect(evidence).toEqual([
      expect.objectContaining({
        contextKind: 'technical',
        policyGroup: 'points',
      }),
    ]);
  });
});

// ── 조사 계약 ──

const couponPairingEvidence: PolicyEvidence = {
  chunkId: 'coupon-07',
  policyCode: 'coupon-07',
  section: '쿠폰 겹쳐 쓰기',
  internalSource: 'policies.csv#coupon-07',
  sourceLabel: '도토리 마켓 쿠폰 안내',
  text: '상품 쿠폰과 장바구니 쿠폰은 주문 하나에 각각 한 장까지 겹쳐 쓸 수 있다',
  contextKind: 'policy',
  policyGroup: 'coupon',
};

const toolbox: ResearchToolbox = {
  schemas: RESEARCH_TOOL_NAMES.map((name) => ({
    name,
    description: `${name} 읽기 전용 도구`,
    parameters: { type: 'object', properties: {} },
  })),
  async run(name, args) {
    const known = (RESEARCH_TOOL_NAMES as readonly string[]).includes(name);
    const query = typeof args.query === 'string' ? args.query : '';
    const items: ResearchItem[] =
      name === 'searchPolicy' && query.includes('쿠폰')
        ? [
            {
              id: 'policy:coupon-07',
              kind: 'policy',
              title: '쿠폰 겹쳐 쓰기',
              text: couponPairingEvidence.text,
              location: {},
              policyEvidence: couponPairingEvidence,
              policyGroup: 'coupon',
            },
          ]
        : [];
    return {
      tool: name,
      summary: known
        ? `후보 ${items.length} 개`
        : `이 환경에 없는 도구: ${name}`,
      items,
      truncated: false,
    };
  },
};

function scriptedAgent(script: ResearchToolCall[][]): ResearchAgent {
  return {
    async nextTurn(input) {
      return { status: 'ok', toolCalls: script[input.turn - 1] ?? [] };
    },
  };
}

const brief: ResearchBrief = {
  question: '도토리 마켓 상품 쿠폰을 장바구니 쿠폰과 같이 써도 되나요?',
  routeReason: 'no_evidence',
  initialEvidence: [],
};

function turnInput(
  turn: number,
  history: ResearchMessage[],
): ResearchTurnInput {
  return {
    brief,
    history,
    tools: toolbox.schemas,
    turn,
    maxTurns: DEFAULT_RESEARCH_BUDGET.maxTurns,
    remainingToolCalls: DEFAULT_RESEARCH_BUDGET.maxToolCalls,
    signal: new AbortController().signal,
  };
}

describe('조사 계약', () => {
  it('도구 이름 아홉 개는 겹치지 않고 끝 선언 이름과도 다르다', () => {
    expect(RESEARCH_TOOL_NAMES).toHaveLength(9);
    expect(new Set(RESEARCH_TOOL_NAMES).size).toBe(9);
    expect(RESEARCH_TOOL_NAMES).not.toContain(RESEARCH_FINISH_TOOL_NAME);
    expectTypeOf<
      keyof ResearchToolArgumentMap
    >().toEqualTypeOf<ResearchToolName>();
  });

  it('예산 기본값은 양의 정수이고 실행 중에 바꿀 수 없다', () => {
    for (const value of [
      ...Object.values(DEFAULT_RESEARCH_BUDGET),
      ...Object.values(DEFAULT_RESEARCH_PACKING),
    ]) {
      expect(Number.isInteger(value) && value > 0).toBe(true);
    }
    expect(DEFAULT_RESEARCH_BUDGET.maxToolCallsPerTurn).toBeLessThanOrEqual(
      DEFAULT_RESEARCH_BUDGET.maxToolCalls,
    );
    expect(DEFAULT_RESEARCH_PACKING.reservedLeadingItems).toBeLessThan(
      DEFAULT_RESEARCH_PACKING.maxItems,
    );
    expect(DEFAULT_RESEARCH_PACKING.maxItemChars).toBeLessThanOrEqual(
      DEFAULT_RESEARCH_PACKING.maxTotalChars,
    );
    expect(Object.isFrozen(DEFAULT_RESEARCH_BUDGET)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RESEARCH_PACKING)).toBe(true);
    expect(Object.isFrozen(RESEARCH_TOOL_NAMES)).toBe(true);
  });

  it('공개 진입점이 조사 상수를 그대로 내보낸다', () => {
    expect(publicApi.RESEARCH_TOOL_NAMES).toBe(RESEARCH_TOOL_NAMES);
    expect(publicApi.DEFAULT_RESEARCH_BUDGET).toBe(DEFAULT_RESEARCH_BUDGET);
    expect(publicApi.DEFAULT_RESEARCH_PACKING).toBe(DEFAULT_RESEARCH_PACKING);
    expect(publicApi.RESEARCH_FINISH_TOOL_NAME).toBe(RESEARCH_FINISH_TOOL_NAME);
  });

  it('턴 단위 에이전트는 도구만 고르고, 도구가 준 id 만 근거로 남는다', async () => {
    const searchCall: ResearchToolCall = {
      id: 'call-1',
      name: 'searchPolicy',
      arguments: { query: '상품 쿠폰 장바구니 쿠폰 겹쳐 쓰기' },
    };
    const finishCall: ResearchToolCall = {
      id: 'call-2',
      name: RESEARCH_FINISH_TOOL_NAME,
      arguments: {
        conclusion: '종류가 다른 쿠폰은 한 장씩 함께 쓸 수 있다',
        evidenceIds: ['policy:coupon-07', 'policy:made-up'],
      },
    };
    const agent = scriptedAgent([[searchCall], [finishCall]]);

    const first = await agent.nextTurn(turnInput(1, []));
    const result = await toolbox.run(
      first.toolCalls[0]!.name,
      first.toolCalls[0]!.arguments,
    );
    const second = await agent.nextTurn(
      turnInput(2, [
        { role: 'assistant', toolCalls: first.toolCalls },
        { role: 'tool', callId: searchCall.id, content: result.summary },
      ]),
    );
    const finish = second.toolCalls[0]!
      .arguments as unknown as FinishResearchArgs;
    const returnedIds = new Set(result.items.map((item) => item.id));
    const outcome: ResearchOutcome = {
      status: 'finish',
      items: result.items,
      evidenceIds: finish.evidenceIds.filter((id) => returnedIds.has(id)),
      droppedIds: finish.evidenceIds.filter((id) => !returnedIds.has(id)),
      conclusion: finish.conclusion,
      turns: 2,
      toolCalls: [
        { turn: 1, name: 'searchPolicy', args: 'query', itemCount: 1 },
      ],
      collectedCount: result.items.length,
      elapsedMs: 0,
    };

    expect(second.toolCalls[0]?.name).toBe(RESEARCH_FINISH_TOOL_NAME);
    expect(outcome.evidenceIds).toEqual(['policy:coupon-07']);
    expect(outcome.droppedIds).toEqual(['policy:made-up']);
    expect(outcome.items[0]?.policyEvidence).toBe(couponPairingEvidence);
  });

  it('도구 묶음은 모르는 도구 이름에 던지지 않고 빈 결과로 답한다', async () => {
    const result = await toolbox.run('deleteOrder', { orderId: 'A-1' });

    expect(result.items).toEqual([]);
    expect(result.summary).toContain('deleteOrder');
  });
});

// ── 재정렬 계약 ──

function candidate(
  id: string,
  group: string,
  text: string,
  fusedScore: number,
): PolicyRetrievalCandidate {
  return {
    chunk: PolicyChunk.rehydrate({
      id,
      policyCode: id,
      section: group,
      text,
      source: 'dotori-policies.csv',
      policyGroup: group,
    }),
    fusedScore,
  };
}

const shippingCandidates = [
  candidate(
    'shipping-02',
    'shipping',
    '제주·도서 지역은 배송비가 따로 붙는다',
    0.031,
  ),
  candidate(
    'shipping-05',
    'shipping',
    '3 만 원 넘게 사면 기본 배송비를 받지 않는다',
    0.029,
  ),
  candidate(
    'coupon-03',
    'coupon',
    '배송비 쿠폰은 묶음 배송 한 건에만 쓴다',
    0.012,
  ),
];

const shadowReranker: Reranker = {
  mode: 'shadow',
  async rerank(query, candidates) {
    const score = (item: PolicyRetrievalCandidate) =>
      query.split(/\s+/u).filter((word) => item.chunk.text.includes(word))
        .length;
    return {
      status: 'shadow',
      items: candidates
        .map((item) => ({ candidate: item, score: score(item) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score),
    };
  },
};

const brokenReranker: Reranker = {
  mode: 'on',
  async rerank() {
    return { status: 'unavailable', reason: 'timeout' };
  },
};

describe('재정렬 계약', () => {
  it('shadow 재정렬기는 받은 후보 안에서 순서만 바꾼다', async () => {
    const result = await shadowReranker.rerank(
      '배송비 받지 않는',
      shippingCandidates,
    );

    expect(shadowReranker.mode).toBe('shadow');
    expect(result.status).toBe('shadow');
    const items = result.status === 'unavailable' ? [] : result.items;
    expect(items[0]?.candidate.chunk.id).toBe('shipping-05');
    for (const item of items) {
      expect(shippingCandidates).toContain(item.candidate);
    }
  });

  it('재정렬기가 실패하면 던지지 않고 unavailable 과 까닭을 돌려준다', async () => {
    const result = await brokenReranker.rerank('배송', shippingCandidates);

    expect(result).toEqual({ status: 'unavailable', reason: 'timeout' });
  });
});
