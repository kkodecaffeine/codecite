import { createHash } from 'node:crypto';
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
import type {
  ConversationTurn,
  DialogueMemory,
  DialogueMemoryRecord,
  ThreadContext,
  ThreadContextSnapshot,
} from './conversation.js';
import type {
  AnswerFeedback,
  AnswerRecord,
  ExperienceCase,
  ExperienceCaseStore,
  FeedbackReason,
  FeedbackReport,
} from './feedback.js';
import type {
  InventoryCatalog,
  InventoryCatalogSource,
  OfficialPolicyDocumentSource,
} from './catalog.js';
import type {
  KnowledgeRefreshRequest,
  KnowledgeRefreshRun,
  KnowledgeRefreshTrigger,
} from './knowledge-refresh.js';
import type {
  RunObservation,
  RunObserver,
  RuntimeBackup,
  RuntimeCache,
  RuntimeCacheEntry,
} from './observability.js';
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

// ── 대화 계약 ──

function inMemoryThreadContext(now: () => number): ThreadContext {
  const store = new Map<string, ThreadContextSnapshot>();
  return {
    async load(threadKey) {
      const snapshot = store.get(threadKey);
      return snapshot && snapshot.expiresAt > now() ? snapshot : undefined;
    },
    async save(threadKey, turns) {
      store.set(threadKey, { turns, expiresAt: now() + 60_000 });
    },
  };
}

function inMemoryDialogueMemory(): DialogueMemory {
  const records: DialogueMemoryRecord[] = [];
  return {
    async record(record) {
      records.push(record);
    },
    async searchSimilar(question, limit) {
      const words = question.split(/\s+/u);
      return records
        .filter((record) => record.clarificationQuestion !== null)
        .filter((record) =>
          words.some((word) => record.questionText.includes(word)),
        )
        .slice(0, limit)
        .map((record) => ({
          question: record.questionText,
          clarificationQuestion: record.clarificationQuestion ?? '',
        }));
    },
  };
}

const membershipTurns: ConversationTurn[] = [
  { role: 'user', content: '도토리 마켓 골드 등급은 어떻게 올라가요?' },
  {
    role: 'assistant',
    content: '누적 주문 금액이 등급 기준을 넘으면 다음 등급으로 오릅니다.',
  },
];

function dialogueRecord(
  caseId: string,
  questionText: string,
  clarificationQuestion: string | null,
): DialogueMemoryRecord {
  return {
    schemaVersion: 1,
    caseId,
    questionText,
    resolvedQuestionText: questionText,
    conversationTurns: [],
    clarificationQuestion,
    state: clarificationQuestion ? 'clarifying' : 'answered',
    answerHash: `answer-${caseId}`,
    citationCount: clarificationQuestion ? 0 : 1,
    recordedAt: '2026-11-16T00:00:00Z',
  };
}

describe('대화 계약', () => {
  it('스레드 문맥은 만료 전까지만 앞 턴을 돌려준다', async () => {
    let clock = 1_000;
    const context = inMemoryThreadContext(() => clock);

    await context.save('thread-membership', membershipTurns);
    expect((await context.load('thread-membership'))?.turns).toEqual(
      membershipTurns,
    );

    clock += 120_000;
    expect(await context.load('thread-membership')).toBeUndefined();
    expect(await context.load('thread-unknown')).toBeUndefined();
  });

  it('대화 기억은 되물었던 사례만 힌트로 돌려준다', async () => {
    const memory = inMemoryDialogueMemory();
    await memory.record(
      dialogueRecord(
        'case-1',
        '그 쿠폰 언제까지 써요?',
        '가입 축하 쿠폰과 리뷰 감사 쿠폰 중 어느 것을 물으셨나요?',
      ),
    );
    await memory.record(
      dialogueRecord('case-2', '리뷰 감사 쿠폰은 언제까지 써요?', null),
    );

    const hints = await memory.searchSimilar('쿠폰 언제까지', 5);

    expect(hints).toEqual([
      {
        question: '그 쿠폰 언제까지 써요?',
        clarificationQuestion:
          '가입 축하 쿠폰과 리뷰 감사 쿠폰 중 어느 것을 물으셨나요?',
      },
    ]);
  });
});

// ── 피드백 계약 ──

interface StoredAnswer {
  record: AnswerRecord;
  feedback?: AnswerFeedback;
  reason?: FeedbackReason;
  comment?: string;
}

