// 저장소 안 시스템 토폴로지. 레코드에서 구조(저장소 → 파일 → 심볼)와 저장소 안 호출을, 탐지 결과에서 실행·데이터 흐름(라우트,
// GraphQL 루트 필드, 큐, 이벤트, 예약 작업, 테이블, 캐시 키, 바깥 서비스)을 그린다. 저장소 사이를 잇는 일은 연결 단계의 몫이다
// - 노드 id 는 저장소 이름과 저장소 기준 경로로만 만든다. 만든 컴퓨터의 절대 경로는 들어가지 않는다
// - 호출은 후보가 정확히 하나일 때만 잇고, 후보가 없거나 여럿이면 버린다(이름이 같다는 것만으로 잇지 않는다)
// - 같은 입력이면 같은 출력이 나오도록 노드는 id 순, 간선은 저장소·출발·종류·도착 순으로 놓는다
import type {
  CurrentSymbolRecord,
  SystemTopologyGraph,
  TopologyEdge,
  TopologyEdgeType,
  TopologyNode,
  TopologyNodeType,
} from '../extensions/code-knowledge.js';
import {
  DEFINING_DETECTIONS,
  GRAPH_FLOOR_EXCLUDES,
  GRAPH_SCHEMA_VERSION,
  GRAPHQL_ROOT_TYPES,
  LOOPBACK_HOSTS,
  TOPOLOGY_CALL_CONFIDENCE,
  TOPOLOGY_CLASS_KINDS,
  TOPOLOGY_MAX_EVIDENCE,
  TOPOLOGY_SELF_RECEIVERS,
  TOPOLOGY_STRUCTURE_CONFIDENCE,
} from './constants.js';
import { receiverTypeName, repositoryReceivers } from './detect.js';
import { MODULE_SYMBOL_KIND } from './extractors/constants.js';
import { compareText } from './files.js';
import { importedBinding, ModuleIndex } from './imports.js';
import { latestCommittedAt } from './output.js';
import type {
  CallResolution,
  Detection,
  GraphBuildState,
  GraphConfig,
  HttpCallDetection,
  RepositoryBuild,
  SystemTopologyOptions,
} from './types.js';

/** 받는 쪽 원문(`this.orderService.cancel`)이 이름과 점으로만 이어졌는지. 호출 결과·첨자·환경 변수를 거치면 풀지 않는다 */
const CALLEE_TEXT = /^[A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)*$/;

/**
 * 저장소 안 시스템 토폴로지를 만든다
 * - 구조: Repository·File 노드, 레코드마다 Class·Function·Enum 노드(module 심볼은 File 노드가 맡는다), 저장소 → 파일 → 심볼 DEPENDS_ON
 * - 호출: CALLS 관계의 원문을 같은 저장소의 심볼 하나로 풀 때만 CALLS 간선(resolveCall 주석)
 * - 탐지: 자원 노드와 간선. 심볼에서 자원으로 가는 동사 간선(PUBLISHES, CONSUMES, PRODUCES_EVENT, HANDLES_EVENT, READS, WRITES,
 *   SCHEDULES, 바깥 서비스는 DEPENDS_ON)과, 실행을 일으키는 자원에서 처리 심볼로 가는 TRIGGERS(API, GraphQL 루트 필드, 예약 작업,
 *   구독하는 큐, 처리하는 이벤트). 열거형이 컬럼 값 범위를 정하면 TYPES_COLUMN
 * generatedAt 은 저장소 커밋 시각 가운데 가장 늦은 것이다(manifest 와 같다)
 */
