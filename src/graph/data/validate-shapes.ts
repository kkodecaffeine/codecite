// 결과 파일마다 계약(src/extensions/code-knowledge.ts) 모양을 손으로 본다. 스키마 도구 없이 있어야 하는 필드와 그 꼴만 본다
// 모르는 필드는 거절하지 않는다(뒤 단계가 필드를 더할 수 있다). 대신 그 값도 경로·비밀값 검사는 지난다
import type {
  CrossRepositoryGraph,
  EntityRelationGraph,
  FieldWriterIndex,
  SystemTopologyGraph,
} from '../../extensions/code-knowledge.js';
import { EXECUTION_FACT_KINDS, GRAPH_SCHEMA_VERSION } from '../constants.js';
import type { UnresolvedItem } from '../types.js';
import {
  COVERAGE_STATUSES,
  CROSS_REPOSITORY_EXTRACTION_KINDS,
  CROSS_REPOSITORY_RELATIONS,
  ENTITY_RELATION_KINDS,
  ENTITY_RELATION_SOURCES,
  FIELD_WRITE_KINDS,
  RECORD_TYPES,
  RELATION_CONFIDENCES,
  TOPOLOGY_EDGE_TYPES,
  TOPOLOGY_NODE_TYPES,
  UNRESOLVED_REASONS,
} from './constants.js';
import type { Shape } from './validate-support.js';

function header(
  shape: Shape,
  value: unknown,
  optional = false,
): Record<string, unknown> | undefined {
  const root = shape.object(value, '');
  if (!root) {
    return undefined;
  }
  if (
    !(optional && root.schemaVersion === undefined) &&
    root.schemaVersion !== GRAPH_SCHEMA_VERSION
  ) {
    shape.fail('schemaVersion', `must be ${GRAPH_SCHEMA_VERSION}`);
  }
  shape.text(root.generatedAt, 'generatedAt', optional);
  return root;
}

export function topologyShape(
  shape: Shape,
  value: unknown,
): SystemTopologyGraph | undefined {
  const root = header(shape, value);
  if (!root) {
    return undefined;
  }
  shape.textArray(root.repositories, 'repositories');
  shape.textArray(root.exclusions, 'exclusions');
  shape.array(root.nodes, 'nodes').forEach((item, index) => {
    const path = `nodes[${index}]`;
    shape.location(item, path);
    const node = shape.object(item, path);
    if (!node) {
      return;
    }
    shape.text(node.id, `${path}.id`);
    shape.oneOf(node.type, `${path}.type`, TOPOLOGY_NODE_TYPES);
    shape.text(node.name, `${path}.name`);
    shape.stringArray(node.aliases, `${path}.aliases`, true);
    shape.stringArray(node.evidence, `${path}.evidence`, true);
    shape.number(node.confidence, `${path}.confidence`, 0, 1, true);
    shape.text(node.commitSha, `${path}.commitSha`, true);
  });
  shape.array(root.edges, 'edges').forEach((item, index) => {
    const path = `edges[${index}]`;
    shape.location(item, path);
    const edge = shape.object(item, path);
    if (!edge) {
      return;
    }
    shape.text(edge.from, `${path}.from`);
    shape.text(edge.to, `${path}.to`);
    shape.oneOf(edge.type, `${path}.type`, TOPOLOGY_EDGE_TYPES);
    shape.number(edge.confidence, `${path}.confidence`, 0, 1);
    shape.stringArray(edge.evidence, `${path}.evidence`);
  });
  shape.array(root.localGraphs, 'localGraphs').forEach((item, index) => {
    const path = `localGraphs[${index}]`;
    const local = shape.object(item, path);
    if (!local) {
      return;
    }
    shape.text(local.repository, `${path}.repository`);
    shape.textArray(local.nodeIds, `${path}.nodeIds`);
    shape
      .array(local.edgeIndexes, `${path}.edgeIndexes`)
      .forEach((edge, position) =>
        shape.integer(edge, `${path}.edgeIndexes[${position}]`, 0),
      );
  });
  shape.array(root.sources, 'sources', true).forEach((item, index) => {
    const source = shape.object(item, `sources[${index}]`);
    if (source) {
      shape.text(source.kind, `sources[${index}].kind`);
      shape.text(source.artifact, `sources[${index}].artifact`, true);
    }
  });
  return shape.ok ? (root as unknown as SystemTopologyGraph) : undefined;
}