function inMemoryFeedbackReport(): {
  report: FeedbackReport;
  stored: Map<string, StoredAnswer>;
} {
  const stored = new Map<string, StoredAnswer>();
  const report: FeedbackReport = {
    async recordAnswer(record) {
      const reportId = `report-${stored.size + 1}`;
      stored.set(reportId, { record });
      return reportId;
    },
    async findAnswer(answerKey) {
      return [...stored].find(
        ([, entry]) => entry.record.answerKey === answerKey,
      )?.[0];
    },
    async recordFeedback(reportId, feedback) {
      const entry = stored.get(reportId);
      if (entry) {
        entry.feedback = feedback;
      }
    },
    async updateReason(reportId, reason, comment) {
      const entry = stored.get(reportId);
      if (entry) {
        entry.reason = reason;
        entry.comment = comment;
      }
    },
  };
  return { report, stored };
}

function inMemoryExperienceCases(): ExperienceCaseStore {
  const cases = new Map<string, ExperienceCase>();
  return {
    record(experienceCase) {
      const previous = cases.get(experienceCase.caseId);
      cases.set(experienceCase.caseId, {
        ...experienceCase,
        occurrenceCount:
          (previous?.occurrenceCount ?? 0) + experienceCase.occurrenceCount,
      });
    },
    async searchSimilar(query, limit) {
      return [...cases.values()]
        .filter((item) => item.queryText?.includes(query))
        .slice(0, limit);
    },
    async updateStatus(caseId, status) {
      const found = cases.get(caseId);
      if (found) {
        cases.set(caseId, { ...found, status });
      }
    },
  };
}

describe('피드백 계약', () => {
  it('평가는 답 기록에 붙고, 같은 기록의 평가는 마지막 것으로 바뀐다', async () => {
    const { report, stored } = inMemoryFeedbackReport();
    const reportId = await report.recordAnswer({
      answerKey: 'room-7:1731700000.000100',
      kind: 'answer',
      question: '도토리 마켓 해외 직구 상품도 반품할 수 있어요?',
      answer: '받은 날부터 열흘 안에 반품을 신청할 수 있습니다.',
      evidenceIds: ['refund-04'],
      generation: 'llm',
      answeredAt: '2026-11-16T03:00:00Z',
    });

    const foundId = await report.findAnswer('room-7:1731700000.000100');
    await report.recordFeedback(foundId!, {
      rating: 'helpful',
      reportedAt: '2026-11-16T03:01:00Z',
    });
    await report.recordFeedback(foundId!, {
      rating: 'unhelpful',
      reviewerName: '다람',
      reportedAt: '2026-11-16T03:02:00Z',
    });
    await report.updateReason(
      foundId!,
      'incomplete_answer',
      '직구 상품은 왕복 배송비를 고객이 낸다는 말이 빠졌어요',
    );

    expect(foundId).toBe(reportId);
    expect(stored.get(reportId!)?.feedback?.rating).toBe('unhelpful');
    expect(stored.get(reportId!)?.reason).toBe('incomplete_answer');
  });

  it('경험 사례는 같은 사례를 모아 횟수를 세고 사람이 상태를 정한다', async () => {
    const store = inMemoryExperienceCases();
    const repeated: ExperienceCase = {
      schemaVersion: 1,
      caseId: 'exp-shipping-delay',
      queryHash: 'q-5d1e',
      queryText: '배송 지연 보상',
      outcome: 'abstained',
      signals: ['abstention'],
      source: 'runtime_signal',
      status: 'candidate',
      occurrenceCount: 1,
    };

    await store.record(repeated);
    await store.record(repeated);
    await store.updateStatus('exp-shipping-delay', 'verified');
    const [found] = await store.searchSimilar('배송 지연', 3);

    expect(found?.occurrenceCount).toBe(2);
    expect(found?.status).toBe('verified');
  });
});

// ── 관측·런타임 계약 ──

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function observationFor(
  question: string,
  answer: string,
  stageMs: Record<string, number>,
): RunObservation {
  return {
    schemaVersion: 1,
    requestId: 'req-local-1',
    queryHash: hashOf(question),
    outcome: 'answered',
    signals: [],
    elapsedMs: Object.values(stageMs).reduce((sum, ms) => sum + ms, 0),
    stageMs,
    answerHash: hashOf(answer),
    answerLength: answer.length,
    citationCount: 1,
  };
}

