// 저장소 간 연결 단계. 탐지 결과·레코드·저장소 안 토폴로지를 읽어 CrossRepositoryGraph 와 못 이은 항목, 보고서를 만든다
// - 노드 id 는 레코드의 stableSymbolId 다. 결과에는 저장소 기준 상대 경로만 남는다
// - 실행 관계 간선에는 부르는 쪽 조건, 처리하는 쪽 조건·예외, 처리하는 쪽에서 따라간 handlerChain 을 단다
// - 같은 입력이면 같은 출력이 나오도록 간선·노드·못 이은 항목의 순서를 고정한다
import { createHash } from 'node:crypto';
import type {
  CodeLocation,
  CrossRepositoryEdge,
  CrossRepositoryGraph,
  CrossRepositoryNode,
  CurrentSymbolRecord,
} from '../../extensions/code-knowledge.js';
import { GRAPH_SCHEMA_VERSION } from '../constants.js';
import {
  GRAPH_CROSS_REPOSITORY_FILE,
  UNRESOLVED_REASONS,
} from '../data/constants.js';
import { compareText } from '../files.js';
import { latestCommittedAt } from '../output.js';
import type {
  DetectionKind,
  GraphBuildState,
  GraphReport,
  UnresolvedItem,
  UnresolvedReason,
} from '../types.js';
import {
  RELATION_CONFIDENCE_RANK,
  UNRESOLVED_RATIO_DIGITS,
} from './constants.js';
import { LinkContext, recordLabel, unresolvedAt } from './context.js';
import {
  computeCoverage,
  providerContracts,
  relationCounts,
  unresolvedRatio,
} from './coverage.js';
import { linkGraphql } from './graphql.js';
import {
  conditionFacts,
  exceptionFacts,
  handlerChain,
} from './handler-chain.js';
import { linkHttp } from './http.js';
import { manualLinkDrafts } from './manual.js';
import { linkCronTriggers, linkMessaging } from './messaging.js';
import { linkPackages } from './package.js';
import { linkShares } from './shares.js';
import type {
  BuildCrossRepositoryOptions,
  CrossRepositoryBuild,
  LinkDraft,
} from './types.js';

/**
 * 저장소 간 그래프를 만든다. 순서: HTTP → GraphQL → 큐·이벤트 → 예약 작업(앞의 호출·발행을 따라) → 패키지 → 같은 자원 → 수동 연결
 * 받는 쪽 계약 가운데 부르는 쪽과 잇지 못한 것은 no-caller 로 남긴다. 다른 못 이은 항목의 후보로 이미 나온 심볼은 뺀다
 */
export function buildCrossRepositoryGraph(
  state: GraphBuildState,
  options: BuildCrossRepositoryOptions = {},
): CrossRepositoryBuild {
  const context = new LinkContext(state);
  const http = linkHttp(context);
  const graphql = linkGraphql(context);
  const messaging = linkMessaging(context);
  const cron = linkCronTriggers(context, [
    ...http.drafts,
    ...graphql.drafts,
    ...messaging.drafts,
  ]);
  const packages = linkPackages(context);
  const shares = linkShares(context);
  const manual = options.manualLinks
    ? manualLinkDrafts(context, options.manualLinks)
    : [];
  const edges = finalizeEdges(context, [
    ...http.drafts,
    ...graphql.drafts,
    ...messaging.drafts,
    ...cron,
    ...packages.drafts,
    ...shares.drafts,
    ...manual,
  ]);

  const unresolved = [
    ...http.unresolved,
    ...graphql.unresolved,
    ...messaging.unresolved,
    ...packages.unresolved,
  ];
  const providers = providerContracts(context);
  const { coverage, unresolvedProviders } = computeCoverage({
    expectedRepositories: context.repositories,
    auditedRepositories: [...context.recordsByRepository.keys()],
    edges,
    providers: new Set(providers.keys()),
    maxUnresolvedRatio: state.config.maxUnresolvedRatio,
  });
  const mentioned = new Set(
    unresolved.flatMap((item) => item.candidates ?? []),
  );
  for (const id of unresolvedProviders) {
    const provider = providers.get(id);
    if (!provider || mentioned.has(recordLabel(provider.record))) {
      continue;
    }
    for (const detection of provider.detections) {
      unresolved.push(
        detection.kind === 'http-route'
          ? unresolvedAt(
              detection,
              'HTTP_CALLS',
              'no-caller',
              `${detection.method.toUpperCase()} ${detection.path}`,
            )
          : unresolvedAt(
              detection,
              'GRAPHQL_CALLS',
              'no-caller',
              `${detection.operationType} ${detection.field}`,
            ),
      );
    }
  }

  const graph: CrossRepositoryGraph = {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    generatedAt: generatedAt(state),
    repositories: context.repositories,
    coverage,
    nodes: graphNodes(edges),
    edges,
  };
  return { graph, unresolved: sortUnresolved(unresolved) };
}