export function crossRepositoryShape(
  shape: Shape,
  value: unknown,
): CrossRepositoryGraph | undefined {
  const root = header(shape, value, true);
  if (!root) {
    return undefined;
  }
  shape.textArray(root.repositories, 'repositories', true);
  if (root.coverage !== undefined) {
    const coverage = shape.object(root.coverage, 'coverage');
    if (coverage) {
      shape.oneOf(coverage.status, 'coverage.status', COVERAGE_STATUSES);
      shape.textArray(
        coverage.expectedRepositories,
        'coverage.expectedRepositories',
      );
      shape.textArray(
        coverage.auditedRepositories,
        'coverage.auditedRepositories',
      );
      const counts = shape.object(
        coverage.relationCounts,
        'coverage.relationCounts',
      );
      for (const [relation, count] of Object.entries(counts ?? {})) {
        shape.oneOf(
          relation,
          `coverage.relationCounts.${relation} (key)`,
          CROSS_REPOSITORY_RELATIONS,
        );
        shape.integer(count, `coverage.relationCounts.${relation}`, 0);
      }
      for (const field of [
        'providerContracts',
        'linkedProviderContracts',
        'unresolvedProviderContracts',
      ]) {
        shape.integer(coverage[field], `coverage.${field}`, 0);
      }
    }
  }
  shape.array(root.nodes, 'nodes').forEach((item, index) => {
    const path = `nodes[${index}]`;
    const node = shape.object(item, path);
    if (!node) {
      return;
    }
    shape.text(node.id, `${path}.id`);
    shape.textArray(node.repositories, `${path}.repositories`);
    shape.textArray(node.symbols, `${path}.symbols`);
    shape
      .array(node.recordTypes, `${path}.recordTypes`)
      .forEach((type, position) =>
        shape.oneOf(type, `${path}.recordTypes[${position}]`, RECORD_TYPES),
      );
  });
  shape.array(root.edges, 'edges').forEach((item, index) => {
    const path = `edges[${index}]`;
    const edge = shape.object(item, path);
    if (!edge) {
      return;
    }
    shape.text(edge.id, `${path}.id`);
    shape.oneOf(edge.relation, `${path}.relation`, CROSS_REPOSITORY_RELATIONS);
    shape.text(edge.source, `${path}.source`);
    shape.text(edge.target, `${path}.target`);
    const extraction = shape.object(edge.extraction, `${path}.extraction`);
    if (extraction) {
      shape.oneOf(
        extraction.kind,
        `${path}.extraction.kind`,
        CROSS_REPOSITORY_EXTRACTION_KINDS,
      );
      shape.string(extraction.locator, `${path}.extraction.locator`);
      shape.string(extraction.value, `${path}.extraction.value`);
    }
    shape.oneOf(edge.confidence, `${path}.confidence`, RELATION_CONFIDENCES);
    shape.stringArray(edge.evidence, `${path}.evidence`, true);
    for (const field of ['sourceLocation', 'targetLocation']) {
      if (edge[field] !== undefined) {
        shape.location(edge[field], `${path}.${field}`);
      }
    }
    shape
      .array(edge.handlerChain, `${path}.handlerChain`, true)
      .forEach((location, position) =>
        shape.location(location, `${path}.handlerChain[${position}]`),
      );
    for (const field of [
      'callerConditions',
      'handlerConditions',
      'handlerExceptions',
    ]) {
      shape
        .array(edge[field], `${path}.${field}`, true)
        .forEach((fact, position) =>
          shape.fact(
            fact,
            `${path}.${field}[${position}]`,
            EXECUTION_FACT_KINDS,
          ),
        );
    }
  });
  return shape.ok ? (root as unknown as CrossRepositoryGraph) : undefined;
}

