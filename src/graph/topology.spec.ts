import { describe, expect, it } from 'vitest';
import type {
  SystemTopologyGraph,
  TopologyEdgeType,
} from '../extensions/code-knowledge.js';
import { parseGraphConfig } from './config.js';
import { repositoryReceivers } from './detect.js';
import { buildRepositoryRecords } from './records.js';
import { buildSystemTopology, normalizeMessageName } from './topology.js';
import type {
  ClassMember,
  Detection,
  DetectionBase,
  ExtractedSymbol,
  GraphBuildState,
  RepositoryBuild,
} from './types.js';

const config = parseGraphConfig(
  {
    repositories: [
      { name: 'shop-api', url: 'https://example.com/shop-api.git' },
      {
        name: 'shop-worker',
        url: 'https://example.com/shop-worker.git',
        exclude: ['scripts/**'],
      },
    ],
    hints: {
      external: ['https://payments.example.com'],
      baseUrls: { SHOP_API_URL: 'shop-api' },
    },
  },
  '/work/dotori',
);

const COMMITS = {
  'shop-api': ['a'.repeat(40), '2026-11-03T10:00:00.000Z'],
  'shop-worker': ['b'.repeat(40), '2026-11-07T08:30:00.000Z'],
} as const;

const calls = (...targets: string[]) =>
  targets.map((symbol) => ({
    type: 'CALLS',
    target: { repository: 'shop-api', symbol },
  }));
const imports = (...targets: string[]) =>
  targets.map((symbol) => ({
    type: 'IMPORTS',
    target: { repository: 'shop-api', symbol },
  }));
const injects = (...targets: string[]) =>
  targets.map((symbol) => ({
    type: 'INJECTS',
    target: { repository: 'shop-api', symbol },
  }));

function symbol(
  filePath: string,
  name: string,
  kind: string,
  lineStart: number,
  extra: Partial<ExtractedSymbol> = {},
): ExtractedSymbol {
  return {
    filePath,
    language: filePath.endsWith('.py') ? 'python' : 'typescript',
    symbol: name,
    kind,
    content: `// ${name}`,
    lineStart,
    lineEnd: lineStart + 3,
    relations: [],
    ...extra,
  };
}

const member = (name: string, type?: string): ClassMember => ({
  name,
  ...(type ? { type } : {}),
  line: 4,
  parameter: true,
  decorators: [],
});

/** 도토리 마켓 shop-api 의 추출 심볼 */
const apiSymbols = (): ExtractedSymbol[] => [
  symbol('src/main.ts', '<module>', 'module', 3, {
    relations: calls('bootstrap'),
  }),
  symbol('src/main.ts', 'bootstrap', 'function', 8),
  symbol('src/money.ts', 'toWon', 'function', 1),
  symbol('src/money.ts', 'round', 'function', 5),
  symbol('src/notify.ts', 'notify', 'function', 1),
  symbol('src/notify/index.ts', 'notify', 'function', 1),
  symbol('src/order/order.controller.ts', 'OrderController', 'controller', 6, {
    lineEnd: 40,
    members: [member('orders', 'OrderService'), member('clock')],
    relations: injects('OrderService'),
  }),
  symbol(
    'src/order/order.controller.ts',
    'OrderController.cancel',
    'method',
    12,
    {
      relations: [
        ...imports('toWon from ../money', '* as money from ../money'),
        ...imports('notify from ../notify'),
        ...calls(
          'this.orders.cancel',
          'this.audit',
          'formatReceipt',
          'toWon',
          'money.round',
          'notify',
          'this.clock.now',
          'console.log',
          'this.orders.find().then',
        ),
      ],
      executionFacts: [
        { line: 14, kind: 'calls', subject: 'this.orders.cancel' },
      ],
    },
  ),
  symbol(
    'src/order/order.controller.ts',
    'OrderController.audit',
    'method',
    30,
  ),
  symbol('src/order/order.controller.ts', 'formatReceipt', 'function', 44),
  symbol('src/order/order.entity.ts', 'Order', 'entity', 3),
  symbol('src/order/order-status.ts', 'OrderStatus', 'enum', 1),
  symbol('src/order/order.service.ts', 'OrderService', 'class', 5),
  symbol('src/order/order.service.ts', 'OrderService.cancel', 'method', 9),
  symbol('src/order/legacy.ts', 'LegacyOrders', 'class', 2, {
    relations: injects('OrderService', 'Repository<Order>'),
  }),
  symbol('src/order/legacy.ts', 'LegacyOrders.sync', 'method', 7, {
    relations: calls('self.order_service.cancel', 'this.ledger.cancel'),
  }),
  symbol('src/refund/refund.controller.ts', 'RefundController', 'class', 1, {
    members: [member('refunds', 'RefundService')],
  }),
  symbol(
    'src/refund/refund.controller.ts',
    'RefundController.approve',
    'method',
    5,
    { relations: calls('this.refunds.approve') },
  ),
  symbol(
    'src/refund/a/refund.service.ts',
    'RefundService.approve',
    'method',
    3,
  ),
  symbol(
    'src/refund/b/refund.service.ts',
    'RefundService.approve',
    'method',
    3,
  ),
];

