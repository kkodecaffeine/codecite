import { describe, expect, it } from 'vitest';
import { PolicyChunk } from './policy-chunk.js';
import { PolicyCode } from './policy-code.js';
import { PolicyStatus } from './policy-status.js';
import { Policy } from './policy.js';
import type { PolicyClaimProps } from './types.js';

const claim: PolicyClaimProps = {
  claimId: 'claim-points-expiry',
  policyGroup: 'points',
  facet: 'expiration',
  statement: '적립금은 적립일부터 1 년 뒤 사라진다.',
  confidence: 'high',
  provenanceChunkIds: [],
};

const policy = Policy.create({
  name: '적립금 만료',
  decision: claim.statement,
  status: PolicyStatus.of('Active'),
  section: 'points',
  code: PolicyCode.of('POINTS-002'),
  source: 'policies.csv#row-3',
  policyGroup: 'points',
  policyClaims: [claim],
});

describe('PolicyChunk', () => {
  it('정책 조각의 claim 에 출처 조각 id 가 없으면 정책 행 id 를 채운다', () => {
    const chunk = PolicyChunk.fromPolicy(policy, {
      contextKind: 'policy',
      text: '[정책]\n- 적립금은 1 년 뒤 사라집니다.',
      searchText: '도메인: points',
    });

    expect(chunk.id).toBe('policies.csv#row-3#POINTS-002');
    expect(chunk.policyGroup).toBe('points');
    expect(chunk.policyClaims).toEqual([
      { ...claim, provenanceChunkIds: ['policies.csv#row-3#POINTS-002'] },
    ]);
    expect(chunk.symbol).toBeUndefined();
    expect(chunk.relationTargets).toEqual([]);
  });

  it('기술 조각에는 claim 을 싣지 않는다', () => {
    const chunk = PolicyChunk.fromPolicy(policy, {
      contextKind: 'technical',
      text: '[API]\n- POST /points/expire',
      searchText: '',
    });

    expect(chunk.id).toBe('policies.csv#row-3#POINTS-002#technical');
    expect(chunk.policyClaims).toEqual([]);
    expect(chunk.searchText).toBe('[API]\n- POST /points/expire');
  });

  it('코드 심볼 문서에서 심볼·위치·관계 대상을 읽는다', () => {
    const chunk = PolicyChunk.fromPolicy(policy, {
      contextKind: 'technical',
      text: [
        '[심볼]',
        'PointExpiryJob.run',
        '',
        '[구조]',
        '- 위치: src/points/point-expiry.job.ts:12-40',
        '',
        '[관계]',
        '- CALLS: PointLedger.expire',
        '- CALLS: PointLedger.expire',
        '- READS: point_ledger',
      ].join('\n'),
      searchText: 'PointExpiryJob.run',
    });

    expect(chunk.symbol).toBe('PointExpiryJob.run');
    expect(chunk.sourceFile).toBe('src/points/point-expiry.job.ts');
    expect(chunk.lineStart).toBe(12);
    expect(chunk.relationTargets).toEqual([
      'PointLedger.expire',
      'point_ledger',
    ]);
  });

  it('조각 종류가 없던 예전 조각은 정책으로 읽되 메타데이터가 없다고 알린다', () => {
    const legacy = PolicyChunk.rehydrate({
      id: 'legacy',
      policyCode: 'POINTS-001',
      section: 'points',
      text: '적립금 안내',
      source: 'policies.csv#row-2',
    });

    expect(legacy.contextKind).toBe('policy');
    expect(legacy.hasContextKindMetadata).toBe(false);
    expect(legacy.searchText).toBe('적립금 안내');
    expect(legacy.toJSON()).toMatchObject({
      contextKind: 'policy',
      searchText: '적립금 안내',
    });
  });
});
