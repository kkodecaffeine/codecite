import { describe, expect, it } from 'vitest';
import { PolicyChunk } from '../domain/policy-chunk.js';
import type { PolicyContextKind } from '../domain/types.js';
import { InMemoryVectorIndex } from './vector-index.js';

const chunk = (
  id: string,
  contextKind: PolicyContextKind = 'policy',
): PolicyChunk =>
  PolicyChunk.rehydrate({
    id,
    policyCode: id,
    section: '정책',
    text: id,
    source: 'claims.csv',
    contextKind,
  });

const ids = (chunks: PolicyChunk[]): string[] => chunks.map((item) => item.id);

describe('InMemoryVectorIndex', () => {
  it('질문 벡터와 코사인 유사도가 높은 순서로 limit 개까지 돌려준다', async () => {
    const index = new InMemoryVectorIndex();
    await index.rebuild(
      [chunk('wrapping'), chunk('parcel'), chunk('voucher')],
      [
        [0, 5, 0],
        [9, 1, 0],
        [1, 1, 1],
      ],
    );

    // 벡터 길이가 아니라 방향으로 비교하므로 [9, 1, 0] 이 [2, 0, 0] 에 가장 가깝다
    expect(ids(await index.search([2, 0, 0], 2))).toEqual([
      'parcel',
      'voucher',
    ]);
    expect(index.size).toBe(3);
    expect(index.dimension).toBe(3);
  });

  it('유사도가 같으면 먼저 넣은 조각을 앞에 둔다', async () => {
    const index = new InMemoryVectorIndex();
    await index.rebuild(
      [chunk('first'), chunk('second'), chunk('third')],
      [
        [0, 3],
        [0, 7],
        [4, 0],
      ],
    );

    expect(ids(await index.search([0, 1], 3))).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('조각 종류를 하나 주면 그 종류만, 여러 개 주면 종류별 순위를 번갈아 돌려준다', async () => {
    const index = new InMemoryVectorIndex();
    await index.rebuild(
      [
        chunk('policy-near'),
        chunk('policy-far'),
        chunk('technical-near', 'technical'),
        chunk('technical-far', 'technical'),
      ],
      [
        [1, 0],
        [1, 1],
        [1, 0.1],
        [0, 1],
      ],
    );

    expect(
      ids(await index.search([1, 0], 5, { contextKinds: ['technical'] })),
    ).toEqual(['technical-near', 'technical-far']);
    expect(
      ids(
        await index.search([1, 0], 3, {
          contextKinds: ['technical', 'policy'],
        }),
      ),
    ).toEqual(['technical-near', 'policy-near', 'technical-far']);
  });

  it('길이가 0 인 벡터는 어느 질문과도 유사도 0 으로 본다', async () => {
    const index = new InMemoryVectorIndex();
    await index.rebuild(
      [chunk('blank'), chunk('opposite')],
      [
        [0, 0],
        [-1, 0],
      ],
    );

    expect(ids(await index.search([1, 0], 2))).toEqual(['blank', 'opposite']);
  });

  it('비어 있거나 limit 이 1 보다 작으면 빈 배열을 돌려준다', async () => {
    const index = new InMemoryVectorIndex();
    expect(await index.search([1, 0], 3)).toEqual([]);

    await index.rebuild([chunk('only')], [[1, 0]]);
    expect(await index.search([1, 0], 0)).toEqual([]);
    expect(await index.search([1, 0], Number.NaN)).toEqual([]);
  });

  it('조각과 벡터의 개수·차원이 어긋나거나 숫자가 아닌 값이 있으면 throw 하고 전 색인을 지킨다', async () => {
    const index = new InMemoryVectorIndex();
    await index.rebuild([chunk('kept')], [[1, 0]]);

    await expect(
      index.rebuild([chunk('a'), chunk('b')], [[1, 0]]),
    ).rejects.toThrow('one embedding per chunk');
    await expect(
      index.rebuild(
        [chunk('a'), chunk('b')],
        [
          [1, 0],
          [1, 0, 0],
        ],
      ),
    ).rejects.toThrow('dimensions');
    await expect(index.rebuild([chunk('a')], [[]])).rejects.toThrow(
      'dimensions',
    );
    await expect(
      index.rebuild([chunk('a')], [[1, Number.POSITIVE_INFINITY]]),
    ).rejects.toThrow('finite');

    expect(ids(await index.search([1, 0], 5))).toEqual(['kept']);
  });

  it('질문 벡터의 차원이 색인과 다르면 throw 한다', async () => {
    const index = new InMemoryVectorIndex();
    await index.rebuild([chunk('two-dimensional')], [[1, 0]]);

    await expect(index.search([1, 0, 0], 1)).rejects.toThrow('dimensions');
  });

  it('넘겨받은 배열을 나중에 바꿔도 색인은 그대로다', async () => {
    const chunks = [chunk('north'), chunk('east')];
    const embeddings = [
      [0, 1],
      [1, 0],
    ];
    const index = new InMemoryVectorIndex();
    await index.rebuild(chunks, embeddings);

    chunks.reverse();
    embeddings[0][0] = 100;

    expect(ids(await index.search([0, 1], 1))).toEqual(['north']);
  });

  it('빈 조각으로 다시 만들면 색인을 비운다', async () => {
    const index = new InMemoryVectorIndex();
    await index.rebuild([chunk('gone')], [[1]]);
    await index.rebuild([], []);

    expect(index.size).toBe(0);
    expect(index.dimension).toBeUndefined();
    expect(await index.search([1], 1)).toEqual([]);
  });
});
