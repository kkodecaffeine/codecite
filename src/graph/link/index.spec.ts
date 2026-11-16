import { describe, expect, it } from 'vitest';
import type {
  CrossRepositoryEdge,
  ExecutionFact,
} from '../../extensions/code-knowledge.js';
import { parseGraphConfig } from '../config.js';
import { EMPTY_FILE_SKIP_COUNTS } from '../constants.js';
import { buildRepositoryRecords, stableSymbolId } from '../records.js';
import { buildSystemTopology } from '../topology.js';
import type {
  ClassMember,
  Detection,
  ExtractedSymbol,
  GraphBuildState,
  GraphHints,
  RepositoryBuild,
} from '../types.js';
import { buildCrossRepositoryGraph, buildGraphReport } from './index.js';
import { ManualLinkError } from './manual.js';

// ── 도토리 마켓 가짜 상태: shop-api(서버), shop-web(웹), shop-worker(작업자) ──

const REPOSITORIES = ['shop-api', 'shop-web', 'shop-worker'];
const COMMITTED = {
  'shop-api': '2026-11-02T08:00:00.000Z',
  'shop-web': '2026-11-03T09:30:00.000Z',
  'shop-worker': '2026-11-01T07:15:00.000Z',
} as Record<string, string>;

type Symbols = Record<string, ExtractedSymbol[]>;

function sym(
  filePath: string,
  name: string,
  kind = 'method',
  lineStart = 1,
  extra: Partial<ExtractedSymbol> = {},
): ExtractedSymbol {
  return {
    filePath,
    language: filePath.endsWith('.py') ? 'python' : 'typescript',
    symbol: name,
    kind,
    content: `// ${name}`,
    lineStart,
    lineEnd: lineStart + 4,
    relations: [],
    ...extra,
  };
}

const calls = (repository: string, ...targets: string[]) =>
  targets.map((symbol) => ({
    type: 'CALLS',
    target: { repository, symbol },
  }));

const imports = (repository: string, ...targets: string[]) =>
  targets.map((symbol) => ({
    type: 'IMPORTS',
    target: { repository, symbol },
  }));

const member = (name: string, type: string): ClassMember => ({
  name,
  type,
  line: 3,
  parameter: true,
  decorators: [],
});

const fact = (
  kind: ExecutionFact['kind'],
  line: number,
  subject: string,
): ExecutionFact => ({ kind, line, subject });

type DetectionFields = Record<string, unknown> & { kind: Detection['kind'] };

function det(
  repository: string,
  filePath: string,
  symbol: string,
  line: number,
  fields: DetectionFields,
  confidence = 0.95,
): Detection {
  return {
    repository,
    filePath,
    symbol,
    line,
    detector: 'acorn',
    confidence,
    evidence: `${symbol} line ${line}`,
    ...fields,
  } as Detection;
}

function linkState(input: {
  symbols: Symbols;
  detections: Detection[];
  hints?: GraphHints;
  maxUnresolvedRatio?: number;
  repositories?: string[];
}): GraphBuildState {
  const names = input.repositories ?? REPOSITORIES;
  const config = parseGraphConfig(
    {
      repositories: names.map((name) => ({
        name,
        url: `https://example.com/dotori/${name}.git`,
      })),
      ...(input.hints ? { hints: input.hints } : {}),
      ...(input.maxUnresolvedRatio !== undefined
        ? { maxUnresolvedRatio: input.maxUnresolvedRatio }
        : {}),
    },
    '/work/dotori',
  );
  const repositories: RepositoryBuild[] = names.map((name) => {
    const extracted = input.symbols[name] ?? [];
    const commitSha = String(names.indexOf(name) + 1).repeat(40);
    const committedAt = COMMITTED[name] ?? COMMITTED['shop-api'];
    const { records } = buildRepositoryRecords(extracted, {
      repository: name,
      commitSha,
      committedAt,
      groups: {},
    });
    return {
      snapshot: {
        repository: name,
        branch: 'main',
        commitSha,
        committedAt,
        reused: false,
      },
      manifest: {
        name,
        branch: 'main',
        commitSha,
        committedAt,
        inputFingerprint: 'sha256:test',
        symbolsFile: `symbols/${name}.jsonl`,
        symbolCount: records.length,
        fileCount: 0,
        skippedFiles: { ...EMPTY_FILE_SKIP_COUNTS },
        failures:
          name === 'shop-web'
            ? [{ filePath: 'src/legacy/broken.ts', message: 'cannot parse' }]
            : [],
      },
      records,
      extracted,
    };
  });
  const detections = new Map<string, Detection[]>(
    names.map((name) => [
      name,
      input.detections.filter((detection) => detection.repository === name),
    ]),
  );
  const state: GraphBuildState = {
    config,
    repositories,
    records: repositories.flatMap((build) => build.records),
    detections,
    artifacts: new Map(),
  };
  state.topology = buildSystemTopology(state, detections);
  return state;
}

const id = (repository: string, filePath: string, symbol: string) =>
  stableSymbolId(repository, filePath, symbol);

const edgesOf = (edges: CrossRepositoryEdge[], relation: string) =>
  edges.filter((edge) => edge.relation === relation);

const brief = (edge: CrossRepositoryEdge) =>
  `${edge.relation} ${edge.sourceLocation?.repository}#${edge.sourceLocation?.symbol} -> ${edge.targetLocation?.repository}#${edge.targetLocation?.symbol} [${edge.confidence}] ${edge.extraction.value}`;

// ── 공통 심볼 ──

const CONTROLLER = 'src/order/order.controller.ts';
const SERVICE = 'src/order/order.service.ts';