const base = (
  filePath: string,
  name: string,
  line: number,
  confidence = 0.9,
): DetectionBase => ({
  repository: 'shop-api',
  filePath,
  symbol: name,
  line,
  detector: 'acorn',
  confidence,
  evidence: `${name} line ${line}`,
});

const CONTROLLER = 'src/order/order.controller.ts';
const SERVICE = 'src/order/order.service.ts';
const LEGACY = 'src/order/legacy.ts';

const apiDetections = (): Detection[] => [
  {
    ...base('src/main.ts', '<module>', 4, 0.8),
    kind: 'http-route',
    method: 'GET',
    path: '/health',
  },
  {
    ...base(CONTROLLER, 'OrderController.cancel', 11, 0.95),
    kind: 'http-route',
    method: 'post',
    path: '/orders/:id/cancel',
  },
  {
    ...base(CONTROLLER, 'OrderController.cancel', 11),
    kind: 'graphql-resolver',
    operationType: 'mutation',
    field: 'cancelOrder',
  },
  {
    ...base(SERVICE, 'OrderService.cancel', 10),
    kind: 'queue-publish',
    name: 'orderCancelled',
    dynamic: false,
  },
  {
    ...base(LEGACY, 'LegacyOrders.sync', 6, 0.85),
    kind: 'queue-consume',
    name: 'ORDER_CANCELLED',
    dynamic: false,
  },
  {
    ...base(SERVICE, 'OrderService.cancel', 11, 0.4),
    kind: 'queue-publish',
    name: 'queueFor(order)',
    dynamic: true,
  },
  {
    ...base(SERVICE, 'OrderService.cancel', 12),
    kind: 'event-publish',
    name: 'order.cancelled',
    dynamic: false,
  },
  {
    ...base(LEGACY, 'LegacyOrders.sync', 6),
    kind: 'event-handle',
    name: 'order.cancelled',
    dynamic: false,
  },
  {
    ...base(LEGACY, 'LegacyOrders.sync', 6, 0.98),
    kind: 'schedule',
    expression: '0 3 * * *',
  },
  {
    ...base('src/order/order.entity.ts', 'Order', 3, 0.97),
    kind: 'entity-declaration',
    table: 'orders',
    className: 'Order',
    columns: [
      { name: 'status', enumName: 'OrderStatus' },
      { name: 'memo', dataType: 'text' },
    ],
    relations: [],
  },
  {
    ...base(SERVICE, 'OrderService.cancel', 13),
    kind: 'entity-write',
    target: 'Order',
    targetType: 'class',
  },
  {
    ...base(CONTROLLER, 'OrderController.cancel', 15),
    kind: 'entity-read',
    target: 'orders',
    targetType: 'table',
  },
  {
    ...base(SERVICE, 'OrderService.cancel', 14),
    kind: 'cache-write',
    target: 'order:summary',
    targetType: 'key',
  },
  {
    ...base(CONTROLLER, 'OrderController.cancel', 16),
    kind: 'cache-read',
    target: 'order:summary',
    targetType: 'key',
  },
  {
    ...base(SERVICE, 'OrderService.cancel', 15),
    kind: 'http-call',
    method: 'POST',
    path: '/v1/refunds',
    baseIdentifiers: [],
    host: 'api.payments.example.com',
    dynamic: false,
  },
  {
    ...base(SERVICE, 'OrderService.cancel', 16, 0.6),
    kind: 'http-call',
    method: 'GET',
    path: '/geo',
    baseIdentifiers: [],
    host: 'maps.example.org',
    dynamic: false,
  },
  {
    ...base(SERVICE, 'OrderService.cancel', 17),
    kind: 'http-call',
    method: 'GET',
    path: '/ping',
    baseIdentifiers: [],
    host: 'localhost',
    dynamic: false,
  },
  {
    ...base(SERVICE, 'OrderService.cancel', 18),
    kind: 'http-call',
    method: 'GET',
    path: '/points',
    baseIdentifiers: ['process.env.SHOP_API_URL'],
    host: 'shop-api.internal',
    dynamic: false,
  },
  {
    ...base(CONTROLLER, 'OrderController.cancel', 17),
    kind: 'graphql-client-call',
    operationName: 'CancelOrder',
  },
];

