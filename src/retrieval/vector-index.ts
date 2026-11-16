import type { PolicyChunk } from '../domain/policy-chunk.js';
import type { PolicyContextKind } from '../domain/types.js';
import type { VectorIndex, VectorSearchOptions } from '../ports.js';
import { interleaveChunks } from './scoped-ranker.js';

/**
 * 조각 벡터를 메모리에 두고 코사인 유사도로 찾는 벡터 색인
 * 벡터는 넣을 때 길이 1 로 맞춰 두므로 검색은 내적 한 번으로 끝난다. 외부 벡터 저장소 없이 v0 의 dense 검색을 맡는다
 */
export class InMemoryVectorIndex implements VectorIndex {
  private chunks: PolicyChunk[] = [];
  private vectors: Float64Array[] = [];
  private vectorDimension?: number;

  /** 담긴 조각 수 */
  get size(): number {
    return this.chunks.length;
  }

  /** 담긴 벡터의 차원. 비어 있으면 없다 */
  get dimension(): number | undefined {
    return this.vectorDimension;
  }

  /**
   * 조각과 벡터로 색인을 통째로 바꾼다. 개수나 차원이 어긋나거나 숫자가 아닌 값이 있으면 아무것도 바꾸지 않고 throw 한다
   * 넘겨받은 배열은 복사해 두므로 호출자가 나중에 바꿔도 색인은 그대로다
   */
  async rebuild(
    chunks: readonly PolicyChunk[],
    embeddings: readonly (readonly number[])[],
  ): Promise<void> {
    if (chunks.length !== embeddings.length) {
      throw new Error(
        `Vector index needs one embedding per chunk: ${chunks.length} chunks, ${embeddings.length} embeddings.`,
      );
    }
    const dimension = embeddings[0]?.length;
    const vectors = embeddings.map((embedding, index) => {
      if (embedding.length === 0 || embedding.length !== dimension) {
        throw new Error(
          `Embedding ${index} has ${embedding.length} dimensions; expected ${dimension}.`,
        );
      }
      return unitVector(embedding, `Embedding ${index}`);
    });
    this.chunks = [...chunks];
    this.vectors = vectors;
    this.vectorDimension = dimension;
  }

  /**
   * 질문 벡터와 코사인 유사도가 높은 순서로 조각을 돌려준다. 같으면 먼저 넣은 조각이 앞이다
   * 조각 종류를 하나 주면 그 종류만, 여러 개 주면 종류별 순위를 번갈아 넣어 한 종류가 자리를 다 쓰지 않게 한다
   */
  async search(
    queryVector: readonly number[],
    limit: number,
    options: VectorSearchOptions = {},
  ): Promise<PolicyChunk[]> {
    const normalizedLimit = Number.isFinite(limit) ? Math.floor(limit) : 0;
    if (normalizedLimit <= 0 || this.chunks.length === 0) {
      return [];
    }
    if (queryVector.length !== this.vectorDimension) {
      throw new Error(
        `Query vector has ${queryVector.length} dimensions; the index has ${this.vectorDimension}.`,
      );
    }
    const query = unitVector(queryVector, 'Query vector');
    const contextKinds = [...new Set(options.contextKinds ?? [])];
    if (contextKinds.length <= 1) {
      return this.rank(query, normalizedLimit, contextKinds[0]);
    }
    return interleaveChunks(
      contextKinds.map((contextKind) =>
        this.rank(query, normalizedLimit, contextKind),
      ),
      normalizedLimit,
    );
  }

  private rank(
    query: Float64Array,
    limit: number,
    contextKind?: PolicyContextKind,
  ): PolicyChunk[] {
    return this.chunks
      .map((chunk, index) => ({ chunk, index }))
      .filter(
        ({ chunk }) =>
          contextKind === undefined || chunk.contextKind === contextKind,
      )
      .map(({ chunk, index }) => ({
        chunk,
        index,
        score: dot(query, this.vectors[index]),
      }))
      .sort(
        (left, right) => right.score - left.score || left.index - right.index,
      )
      .slice(0, limit)
      .map(({ chunk }) => chunk);
  }
}

/** 길이 1 로 맞춘 사본. 길이가 0 인 벡터는 어느 벡터와도 유사도 0 이 되도록 그대로 둔다 */
function unitVector(values: readonly number[], label: string): Float64Array {
  const vector = Float64Array.from(values);
  if (!vector.every(Number.isFinite)) {
    throw new Error(`${label} contains a value that is not a finite number.`);
  }
  const norm = Math.sqrt(dot(vector, vector));
  if (norm > 0) {
    for (let index = 0; index < vector.length; index += 1) {
      vector[index] /= norm;
    }
  }
  return vector;
}

function dot(left: Float64Array, right: Float64Array): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += left[index] * right[index];
  }
  return sum;
}