/** shop-api: 주문 취소 라우트 → 서비스 → 적립금 되돌리기. 서비스·적립금에 조건과 예외가 있다 */
const apiSymbols = (): ExtractedSymbol[] => [
  sym(CONTROLLER, 'OrderController', 'controller', 1, {
    lineEnd: 40,
    members: [member('orders', 'OrderService')],
  }),
  sym(CONTROLLER, 'OrderController.cancel', 'method', 10, {
    relations: calls('shop-api', 'this.orders.cancel'),
  }),
  sym(SERVICE, 'OrderService', 'class', 1, {
    lineEnd: 60,
    members: [member('points', 'PointLedger')],
  }),
  sym(SERVICE, 'OrderService.cancel', 'method', 12, {
    relations: calls('shop-api', 'this.points.restore'),
    executionFacts: [
      fact('condition', 13, 'order.shippedAt !== null'),
      fact('throws', 14, 'new OrderAlreadyShipped()'),
      fact('calls', 15, 'this.points.restore'),
    ],
  }),
  sym('src/points/point-ledger.ts', 'PointLedger', 'class', 1, { lineEnd: 30 }),
  sym('src/points/point-ledger.ts', 'PointLedger.restore', 'method', 5, {
    executionFacts: [fact('condition', 6, 'amount > 0')],
  }),
  sym('src/main.ts', 'healthCheck', 'function', 3),
];

const cancelRoute = (repository = 'shop-api') =>
  det(repository, CONTROLLER, 'OrderController.cancel', 9, {
    kind: 'http-route',
    method: 'POST',
    path: '/orders/:param/cancel',
  });

const webSymbols = (): ExtractedSymbol[] => [
  sym('src/order/cancel-button.ts', 'requestCancel', 'function', 4, {
    executionFacts: [fact('condition', 5, 'confirmed')],
  }),
  sym('src/order/status.ts', 'loadStatus', 'function', 2),
];

const webCall = (fields: Partial<Record<string, unknown>> = {}, line = 6) =>
  det(
    'shop-web',
    'src/order/cancel-button.ts',
    'requestCancel',
    line,
    {
      kind: 'http-call',
      method: 'POST',
      path: '/orders/:param/cancel',
      baseIdentifiers: [],
      dynamic: false,
      ...fields,
    } as DetectionFields,
    0.9,
  );

