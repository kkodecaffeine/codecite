import { describe, expect, it } from 'vitest';
import { PolicyChunk } from '../domain/policy-chunk.js';
import { prioritizePolicyEvidenceCandidates } from './evidence-prioritizer.js';
import type { PolicyRetrievalCandidate } from './types.js';

function candidate(id: string, text: string): PolicyRetrievalCandidate {
  return {
    chunk: PolicyChunk.rehydrate({
      id,
      policyCode: id,
      section: 'example',
      text,
      searchText: text,
      source: `${id}.csv`,
      contextKind: 'technical',
    }),
    fusedScore: 1,
  };
}

describe('prioritizePolicyEvidenceCandidates', () => {
  it('정책 이름과 무관하게 구체적인 규칙을 구조 설명보다 앞에 둔다', () => {
    const result = prioritizePolicyEvidenceCandidates('반품 배송비 조건', [
      candidate('outline', '반품 배송비 화면 구성 요소'),
      candidate(
        'rule',
        '수령 후 7일이 지나거나 포장을 뜯은 경우 반품 배송비는 고객이 낸다',
      ),
    ]);

    expect(result.map(({ chunk }) => chunk.id)).toEqual(['rule', 'outline']);
  });

  it('관련 없는 구체적인 규칙을 위 순위 구간으로 끌어올리지 않는다', () => {
    const result = prioritizePolicyEvidenceCandidates('실버등급 쿠폰', [
      candidate('silver-coupon', '실버등급 생일 쿠폰 지급'),
      candidate('band-1', '등급 조회'),
      candidate('band-2', '등급 갱신'),
      candidate('band-3', '실버등급 대상자 목록'),
      candidate('band-4', '쿠폰 만들기'),
      candidate(
        'unrelated-rule',
        '재고가 3개 이하이고 입고 예정일이 없는 경우 품절로 표시한다',
      ),
    ]);

    expect(result.slice(0, 5).map(({ chunk }) => chunk.id)).toContain(
      'silver-coupon',
    );
    expect(result[5].chunk.id).toBe('unrelated-rule');
  });

  it('같은 구간에서는 질문 낱말을 더 많이 담은 근거를 앞에 둔다', () => {
    const result = prioritizePolicyEvidenceCandidates('쿠폰 환불', [
      candidate('issue', '쿠폰 발급'),
      candidate('refund', '쿠폰 환불'),
    ]);

    expect(result.map(({ chunk }) => chunk.id)).toEqual(['refund', 'issue']);
  });
});
