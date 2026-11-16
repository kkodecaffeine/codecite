// 엔티티 관계 그래프. 저장소마다 탐지한 엔티티 선언(테이블·컬렉션)을 테이블 이름으로 묶어 노드 하나로 만들고,
// ORM 의 관계 선언(declared)과 연결 컬럼 이름 규칙으로 추정한 관계(naming)를 단다
// - 테이블 이름이 대소문자 없이 같으면 저장소가 달라도 같은 노드다. 이름이 같아도 저장소 종류(store)가 다르면 따로 둔다
// - 엔티티 클래스 이름은 그 클래스를 선언한 테이블로 푼다. 같은 저장소를 먼저 보고, 후보가 둘 이상이면 풀지 않는다
// - 추정 관계는 관계 선언이 덮지 않은 컬럼에만, 후보 테이블이 정확히 하나일 때만 단다. 답에서 단정하지 않도록 source 로 가른다
import type {
  CodeLocation,
  CurrentSymbolRecord,
  EntityColumn,
  EntityRelation,
  EntityRelationGraph,
  EntityTableNode,
} from '../../extensions/code-knowledge.js';
import { GRAPH_SCHEMA_VERSION } from '../constants.js';
import { compareText } from '../files.js';
import { latestCommittedAt } from '../output.js';
import { policyGroupFor } from '../records.js';
import type {
  DataAccessDetection,
  EntityDeclarationDetection,
  GraphBuildState,
} from '../types.js';
import { OWNING_RELATION_KINDS } from './constants.js';
import { foreignKeyCandidates, tableMatchKey } from './naming.js';
import type { EntityTableResolver } from './types.js';

/** 선언 하나와 그 저장소. 저장소 이름 → 파일 경로 → 줄 순서로 놓는다 */
interface Declaration {
  repository: string;
  detection: EntityDeclarationDetection;
  /** 노드 열쇠(저장소 종류 + 소문자 테이블 이름) */
  key: string;
}

/** 만드는 중인 노드 */
interface NodeDraft {
  key: string;
  table: string;
  store?: string;
  entityNames: Set<string>;
  policyGroups: Set<string>;
  sources: Map<string, CodeLocation>;
  columns: EntityColumn[];
  relations: Map<string, EntityRelation>;
}

/**
 * 엔티티 관계 그래프를 만든다
 * - 노드: entity-declaration 탐지를 테이블 이름(대소문자 무시)과 저장소 종류로 묶는다. 테이블 표기는 처음 선언한 자리의 것이다
 * - entityNames·sources·columns: 묶은 선언의 클래스 이름, 선언 자리, 컬럼(이름이 같으면 비어 있는 설명을 채운다)
 * - policyGroups: 선언한 심볼 레코드의 정책 묶음
 * - declared 관계: 선언의 상대 클래스를 테이블로 풀 수 있을 때만
 * - naming 관계: config.entities.foreignKeySuffixes 로 끝나는 컬럼 가운데 관계 선언이 덮지 않은 것만
 * generatedAt 은 저장소 커밋 시각 가운데 가장 늦은 것이다
 */
export function buildEntityRelationGraph(
  state: GraphBuildState,
): EntityRelationGraph {
  const declarations = collectDeclarations(state);
  const resolver = new EntityTableIndex(declarations);
  const records = new Map<string, CurrentSymbolRecord>();
  for (const record of state.records) {
    records.set(
      locationKey(record.repository, record.filePath, record.symbol),
      record,
    );
  }
  const nodes = new Map<string, NodeDraft>();
  for (const declaration of declarations) {
    const { repository, detection, key } = declaration;
    const node = nodes.get(key) ?? newNode(key, detection);
    nodes.set(key, node);
    node.entityNames.add(detection.className);
    const record = records.get(
      locationKey(repository, detection.filePath, detection.symbol),
    );
    // 레코드가 없는 이름(프리셋이 붙인 이름)이면 레코드와 같은 규칙(파일 경로)으로 정한다
    const group = record
      ? record.policyGroup
      : policyGroupFor(repository, detection.filePath, state.config.groups);
    if (group) {
      node.policyGroups.add(group);
    }
    const source: CodeLocation = {
      repository,
      filePath: detection.filePath,
      symbol: detection.symbol,
      lineStart: record?.lineStart ?? detection.line,
      lineEnd: record?.lineEnd ?? record?.lineStart ?? detection.line,
    };
    node.sources.set(
      locationKey(source.repository, source.filePath, source.symbol),
      source,
    );
    for (const column of detection.columns) {
      mergeColumn(node.columns, column);
    }
    for (const relation of detection.relations) {
      const targetTable = resolver.resolveClass(
        repository,
        relation.targetClass,
      );
      if (!targetTable) {
        continue;
      }
      addRelation(node, {
        targetTable,
        kind: relation.kind,
        source: 'declared',
        ...(relation.column ? { column: relation.column } : {}),
        ...(relation.property ? { property: relation.property } : {}),
      });
    }
  }
  addNamingRelations(nodes, state.config.entities.foreignKeySuffixes);
  return sortEntityGraph({
    schemaVersion: GRAPH_SCHEMA_VERSION,
    generatedAt: latestCommittedAt(
      state.repositories.map((build) => build.manifest),
    ),
    tables: [...nodes.values()].map(finishNode),
  });
}