export function entitiesShape(
  shape: Shape,
  value: unknown,
): EntityRelationGraph | undefined {
  const root = header(shape, value);
  if (!root) {
    return undefined;
  }
  shape.array(root.tables, 'tables').forEach((item, index) => {
    const path = `tables[${index}]`;
    const table = shape.object(item, path);
    if (!table) {
      return;
    }
    shape.text(table.table, `${path}.table`);
    shape.text(table.store, `${path}.store`, true);
    shape.textArray(table.entityNames, `${path}.entityNames`);
    shape.textArray(table.policyGroups, `${path}.policyGroups`);
    shape
      .array(table.sources, `${path}.sources`)
      .forEach((source, position) =>
        shape.location(source, `${path}.sources[${position}]`),
      );
    shape.array(table.columns, `${path}.columns`).forEach((entry, position) => {
      const column = shape.object(entry, `${path}.columns[${position}]`);
      if (column) {
        const at = `${path}.columns[${position}]`;
        shape.text(column.name, `${at}.name`);
        shape.string(column.dataType, `${at}.dataType`, true);
        shape.string(column.comment, `${at}.comment`, true);
        shape.string(column.enumName, `${at}.enumName`, true);
      }
    });
    shape
      .array(table.relations, `${path}.relations`)
      .forEach((entry, position) => {
        const at = `${path}.relations[${position}]`;
        const relation = shape.object(entry, at);
        if (relation) {
          shape.text(relation.targetTable, `${at}.targetTable`);
          shape.oneOf(relation.kind, `${at}.kind`, ENTITY_RELATION_KINDS);
          shape.oneOf(relation.source, `${at}.source`, ENTITY_RELATION_SOURCES);
          shape.text(relation.column, `${at}.column`, true);
          shape.text(relation.property, `${at}.property`, true);
        }
      });
  });
  return shape.ok ? (root as unknown as EntityRelationGraph) : undefined;
}

export function fieldWritersShape(
  shape: Shape,
  value: unknown,
): FieldWriterIndex | undefined {
  const root = header(shape, value);
  if (!root) {
    return undefined;
  }
  shape.integer(root.maxWritersPerField, 'maxWritersPerField', 1);
  const writers = shape.object(root.writers, 'writers') ?? {};
  for (const [key, list] of Object.entries(writers)) {
    shape.array(list, `writers.${key}`).forEach((item, index) => {
      const path = `writers.${key}[${index}]`;
      const entry = shape.object(item, path);
      if (!entry) {
        return;
      }
      shape.text(entry.symbolId, `${path}.symbolId`);
      shape.text(entry.symbol, `${path}.symbol`);
      shape.text(entry.filePath, `${path}.filePath`);
      shape.integer(entry.lineStart, `${path}.lineStart`, 1);
      shape.oneOf(entry.kind, `${path}.kind`, FIELD_WRITE_KINDS);
      shape.text(entry.entity, `${path}.entity`, true);
      shape.string(entry.valueSummary, `${path}.valueSummary`);
      shape.stringArray(entry.conditions, `${path}.conditions`, true);
    });
  }
  const truncated = shape.object(root.truncated, 'truncated') ?? {};
  for (const [key, count] of Object.entries(truncated)) {
    shape.integer(count, `truncated.${key}`, 1);
  }
  return shape.ok ? (root as unknown as FieldWriterIndex) : undefined;
}

/** report.json 은 연결 단계가 정한다. 여기서는 객체인지와, 못 이은 항목 목록이 있으면 그 항목 모양만 본다 */
export function reportShape(
  shape: Shape,
  value: unknown,
): { unresolved: UnresolvedItem[] } | undefined {
  const root = shape.object(value, '');
  if (!root) {
    return undefined;
  }
  shape.array(root.unresolved, 'unresolved', true).forEach((item, index) => {
    const path = `unresolved[${index}]`;
    const entry = shape.object(item, path);
    if (!entry) {
      return;
    }
    shape.oneOf(entry.reason, `${path}.reason`, UNRESOLVED_REASONS);
    shape.oneOf(entry.relation, `${path}.relation`, CROSS_REPOSITORY_RELATIONS);
    shape.text(entry.repository, `${path}.repository`);
    shape.text(entry.filePath, `${path}.filePath`);
    shape.text(entry.symbol, `${path}.symbol`);
    shape.integer(entry.line, `${path}.line`, 1, true);
    shape.string(entry.value, `${path}.value`);
    shape.textArray(entry.candidates, `${path}.candidates`, true);
  });
  return shape.ok
    ? { unresolved: (root.unresolved as UnresolvedItem[] | undefined) ?? [] }
    : undefined;
}
