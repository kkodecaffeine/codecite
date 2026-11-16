import { describe, expect, it } from 'vitest';
import {
  createKnowledgeClaim,
  knowledgeClaimSearchText,
  normalizePolicyClaimConfidence,
  normalizePolicyClaimFacet,
  normalizePolicyGroup,
  stablePolicyClaimId,
} from './policy-claim.js';

describe('KnowledgeClaim v2', () => {
  it('원천 종류에 따라 안전한 기본 지식 종류를 부여한다', () => {
    const code = createKnowledgeClaim({
      sourceKind: 'code',
      subject: 'order archiver',
      predicate: 'moves',
      value: 'cold storage',
      conditions: [],
      exceptions: [],
      facet: 'outcome',
      statement: 'order archiver moves old orders',
      confidence: 'high',
      status: 'active',
      provenanceChunkIds: [],
      relations: [],
      provenance: [
        {
          sourceId: 'code:order-archiver',
          sourceKind: 'code',
          sourceLabel: 'order archiver',
          publicAnswerSafe: true,
        },
      ],
    });

    expect(code.knowledgeKind).toBe('implementation-detail');
  });

  const provenance = {
    sourceId: 'code:point-expiry',
    sourceKind: 'code' as const,
    sourceLabel: 'dotori-shop#expirePoints',
    repository: 'dotori-shop',
    filePath: 'src/points/point-expiry.service.ts',
    symbol: 'expirePoints',
    publicAnswerSafe: true,
  };

  it('주체·서술어·값·조건·출처를 가진 안정적 claim 을 만든다', () => {
    const first = createKnowledgeClaim({
      sourceKind: 'code',
      subject: 'point expiry',
      predicate: 'expires after',
      value: '365 days',
      conditions: ['membership = basic'],
      exceptions: [],
      facet: 'expiration',
      statement: '기본 등급 적립금은 적립일부터 365 일 뒤 사라진다.',
      confidence: 'high',
      status: 'active',
      provenance: [provenance],
      provenanceChunkIds: [],
      relations: [],
    });
    const second = createKnowledgeClaim({ ...first, claimId: undefined });

    expect(first.schemaVersion).toBe(2);
    expect(first.claimId).toBe(second.claimId);
    expect(first.provenanceVersionId).toBe(second.provenanceVersionId);
    expect(first.conditions).toEqual(['membership = basic']);
  });

  it('특정 업무와 무관하게 구조화 claim 을 자연어 검색 문서로 확장한다', () => {
    const claim = createKnowledgeClaim({
      sourceKind: 'code',
      policyGroup: 'coupon-stacking',
      subject: 'CouponStackingRule',
      predicate: 'blocks',
      value: 'SecondCoupon',
      conditions: ['appliedCoupons > 1'],
      exceptions: [],
      facet: 'exception',
      statement: 'CouponStackingRule blocks SecondCoupon',
      confidence: 'high',
      status: 'active',
      provenance: [provenance],
      provenanceChunkIds: [],
      relations: [],
    });

    const text = knowledgeClaimSearchText(claim);

    expect(text).toContain('topic: coupon stacking');
    expect(text).toContain('subject terms: Coupon Stacking Rule');
    expect(text).toMatch(/^facet: exception [가-힣 ]*예외/mu);
    expect(text).toMatch(/조건은 applied Coupons > 1/u);
  });

  it('출처가 없는 claim 을 거부한다', () => {
    expect(() =>
      createKnowledgeClaim({
        sourceKind: 'policy',
        subject: 'coupon',
        predicate: 'applicable',
        value: 'false',
        conditions: [],
        exceptions: [],
        facet: 'eligibility',
        statement: 'not applicable',
        confidence: 'high',
        status: 'active',
        provenance: [],
        provenanceChunkIds: [],
        relations: [],
      }),
    ).toThrow('provenance is required');
  });

  it('호출자가 준 오래된 provenance version 을 신뢰하지 않고 다시 계산한다', () => {
    const claim = createKnowledgeClaim({
      sourceKind: 'code',
      subject: 'coupon',
      predicate: 'applies',
      value: 'welcome coupon',
      conditions: [],
      exceptions: [],
      facet: 'outcome',
      statement: 'applies welcome coupon',
      confidence: 'high',
      status: 'active',
      provenanceChunkIds: [],
      relations: [],
      provenanceVersionId: 'stale-version',
      provenance: [{ ...provenance, contentHash: 'new-content-hash' }],
    });

    expect(claim.provenanceVersionId).not.toBe('stale-version');
    expect(claim.provenanceVersionId).toMatch(/^knowledge-provenance-/);
  });
});

describe('policy claim 정규화', () => {
  it('묶음 이름을 소문자와 하이픈으로 맞춘다', () => {
    expect(normalizePolicyGroup('  Points Expiry ')).toBe('points-expiry');
    expect(normalizePolicyGroup('적립금 / 만료')).toBe('적립금-만료');
  });

  it('알 수 없는 facet 은 outcome, high 가 아닌 신뢰도는 low 로 본다', () => {
    expect(normalizePolicyClaimFacet(' Reversal ')).toBe('reversal');
    expect(normalizePolicyClaimFacet('refund')).toBe('outcome');
    expect(normalizePolicyClaimConfidence('HIGH')).toBe('high');
    expect(normalizePolicyClaimConfidence('')).toBe('low');
  });

  it('묶음·종류·문장이 같으면 행 위치와 무관하게 같은 claim id 를 만든다', () => {
    const statement = '환불은 결제 수단으로 3 영업일 안에 돌아간다.';
    const id = stablePolicyClaimId({
      policyGroup: 'refund',
      facet: 'duration',
      statement,
    });

    expect(id).toMatch(/^claim-[0-9a-f]{16}$/);
    expect(
      stablePolicyClaimId({
        policyGroup: 'refund',
        facet: ' DURATION ',
        statement: ` ${statement} `,
      }),
    ).toBe(id);
    expect(
      stablePolicyClaimId({
        policyGroup: 'points',
        facet: 'duration',
        statement,
      }),
    ).not.toBe(id);
  });
});