export function buildSystemTopology(
  state: GraphBuildState,
  detections: ReadonlyMap<string, readonly Detection[]>,
  options: SystemTopologyOptions = {},
): SystemTopologyGraph {
  const graph = new TopologyGraph();
  const builds = [...state.repositories].sort((left, right) =>
    compareText(left.manifest.name, right.manifest.name),
  );
  for (const build of builds) {
    new RepositoryTopology(
      graph,
      build,
      detections.get(build.manifest.name) ?? [],
      state.config,
    ).build();
  }
  const nodes = graph.sortedNodes();
  const edges = graph.sortedEdges();
  const repositories = builds.map((build) => build.manifest.name);
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    generatedAt: latestCommittedAt(builds.map((build) => build.manifest)),
    repositories,
    exclusions: topologyExclusions(state.config),
    nodes,
    edges,
    localGraphs: repositories.map((repository) => ({
      repository,
      nodeIds: nodes
        .filter((node) => node.repository === repository)
        .map((node) => node.id),
      edgeIndexes: edges.flatMap((edge, index) =>
        edge.repository === repository ? [index] : [],
      ),
    })),
    sources: [
      ...new Set([
        ...(options.extractors ?? []).map((name) => `extractor:${name}`),
        ...(options.presets ?? []).map((name) => `preset:${name}`),
      ]),
    ]
      .sort(compareText)
      .map((kind) => ({ kind })),
  };
}

/**
 * 큐·이벤트 이름을 저장소 안에서 맞출 열쇠로 바꾼다. 대소문자와 구분자만 맞추고 낱말은 떼지 않는다
 * 주소 꼴이면 경로의 마지막 조각(없으면 호스트)을 이름으로 본다. `orderPlaced`, `ORDER_PLACED`, `order.placed` 는 모두 `order-placed`
 */
