import type { PolicyChunk } from '../domain/policy-chunk.js';
import {
  tokenizePolicyDocumentText,
  tokenizePolicySearchQuery,
} from '../text/tokenizer.js';
import type { Vocabulary } from '../text/types.js';
import { DEFAULT_KOREAN_VOCABULARY } from '../text/vocabulary.js';
import { BM25_B, BM25_K1 } from './constants.js';
import type { Bm25Posting, PreparedBm25Corpus } from './types.js';

/**
 * 조각 배열과 사전마다 한 번 만든 역색인. 같은 배열로 검색을 되풀이할 때 질문마다 모든 조각을 다시 토큰화하지 않는다
 * 큰 말뭉치를 질문마다 토큰화하면 그동안 이벤트 루프가 막혀 함께 시작한 검색이 줄지어 끝난다
 */
const preparedCorpora = new WeakMap<
  readonly PolicyChunk[],
  WeakMap<Vocabulary, PreparedBm25Corpus>
>();

/** 활성 정책 조각 전체에서 BM25 점수로 lexical 후보 순위를 만든다 */
export function rankPolicyChunksByBm25(
  query: string,
  chunks: PolicyChunk[],
  limit: number,
  vocabulary: Vocabulary = DEFAULT_KOREAN_VOCABULARY,
): PolicyChunk[] {
  const queryTerms = tokenizePolicySearchQuery(query, vocabulary);
  if (queryTerms.length === 0 || chunks.length === 0) {
    return [];
  }

  const corpus = preparedBm25Corpus(chunks, vocabulary);
  const documentCount = chunks.length;
  const postings = queryTerms.map((term) => corpus.postings.get(term));
  const documentFrequency = postings.map(
    (posting) => posting?.documents.length ?? 0,
  );
  // 질문 낱말이 하나도 없는 문서는 점수가 0 이라 걸러지므로 낱말이 나온 문서만 점수를 매긴다
  const termFrequencies = new Map<number, number[]>();
  postings.forEach((posting, termIndex) => {
    if (!posting) {
      return;
    }
    posting.documents.forEach((document, position) => {
      let frequencies = termFrequencies.get(document);
      if (!frequencies) {
        frequencies = new Array<number>(queryTerms.length).fill(0);
        termFrequencies.set(document, frequencies);
      }
      frequencies[termIndex] = posting.frequencies[position];
    });
  });

  return [...termFrequencies]
    .map(([index, frequencies]) => {
      const length = corpus.documentLengths[index];
      return {
        chunk: chunks[index],
        index,
        matchedQueryTerms: frequencies.filter((frequency) => frequency > 0)
          .length,
        // 낱말 순서대로 더해 문서 전체를 훑을 때와 같은 부동소수점 합을 만든다
        score: frequencies.reduce(
          (total, frequency, termIndex) =>
            total +
            bm25TermScore(
              frequency,
              length,
              corpus.averageLength,
              documentFrequency[termIndex],
              documentCount,
            ),
          0,
        ),
      };
    })
    .filter((document) => document.score > 0)
    .sort(
      (left, right) =>
        right.matchedQueryTerms - left.matchedQueryTerms ||
        right.score - left.score ||
        left.index - right.index ||
        compareIds(left.chunk.id, right.chunk.id),
    )
    .slice(0, clampLimit(limit, chunks.length))
    .map((document) => document.chunk);
}

/** 같은 배열·사전이면 만들어 둔 역색인을 쓰고, 호출자가 배열을 바꿨으면 다시 만든다 */
function preparedBm25Corpus(
  chunks: PolicyChunk[],
  vocabulary: Vocabulary,
): PreparedBm25Corpus {
  let byVocabulary = preparedCorpora.get(chunks);
  if (!byVocabulary) {
    byVocabulary = new WeakMap();
    preparedCorpora.set(chunks, byVocabulary);
  }
  const cached = byVocabulary.get(vocabulary);
  if (cached && sameChunks(cached.chunks, chunks)) {
    return cached;
  }
  const corpus = buildBm25Corpus(chunks, vocabulary);
  byVocabulary.set(vocabulary, corpus);
  return corpus;
}

function buildBm25Corpus(
  chunks: readonly PolicyChunk[],
  vocabulary: Vocabulary,
): PreparedBm25Corpus {
  const documentLengths: number[] = [];
  const growingPostings = new Map<
    string,
    { documents: number[]; frequencies: number[] }
  >();
  chunks.forEach((chunk, index) => {
    const tokens = tokenizePolicyDocumentText(
      `${chunk.policyCode} ${chunk.section} ${chunk.searchText}`,
      vocabulary,
    );
    documentLengths.push(tokens.length);
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    for (const [token, frequency] of frequencies) {
      let posting = growingPostings.get(token);
      if (!posting) {
        posting = { documents: [], frequencies: [] };
        growingPostings.set(token, posting);
      }
      posting.documents.push(index);
      posting.frequencies.push(frequency);
    }
  });
  const postings = new Map<string, Bm25Posting>();
  for (const [token, posting] of growingPostings) {
    postings.set(token, {
      documents: Int32Array.from(posting.documents),
      frequencies: Int32Array.from(posting.frequencies),
    });
  }
  const averageLength =
    documentLengths.reduce((sum, length) => sum + length, 0) /
    documentLengths.length;
  return { chunks: [...chunks], documentLengths, averageLength, postings };
}

function sameChunks(
  left: readonly PolicyChunk[],
  right: readonly PolicyChunk[],
): boolean {
  return (
    left.length === right.length &&
    left.every((chunk, index) => chunk === right[index])
  );
}

function bm25TermScore(
  frequency: number,
  documentLength: number,
  averageLength: number,
  documentFrequency: number,
  documentCount: number,
): number {
  if (frequency === 0 || documentFrequency === 0) {
    return 0;
  }

  const inverseDocumentFrequency = Math.log(
    1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
  );
  const lengthRatio = averageLength > 0 ? documentLength / averageLength : 0;
  const normalizedFrequency =
    (frequency * (BM25_K1 + 1)) /
    (frequency + BM25_K1 * (1 - BM25_B + BM25_B * lengthRatio));

  return inverseDocumentFrequency * normalizedFrequency;
}

function clampLimit(limit: number, corpusSize: number): number {
  const normalized = Number.isFinite(limit) ? Math.floor(limit) : 1;
  return Math.min(Math.max(normalized, 1), corpusSize);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