/** 탐지 결과에서 엔티티 클래스·테이블 이름을 테이블 이름으로 푸는 색인을 만든다. 필드 쓰기 색인과 저장소 간 연결이 함께 쓴다 */
export function createEntityTableResolver(
  state: Pick<GraphBuildState, 'detections'>,
): EntityTableResolver {
  return new EntityTableIndex(collectDeclarations(state));
}

/**
 * 엔티티 그래프의 정해진 순서: 테이블은 소문자 이름 → 이름 → 저장소 종류, 노드 안의 클래스 이름·정책 묶음은 이름 순,
 * 선언 자리는 저장소 → 경로 → 줄 → 심볼, 관계는 출처(declared 먼저) → 상대 테이블 → 컬럼 → 속성 → 종류
 * 컬럼은 선언에 적힌 순서를 그대로 둔다. 결과 검사도 이 함수로 순서를 본다
 */
export function sortEntityGraph(
  graph: EntityRelationGraph,
): EntityRelationGraph {
  return {
    ...graph,
    tables: graph.tables
      .map((table) => ({
        ...table,
        entityNames: [...table.entityNames].sort(compareText),
        policyGroups: [...table.policyGroups].sort(compareText),
        sources: [...table.sources].sort(compareLocations),
        relations: [...table.relations].sort(compareRelations),
      }))
      .sort(
        (left, right) =>
          compareText(left.table.toLowerCase(), right.table.toLowerCase()) ||
          compareText(left.table, right.table) ||
          compareText(left.store ?? '', right.store ?? ''),
      ),
  };
}

/** 코드 자리 정렬: 저장소 → 경로 → 시작 줄 → 심볼 → 끝 줄 */
export function compareLocations(
  left: CodeLocation,
  right: CodeLocation,
): number {
  return (
    compareText(left.repository, right.repository) ||
    compareText(left.filePath, right.filePath) ||
    left.lineStart - right.lineStart ||
    compareText(left.symbol, right.symbol) ||
    left.lineEnd - right.lineEnd
  );
}

function compareRelations(left: EntityRelation, right: EntityRelation) {
  return (
    compareText(left.source, right.source) ||
    compareText(left.targetTable, right.targetTable) ||
    compareText(left.column ?? '', right.column ?? '') ||
    compareText(left.property ?? '', right.property ?? '') ||
    compareText(left.kind, right.kind)
  );
}

/** 모든 저장소의 엔티티 선언. 저장소 이름 순서, 저장소 안은 탐지 결과 순서(파일 경로·줄) */
function collectDeclarations(
  state: Pick<GraphBuildState, 'detections'>,
): Declaration[] {
  const declarations: Declaration[] = [];
  const repositories = [...state.detections.keys()].sort(compareText);
  for (const repository of repositories) {
    for (const detection of state.detections.get(repository) ?? []) {
      if (detection.kind !== 'entity-declaration' || !detection.table.trim()) {
        continue;
      }
      declarations.push({
        repository,
        detection,
        key: nodeKey(detection.table, detection.store),
      });
    }
  }
  return declarations;
}

function nodeKey(table: string, store: string | undefined): string {
  return `${store ?? ''}\u0000${table.trim().toLowerCase()}`;
}

function locationKey(repository: string, filePath: string, symbol: string) {
  return `${repository}\u0000${filePath}\u0000${symbol}`;
}

function newNode(
  key: string,
  detection: EntityDeclarationDetection,
): NodeDraft {
  return {
    key,
    table: detection.table.trim(),
    ...(detection.store ? { store: detection.store } : {}),
    entityNames: new Set(),
    policyGroups: new Set(),
    sources: new Map(),
    columns: [],
    relations: new Map(),
  };
}

function mergeColumn(columns: EntityColumn[], column: EntityColumn): void {
  const existing = columns.find((item) => item.name === column.name);
  if (!existing) {
    columns.push({ ...column });
    return;
  }
  existing.dataType ??= column.dataType;
  existing.comment ??= column.comment;
  existing.enumName ??= column.enumName;
}

function addRelation(node: NodeDraft, relation: EntityRelation): void {
  const key = [
    relation.source,
    relation.targetTable,
    relation.kind,
    relation.column ?? '',
    relation.property ?? '',
  ].join('\u0000');
  if (!node.relations.has(key)) {
    node.relations.set(key, relation);
  }
}

/**
 * 연결 컬럼 이름으로 관계를 추정한다(foreignKeyCandidates 주석)
 * - 관계 선언의 컬럼, 그리고 컬럼을 적지 않은 소유 관계(many-to-one·one-to-one)의 `속성 + 끝말` 컬럼은 이미 덮인 것으로 본다
 * - 자기 테이블은 후보에서 뺀다(`orders.orderId` 는 자기 키다). 같은 저장소 종류의 테이블을 먼저 보고, 없을 때만 다른 종류를 본다
 * - 낱말이 많은 꼴부터 보며, 처음 후보가 나온 꼴에서 테이블이 정확히 하나일 때만 잇는다. 여럿이면 버리고 짧은 꼴로 내려가지 않는다
 * - 컬럼을 적지 않은 소유 관계가 이미 그 테이블을 가리키면 같은 관계로 보고 더하지 않는다
 */
