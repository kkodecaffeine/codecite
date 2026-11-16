import { describe, expect, it } from 'vitest';
import { PolicyChunk } from '../domain/policy-chunk.js';
import { fusePolicyRankings } from './rrf.js';

const chunk = (id: string, text = id): PolicyChunk =>
  PolicyChunk.rehydrate({
    id,
    policyCode: id,
    section: '정책',
    text,
    source: 'policies.csv',
  });

describe('fusePolicyRankings', () => {
  it('각 순위만 쓰고 두 순위에 모두 나온 후보를 앞에 둔다', () => {
    const a = chunk('a');
    const b = chunk('b');
    const c = chunk('c');

    const result = fusePolicyRankings([a, b], [c, b], 20);

    expect(result.map((candidate) => candidate.chunk.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
    expect(result[0]).toMatchObject({ denseRank: 2, lexicalRank: 2 });
    expect(result[0].fusedScore).toBeCloseTo(2 / 62);
  });

  it('순위마다 중복을 걷어 내고 동점은 가장 좋은 순위, 그다음 id 로 가른다', () => {
    const a = chunk('a');
    const b = chunk('b');

    const result = fusePolicyRankings([b, b], [a, a], 20);

    expect(result.map((candidate) => candidate.chunk.id)).toEqual(['a', 'b']);
    expect(result).toHaveLength(2);
  });

  it('같은 id 가 두 순위에 있으면 lexical 쪽 조각을 근거로 쓴다', () => {
    const result = fusePolicyRankings(
      [chunk('same', 'copy kept in the vector index')],
      [chunk('same', 'row read from the csv just now')],
      20,
    );

    expect(result[0].chunk.text).toBe('row read from the csv just now');
    expect(result[0]).toMatchObject({ denseRank: 1, lexicalRank: 1 });
  });

  it('남길 개수를 넘지 않고 후보가 없으면 빈 목록을 돌려준다', () => {
    expect(
      fusePolicyRankings([chunk('a'), chunk('b')], [chunk('c')], 2),
    ).toHaveLength(2);
    expect(fusePolicyRankings([], [], 5)).toEqual([]);
  });
});
