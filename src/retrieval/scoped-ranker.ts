import type { PolicyChunk } from '../domain/policy-chunk.js';
import type { PolicyContextKind } from '../domain/types.js';
import type { Vocabulary } from '../text/types.js';
import { DEFAULT_KOREAN_VOCABULARY } from '../text/vocabulary.js';
import { rankPolicyChunksByBm25 } from './bm25-ranker.js';

/**
 * 같은 조각 배열에서 조각 종류별로 거른 배열을 다시 쓴다
 * BM25 역색인이 배열 객체마다 한 번만 만들어지므로 거른 배열도 질문마다 같은 객체여야 한다
 */
const chunksByContextKind = new WeakMap<
  readonly PolicyChunk[],
  {
    snapshot: readonly PolicyChunk[];
    byKind: Map<PolicyContextKind, PolicyChunk[]>;
  }
>();

function chunksOfKind(
  chunks: PolicyChunk[],
  contextKind: PolicyContextKind,
): PolicyChunk[] {
  let cached = chunksByContextKind.get(chunks);
  if (
    !cached ||
    cached.snapshot.length !== chunks.length ||
    !cached.snapshot.every((chunk, index) => chunk === chunks[index])
  ) {
    cached = { snapshot: [...chunks], byKind: new Map() };
    chunksByContextKind.set(chunks, cached);
  }
  let filtered = cached.byKind.get(contextKind);
  if (!filtered) {
    filtered = chunks.filter((chunk) => chunk.contextKind === contextKind);
    cached.byKind.set(contextKind, filtered);
  }
  return filtered;
}

/** 여러 조각 종류를 검색할 때 종류별 lexical 후보를 번갈아 넣어 앞 종류가 자리를 다 쓰지 않게 한다 */
export function rankPolicyChunksByScope(
  query: string,
  chunks: PolicyChunk[],
  contextKinds: PolicyContextKind[],
  limit: number,
  vocabulary: Vocabulary = DEFAULT_KOREAN_VOCABULARY,
): PolicyChunk[] {
  if (contextKinds.length === 1) {
    return rankPolicyChunksByBm25(
      query,
      chunksOfKind(chunks, contextKinds[0]),
      limit,
      vocabulary,
    );
  }

  return interleaveChunks(
    contextKinds.map((contextKind) =>
      rankPolicyChunksByBm25(
        query,
        chunksOfKind(chunks, contextKind),
        limit,
        vocabulary,
      ),
    ),
    limit,
  );
}

function interleaveChunks(
  rankings: PolicyChunk[][],
  limit: number,
): PolicyChunk[] {
  const result: PolicyChunk[] = [];
  const maxLength = Math.max(0, ...rankings.map((ranking) => ranking.length));
  for (let rank = 0; rank < maxLength && result.length < limit; rank += 1) {
    for (const ranking of rankings) {
      const chunk = ranking[rank];
      if (chunk) {
        result.push(chunk);
      }
      if (result.length >= limit) {
        break;
      }
    }
  }
  return result;
}
