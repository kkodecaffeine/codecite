import { describe, expect, it } from 'vitest';
import { PolicyChunk } from '../domain/policy-chunk.js';
import type { PolicyContextKind } from '../domain/types.js';
import { rankPolicyChunksByScope } from './scoped-ranker.js';

const chunk = (
  id: string,
  text: string,
  contextKind: PolicyContextKind,
): PolicyChunk =>
  PolicyChunk.rehydrate({
    id,
    policyCode: id,
    section: '정책',
    text,
    source: 'policies.csv',
    contextKind,
  });

const chunks = [
  chunk('policy-1', '쿠폰 환불 정책', 'policy'),
  chunk('policy-2', '쿠폰 발급 정책', 'policy'),
  chunk('policy-3', '쿠폰 만료 정책', 'policy'),
  chunk('technical-1', '쿠폰 환불 API', 'technical'),
  chunk('technical-2', '쿠폰 발급 API', 'technical'),
];

describe('rankPolicyChunksByScope', () => {
  it('조각 종류 하나만 검색하면 그 종류의 조각만 돌려준다', () => {
    expect(
      rankPolicyChunksByScope('쿠폰', chunks, ['policy'], 10).map(
        (item) => item.id,
      ),
    ).toEqual(['policy-1', 'policy-2', 'policy-3']);
  });

  it('여러 종류를 검색하면 종류별 순위를 번갈아 넣어 앞 종류가 자리를 다 쓰지 않게 한다', () => {
    expect(
      rankPolicyChunksByScope('쿠폰', chunks, ['technical', 'policy'], 4).map(
        (item) => item.id,
      ),
    ).toEqual(['technical-1', 'policy-1', 'technical-2', 'policy-2']);
  });

  it('배열을 바꾸면 종류별로 거른 배열도 다시 만든다', () => {
    const mutable = [chunk('policy-1', '쿠폰 환불 정책', 'policy')];
    expect(rankPolicyChunksByScope('쿠폰', mutable, ['technical'], 5)).toEqual(
      [],
    );

    mutable.push(chunk('technical-1', '쿠폰 환불 API', 'technical'));
    expect(
      rankPolicyChunksByScope('쿠폰', mutable, ['technical'], 5).map(
        (item) => item.id,
      ),
    ).toEqual(['technical-1']);
  });
});