describe('HTTP_CALLS', () => {
  it('힌트 없이 다른 저장소에 라우트가 하나뿐이면 medium 으로 잇고 처리 사슬과 조건·예외를 단다', () => {
    const state = linkState({
      symbols: { 'shop-api': apiSymbols(), 'shop-web': webSymbols() },
      detections: [cancelRoute(), webCall()],
    });
    const { graph, unresolved } = buildCrossRepositoryGraph(state);
    const [edge] = edgesOf(graph.edges, 'HTTP_CALLS');

    expect(edge).toMatchObject({
      relation: 'HTTP_CALLS',
      source: id('shop-web', 'src/order/cancel-button.ts', 'requestCancel'),
      target: id('shop-api', CONTROLLER, 'OrderController.cancel'),
      confidence: 'medium',
      extraction: {
        kind: 'route',
        locator: 'src/order/cancel-button.ts:6',
        value: 'POST /orders/:param/cancel',
      },
      sourceLocation: {
        repository: 'shop-web',
        filePath: 'src/order/cancel-button.ts',
        symbol: 'requestCancel',
        lineStart: 4,
        lineEnd: 8,
      },
    });
    expect(edge.handlerChain?.map((place) => place.symbol)).toEqual([
      'OrderService.cancel',
      'PointLedger.restore',
    ]);
    expect(edge.callerConditions?.map((item) => item.subject)).toEqual([
      'confirmed',
    ]);
    expect(edge.handlerConditions?.map((item) => item.subject)).toEqual([
      'order.shippedAt !== null',
      'amount > 0',
    ]);
    expect(edge.handlerExceptions?.map((item) => item.subject)).toEqual([
      'new OrderAlreadyShipped()',
    ]);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(
      [edge.source, edge.target].sort(),
    );
    expect(graph.nodes[0].recordTypes).toEqual(['current_symbol']);
    expect(unresolved.filter((item) => item.reason !== 'no-caller')).toEqual(
      [],
    );
  });

  it('프록시 접두어는 떼고 대상 저장소를 정해 high 로 잇고, 다른 저장소의 같은 라우트는 후보에서 뺀다', () => {
    const state = linkState({
      symbols: {
        'shop-api': apiSymbols(),
        'shop-web': webSymbols(),
        'shop-worker': [
          sym(CONTROLLER, 'OrderController.cancel', 'method', 10),
        ],
      },
      detections: [
        cancelRoute(),
        cancelRoute('shop-worker'),
        webCall({ path: '/api/proxy/orders/:param/cancel' }),
      ],
      hints: { proxyPrefixes: { '/api/proxy': 'shop-api' } },
    });
    const { graph } = buildCrossRepositoryGraph(state);
    expect(edgesOf(graph.edges, 'HTTP_CALLS').map(brief)).toEqual([
      'HTTP_CALLS shop-web#requestCancel -> shop-api#OrderController.cancel [high] POST /orders/:param/cancel',
    ]);
    expect(graph.edges[0].evidence).toContain(
      'proxy prefix /api/proxy points to shop-api',
    );
  });

  it('주소 변수 힌트는 process.env·os.environ 꼴과 멤버 연쇄 끝 이름을 모두 알아본다', () => {
    for (const identifier of [
      'process.env.SHOP_API_URL',
      'os.environ.SHOP_API_URL',
      'this.config.SHOP_API_URL',
      'SHOP_API_URL',
    ]) {
      const state = linkState({
        symbols: {
          'shop-api': apiSymbols(),
          'shop-web': webSymbols(),
          'shop-worker': [
            sym(CONTROLLER, 'OrderController.cancel', 'method', 10),
          ],
        },
        detections: [
          cancelRoute(),
          cancelRoute('shop-worker'),
          webCall({ baseIdentifiers: [identifier] }),
        ],
        hints: { baseUrls: { SHOP_API_URL: 'shop-api' } },
      });
      const { graph } = buildCrossRepositoryGraph(state);
      expect(edgesOf(graph.edges, 'HTTP_CALLS').map(brief)).toEqual([
        'HTTP_CALLS shop-web#requestCancel -> shop-api#OrderController.cancel [high] POST /orders/:param/cancel',
      ]);
    }
  });

  it('바깥 서비스 호스트·주소 변수·경로 접두어에 맞는 호출은 경로가 같아도 잇지 않고 external 로 남긴다', () => {
    const state = linkState({
      symbols: { 'shop-api': apiSymbols(), 'shop-web': webSymbols() },
      detections: [
        cancelRoute(),
        webCall({ host: 'api.payments.example.com' }, 6),
        webCall({ baseIdentifiers: ['process.env.PAYMENTS_URL'] }, 7),
        webCall({ path: '/partner/orders/:param/cancel' }, 8),
      ],
      hints: {
        external: ['https://payments.example.com', 'PAYMENTS_URL', '/partner'],
      },
    });
    const { graph, unresolved } = buildCrossRepositoryGraph(state);
    expect(edgesOf(graph.edges, 'HTTP_CALLS')).toEqual([]);
    expect(
      unresolved
        .filter((item) => item.reason === 'external')
        .map((item) => `${item.line} ${item.value}`),
    ).toEqual([
      '6 POST api.payments.example.com/orders/:param/cancel',
      '7 POST process.env.PAYMENTS_URL/orders/:param/cancel',
      '8 POST /partner/orders/:param/cancel',
    ]);
  });

  it('처리기가 여럿이면 잇지 않고 후보와 함께 ambiguous-provider, 없으면 no-provider, 경로를 못 읽으면 dynamic-target', () => {
    const state = linkState({
      symbols: {
        'shop-api': apiSymbols(),
        'shop-web': webSymbols(),
        'shop-worker': [
          sym(CONTROLLER, 'OrderController.cancel', 'method', 10),
        ],
      },
      detections: [
        cancelRoute(),
        cancelRoute('shop-worker'),
        webCall({}, 6),
        webCall({ path: '/carts/:param' }, 7),
        webCall({ path: undefined, dynamic: true }, 8),
      ],
    });
    const { graph, unresolved } = buildCrossRepositoryGraph(state);
    expect(edgesOf(graph.edges, 'HTTP_CALLS')).toEqual([]);
    const fromWeb = unresolved.filter((item) => item.repository === 'shop-web');
    expect(fromWeb).toEqual([
      {
        reason: 'ambiguous-provider',
        relation: 'HTTP_CALLS',
        repository: 'shop-web',
        filePath: 'src/order/cancel-button.ts',
        symbol: 'requestCancel',
        line: 6,
        value: 'POST /orders/:param/cancel',
        candidates: [
          `shop-api:${CONTROLLER}#OrderController.cancel`,
          `shop-worker:${CONTROLLER}#OrderController.cancel`,
        ],
      },
      expect.objectContaining({
        reason: 'no-provider',
        line: 7,
        value: 'POST /carts/:param',
      }),
      expect.objectContaining({
        reason: 'dynamic-target',
        line: 8,
        value: 'POST <dynamic>',
      }),
    ]);
    // 후보로 이미 보고된 처리기는 no-caller 로 다시 남기지 않는다
    expect(unresolved.filter((item) => item.reason === 'no-caller')).toEqual(
      [],
    );
  });

  it('`/`·`/health`·매개변수뿐인 경로는 힌트 없이 잇지 않고, 힌트가 있으면 잇는다', () => {
    const detections = [
      det('shop-api', 'src/main.ts', 'healthCheck', 3, {
        kind: 'http-route',
        method: 'GET',
        path: '/health',
      }),
      webCall({ method: 'GET', path: '/health' }, 6),
      webCall({ method: 'GET', path: '/:param' }, 7),
    ];
    const plain = buildCrossRepositoryGraph(
      linkState({
        symbols: { 'shop-api': apiSymbols(), 'shop-web': webSymbols() },
        detections,
      }),
    );
    expect(edgesOf(plain.graph.edges, 'HTTP_CALLS')).toEqual([]);
    expect(
      plain.unresolved
        .filter((item) => item.repository === 'shop-web')
        .map((item) => `${item.reason} ${item.value}`),
    ).toEqual(['ambiguous-provider GET /health', 'no-provider GET /:param']);

    const hinted = buildCrossRepositoryGraph(
      linkState({
        symbols: { 'shop-api': apiSymbols(), 'shop-web': webSymbols() },
        detections: [
          detections[0],
          webCall(
            {
              method: 'GET',
              path: '/health',
              baseIdentifiers: ['SHOP_API_URL'],
            },
            6,
          ),
        ],
        hints: { baseUrls: { SHOP_API_URL: 'shop-api' } },
      }),
    );
    expect(edgesOf(hinted.graph.edges, 'HTTP_CALLS').map(brief)).toEqual([
      'HTTP_CALLS shop-web#requestCancel -> shop-api#healthCheck [high] GET /health',
    ]);
  });

  it('같은 저장소에 맞는 라우트가 있으면 저장소 안 호출로 보고 잇지도 남기지도 않는다', () => {
    const state = linkState({
      symbols: {
        'shop-api': apiSymbols(),
        'shop-web': [
          ...webSymbols(),
          sym('src/pages/api/orders.ts', 'cancelProxy', 'function', 1),
        ],
      },
      detections: [
        cancelRoute(),
        det('shop-web', 'src/pages/api/orders.ts', 'cancelProxy', 1, {
          kind: 'http-route',
          method: '*',
          path: '/orders/[id]/cancel',
        }),
        webCall(),
      ],
    });
    const { graph, unresolved } = buildCrossRepositoryGraph(state);
    expect(edgesOf(graph.edges, 'HTTP_CALLS')).toEqual([]);
    expect(unresolved.filter((item) => item.repository === 'shop-web')).toEqual(
      [expect.objectContaining({ reason: 'no-caller', symbol: 'cancelProxy' })],
    );
  });

  it('신뢰도는 탐지 신뢰도가 허락하는 값을 넘지 않는다', () => {
    const weak = det(
      'shop-web',
      'src/order/cancel-button.ts',
      'requestCancel',
      6,
      {
        kind: 'http-call',
        method: 'POST',
        path: '/orders/:param/cancel',
        baseIdentifiers: ['SHOP_API_URL'],
        dynamic: true,
      },
      0.6,
    );
    const { graph } = buildCrossRepositoryGraph(
      linkState({
        symbols: { 'shop-api': apiSymbols(), 'shop-web': webSymbols() },
        detections: [cancelRoute(), weak],
        hints: { baseUrls: { SHOP_API_URL: 'shop-api' } },
      }),
    );
    expect(graph.edges[0].confidence).toBe('medium');
  });
});