const workerSymbols = (): ExtractedSymbol[] => [
  symbol('shop_worker/review.py', 'on_review_posted', 'function', 4),
];

const workerDetections = (): Detection[] => [
  {
    ...base('shop_worker/review.py', 'on_review_posted', 3),
    repository: 'shop-worker',
    kind: 'queue-consume',
    name: 'review-posted',
    dynamic: false,
  },
];

function freshBuild(
  name: keyof typeof COMMITS,
  extracted: ExtractedSymbol[],
): RepositoryBuild {
  const [commitSha, committedAt] = COMMITS[name];
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
      inputFingerprint: 'sha256:0',
      symbolsFile: `symbols/${name}.jsonl`,
      symbolCount: records.length,
      fileCount: 0,
      skippedFiles: {
        floor: 0,
        defaultExcludes: 0,
        exclude: 0,
        notIncluded: 0,
        unsupported: 0,
        binary: 0,
        tooLarge: 0,
      },
      failures: [],
    },
    records,
    extracted,
  };
}

function topologyOf(
  api = apiSymbols(),
  detections = apiDetections(),
): SystemTopologyGraph {
  const state: GraphBuildState = {
    config,
    repositories: [
      freshBuild('shop-worker', workerSymbols()),
      freshBuild('shop-api', api),
    ],
    records: [],
    detections: new Map(),
    artifacts: new Map(),
  };
  return buildSystemTopology(
    state,
    new Map([
      ['shop-api', detections],
      ['shop-worker', workerDetections()],
    ]),
    { extractors: ['typescript', 'python'], presets: ['acorn', 'acorn'] },
  );
}

const sym = (filePath: string, name: string) =>
  `symbol:shop-api:${filePath}#${name}`;

function edgesOf(graph: SystemTopologyGraph, type: TopologyEdgeType) {
  return graph.edges
    .filter((edge) => edge.type === type)
    .map((edge) => `${edge.from} -> ${edge.to}`);
}

