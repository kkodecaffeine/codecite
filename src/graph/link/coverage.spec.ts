import { describe, expect, it } from 'vitest';
import type { CrossRepositoryEdge } from '../../extensions/code-knowledge.js';
import { computeCoverage } from './coverage.js';

const edge = (
  relation: CrossRepositoryEdge['relation'],
  target: string,
): CrossRepositoryEdge => ({
  id: `${relation}:${target}`,
  relation,
  source: 'caller',
  target,
  extraction: { kind: 'route', locator: 'src/a.ts:1', value: 'GET /a' },
  confidence: 'medium',
});

describe('computeCoverage', () => {
  const input = {
    expectedRepositories: ['shop-web', 'shop-api'],
    auditedRepositories: ['shop-api', 'shop-web'],
    edges: [
      edge('HTTP_CALLS', 'p1'),
      edge('HTTP_CALLS', 'p1'),
      edge('GRAPHQL_CALLS', 'p2'),
      edge('HTTP_CALLS', 'not-a-provider'),
      edge('SHARES_ENTITY', 'p3'),
    ],
    providers: new Set(['p1', 'p2', 'p3', 'p4']),
  };

  it('이은 계약은 HTTP·GraphQL 간선 target 과 계약의 교집합, 못 이은 계약은 정확한 차집합이다', () => {
    const { coverage, unresolvedProviders } = computeCoverage(input);
    expect(coverage).toEqual({
      status: 'pass',
      expectedRepositories: ['shop-api', 'shop-web'],
      auditedRepositories: ['shop-api', 'shop-web'],
      relationCounts: { HTTP_CALLS: 3, GRAPHQL_CALLS: 1, SHARES_ENTITY: 1 },
      providerContracts: 4,
      linkedProviderContracts: 2,
      unresolvedProviderContracts: 2,
    });
    expect(unresolvedProviders).toEqual(['p3', 'p4']);
  });

  it('레코드가 없는 기대 저장소가 있거나 못 이은 비율이 상한을 넘으면 fail 이다', () => {
    expect(
      computeCoverage({ ...input, auditedRepositories: ['shop-api'] }).coverage
        .status,
    ).toBe('fail');
    expect(
      computeCoverage({ ...input, maxUnresolvedRatio: 0.4 }).coverage.status,
    ).toBe('fail');
    expect(
      computeCoverage({ ...input, maxUnresolvedRatio: 0.5 }).coverage.status,
    ).toBe('pass');
    expect(
      computeCoverage({ ...input, providers: new Set(), maxUnresolvedRatio: 0 })
        .coverage,
    ).toMatchObject({ status: 'pass', providerContracts: 0 });
  });
});