function inMemoryRuntimeCache(now: () => number): RuntimeCache {
  const entries = new Map<string, RuntimeCacheEntry<unknown>>();
  return {
    async get<T>(namespace: string, key: string) {
      const entry = entries.get(`${namespace}/${key}`);
      return entry && entry.expiresAt > now()
        ? (entry as RuntimeCacheEntry<T>)
        : undefined;
    },
    async set(namespace, key, value, expiresAt) {
      entries.set(`${namespace}/${key}`, { value, expiresAt });
    },
  };
}

describe('관측·런타임 계약', () => {
  it('관측 기록은 질문 본문 없이 해시와 단계별 시간만 남긴다', async () => {
    const recorded: RunObservation[] = [];
    const observer: RunObserver = {
      record(observation) {
        recorded.push(observation);
      },
    };
    const question = '도토리 마켓 실버 등급은 무료 배송 쿠폰을 몇 장 받나요?';

    await observer.record(
      observationFor(question, '실버 등급은 매달 두 장을 받습니다.', {
        retrieval: 40,
        packing: 3,
        generation: 900,
      }),
    );

    expect(recorded).toHaveLength(1);
    expect(JSON.stringify(recorded[0])).not.toContain('실버 등급');
    expect(recorded[0]?.elapsedMs).toBe(943);
  });

  it('런타임 캐시는 만료된 값을 없는 것으로 보고, 백업은 요청만 받는다', async () => {
    let clock = 0;
    let backups = 0;
    const cache = inMemoryRuntimeCache(() => clock);
    const backup: RuntimeBackup = {
      async requestBackup() {
        backups += 1;
      },
    };

    await cache.set(
      'question-plan',
      'q-5d1e',
      { searchTerms: ['배송비'] },
      500,
    );
    expect(
      (await cache.get<{ searchTerms: string[] }>('question-plan', 'q-5d1e'))
        ?.value.searchTerms,
    ).toEqual(['배송비']);

    clock = 600;
    expect(await cache.get('question-plan', 'q-5d1e')).toBeUndefined();

    await backup.requestBackup();
    expect(backups).toBe(1);
  });
});

// ── 지식 갱신 계약 ──

function fakeRefreshTrigger(heads: Record<string, string>): {
  trigger: KnowledgeRefreshTrigger;
  dispatched: KnowledgeRefreshRequest[];
} {
  const dispatched: KnowledgeRefreshRequest[] = [];
  let active: KnowledgeRefreshRun | undefined;
  const trigger: KnowledgeRefreshTrigger = {
    async activeRun() {
      return active;
    },
    async latestCommit(repository) {
      return { branch: 'main', sha: heads[repository] ?? '' };
    },
    async dispatch(request) {
      dispatched.push(request);
      active = {
        id: `run-${dispatched.length}`,
        url: `https://ci.example.test/runs/${dispatched.length}`,
        status: '진행 중',
        createdAt: '2026-11-16T04:00:00Z',
      };
      return { run: active, statusUrl: 'https://ci.example.test/runs' };
    },
  };
  return { trigger, dispatched };
}

async function refreshChanged(
  trigger: KnowledgeRefreshTrigger,
  reflected: Record<string, string>,
): Promise<'already_latest' | 'busy' | 'started'> {
  if (await trigger.activeRun()) {
    return 'busy';
  }
  const repositories: string[] = [];
  for (const [repository, sha] of Object.entries(reflected)) {
    if ((await trigger.latestCommit(repository)).sha !== sha) {
      repositories.push(repository);
    }
  }
  if (repositories.length === 0) {
    return 'already_latest';
  }
  await trigger.dispatch({
    repositories,
    rebuildEmbeddings: false,
    requestedBy: 'maintainer-1',
    replyTo: 'room-7:thread-42',
  });
  return 'started';
}