describe('buildSystemTopology: 구조', () => {
  const graph = topologyOf();

  it('저장소·파일·심볼 노드를 만들고, module 심볼은 노드 없이 파일 노드가 맡는다', () => {
    const types = Object.fromEntries(
      graph.nodes.map((node) => [node.id, node.type]),
    );
    expect(types['repository:shop-api']).toBe('Repository');
    expect(types['file:shop-api:src/main.ts']).toBe('File');
    expect(types[sym(CONTROLLER, 'OrderController')]).toBe('Class');
    expect(types[sym('src/order/order.entity.ts', 'Order')]).toBe('Class');
    expect(types[sym(CONTROLLER, 'OrderController.cancel')]).toBe('Function');
    expect(types[sym('src/order/order-status.ts', 'OrderStatus')]).toBe('Enum');
    expect(graph.nodes.some((node) => node.id.endsWith('#<module>'))).toBe(
      false,
    );
    expect(graph.nodes.filter((node) => node.name === '<module>')).toHaveLength(
      0,
    );
    expect(
      graph.nodes.find((node) => node.id === 'repository:shop-api'),
    ).toMatchObject({ commitSha: 'a'.repeat(40), confidence: 1 });

    const dependsOn = edgesOf(graph, 'DEPENDS_ON');
    expect(dependsOn).toContain(
      'repository:shop-api -> file:shop-api:src/main.ts',
    );
    expect(dependsOn).toContain(
      `file:shop-api:src/main.ts -> ${sym('src/main.ts', 'bootstrap')}`,
    );
    expect(
      graph.edges.find(
        (edge) =>
          edge.type === 'DEPENDS_ON' &&
          edge.to === sym('src/main.ts', 'bootstrap'),
      ),
    ).toMatchObject({ confidence: 1, lineStart: 8, lineEnd: 11 });
  });

  it('generatedAt·repositories·exclusions·sources·localGraphs 를 채운다', () => {
    expect(graph.generatedAt).toBe('2026-11-07T08:30:00.000Z');
    expect(graph.repositories).toEqual(['shop-api', 'shop-worker']);
    expect(graph.exclusions).toContain('.env*');
    expect(graph.exclusions).toContain('**/*.spec.*');
    expect(graph.exclusions).toContain('shop-worker:scripts/**');
    expect(graph.sources).toEqual([
      { kind: 'extractor:python' },
      { kind: 'extractor:typescript' },
      { kind: 'preset:acorn' },
    ]);
    for (const local of graph.localGraphs) {
      expect(
        local.nodeIds.every(
          (id) =>
            graph.nodes.find((node) => node.id === id)?.repository ===
            local.repository,
        ),
      ).toBe(true);
      expect(
        local.edgeIndexes.every(
          (index) => graph.edges[index].repository === local.repository,
        ),
      ).toBe(true);
    }
    const worker = graph.localGraphs.find(
      (local) => local.repository === 'shop-worker',
    );
    expect(worker?.nodeIds).toContain('queue:shop-worker:review-posted');
    expect(
      graph.localGraphs.reduce((sum, local) => sum + local.nodeIds.length, 0),
    ).toBe(graph.nodes.length);
    expect(
      graph.localGraphs.reduce(
        (sum, local) => sum + local.edgeIndexes.length,
        0,
      ),
    ).toBe(graph.edges.length);
  });
});

describe('buildSystemTopology: 저장소 안 호출', () => {
  const graph = topologyOf();
  const calls = edgesOf(graph, 'CALLS');
  const cancel = sym(CONTROLLER, 'OrderController.cancel');

  it('후보가 하나뿐인 호출만 잇는다: 같은 파일, 가져온 이름, 모듈 전체 가져오기, this 메서드', () => {
    expect(calls).toContain(`${cancel} -> ${sym(CONTROLLER, 'formatReceipt')}`);
    expect(calls).toContain(`${cancel} -> ${sym('src/money.ts', 'toWon')}`);
    expect(calls).toContain(`${cancel} -> ${sym('src/money.ts', 'round')}`);
    expect(calls).toContain(
      `${cancel} -> ${sym(CONTROLLER, 'OrderController.audit')}`,
    );
  });

  it('this.멤버.메서드 는 멤버 타입으로 잇고, 호출 줄을 실행 사실에서 찾는다', () => {
    const edge = graph.edges.find(
      (item) =>
        item.type === 'CALLS' &&
        item.from === cancel &&
        item.to === sym(SERVICE, 'OrderService.cancel'),
    );
    expect(edge).toMatchObject({
      confidence: 0.85,
      lineStart: 14,
      lineEnd: 14,
      evidence: [
        'this.orders.cancel → OrderService.cancel (orders: OrderService)',
      ],
    });
  });

  it('멤버 목록이 없는 클래스는 이름이 같은 주입 타입 하나로만 잇는다', () => {
    const sync = sym(LEGACY, 'LegacyOrders.sync');
    const fromSync = graph.edges.filter(
      (edge) => edge.type === 'CALLS' && edge.from === sync,
    );
    expect(fromSync.map((edge) => [edge.to, edge.confidence])).toEqual([
      [sym(SERVICE, 'OrderService.cancel'), 0.7],
    ]);
  });

  it('후보가 여럿이거나 없으면 버린다: 두 파일로 풀리는 모듈, 같은 이름 메서드 둘, 타입 없는 멤버, 바깥 이름', () => {
    expect(calls.some((edge) => edge.includes('#notify'))).toBe(false);
    expect(
      calls.some((edge) =>
        edge.startsWith(
          sym('src/refund/refund.controller.ts', 'RefundController.approve'),
        ),
      ),
    ).toBe(false);
    expect(
      calls.filter((edge) => edge.startsWith(`${cancel} ->`)),
    ).toHaveLength(5);
  });

  it('파일 최상위 문장의 호출은 파일 노드에서 나간다', () => {
    expect(calls).toContain(
      `file:shop-api:src/main.ts -> ${sym('src/main.ts', 'bootstrap')}`,
    );
  });
});

