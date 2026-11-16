// 저장소 간 그래프가 받는 쪽 계약을 얼마나 덮었는지. 수를 빼서 어림하지 않고 처리 심볼 집합의 차로 정확히 센다
// - 받는 쪽 계약: http-route·graphql-resolver 탐지의 처리 심볼(같은 심볼은 하나로 센다). 필드 리졸버(`부모.필드`)는 뺀다
// - 이은 계약: HTTP_CALLS·GRAPHQL_CALLS 간선(수동 연결 포함)의 target 가운데 받는 쪽 계약인 것
// - 못 이은 계약: 받는 쪽 계약 − 이은 계약. 그래서 이은 수 + 못 이은 수 = 계약 수다
// - status: 기대 저장소 가운데 레코드가 없는 저장소가 있거나, maxUnresolvedRatio 를 정했고 못 이은 비율이 그보다 크면 fail
import type {
  CrossRepositoryCoverage,
  CrossRepositoryRelation,
  CurrentSymbolRecord,
} from '../../extensions/code-knowledge.js';
import { compareText } from '../files.js';
import type { GraphqlResolverDetection, HttpRouteDetection } from '../types.js';
import { CROSS_REPOSITORY_RELATIONS } from '../data/constants.js';
import { PROVIDER_RELATIONS } from './constants.js';
import type { LinkContext } from './context.js';
import { isRootField } from './graphql.js';
import type { CoverageInput } from './types.js';

/** 받는 쪽 계약: 처리 심볼 id → 그 심볼과 계약 탐지들 */
export function providerContracts(context: LinkContext): Map<
  string,
  {
    record: CurrentSymbolRecord;
    detections: Array<HttpRouteDetection | GraphqlResolverDetection>;
  }
> {
  const result = new Map<
    string,
    {
      record: CurrentSymbolRecord;
      detections: Array<HttpRouteDetection | GraphqlResolverDetection>;
    }
  >();
  for (const detection of context.detectionsOf(
    'http-route',
    'graphql-resolver',
  )) {
    if (
      detection.kind === 'graphql-resolver' &&
      !isRootField(detection.field)
    ) {
      continue;
    }
    const record = context.recordFor(detection);
    if (!record) {
      continue;
    }
    const entry = result.get(record.stableSymbolId) ?? {
      record,
      detections: [],
    };
    entry.detections.push(detection);
    result.set(record.stableSymbolId, entry);
  }
  return result;
}

/** coverage 와 못 이은 계약 id(정렬) */
export function computeCoverage(input: CoverageInput): {
  coverage: CrossRepositoryCoverage;
  unresolvedProviders: string[];
} {
  const linkedTargets = new Set(
    input.edges
      .filter((edge) => PROVIDER_RELATIONS.includes(edge.relation))
      .map((edge) => edge.target),
  );
  const providers = [...input.providers].sort(compareText);
  const linked = providers.filter((id) => linkedTargets.has(id));
  const unresolved = providers.filter((id) => !linkedTargets.has(id));
  const expected = [...new Set(input.expectedRepositories)].sort(compareText);
  const audited = [...new Set(input.auditedRepositories)].sort(compareText);
  const missing = expected.some((repository) => !audited.includes(repository));
  const ratio = unresolvedRatio(providers.length, unresolved.length);
  const overLimit =
    input.maxUnresolvedRatio !== undefined && ratio > input.maxUnresolvedRatio;
  return {
    coverage: {
      status: missing || overLimit ? 'fail' : 'pass',
      expectedRepositories: expected,
      auditedRepositories: audited,
      relationCounts: relationCounts(input.edges),
      providerContracts: providers.length,
      linkedProviderContracts: linked.length,
      unresolvedProviderContracts: unresolved.length,
    },
    unresolvedProviders: unresolved,
  };
}

/** 못 이은 계약 비율. 계약이 없으면 0 */
export function unresolvedRatio(providers: number, unresolved: number): number {
  return providers === 0 ? 0 : unresolved / providers;
}

/** 관계별 간선 수. 키는 계약의 관계 순서이고, 없는 관계는 넣지 않는다 */
export function relationCounts(
  edges: readonly { relation: CrossRepositoryRelation }[],
): Partial<Record<CrossRepositoryRelation, number>> {
  const counts: Partial<Record<CrossRepositoryRelation, number>> = {};
  for (const relation of CROSS_REPOSITORY_RELATIONS) {
    const count = edges.filter((edge) => edge.relation === relation).length;
    if (count > 0) {
      counts[relation] = count;
    }
  }
  return counts;
}