/**
 * report.json 을 만든다: coverage, 관계별 간선 수, 까닭별 못 이은 항목 수, 탐지기별 탐지 수, 추출 실패, 못 이은 항목
 * graph 를 주지 않으면 state.artifacts 의 cross-repository.json 을 읽는다
 */
export function buildGraphReport(
  state: GraphBuildState,
  unresolved: readonly UnresolvedItem[],
  graph = state.artifacts.get(GRAPH_CROSS_REPOSITORY_FILE) as
    CrossRepositoryGraph | undefined,
): GraphReport {
  if (!graph?.coverage) {
    throw new Error(
      `${GRAPH_CROSS_REPOSITORY_FILE} must be built before the report`,
    );
  }
  const coverage = graph.coverage;
  const reasons: Partial<Record<UnresolvedReason, number>> = {};
  for (const reason of UNRESOLVED_REASONS) {
    const count = unresolved.filter((item) => item.reason === reason).length;
    if (count > 0) {
      reasons[reason] = count;
    }
  }
  const detectorCounts = new Map<string, Map<DetectionKind, number>>();
  for (const detections of state.detections.values()) {
    for (const detection of detections) {
      const kinds = detectorCounts.get(detection.detector) ?? new Map();
      kinds.set(detection.kind, (kinds.get(detection.kind) ?? 0) + 1);
      detectorCounts.set(detection.detector, kinds);
    }
  }
  const detectors: GraphReport['detectors'] = {};
  for (const name of [...detectorCounts.keys()].sort(compareText)) {
    const kinds = detectorCounts.get(name) as Map<DetectionKind, number>;
    detectors[name] = Object.fromEntries(
      [...kinds.entries()].sort(([left], [right]) => compareText(left, right)),
    );
  }
  const extractionFailures = [...state.repositories]
    .sort((left, right) => compareText(left.manifest.name, right.manifest.name))
    .flatMap((build) =>
      build.manifest.failures.map((failure) => ({
        repository: build.manifest.name,
        filePath: failure.filePath,
        message: failure.message,
      })),
    );
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    generatedAt: graph.generatedAt ?? generatedAt(state),
    coverage,
    unresolvedRatio: Number(
      unresolvedRatio(
        coverage.providerContracts,
        coverage.unresolvedProviderContracts,
      ).toFixed(UNRESOLVED_RATIO_DIGITS),
    ),
    relations: relationCounts(graph.edges),
    reasons,
    detectors,
    extractionFailures,
    unresolved: sortUnresolved(unresolved),
  };
}

/**
 * 초안을 계약 모양 간선으로 바꾼다. (관계, source, target, 맞춘 값)이 같은 초안은 하나로 합치고 신뢰도는 높은 쪽을 남긴다
 * 실행 관계는 처리하는 쪽에서 handlerChain 을 따고, 부르는 쪽 조건과 처리하는 쪽(사슬 포함) 조건·예외 실행 사실을 단다
 */
function finalizeEdges(
  context: LinkContext,
  drafts: readonly LinkDraft[],
): CrossRepositoryEdge[] {
  const merged = new Map<string, LinkDraft>();
  for (const draft of drafts) {
    const key = [
      draft.relation,
      draft.source.stableSymbolId,
      draft.target.stableSymbolId,
      draft.extraction.value,
    ].join('\0');
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, draft);
    } else if (
      RELATION_CONFIDENCE_RANK[draft.confidence] >
      RELATION_CONFIDENCE_RANK[existing.confidence]
    ) {
      existing.confidence = draft.confidence;
    }
  }
  return [...merged.entries()]
    .map(([key, draft]) => toEdge(context, key, draft))
    .sort(compareEdges);
}