describe('buildSystemTopology: 탐지에서 그리는 노드와 간선', () => {
  const graph = topologyOf();
  const node = (id: string) => graph.nodes.find((item) => item.id === id);
  const cancel = sym(CONTROLLER, 'OrderController.cancel');
  const serviceCancel = sym(SERVICE, 'OrderService.cancel');
  const sync = sym(LEGACY, 'LegacyOrders.sync');

  it('API 와 GraphQL 루트 필드는 처리 심볼을 TRIGGERS 한다(module 의 라우트는 파일 노드)', () => {
    expect(node('api:shop-api:POST /orders/:id/cancel')).toMatchObject({
      type: 'API',
      name: 'POST /orders/:id/cancel',
      filePath: CONTROLLER,
      symbol: 'OrderController.cancel',
      lineStart: 11,
      confidence: 0.95,
      evidence: ['acorn: OrderController.cancel line 11'],
    });
    const triggers = edgesOf(graph, 'TRIGGERS');
    expect(triggers).toContain(
      `api:shop-api:POST /orders/:id/cancel -> ${cancel}`,
    );
    expect(triggers).toContain(
      'api:shop-api:GET /health -> file:shop-api:src/main.ts',
    );
    expect(node('graphql:shop-api:Mutation:cancelOrder')?.type).toBe(
      'GraphQLOperation',
    );
    expect(triggers).toContain(
      `graphql:shop-api:Mutation:cancelOrder -> ${cancel}`,
    );
  });

  it('큐 이름은 대소문자·구분자를 맞춰 한 노드로 모으고, 발행·구독·TRIGGERS 를 긋는다. 동적 이름은 노드를 만들지 않는다', () => {
    expect(node('queue:shop-api:order-cancelled')).toMatchObject({
      type: 'Queue',
      name: 'order-cancelled',
      aliases: ['ORDER_CANCELLED', 'orderCancelled'],
      confidence: 0.9,
    });
    expect(edgesOf(graph, 'PUBLISHES')).toEqual([
      `${serviceCancel} -> queue:shop-api:order-cancelled`,
    ]);
    expect(edgesOf(graph, 'CONSUMES')).toContain(
      `${sync} -> queue:shop-api:order-cancelled`,
    );
    expect(edgesOf(graph, 'TRIGGERS')).toContain(
      `queue:shop-api:order-cancelled -> ${sync}`,
    );
    expect(graph.nodes.filter((item) => item.type === 'Queue')).toHaveLength(2);
  });

  it('이벤트 발행·처리, 예약 작업', () => {
    expect(edgesOf(graph, 'PRODUCES_EVENT')).toEqual([
      `${serviceCancel} -> event:shop-api:order-cancelled`,
    ]);
    expect(edgesOf(graph, 'HANDLES_EVENT')).toEqual([
      `${sync} -> event:shop-api:order-cancelled`,
    ]);
    const scheduler = `scheduler:shop-api:${LEGACY}#LegacyOrders.sync:0 3 * * *`;
    expect(node(scheduler)).toMatchObject({
      type: 'Scheduler',
      name: '0 3 * * *',
      confidence: 0.98,
    });
    expect(edgesOf(graph, 'SCHEDULES')).toEqual([`${sync} -> ${scheduler}`]);
    expect(edgesOf(graph, 'TRIGGERS')).toContain(`${scheduler} -> ${sync}`);
    expect(edgesOf(graph, 'TRIGGERS')).toContain(
      `event:shop-api:order-cancelled -> ${sync}`,
    );
  });

  it('엔티티 클래스 이름과 테이블 이름을 한 테이블 노드로 묶어 읽기·쓰기를 긋고, 열거형 컬럼은 TYPES_COLUMN', () => {
    expect(node('table:shop-api:orders')).toMatchObject({
      type: 'DatabaseTable',
      name: 'orders',
      aliases: ['Order'],
      filePath: 'src/order/order.entity.ts',
    });
    expect(graph.nodes.some((item) => item.id === 'table:shop-api:Order')).toBe(
      false,
    );
    expect(edgesOf(graph, 'WRITES')).toContain(
      `${serviceCancel} -> table:shop-api:orders`,
    );
    expect(edgesOf(graph, 'READS')).toContain(
      `${cancel} -> table:shop-api:orders`,
    );
    expect(
      graph.edges.find((edge) => edge.type === 'TYPES_COLUMN'),
    ).toMatchObject({
      from: sym('src/order/order-status.ts', 'OrderStatus'),
      to: 'table:shop-api:orders',
      confidence: 0.97,
      evidence: ['acorn: column orders.status takes OrderStatus'],
    });
  });

  it('캐시 키 읽기·쓰기', () => {
    expect(node('cache:shop-api:order:summary')?.type).toBe('CacheKey');
    expect(edgesOf(graph, 'WRITES')).toContain(
      `${serviceCancel} -> cache:shop-api:order:summary`,
    );
    expect(edgesOf(graph, 'READS')).toContain(
      `${cancel} -> cache:shop-api:order:summary`,
    );
  });

  it('바깥 서비스는 hints.external 에 맞거나 주소에 적힌 바깥 호스트일 때만 만든다', () => {
    const external = graph.nodes
      .filter((item) => item.type === 'ExternalService')
      .map((item) => [item.name, item.confidence]);
    expect(external).toEqual([
      ['api.payments.example.com', 0.9],
      ['maps.example.org', 0.6],
    ]);
    expect(edgesOf(graph, 'DEPENDS_ON')).toContain(
      `${serviceCancel} -> external:shop-api:api.payments.example.com`,
    );
  });
});