function addNamingRelations(
  nodes: ReadonlyMap<string, NodeDraft>,
  suffixes: readonly string[],
): void {
  const byMatchKey = new Map<string, NodeDraft[]>();
  for (const node of nodes.values()) {
    const key = tableMatchKey(node.table);
    byMatchKey.set(key, [...(byMatchKey.get(key) ?? []), node]);
  }
  for (const node of nodes.values()) {
    const declared = [...node.relations.values()];
    const covered = new Set<string>();
    const implicitTargets = new Set<string>();
    for (const relation of declared) {
      if (relation.column) {
        covered.add(relation.column);
        continue;
      }
      if (!OWNING_RELATION_KINDS.includes(relation.kind)) {
        continue;
      }
      implicitTargets.add(relation.targetTable);
      if (relation.property) {
        for (const suffix of suffixes) {
          covered.add(`${relation.property}${suffix}`);
        }
      }
    }
    for (const column of node.columns) {
      if (covered.has(column.name)) {
        continue;
      }
      const target = namingTarget(column.name, node, byMatchKey, suffixes);
      if (!target || implicitTargets.has(target.table)) {
        continue;
      }
      addRelation(node, {
        targetTable: target.table,
        kind: 'many-to-one',
        source: 'naming',
        column: column.name,
      });
    }
  }
}

function namingTarget(
  column: string,
  node: NodeDraft,
  byMatchKey: ReadonlyMap<string, readonly NodeDraft[]>,
  suffixes: readonly string[],
): NodeDraft | undefined {
  for (const keys of foreignKeyCandidates(column, suffixes)) {
    const found = new Map<string, NodeDraft>();
    for (const key of keys) {
      for (const candidate of byMatchKey.get(key) ?? []) {
        if (candidate.key !== node.key) {
          found.set(candidate.key, candidate);
        }
      }
    }
    if (found.size === 0) {
      continue;
    }
    const all = [...found.values()];
    const sameStore = all.filter(
      (candidate) => (candidate.store ?? '') === (node.store ?? ''),
    );
    const pool = sameStore.length > 0 ? sameStore : all;
    return pool.length === 1 ? pool[0] : undefined;
  }
  return undefined;
}

function finishNode(node: NodeDraft): EntityTableNode {
  return {
    table: node.table,
    ...(node.store ? { store: node.store } : {}),
    entityNames: [...node.entityNames],
    policyGroups: [...node.policyGroups],
    sources: [...node.sources.values()],
    columns: node.columns,
    relations: [...node.relations.values()],
  };
}

/** 선언에서 만든 클래스·테이블 이름 색인 */
class EntityTableIndex implements EntityTableResolver {
  /** 노드 열쇠 → 테이블 표기(처음 선언한 자리의 것) */
  private readonly tables = new Map<string, string>();
  /** 클래스 이름 → 선언 자리와 노드 열쇠 */
  private readonly classes = new Map<
    string,
    Array<{ repository: string; filePath: string; key: string }>
  >();
  /** 소문자 테이블 이름 → 노드 열쇠 */
  private readonly names = new Map<string, Set<string>>();

  constructor(declarations: readonly Declaration[]) {
    for (const { repository, detection, key } of declarations) {
      if (!this.tables.has(key)) {
        this.tables.set(key, detection.table.trim());
      }
      const lower = detection.table.trim().toLowerCase();
      this.names.set(lower, (this.names.get(lower) ?? new Set()).add(key));
      const list = this.classes.get(detection.className) ?? [];
      list.push({ repository, filePath: detection.filePath, key });
      this.classes.set(detection.className, list);
    }
  }

  resolveClass(
    repository: string,
    className: string,
    filePath?: string,
  ): string | undefined {
    const candidates = this.classes.get(className) ?? [];
    const scopes = [
      filePath === undefined
        ? undefined
        : (item: { repository: string; filePath: string }) =>
            item.repository === repository && item.filePath === filePath,
      (item: { repository: string }) => item.repository === repository,
      () => true,
    ];
    for (const scope of scopes) {
      if (!scope) {
        continue;
      }
      const keys = new Set(candidates.filter(scope).map((item) => item.key));
      if (keys.size === 1) {
        return this.tables.get([...keys][0]);
      }
      if (keys.size > 1) {
        return undefined;
      }
    }
    return undefined;
  }

  resolveTable(name: string): string | undefined {
    const keys = this.names.get(name.trim().toLowerCase());
    return keys?.size === 1 ? this.tables.get([...keys][0]) : undefined;
  }

  resolveTarget(
    repository: string,
    target: string,
    targetType: DataAccessDetection['targetType'],
  ): string | undefined {
    if (targetType === 'key') {
      return undefined;
    }
    if (targetType === 'table') {
      return this.resolveTable(target) ?? target;
    }
    if (!this.classes.has(target)) {
      return target;
    }
    return this.resolveClass(repository, target);
  }
}