describe('지식 갱신 계약', () => {
  it('바뀐 저장소만 갱신하고, 진행 중이면 새로 시작하지 않는다', async () => {
    const reflected = { 'dotori-api': 'a1a1a1', 'dotori-web': 'b2b2b2' };
    const { trigger, dispatched } = fakeRefreshTrigger({
      'dotori-api': 'a1a1a1',
      'dotori-web': 'c3c3c3',
    });

    expect(await refreshChanged(trigger, reflected)).toBe('started');
    expect(dispatched[0]?.repositories).toEqual(['dotori-web']);
    expect(await refreshChanged(trigger, reflected)).toBe('busy');
    expect(dispatched).toHaveLength(1);
  });

  it('모든 저장소가 반영된 커밋과 같으면 이미 최신이다', async () => {
    const { trigger, dispatched } = fakeRefreshTrigger({
      'dotori-api': 'a1a1a1',
    });

    expect(await refreshChanged(trigger, { 'dotori-api': 'a1a1a1' })).toBe(
      'already_latest',
    );
    expect(dispatched).toEqual([]);
  });
});

// ── 목록·공식 문서 계약 ──

const couponCatalog: InventoryCatalog = {
  schemaVersion: 1,
  generatedAt: '2026-11-01T00:00:00Z',
  inventories: [
    {
      id: 'coupon-kinds',
      title: '도토리 마켓 쿠폰 종류',
      subjectPattern: '쿠폰.*(종류|어떤|뭐뭐)',
      scopeNote: '고객이 쿠폰함에서 받는 쿠폰만 담고, 판매자 부담 할인은 뺀다',
      itemNoun: '쿠폰',
      groups: [
        { id: 'first-order', label: '첫 주문' },
        { id: 'activity', label: '활동 보상' },
      ],
      categories: [],
      entries: [
        {
          id: 'first-order-coupon',
          group: 'first-order',
          label: '첫 주문 할인 쿠폰',
          channel: '쿠폰함',
          trigger: '첫 주문을 마친 다음 날 발급',
          surface: 'dotori-web',
          sources: [
            {
              repository: 'dotori-api',
              filePath: 'src/coupon/first-order-coupon.issuer.ts',
              symbol: 'FirstOrderCouponIssuer.issue',
              resolved: true,
            },
          ],
          resolved: true,
        },
        {
          id: 'photo-review-coupon',
          group: 'activity',
          label: '사진 리뷰 감사 쿠폰',
          trigger: '사진 리뷰 등록',
          surface: 'dotori-web',
          sources: [
            {
              repository: 'dotori-api',
              filePath: 'src/review/photo-review-reward.ts',
              symbol: 'PhotoReviewReward.grant',
              resolved: false,
            },
          ],
          resolved: false,
        },
      ],
      uncoveredCandidates: [
        {
          repository: 'dotori-api',
          filePath: 'src/coupon/restock-coupon.issuer.ts',
          symbol: 'RestockCouponIssuer.issue',
        },
      ],
    },
  ],
};

const catalogSource: InventoryCatalogSource = {
  load: async () => couponCatalog,
};

const shippingDocument: PolicyEvidence = {
  chunkId: 'official-shipping-2',
  policyCode: 'official-shipping-2',
  section: '출고',
  internalSource: 'docs/official/shipping.md#2',
  sourceLabel: '도토리 마켓 배송 안내서',
  text: '오후 두 시까지 결제한 주문은 그날 출고하고, 그 뒤 주문은 다음 영업일에 출고한다',
  contextKind: 'policy',
  policyGroup: 'shipping',
};

const officialDocuments: OfficialPolicyDocumentSource = {
  async lookup(question) {
    return question.includes('출고') ? [shippingDocument] : [];
  },
};

describe('목록·공식 문서 계약', () => {
  it('목록은 출처를 찾은 항목만 근거로 세고 새 후보는 따로 알린다', async () => {
    const catalog = await catalogSource.load();
    const [inventory] = catalog?.inventories ?? [];
    const usable = inventory?.entries.filter((entry) => entry.resolved) ?? [];

    expect(
      new RegExp(inventory!.subjectPattern, 'u').test('쿠폰은 어떤 게 있어요?'),
    ).toBe(true);
    expect(usable.map((entry) => entry.label)).toEqual(['첫 주문 할인 쿠폰']);
    expect(inventory?.uncoveredCandidates).toHaveLength(1);
  });

  it('공식 정책 문서는 맞는 구절이 없으면 빈 배열을 돌려준다', async () => {
    expect(
      await officialDocuments.lookup('오늘 주문하면 언제 출고돼요?'),
    ).toEqual([shippingDocument]);
    expect(await officialDocuments.lookup('적립금 유효 기간')).toEqual([]);
  });
});