describe('GRAPHQL_CALLS', () => {
  const RESOLVER = 'src/graphql/order.resolver.ts';
  const graphqlApi = (): ExtractedSymbol[] => [
    ...apiSymbols(),
    sym(RESOLVER, 'OrderResolver.cancelOrder', 'method', 8),
    sym(RESOLVER, 'OrderResolver.items', 'method', 20),
    sym('src/admin/order.resolver.ts', 'AdminOrderResolver.order', 'method', 4),
  ];
  const resolver = (
    filePath: string,
    symbol: string,
    operationType: string,
    field: string,
    repository = 'shop-api',
  ) =>
    det(repository, filePath, symbol, 7, {
      kind: 'graphql-resolver',
      operationType,
      field,
    });
  const graphqlWeb = (): ExtractedSymbol[] => [
    ...webSymbols(),
    sym('src/graphql/cancel-order.graphql', 'CancelOrder', 'schema', 1),
  ];
  const documentOf = (
    rootFields: string[],
    schema?: string,
    filePath = 'src/graphql/cancel-order.graphql',
  ) =>
    det('shop-web', filePath, 'CancelOrder', 1, {
      kind: 'graphql-document',
      operationType: 'mutation',
      operationName: 'CancelOrder',
      rootFields,
      ...(schema ? { schema } : {}),
    });
  const clientCall = (operationName = 'CancelOrder') =>
    det('shop-web', 'src/order/cancel-button.ts', 'requestCancel', 9, {
      kind: 'graphql-client-call',
      operationName,
    });

  it('연산 문서의 루트 필드를 스키마 범위 안의 리졸버 하나에 high 로 잇고, 루트 필드마다 간선 하나다', () => {
    const state = linkState({
      symbols: { 'shop-api': graphqlApi(), 'shop-web': graphqlWeb() },
      detections: [
        resolver(
          RESOLVER,
          'OrderResolver.cancelOrder',
          'mutation',
          'cancelOrder',
        ),
        resolver(RESOLVER, 'OrderResolver.items', 'query', 'Order.items'),
        documentOf(['cancelOrder', 'refundPoints'], 'shop'),
        clientCall(),
      ],
      hints: {
        graphqlSchemas: {
          shop: { repository: 'shop-api', paths: ['src/graphql'] },
        },
      },
    });
    const { graph, unresolved } = buildCrossRepositoryGraph(state);
    expect(edgesOf(graph.edges, 'GRAPHQL_CALLS').map(brief)).toEqual([
      'GRAPHQL_CALLS shop-web#requestCancel -> shop-api#OrderResolver.cancelOrder [high] mutation CancelOrder → cancelOrder',
    ]);
    expect(
      unresolved
        .filter((item) => item.relation === 'GRAPHQL_CALLS')
        .map((item) => `${item.reason} ${item.value}`),
    ).toEqual(['no-provider mutation CancelOrder → refundPoints']);
    // 필드 리졸버는 받는 쪽 계약으로 세지 않는다
    expect(graph.coverage?.providerContracts).toBe(1);
  });

  it('스키마 힌트가 없으면 다른 저장소 전부에서 찾아 medium 이고, 경로 범위 밖 리졸버는 보지 않는다', () => {
    const detections = [
      resolver(
        RESOLVER,
        'OrderResolver.cancelOrder',
        'mutation',
        'cancelOrder',
      ),
      resolver(
        'src/admin/order.resolver.ts',
        'AdminOrderResolver.order',
        'mutation',
        'cancelOrder',
      ),
      documentOf(['cancelOrder']),
      clientCall(),
    ];
    const open = buildCrossRepositoryGraph(
      linkState({
        symbols: { 'shop-api': graphqlApi(), 'shop-web': graphqlWeb() },
        detections,
      }),
    );
    expect(edgesOf(open.graph.edges, 'GRAPHQL_CALLS')).toEqual([]);
    expect(
      open.unresolved.find((item) => item.relation === 'GRAPHQL_CALLS'),
    ).toMatchObject({ reason: 'ambiguous-provider' });

    const scoped = buildCrossRepositoryGraph(
      linkState({
        symbols: { 'shop-api': graphqlApi(), 'shop-web': graphqlWeb() },
        detections: [
          ...detections.slice(0, 2),
          documentOf(['cancelOrder'], 'shop'),
          clientCall(),
        ],
        hints: {
          graphqlSchemas: {
            shop: { repository: 'shop-api', paths: ['src/graphql/**'] },
          },
        },
      }),
    );
    expect(edgesOf(scoped.graph.edges, 'GRAPHQL_CALLS').map(brief)).toEqual([
      'GRAPHQL_CALLS shop-web#requestCancel -> shop-api#OrderResolver.cancelOrder [high] mutation CancelOrder → cancelOrder',
    ]);

    const unhinted = buildCrossRepositoryGraph(
      linkState({
        symbols: { 'shop-api': graphqlApi(), 'shop-web': graphqlWeb() },
        detections: [detections[0], documentOf(['cancelOrder']), clientCall()],
      }),
    );
    expect(unhinted.graph.edges[0].confidence).toBe('medium');
  });

  it('연산 문서가 없거나 뜻이 다른 문서가 여럿이면 연산 이름으로 못 이은 항목을 남긴다', () => {
    const state = linkState({
      symbols: {
        'shop-api': graphqlApi(),
        'shop-web': [
          ...graphqlWeb(),
          sym('src/legacy/cancel-order.graphql', 'CancelOrder', 'schema', 1),
        ],
      },
      detections: [
        resolver(
          RESOLVER,
          'OrderResolver.cancelOrder',
          'mutation',
          'cancelOrder',
        ),
        documentOf(['cancelOrder']),
        documentOf(
          ['cancelOrderV2'],
          undefined,
          'src/legacy/cancel-order.graphql',
        ),
        clientCall(),
        clientCall('TrackParcel'),
      ],
    });
    const { unresolved } = buildCrossRepositoryGraph(state);
    expect(
      unresolved
        .filter(
          (item) =>
            item.relation === 'GRAPHQL_CALLS' && item.repository === 'shop-web',
        )
        .map(
          (item) =>
            `${item.reason} ${item.value} ${item.candidates?.length ?? 0}`,
        ),
    ).toEqual([
      'ambiguous-provider CancelOrder 2',
      'no-provider TrackParcel 0',
    ]);
  });
});

