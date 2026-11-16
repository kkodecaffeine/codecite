import type { PolicyChunk } from '../domain/policy-chunk.js';
import { DEFAULT_RRF_CONSTANT } from './constants.js';
import type { PolicyRetrievalCandidate } from './types.js';

/** dense 와 lexical 의 원점수 대신 각 순위만 써서 후보를 합친다(Reciprocal Rank Fusion) */
export function fusePolicyRankings(
  denseRanking: PolicyChunk[],
  lexicalRanking: PolicyChunk[],
  limit: number,
  rrfConstant = DEFAULT_RRF_CONSTANT,
): PolicyRetrievalCandidate[] {
  const candidates = new Map<string, PolicyRetrievalCandidate>();

  addRanking(candidates, denseRanking, 'denseRank', rrfConstant);
  addRanking(candidates, lexicalRanking, 'lexicalRank', rrfConstant);

  return Array.from(candidates.values())
    .sort((left, right) => {
      const scoreDifference = right.fusedScore - left.fusedScore;
      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      const bestRankDifference = bestRank(left) - bestRank(right);
      return bestRankDifference || compareIds(left.chunk.id, right.chunk.id);
    })
    .slice(0, clampLimit(limit, candidates.size));
}

/** 같은 id 는 순위마다 한 번만 센다. 두 순위에 모두 나오면 lexical 쪽 조각(색인을 거치지 않은 최신 원문)을 쓴다 */
function addRanking(
  candidates: Map<string, PolicyRetrievalCandidate>,
  ranking: PolicyChunk[],
  rankKey: 'denseRank' | 'lexicalRank',
  rrfConstant: number,
): void {
  const seen = new Set<string>();
  let rank = 0;

  for (const chunk of ranking) {
    if (seen.has(chunk.id)) {
      continue;
    }
    seen.add(chunk.id);
    rank += 1;

    const candidate = candidates.get(chunk.id) ?? {
      chunk,
      fusedScore: 0,
    };
    if (rankKey === 'lexicalRank') {
      candidate.chunk = chunk;
    }
    candidate[rankKey] = rank;
    candidate.fusedScore += 1 / (rrfConstant + rank);
    candidates.set(chunk.id, candidate);
  }
}

function bestRank(candidate: PolicyRetrievalCandidate): number {
  return Math.min(
    candidate.denseRank ?? Number.POSITIVE_INFINITY,
    candidate.lexicalRank ?? Number.POSITIVE_INFINITY,
  );
}

function clampLimit(limit: number, candidateCount: number): number {
  const normalized = Number.isFinite(limit) ? Math.floor(limit) : 1;
  return Math.min(Math.max(normalized, 1), candidateCount);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