describe('buildSystemTopology: 같은 입력 같은 출력', () => {
  it('레코드·탐지 순서가 달라도 바이트 단위로 같다', () => {
    const first = JSON.stringify(topologyOf());
    const shuffled = JSON.stringify(
      topologyOf([...apiSymbols()].reverse(), [...apiDetections()].reverse()),
    );
    expect(shuffled).toBe(first);
  });

  it('재사용한 저장소(추출 심볼 없음)도 남겨 둔 멤버 타입으로 같은 토폴로지를 만든다', () => {
    const fresh = freshBuild('shop-api', apiSymbols());
    const reused: RepositoryBuild = {
      snapshot: { ...fresh.snapshot, reused: true },
      manifest: fresh.manifest,
      records: fresh.records,
      previousDetections: {
        detections: apiDetections(),
        receivers: repositoryReceivers(fresh),
      },
    };
    const graphOf = (build: RepositoryBuild) =>
      JSON.stringify(
        buildSystemTopology(
          {
            config,
            repositories: [build],
            records: [],
            detections: new Map(),
            artifacts: new Map(),
          },
          new Map([['shop-api', apiDetections()]]),
        ),
      );
    expect(graphOf(reused)).toBe(graphOf(fresh));
    expect(graphOf(reused)).toContain(
      'OrderService.cancel (orders: OrderService)',
    );
  });
});

describe('normalizeMessageName', () => {
  it('대소문자·구분자만 맞추고, 주소면 마지막 경로 조각을 쓴다', () => {
    expect(normalizeMessageName('orderPlaced')).toBe('order-placed');
    expect(normalizeMessageName('ORDER_PLACED')).toBe('order-placed');
    expect(normalizeMessageName('order.placed')).toBe('order-placed');
    expect(normalizeMessageName('HTTPOrderEvents')).toBe('http-order-events');
    expect(
      normalizeMessageName('https://queue.example.com/1234/shop-orders'),
    ).toBe('shop-orders');
    expect(normalizeMessageName('  ')).toBe('');
  });
});