describe('큐·이벤트', () => {
  const WORKER = 'shop_worker/tasks.py';
  const publish = (
    repository: string,
    filePath: string,
    symbol: string,
    name: string,
    kind = 'queue-publish',
    dynamic = false,
  ) =>
    det(repository, filePath, symbol, 20, {
      kind,
      name,
      dynamic,
    } as DetectionFields);
  const workerSymbols = (): ExtractedSymbol[] => [
    sym(WORKER, 'handle_order_placed', 'function', 3, {
      executionFacts: [fact('throws', 6, 'StockMissing()')],
    }),
    sym(WORKER, 'handle_review', 'function', 30),
  ];

  it('구독자가 다른 저장소에 하나면 발행 → 구독 PUBLISHES_TO_QUEUE 로, 이름 표기가 달라도 정규화해 잇는다', () => {
    const state = linkState({
      symbols: { 'shop-api': apiSymbols(), 'shop-worker': workerSymbols() },
      detections: [
        publish('shop-api', SERVICE, 'OrderService.cancel', 'ORDER_PLACED'),
        publish(
          'shop-worker',
          WORKER,
          'handle_order_placed',
          'orderPlaced',
          'queue-consume',
        ),
      ],
    });
    const { graph } = buildCrossRepositoryGraph(state);
    const [edge] = edgesOf(graph.edges, 'PUBLISHES_TO_QUEUE');
    expect(brief(edge)).toBe(
      'PUBLISHES_TO_QUEUE shop-api#OrderService.cancel -> shop-worker#handle_order_placed [medium] order-placed',
    );
    expect(edge.extraction.kind).toBe('queue');
    expect(edge.handlerExceptions?.map((item) => item.subject)).toEqual([
      'StockMissing()',
    ]);
    expect(edge.callerConditions?.map((item) => item.subject)).toEqual([
      'order.shippedAt !== null',
    ]);
  });

  it('구독자가 여러 저장소에 있으면 발행자가 하나뿐인 구독자마다 구독 → 발행 CONSUMES_FROM_QUEUE 로 잇는다', () => {
    const state = linkState({
      symbols: {
        'shop-api': apiSymbols(),
        'shop-web': webSymbols(),
        'shop-worker': workerSymbols(),
      },
      detections: [
        publish('shop-api', SERVICE, 'OrderService.cancel', 'order-placed'),
        publish(
          'shop-web',
          'src/order/status.ts',
          'loadStatus',
          'order-placed',
          'queue-consume',
        ),
        publish(
          'shop-worker',
          WORKER,
          'handle_order_placed',
          'order-placed',
          'queue-consume',
        ),
      ],
    });
    const { graph, unresolved } = buildCrossRepositoryGraph(state);
    expect(edgesOf(graph.edges, 'CONSUMES_FROM_QUEUE').map(brief)).toEqual([
      'CONSUMES_FROM_QUEUE shop-web#loadStatus -> shop-api#OrderService.cancel [medium] order-placed',
      'CONSUMES_FROM_QUEUE shop-worker#handle_order_placed -> shop-api#OrderService.cancel [medium] order-placed',
    ]);
    // 방향과 상관없이 처리하는 쪽(구독자)의 예외를 단다
    expect(
      edgesOf(graph.edges, 'CONSUMES_FROM_QUEUE')[1].handlerExceptions,
    ).toHaveLength(1);
    expect(edgesOf(graph.edges, 'PUBLISHES_TO_QUEUE')).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  it('발행자와 구독자가 모두 여럿이면 잇지 않고 후보와 함께 ambiguous-provider 로 남긴다', () => {
    const state = linkState({
      repositories: [...REPOSITORIES, 'shop-admin'],
      symbols: {
        'shop-admin': [
          sym('src/orders/sync.ts', 'syncPlacedOrder', 'function', 2),
        ],
        'shop-api': apiSymbols(),
        'shop-web': webSymbols(),
        'shop-worker': workerSymbols(),
      },
      detections: [
        publish('shop-api', SERVICE, 'OrderService.cancel', 'order-placed'),
        publish(
          'shop-web',
          'src/order/status.ts',
          'loadStatus',
          'order-placed',
        ),
        publish(
          'shop-admin',
          'src/orders/sync.ts',
          'syncPlacedOrder',
          'order-placed',
          'queue-consume',
        ),
        publish(
          'shop-worker',
          WORKER,
          'handle_order_placed',
          'order-placed',
          'queue-consume',
        ),
      ],
    });
    const { graph, unresolved } = buildCrossRepositoryGraph(state);
    expect(graph.edges).toEqual([]);
    const candidates = `shop-admin:src/orders/sync.ts#syncPlacedOrder,shop-worker:${WORKER}#handle_order_placed`;
    expect(
      unresolved.map(
        (item) =>
          `${item.repository} ${item.reason} ${item.candidates?.join(',')}`,
      ),
    ).toEqual([
      `shop-api ambiguous-provider ${candidates}`,
      `shop-web ambiguous-provider ${candidates}`,
    ]);
  });

  it('일반 낱말 하나뿐인 이름은 잇지 않고, 동적 이름·구독자 없음·발행자 없음을 까닭과 함께 남긴다', () => {
    const state = linkState({
      symbols: { 'shop-api': apiSymbols(), 'shop-worker': workerSymbols() },
      detections: [
        publish('shop-api', SERVICE, 'OrderService.cancel', 'JOBS'),
        publish(
          'shop-worker',
          WORKER,
          'handle_order_placed',
          'jobs',
          'queue-consume',
        ),
        publish(
          'shop-api',
          CONTROLLER,
          'OrderController.cancel',
          'queueFor(order)',
          'queue-publish',
          true,
        ),
        publish('shop-api', 'src/main.ts', 'healthCheck', 'parcel-shipped'),
        publish(
          'shop-worker',
          WORKER,
          'handle_review',
          'review-posted',
          'queue-consume',
        ),
      ],
    });
    const { graph, unresolved } = buildCrossRepositoryGraph(state);
    expect(graph.edges).toEqual([]);
    expect(
      unresolved.map((item) => `${item.relation} ${item.reason} ${item.value}`),
    ).toEqual([
      'PUBLISHES_TO_QUEUE no-provider parcel-shipped',
      'PUBLISHES_TO_QUEUE dynamic-target queueFor(order)',
      'PUBLISHES_TO_QUEUE ambiguous-provider jobs',
      'CONSUMES_FROM_QUEUE no-caller review-posted',
    ]);
  });

  it('이벤트도 같은 규칙으로 PUBLISHES_EVENT 를 잇고, 같은 저장소 안 짝은 토폴로지에 맡긴다', () => {
    const state = linkState({
      symbols: { 'shop-api': apiSymbols(), 'shop-worker': workerSymbols() },
      detections: [
        publish(
          'shop-api',
          SERVICE,
          'OrderService.cancel',
          'order.cancelled',
          'event-publish',
        ),
        publish(
          'shop-api',
          'src/points/point-ledger.ts',
          'PointLedger.restore',
          'order.cancelled',
          'event-handle',
        ),
        publish(
          'shop-worker',
          WORKER,
          'handle_review',
          'OrderCancelled',
          'event-handle',
        ),
      ],
    });
    const { graph, unresolved } = buildCrossRepositoryGraph(state);
    expect(graph.edges.map(brief)).toEqual([
      'PUBLISHES_EVENT shop-api#OrderService.cancel -> shop-worker#handle_review [medium] order-cancelled',
    ]);
    expect(graph.edges[0].extraction.kind).toBe('event');
    expect(unresolved).toEqual([]);
  });

  it('예약 작업이 저장소 안 호출을 따라 저장소 간 호출에 닿으면 CRON_TRIGGERS 로 잇는다', () => {
    const JOB = 'src/jobs/settle.job.ts';
    const state = linkState({
      symbols: {
        'shop-api': apiSymbols(),
        'shop-web': [
          ...webSymbols(),
          sym(JOB, 'settleDaily', 'function', 2, {
            relations: calls('shop-web', 'syncOrders'),
          }),
          sym(JOB, 'syncOrders', 'function', 10),
          sym(JOB, 'pingNow', 'function', 20),
        ],
      },
      detections: [
        cancelRoute(),
        det('shop-web', JOB, 'settleDaily', 1, {
          kind: 'schedule',
          expression: '0 4 * * *',
        }),
        det('shop-web', JOB, 'pingNow', 19, {
          kind: 'schedule',
          expression: '*/5 * * * *',
        }),
        det('shop-web', JOB, 'syncOrders', 11, {
          kind: 'http-call',
          method: 'POST',
          path: '/orders/:param/cancel',
          baseIdentifiers: ['SHOP_API_URL'],
          dynamic: false,
        }),
        det('shop-web', JOB, 'pingNow', 21, {
          kind: 'http-call',
          method: 'POST',
          path: '/orders/:param/cancel',
          baseIdentifiers: ['SHOP_API_URL'],
          dynamic: false,
        }),
      ],
      hints: { baseUrls: { SHOP_API_URL: 'shop-api' } },
    });
    const { graph } = buildCrossRepositoryGraph(state);
    expect(edgesOf(graph.edges, 'CRON_TRIGGERS').map(brief)).toEqual([
      'CRON_TRIGGERS shop-web#settleDaily -> shop-api#OrderController.cancel [medium] 0 4 * * * → HTTP_CALLS POST /orders/:param/cancel',
      'CRON_TRIGGERS shop-web#pingNow -> shop-api#OrderController.cancel [high] */5 * * * * → HTTP_CALLS POST /orders/:param/cancel',
    ]);
    expect(edgesOf(graph.edges, 'CRON_TRIGGERS')[0].evidence).toContain(
      'settleDaily reaches syncOrders in 1 call(s)',
    );
  });
});

describe('DEPENDS_ON_PACKAGE', () => {
  const SHARED = 'src/money/format.ts';
  const sharedApi = (): ExtractedSymbol[] => [
    ...apiSymbols(),
    sym(SHARED, 'formatWon', 'function', 1),
    sym('src/coupon/rules.ts', 'applyCoupon', 'function', 1),
    sym('src/coupon/legacy.ts', 'applyCoupon', 'function', 1),
    sym('src/index.ts', '<module>', 'module', 1),
  ];

  it('가져온 이름이 내는 저장소에 하나면 그 심볼(high), 아니면 진입 파일 모듈(medium), 둘 다 없으면 까닭을 남긴다', () => {
    const state = linkState({
      symbols: {
        'shop-api': sharedApi(),
        'shop-web': [
          sym('src/cart/total.ts', 'cartTotal', 'function', 3, {
            relations: [
              ...imports(
                'shop-web',
                'formatWon from @dotori/shared',
                'applyCoupon from @dotori/shared/coupon',
                '* as shared from @dotori/shared',
                'unknownThing from @dotori/shared',
                'debounce from lodash',
              ),
            ],
          }),
        ],
      },
      detections: [],
      hints: { packages: { '@dotori': 'shop-api' } },
    });
    const { graph, unresolved } = buildCrossRepositoryGraph(state);
    expect(edgesOf(graph.edges, 'DEPENDS_ON_PACKAGE').map(brief)).toEqual([
      'DEPENDS_ON_PACKAGE shop-web#cartTotal -> shop-api#<module> [medium] @dotori/shared',
      'DEPENDS_ON_PACKAGE shop-web#cartTotal -> shop-api#<module> [medium] @dotori/shared#unknownThing',
      'DEPENDS_ON_PACKAGE shop-web#cartTotal -> shop-api#formatWon [high] @dotori/shared#formatWon',
    ]);
    expect(
      unresolved.map(
        (item) => `${item.reason} ${item.value} ${item.candidates?.length}`,
      ),
    ).toEqual(['ambiguous-provider @dotori/shared#applyCoupon 2']);
    expect(graph.edges.every((edge) => edge.handlerChain === undefined)).toBe(
      true,
    );
  });

  it('진입 파일이 없으면 no-provider 로 남긴다', () => {
    const state = linkState({
      symbols: {
        'shop-api': apiSymbols(),
        'shop-web': [
          sym('src/cart/total.ts', 'cartTotal', 'function', 3, {
            relations: imports(
              'shop-web',
              'default as money from @dotori/shared',
            ),
          }),
        ],
      },
      detections: [],
      hints: { packages: { '@dotori/shared': 'shop-api' } },
    });
    expect(buildCrossRepositoryGraph(state).unresolved).toEqual([
      {
        reason: 'no-provider',
        relation: 'DEPENDS_ON_PACKAGE',
        repository: 'shop-web',
        filePath: 'src/cart/total.ts',
        symbol: 'cartTotal',
        line: 3,
        value: '@dotori/shared',
      },
    ]);
  });
});

describe('SHARES_ENTITY·SHARES_CACHE_KEY', () => {
  it('같은 이름(대소문자 무시)·같은 엔티티 클래스의 테이블과 캐시 키를 쓰는 저장소를 이름 순으로 이웃끼리만 medium 으로 잇는다', () => {
    const access = (
      repository: string,
      filePath: string,
      symbol: string,
      target: string,
      kind = 'entity-read',
      targetType = kind.startsWith('cache') ? 'key' : 'table',
    ) =>
      det(repository, filePath, symbol, 5, {
        kind,
        target,
        targetType,
      } as DetectionFields);
    const state = linkState({
      symbols: {
        'shop-api': [
          ...apiSymbols(),
          sym('src/order/order.entity.ts', 'Order', 'entity', 1),
        ],
        'shop-web': webSymbols(),
        'shop-worker': [
          sym('shop_worker/tasks.py', 'handle_review', 'function', 3),
        ],
      },
      detections: [
        det('shop-api', 'src/order/order.entity.ts', 'Order', 2, {
          kind: 'entity-declaration',
          table: 'orders',
          className: 'Order',
          columns: [],
          relations: [],
        }),
        access(
          'shop-api',
          SERVICE,
          'OrderService.cancel',
          'orders',
          'entity-write',
        ),
        access('shop-web', 'src/order/status.ts', 'loadStatus', 'Orders'),
        access(
          'shop-worker',
          'shop_worker/tasks.py',
          'handle_review',
          'Order',
          'entity-read',
          'class',
        ),
        access(
          'shop-api',
          SERVICE,
          'OrderService.cancel',
          'cart:summary',
          'cache-write',
        ),
        access(
          'shop-web',
          'src/order/status.ts',
          'loadStatus',
          'cart:summary',
          'cache-read',
        ),
      ],
    });
    const { graph } = buildCrossRepositoryGraph(state);
    expect(graph.edges.map(brief)).toEqual([
      'SHARES_CACHE_KEY shop-api#OrderService.cancel -> shop-web#loadStatus [medium] cart:summary',
      'SHARES_ENTITY shop-api#Order -> shop-web#loadStatus [medium] orders',
      'SHARES_ENTITY shop-web#loadStatus -> shop-worker#handle_review [medium] orders',
    ]);
    expect(graph.edges[1].evidence).toContain(
      'shop-api: 0 read(s), 1 write(s)',
    );
    expect(
      graph.edges.every((edge) => edge.callerConditions === undefined),
    ).toBe(true);
  });
});

describe('수동 연결', () => {
  const state = () =>
    linkState({
      symbols: { 'shop-api': apiSymbols(), 'shop-web': webSymbols() },
      detections: [cancelRoute()],
    });
  const link = {
    relation: 'HTTP_CALLS' as const,
    from: {
      repository: 'shop-web',
      filePath: 'src/order/status.ts',
      symbol: 'loadStatus',
    },
    to: {
      repository: 'shop-api',
      filePath: CONTROLLER,
      symbol: 'OrderController.cancel',
    },
    evidence:
      'the cancel address comes from runtime settings but always targets this route',
    author: 'agent',
  };

  it('양 끝이 있으면 manual·high 간선으로 넣고 받는 쪽 계약을 이은 것으로 센다', () => {
    const { graph, unresolved } = buildCrossRepositoryGraph(state(), {
      manualLinks: { file: 'graph.links.json', links: [link] },
    });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      relation: 'HTTP_CALLS',
      confidence: 'high',
      extraction: {
        kind: 'manual',
        locator: 'graph.links.json[0]',
        value: 'loadStatus → OrderController.cancel',
      },
      evidence: [link.evidence, 'written by agent'],
    });
    expect(graph.edges[0].handlerChain).toHaveLength(2);
    expect(graph.coverage?.linkedProviderContracts).toBe(1);
    expect(unresolved).toEqual([]);
  });

  it('끝 심볼이나 저장소가 없으면 파일·순번·까닭을 밝혀 멈춘다', () => {
    const missing = {
      ...link,
      to: { ...link.to, symbol: 'OrderController.refund' },
    };
    expect(() =>
      buildCrossRepositoryGraph(state(), {
        manualLinks: { file: 'graph.links.json', links: [link, missing] },
      }),
    ).toThrow(
      new ManualLinkError(
        'graph.links.json',
        1,
        `to shop-api ${CONTROLLER} OrderController.refund is not a symbol in the graph`,
      ),
    );
    const elsewhere = {
      ...link,
      from: { ...link.from, repository: 'shop-admin' },
    };
    expect(() =>
      buildCrossRepositoryGraph(state(), {
        manualLinks: { file: 'graph.links.json', links: [elsewhere] },
      }),
    ).toThrow(
      'graph.links.json[0]: from repository shop-admin is not in the graph',
    );
  });
});