function toEdge(
  context: LinkContext,
  key: string,
  draft: LinkDraft,
): CrossRepositoryEdge {
  const edge: CrossRepositoryEdge = {
    id: `${draft.relation}:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
    relation: draft.relation,
    source: draft.source.stableSymbolId,
    target: draft.target.stableSymbolId,
    extraction: draft.extraction,
    confidence: draft.confidence,
    evidence: draft.evidence.filter((line) => line.trim() !== ''),
    sourceLocation: location(draft.source),
    targetLocation: location(draft.target),
  };
  if (!draft.roles) {
    return edge;
  }
  const chain = handlerChain(context.calls, draft.roles.handler);
  const handlers = [draft.roles.handler, ...chain];
  const callerConditions = conditionFacts(draft.roles.caller);
  const handlerConditions = handlers.flatMap(conditionFacts);
  const handlerExceptions = handlers.flatMap(exceptionFacts);
  return {
    ...edge,
    ...(chain.length > 0 ? { handlerChain: chain.map(location) } : {}),
    ...(callerConditions.length > 0 ? { callerConditions } : {}),
    ...(handlerConditions.length > 0 ? { handlerConditions } : {}),
    ...(handlerExceptions.length > 0 ? { handlerExceptions } : {}),
  };
}

function location(record: CurrentSymbolRecord): CodeLocation {
  const lineStart = record.lineStart ?? 1;
  return {
    repository: record.repository,
    filePath: record.filePath,
    symbol: record.symbol,
    lineStart,
    lineEnd: record.lineEnd ?? lineStart,
  };
}

function graphNodes(
  edges: readonly CrossRepositoryEdge[],
): CrossRepositoryNode[] {
  const nodes = new Map<string, CrossRepositoryNode>();
  for (const edge of edges) {
    for (const [id, place] of [
      [edge.source, edge.sourceLocation],
      [edge.target, edge.targetLocation],
    ] as const) {
      if (place && !nodes.has(id)) {
        nodes.set(id, {
          id,
          repositories: [place.repository],
          symbols: [place.symbol],
          recordTypes: ['current_symbol'],
        });
      }
    }
  }
  return [...nodes.values()].sort((left, right) =>
    compareText(left.id, right.id),
  );
}

function compareEdges(
  left: CrossRepositoryEdge,
  right: CrossRepositoryEdge,
): number {
  return (
    compareText(left.relation, right.relation) ||
    comparePlace(left.sourceLocation, right.sourceLocation) ||
    comparePlace(left.targetLocation, right.targetLocation) ||
    compareText(left.extraction.value, right.extraction.value) ||
    compareText(left.id, right.id)
  );
}

function comparePlace(
  left: CodeLocation | undefined,
  right: CodeLocation | undefined,
): number {
  return (
    compareText(left?.repository ?? '', right?.repository ?? '') ||
    compareText(left?.filePath ?? '', right?.filePath ?? '') ||
    (left?.lineStart ?? 0) - (right?.lineStart ?? 0) ||
    compareText(left?.symbol ?? '', right?.symbol ?? '')
  );
}

/** 같은 항목(관계·까닭·자리·값)은 앞 줄 하나만 남기고 저장소 → 파일 → 줄 → 심볼 → 관계 → 까닭 → 값 순서로 놓는다 */
function sortUnresolved(items: readonly UnresolvedItem[]): UnresolvedItem[] {
  const sorted = [...items].sort(
    (left, right) =>
      compareText(left.repository, right.repository) ||
      compareText(left.filePath, right.filePath) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      compareText(left.symbol, right.symbol) ||
      compareText(left.relation, right.relation) ||
      compareText(left.reason, right.reason) ||
      compareText(left.value, right.value) ||
      compareText(
        (left.candidates ?? []).join(','),
        (right.candidates ?? []).join(','),
      ),
  );
  const seen = new Set<string>();
  return sorted.filter((item) => {
    const key = [
      item.relation,
      item.reason,
      item.repository,
      item.filePath,
      item.symbol,
      item.value,
    ].join('\0');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function generatedAt(state: GraphBuildState): string {
  return latestCommittedAt(state.repositories.map((build) => build.manifest));
}

export {
  ManualLinkError,
  parseManualLinks,
  readManualLinks,
} from './manual.js';
export { formatGraphReport, readGraphReport } from './report.js';