export function normalizeMessageName(name: string): string {
  let text = name.trim();
  const address = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(text);
  if (address) {
    text =
      address[2].split('/').filter(Boolean).at(-1) ??
      address[1].replace(/^[^@]*@/, '');
  }
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── 노드 id ──

function repositoryNodeId(repository: string): string {
  return `repository:${repository}`;
}

function fileNodeId(repository: string, filePath: string): string {
  return `file:${repository}:${filePath}`;
}

function symbolNodeId(repository: string, filePath: string, symbol: string) {
  return `symbol:${repository}:${filePath}#${symbol}`;
}

/** 간선의 위치. 노드·간선이 어느 코드 자리에서 나왔는지 */
interface Place {
  repository: string;
  filePath: string;
  symbol: string;
  lineStart: number;
  lineEnd: number;
}

/** 노드와 간선을 모으며 같은 id 의 노드, 같은 종류·출발·도착의 간선을 하나로 합친다 */
class TopologyGraph {
  private readonly nodes = new Map<
    string,
    {
      node: TopologyNode;
      evidence: Set<string>;
      aliases: Set<string>;
      defined: boolean;
    }
  >();
  private readonly edges = new Map<
    string,
    { edge: TopologyEdge; evidence: Set<string> }
  >();

  /**
   * 노드를 더한다. 이미 있으면 신뢰도는 높은 쪽, 근거·별칭은 합친다
   * 위치는 노드를 선언한 자리(라우트, 리졸버, 엔티티 선언, 예약)를 쓰는 자리(읽기·쓰기·발행)보다 앞세우고, 같은 무게면 앞선 자리를 쓴다
   */
  addNode(
    id: string,
    type: TopologyNodeType,
    name: string,
    place: Place,
    details: {
      confidence: number;
      evidence?: string;
      alias?: string;
      defines?: boolean;
    },
  ): void {
    const defines = details.defines ?? true;
    const existing = this.nodes.get(id);
    if (!existing) {
      this.nodes.set(id, {
        node: { id, type, name, ...place, confidence: details.confidence },
        evidence: new Set(details.evidence ? [details.evidence] : []),
        aliases: new Set(
          details.alias && details.alias !== name ? [details.alias] : [],
        ),
        defined: defines,
      });
      return;
    }
    const node = existing.node;
    node.confidence = Math.max(node.confidence ?? 0, details.confidence);
    if (
      (defines && !existing.defined) ||
      (defines === existing.defined && comparePlace(place, node) < 0)
    ) {
      Object.assign(node, place);
      existing.defined = defines;
    }
    if (details.evidence) {
      existing.evidence.add(details.evidence);
    }
    if (details.alias && details.alias !== node.name) {
      existing.aliases.add(details.alias);
    }
  }

  setCommit(id: string, commitSha: string): void {
    const entry = this.nodes.get(id);
    if (entry) {
      entry.node.commitSha = commitSha;
    }
  }

  /** 간선을 더한다. 출발과 도착이 같으면 버린다. 같은 간선이면 신뢰도는 높은 쪽, 위치는 앞선 자리, 근거는 합친다 */
  addEdge(
    type: TopologyEdgeType,
    from: string,
    to: string,
    place: Place,
    confidence: number,
    evidence: string,
  ): void {
    if (from === to) {
      return;
    }
    const key = `${type}\0${from}\0${to}`;
    const existing = this.edges.get(key);
    if (!existing) {
      this.edges.set(key, {
        edge: { from, to, type, confidence, evidence: [], ...place },
        evidence: new Set([evidence]),
      });
      return;
    }
    existing.edge.confidence = Math.max(existing.edge.confidence, confidence);
    if (comparePlace(place, existing.edge) < 0) {
      Object.assign(existing.edge, place);
    }
    existing.evidence.add(evidence);
  }

  sortedNodes(): TopologyNode[] {
    return [...this.nodes.values()]
      .map(({ node, evidence, aliases }) => {
        const { confidence, commitSha, ...rest } = node;
        return {
          ...rest,
          ...(aliases.size > 0 ? { aliases: limited(aliases) } : {}),
          ...(evidence.size > 0 ? { evidence: limited(evidence) } : {}),
          confidence,
          ...(commitSha ? { commitSha } : {}),
        };
      })
      .sort((left, right) => compareText(left.id, right.id));
  }

  sortedEdges(): TopologyEdge[] {
    return [...this.edges.values()]
      .map(({ edge, evidence }) => ({ ...edge, evidence: limited(evidence) }))
      .sort(
        (left, right) =>
          compareText(left.repository, right.repository) ||
          compareText(left.from, right.from) ||
          compareText(left.type, right.type) ||
          compareText(left.to, right.to),
      );
  }
}

/** 저장소 하나의 노드와 간선 */
class RepositoryTopology {
  private readonly repository: string;
  private readonly byFile = new Map<string, Map<string, CurrentSymbolRecord>>();
  private readonly byName = new Map<string, CurrentSymbolRecord[]>();
  private readonly modules: ModuleIndex;
  private readonly receivers = new Map<string, Record<string, string>>();
  /** 엔티티 클래스 이름 → 그 클래스가 선언한 테이블 이름들 */
  private readonly tablesByClass = new Map<string, Set<string>>();

  constructor(
    private readonly graph: TopologyGraph,
    private readonly source: RepositoryBuild,
    private readonly detections: readonly Detection[],
    private readonly config: GraphConfig,
  ) {
    this.repository = source.manifest.name;
    for (const record of source.records) {
      const inFile = this.byFile.get(record.filePath) ?? new Map();
      inFile.set(record.symbol, record);
      this.byFile.set(record.filePath, inFile);
      if (record.kind !== MODULE_SYMBOL_KIND) {
        this.byName.set(record.symbol, [
          ...(this.byName.get(record.symbol) ?? []),
          record,
        ]);
      }
    }
    this.modules = new ModuleIndex(this.byFile.keys());
    for (const receiver of repositoryReceivers(source)) {
      this.receivers.set(
        `${receiver.filePath}#${receiver.symbol}`,
        receiver.members,
      );
    }
    for (const detection of detections) {
      if (detection.kind === 'entity-declaration') {
        const tables = this.tablesByClass.get(detection.className) ?? new Set();
        tables.add(detection.table);
        this.tablesByClass.set(detection.className, tables);
      }
    }
  }

  build(): void {
    this.addStructure();
    for (const record of this.source.records) {
      this.addCalls(record);
    }
    for (const detection of this.detections) {
      this.addDetection(detection);
    }
  }

  // ── 구조 ──

  private addStructure(): void {
    const repositoryId = repositoryNodeId(this.repository);
    this.graph.addNode(
      repositoryId,
      'Repository',
      this.repository,
      {
        repository: this.repository,
        filePath: '.',
        symbol: this.repository,
        lineStart: 1,
        lineEnd: 1,
      },
      { confidence: TOPOLOGY_STRUCTURE_CONFIDENCE },
    );
    this.graph.setCommit(repositoryId, this.source.manifest.commitSha);
    for (const [filePath, records] of this.byFile) {
      const fileId = fileNodeId(this.repository, filePath);
      const filePlace: Place = {
        repository: this.repository,
        filePath,
        symbol: filePath,
        lineStart: 1,
        lineEnd: [...records.values()].reduce(
          (end, record) => Math.max(end, record.lineEnd ?? 1),
          1,
        ),
      };
      this.graph.addNode(fileId, 'File', filePath, filePlace, {
        confidence: TOPOLOGY_STRUCTURE_CONFIDENCE,
      });
      this.graph.addEdge(
        'DEPENDS_ON',
        repositoryId,
        fileId,
        filePlace,
        TOPOLOGY_STRUCTURE_CONFIDENCE,
        'file in repository',
      );
      for (const record of records.values()) {
        if (record.kind === MODULE_SYMBOL_KIND) {
          continue;
        }
        const place = recordPlace(record);
        this.graph.addNode(
          this.ownerId(record),
          nodeTypeOf(record.kind),
          record.symbol,
          place,
          { confidence: TOPOLOGY_STRUCTURE_CONFIDENCE },
        );
        this.graph.addEdge(
          'DEPENDS_ON',
          fileId,
          this.ownerId(record),
          place,
          TOPOLOGY_STRUCTURE_CONFIDENCE,
          `${record.kind} declared in file`,
        );
      }
    }
  }

  /** 심볼의 노드 id. 파일 최상위 문장 묶음(module)은 그 파일 노드가 맡는다 */
  private ownerId(record: CurrentSymbolRecord): string {
    return record.kind === MODULE_SYMBOL_KIND
      ? fileNodeId(this.repository, record.filePath)
      : symbolNodeId(this.repository, record.filePath, record.symbol);
  }

  // ── 저장소 안 호출 ──

  private addCalls(record: CurrentSymbolRecord): void {
    for (const relation of record.relations) {
      const raw = relation.target.symbol;
      if (relation.type !== 'CALLS' || !raw) {
        continue;
      }
      const resolved = this.resolveCall(record, raw);
      if (!resolved) {
        continue;
      }
      const line = callLine(record, raw);
      this.graph.addEdge(
        'CALLS',
        this.ownerId(record),
        this.ownerId(resolved.target),
        {
          ...recordPlace(record),
          ...(line ? { lineStart: line, lineEnd: line } : {}),
        },
        TOPOLOGY_CALL_CONFIDENCE[resolved.rule],
        `${raw} → ${resolved.target.symbol} (${resolved.note})`,
      );
    }
  }

  /**
   * 호출 원문을 같은 저장소의 심볼 하나로 푼다. 후보가 정확히 하나일 때만 돌려준다
   * - `this.메서드`(`self.`, `cls.` 도): 부르는 메서드의 클래스에 같은 파일로 선언된 `클래스.메서드`
   * - `this.멤버.메서드`: 클래스 멤버의 타입(`멤버: OrderService`)으로 `OrderService.메서드` 를 저장소 전체에서 찾는다.
   *   멤버 목록이 없는 클래스는 주입(INJECTS) 타입 가운데 이름이 멤버와 같은(대소문자·밑줄 무시) 타입 하나로 찾는다
   * - 이름 하나: 같은 파일의 심볼, 아니면 가져온 이름이면 그 모듈의 심볼
   * - `이름.멤버`: 모듈 전체를 가져온 이름이면 그 모듈의 `멤버`, 가져온 클래스면 그 모듈의 `클래스.멤버`, 같은 파일의 클래스면 `클래스.멤버`
   * 파일 최상위 문장 묶음(module)은 호출 대상이 아니다
   */
  private resolveCall(
    record: CurrentSymbolRecord,
    raw: string,
  ):
    | { target: CurrentSymbolRecord; rule: CallResolution; note: string }
    | undefined {
    const text = raw.replaceAll('?.', '.');
    if (!CALLEE_TEXT.test(text)) {
      return undefined;
    }
    const parts = text.split('.');
    const head = parts[0];
    if (TOPOLOGY_SELF_RECEIVERS.includes(head)) {
      return this.resolveOwnMember(record, parts.slice(1));
    }
    const sameFile = this.byFile.get(record.filePath);
    const binding = importedBinding(record.relations, head);
    if (binding) {
      const inner =
        binding.imported === '*'
          ? parts.slice(1)
          : [binding.imported, ...parts.slice(1)];
      if (inner.length === 0) {
        return undefined;
      }
      const name = inner.join('.');
      const candidates = this.modules
        .resolve(record.filePath, binding.specifier)
        .flatMap((file) => {
          const found = this.byFile.get(file)?.get(name);
          return found && found.kind !== MODULE_SYMBOL_KIND ? [found] : [];
        });
      return candidates.length === 1
        ? {
            target: candidates[0],
            rule: 'imported',
            note: `imported from ${binding.specifier}`,
          }
        : undefined;
    }
    const local = sameFile?.get(text);
    return local && local.kind !== MODULE_SYMBOL_KIND
      ? { target: local, rule: 'same-file', note: 'same file' }
      : undefined;
  }

  private resolveOwnMember(
    record: CurrentSymbolRecord,
    rest: readonly string[],
  ):
    | { target: CurrentSymbolRecord; rule: CallResolution; note: string }
    | undefined {
    const separator = record.symbol.lastIndexOf('.');
    if (separator <= 0) {
      return undefined;
    }
    const owner = record.symbol.slice(0, separator);
    if (rest.length === 1) {
      const target = this.byFile
        .get(record.filePath)
        ?.get(`${owner}.${rest[0]}`);
      return target
        ? { target, rule: 'own-member', note: `member of ${owner}` }
        : undefined;
    }
    if (rest.length !== 2) {
      return undefined;
    }
    const [member, method] = rest;
    const typed = this.memberType(record.filePath, owner, member);
    if (!typed) {
      return undefined;
    }
    const candidates = (
      this.byName.get(`${typed.type}.${method}`) ?? []
    ).filter((candidate) => candidate.kind !== MODULE_SYMBOL_KIND);
    return candidates.length === 1
      ? {
          target: candidates[0],
          rule: typed.rule,
          note: `${member}: ${typed.type}`,
        }
      : undefined;
  }

  /** 클래스 멤버의 타입 이름. 멤버 목록이 있으면 그것만 보고, 없을 때만 주입 타입 이름으로 찾는다 */
  private memberType(
    filePath: string,
    owner: string,
    member: string,
  ): { type: string; rule: CallResolution } | undefined {
    const members = this.receivers.get(`${filePath}#${owner}`);
    if (members) {
      const type = members[member];
      return type ? { type, rule: 'member-type' } : undefined;
    }
    const ownerRecord = this.byFile.get(filePath)?.get(owner);
    const wanted = compactName(member);
    const types = new Set(
      (ownerRecord?.relations ?? [])
        .filter((relation) => relation.type === 'INJECTS')
        .map((relation) => receiverTypeName(relation.target.symbol ?? ''))
        .filter(
          (type): type is string =>
            type !== undefined && compactName(type) === wanted,
        ),
    );
    return types.size === 1
      ? { type: [...types][0], rule: 'injected-type' }
      : undefined;
  }

  // ── 탐지 ──

  private addDetection(detection: Detection): void {
    const owner = this.detectionOwner(detection);
    const place: Place = {
      repository: this.repository,
      filePath: detection.filePath,
      symbol: detection.symbol,
      lineStart: detection.line,
      lineEnd: detection.line,
    };
    const evidence = detection.evidence
      ? `${detection.detector}: ${detection.evidence}`
      : detection.detector;
    const confidence = detection.confidence;
    const defines = DEFINING_DETECTIONS.includes(detection.kind);
    const resource = (
      id: string,
      type: TopologyNodeType,
      name: string,
      alias?: string,
    ) => {
      this.graph.addNode(id, type, name, place, {
        confidence,
        evidence,
        alias,
        defines,
      });
      return id;
    };
    const edge = (type: TopologyEdgeType, from: string, to: string) =>
      this.graph.addEdge(type, from, to, place, confidence, evidence);
    const repo = this.repository;

    switch (detection.kind) {
      case 'http-route': {
        const name = `${detection.method.toUpperCase()} ${detection.path}`;
        edge('TRIGGERS', resource(`api:${repo}:${name}`, 'API', name), owner);
        return;
      }
      case 'graphql-resolver': {
        const name = `${GRAPHQL_ROOT_TYPES[detection.operationType] ?? detection.operationType}:${detection.field}`;
        const id = resource(
          `graphql:${repo}:${name}`,
          'GraphQLOperation',
          name,
        );
        edge('TRIGGERS', id, owner);
        return;
      }
      case 'queue-publish':
      case 'queue-consume':
      case 'event-publish':
      case 'event-handle': {
        const key = detection.dynamic
          ? ''
          : normalizeMessageName(detection.name);
        if (!key) {
          return;
        }
        const queue = detection.kind.startsWith('queue');
        const id = resource(
          `${queue ? 'queue' : 'event'}:${repo}:${key}`,
          queue ? 'Queue' : 'Event',
          key,
          detection.name,
        );
        if (detection.kind === 'queue-publish') {
          edge('PUBLISHES', owner, id);
        } else if (detection.kind === 'event-publish') {
          edge('PRODUCES_EVENT', owner, id);
        } else {
          edge(queue ? 'CONSUMES' : 'HANDLES_EVENT', owner, id);
          edge('TRIGGERS', id, owner);
        }
        return;
      }
      case 'schedule': {
        const id = resource(
          `scheduler:${repo}:${detection.filePath}#${detection.symbol}:${detection.expression}`,
          'Scheduler',
          detection.expression,
        );
        edge('SCHEDULES', owner, id);
        edge('TRIGGERS', id, owner);
        return;
      }
      case 'entity-declaration': {
        const table = resource(
          `table:${repo}:${detection.table}`,
          'DatabaseTable',
          detection.table,
          detection.className,
        );
        for (const column of detection.columns) {
          const enumRecord = column.enumName
            ? this.uniqueSymbol(column.enumName, detection.filePath, 'enum')
            : undefined;
          if (enumRecord) {
            this.graph.addEdge(
              'TYPES_COLUMN',
              this.ownerId(enumRecord),
              table,
              place,
              confidence,
              `${detection.detector}: column ${detection.table}.${column.name} takes ${enumRecord.symbol}`,
            );
          }
        }
        return;
      }
      case 'entity-read':
      case 'entity-write': {
        const table = this.tableName(detection.target, detection.targetType);
        if (!table) {
          return;
        }
        const id = resource(`table:${repo}:${table}`, 'DatabaseTable', table);
        edge(detection.kind === 'entity-read' ? 'READS' : 'WRITES', owner, id);
        return;
      }
      case 'cache-read':
      case 'cache-write': {
        const id = resource(
          `cache:${repo}:${detection.target}`,
          'CacheKey',
          detection.target,
        );
        edge(detection.kind === 'cache-read' ? 'READS' : 'WRITES', owner, id);
        return;
      }
      case 'http-call': {
        const service = this.externalService(detection);
        if (service) {
          edge(
            'DEPENDS_ON',
            owner,
            resource(`external:${repo}:${service}`, 'ExternalService', service),
          );
        }
        return;
      }
      case 'graphql-document':
      case 'graphql-client-call':
      case 'field-write':
        // 부르는 쪽 연산과 필드 쓰기는 저장소 간 연결과 필드 쓰기 색인이 쓴다
        return;
    }
  }

  /** 탐지가 붙은 심볼의 노드. 레코드에 없는 이름이면 그 파일 노드에 단다 */
  private detectionOwner(detection: Detection): string {
    const record = this.byFile.get(detection.filePath)?.get(detection.symbol);
    return record
      ? this.ownerId(record)
      : fileNodeId(this.repository, detection.filePath);
  }

  /**
   * 엔티티 읽기·쓰기 대상을 테이블 이름으로. 클래스 이름이면 같은 저장소의 엔티티 선언으로 테이블을 찾아
   * 클래스 이름과 테이블 이름이 같은 노드가 되게 한다. 선언이 없으면 클래스 이름을 그대로, 테이블이 여럿이면 잇지 않는다
   */
  private tableName(target: string, targetType: string): string | undefined {
    if (targetType !== 'class') {
      return target;
    }
    const tables = this.tablesByClass.get(target);
    if (!tables) {
      return target;
    }
    return tables.size === 1 ? [...tables][0] : undefined;
  }

  /** 같은 파일, 아니면 저장소 전체에서 이름과 종류가 맞는 심볼이 하나뿐일 때 그 심볼 */
  private uniqueSymbol(
    name: string,
    filePath: string,
    kind: string,
  ): CurrentSymbolRecord | undefined {
    const local = this.byFile.get(filePath)?.get(name);
    if (local?.kind === kind) {
      return local;
    }
    const candidates = (this.byName.get(name) ?? []).filter(
      (record) => record.kind === kind,
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  /**
   * 바깥 서비스 이름. hints.external 에 맞는 호스트·주소 변수면 그 이름, 아니면 주소에 호스트가 적혀 있고
   * 주소 변수 힌트(hints.baseUrls)로 저장소를 가리키지 않으며 자기 컴퓨터 주소가 아닐 때 그 호스트
   */
  private externalService(detection: HttpCallDetection): string | undefined {
    const host = detection.host ? hostOf(detection.host) : undefined;
    for (const entry of this.config.hints.external ?? []) {
      const hinted = hostOf(entry);
      if (host && (host === hinted || host.endsWith(`.${hinted}`))) {
        return host;
      }
      if (
        detection.baseIdentifiers.some(
          (identifier) =>
            identifier === entry || identifier.endsWith(`.${entry}`),
        )
      ) {
        return host ?? entry;
      }
    }
    if (!host || LOOPBACK_HOSTS.includes(host)) {
      return undefined;
    }
    const baseUrls = this.config.hints.baseUrls ?? {};
    const pointsInside = detection.baseIdentifiers.some((identifier) =>
      Object.keys(baseUrls).some(
        (name) => identifier === name || identifier.endsWith(`.${name}`),
      ),
    );
    return pointsInside ? undefined : host;
  }
}

function nodeTypeOf(kind: string): TopologyNodeType {
  if (kind === 'enum') {
    return 'Enum';
  }
  return TOPOLOGY_CLASS_KINDS.includes(kind) ? 'Class' : 'Function';
}

function recordPlace(record: CurrentSymbolRecord): Place {
  const lineStart = record.lineStart ?? 1;
  return {
    repository: record.repository,
    filePath: record.filePath,
    symbol: record.symbol,
    lineStart,
    lineEnd: record.lineEnd ?? lineStart,
  };
}

/** 호출 원문과 같은 대상을 부르는 실행 사실의 첫 줄. 없으면 undefined 라 심볼 범위를 쓴다 */
function callLine(
  record: CurrentSymbolRecord,
  raw: string,
): number | undefined {
  return record.executionFacts?.find(
    (fact) => fact.kind === 'calls' && fact.subject === raw,
  )?.line;
}

function comparePlace(left: Place, right: Place): number {
  return (
    compareText(left.filePath, right.filePath) ||
    left.lineStart - right.lineStart ||
    compareText(left.symbol, right.symbol) ||
    left.lineEnd - right.lineEnd
  );
}

/** 이름 비교용: 소문자로 바꾸고 밑줄·하이픈을 뗀다(`order_service`, `orderService`, `OrderService` 가 같다) */
function compactName(name: string): string {
  return name.replace(/[_-]/g, '').toLowerCase();
}

/** 주소면 호스트만, 아니면 그 글을 소문자로. 사용자 정보와 포트는 뗀다 */
function hostOf(entry: string): string {
  const address = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(entry.trim());
  return (address ? address[1].replace(/^[^@]*@/, '') : entry.trim())
    .toLowerCase()
    .replace(/:\d+$/, '');
}

function limited(values: Iterable<string>): string[] {
  return [...values].sort(compareText).slice(0, TOPOLOGY_MAX_EVIDENCE);
}

/** 색인에서 뺀 경로 규칙: 바닥 규칙, 기본 제외, 저장소마다의 exclude(`저장소:glob`) */
function topologyExclusions(config: GraphConfig): string[] {
  const perRepository = [...config.repositories]
    .sort((left, right) => compareText(left.name, right.name))
    .flatMap((repository) =>
      (repository.exclude ?? []).map((glob) => `${repository.name}:${glob}`),
    );
  return [
    ...new Set([
      ...GRAPH_FLOOR_EXCLUDES,
      ...config.defaultExcludes,
      ...perRepository,
    ]),
  ];
}