describe('coverage·보고서·결정성', () => {
  const symbols = (): Symbols => ({
    'shop-api': [
      ...apiSymbols(),
      sym(
        'src/coupon/coupon.controller.ts',
        'CouponController.find',
        'method',
        4,
      ),
    ],
    'shop-web': webSymbols(),
  });
  const detections = (): Detection[] => [
    cancelRoute(),
    det(
      'shop-api',
      'src/coupon/coupon.controller.ts',
      'CouponController.find',
      3,
      {
        kind: 'http-route',
        method: 'GET',
        path: '/coupons/:param',
      },
    ),
    det('shop-api', 'src/main.ts', 'healthCheck', 2, {
      kind: 'http-route',
      method: 'GET',
      path: '/health',
    }),
    webCall(),
    webCall({ path: undefined, dynamic: true }, 9),
  ];

  it('받는 쪽 계약은 처리 심볼 집합이고 못 이은 수는 정확한 차집합이며, 남은 계약은 no-caller 로 남긴다', () => {
    const { graph, unresolved } = buildCrossRepositoryGraph(
      linkState({ symbols: symbols(), detections: detections() }),
    );
    expect(graph.coverage).toEqual({
      status: 'fail',
      expectedRepositories: ['shop-api', 'shop-web', 'shop-worker'],
      auditedRepositories: ['shop-api', 'shop-web'],
      relationCounts: { HTTP_CALLS: 1 },
      providerContracts: 3,
      linkedProviderContracts: 1,
      unresolvedProviderContracts: 2,
    });
    expect(
      unresolved
        .filter((item) => item.reason === 'no-caller')
        .map((item) => `${item.symbol} ${item.value}`),
    ).toEqual([
      'CouponController.find GET /coupons/:param',
      'healthCheck GET /health',
    ]);
  });

  it('못 이은 비율이 maxUnresolvedRatio 를 넘으면 fail, 넘지 않으면 pass', () => {
    const run = (ratio: number) =>
      buildCrossRepositoryGraph(
        linkState({
          symbols: symbols(),
          detections: detections(),
          repositories: ['shop-api', 'shop-web'],
          maxUnresolvedRatio: ratio,
        }),
      ).graph.coverage?.status;
    expect(run(0.5)).toBe('fail');
    expect(run(0.7)).toBe('pass');
  });

  it('보고서에 관계·까닭·탐지기별 수, 추출 실패, 못 이은 항목을 담는다', () => {
    const state = linkState({ symbols: symbols(), detections: detections() });
    const built = buildCrossRepositoryGraph(state);
    state.artifacts.set('cross-repository.json', built.graph);
    const report = buildGraphReport(state, built.unresolved);
    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-11-03T09:30:00.000Z',
      unresolvedRatio: 0.6667,
      relations: { HTTP_CALLS: 1 },
      reasons: { 'dynamic-target': 1, 'no-caller': 2 },
      detectors: { acorn: { 'http-call': 2, 'http-route': 3 } },
      extractionFailures: [
        {
          repository: 'shop-web',
          filePath: 'src/legacy/broken.ts',
          message: 'cannot parse',
        },
      ],
    });
    expect(report.unresolved).toEqual(built.unresolved);
    expect(report.coverage).toBe(built.graph.coverage);
    expect(() =>
      buildGraphReport(linkState({ symbols: {}, detections: [] }), []),
    ).toThrow('cross-repository.json must be built before the report');
  });

  it('탐지·레코드 순서를 섞어도 결과는 바이트 단위로 같다', () => {
    const state = linkState({ symbols: symbols(), detections: detections() });
    const first = JSON.stringify(buildCrossRepositoryGraph(state));
    const shuffled: GraphBuildState = {
      ...state,
      records: [...state.records].reverse(),
      detections: new Map(
        [...state.detections.entries()]
          .reverse()
          .map(([name, list]) => [name, [...list].reverse()]),
      ),
    };
    expect(JSON.stringify(buildCrossRepositoryGraph(shuffled))).toBe(first);
    expect(JSON.stringify(buildCrossRepositoryGraph(state))).toBe(first);
  });
});
