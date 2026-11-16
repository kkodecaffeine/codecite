import { describe, expect, it } from 'vitest';
import { PolicyChunk } from '../domain/policy-chunk.js';
import {
  tokenizePolicyDocumentText,
  tokenizePolicySearchQuery,
} from '../text/tokenizer.js';
import {
  DEFAULT_KOREAN_VOCABULARY,
  mergeVocabulary,
} from '../text/vocabulary.js';
import { rankPolicyChunksByBm25 } from './bm25-ranker.js';
import { BM25_B, BM25_K1 } from './constants.js';

const chunk = (id: string, text: string): PolicyChunk =>
  PolicyChunk.rehydrate({
    id,
    policyCode: id,
    section: '정책',
    text,
    source: 'policies.csv',
  });

describe('rankPolicyChunksByBm25', () => {
  it('질문 낱말을 모두 담은 조각을 일부만 담은 조각보다 앞에 둔다', () => {
    const chunks = [
      chunk('partial', '교환 접수는 마이페이지에서 한다'),
      chunk('full', '교환 배송비는 단순 변심이면 고객이 낸다'),
      chunk('none', '적립금 사용 순서'),
    ];

    expect(
      rankPolicyChunksByBm25('교환 배송비 고객', chunks, 3).map(
        (item) => item.id,
      ),
    ).toEqual(['full', 'partial']);
  });

  it('한국어 낱말과 영문 코드 이름을 동의어로 잇는다', () => {
    const chunks = [
      chunk('plain', '쿠폰 사용 내역'),
      chunk('english', '결제 cancel 이 오면 쿠폰 복구'),
    ];

    expect(
      rankPolicyChunksByBm25('쿠폰 취소', chunks, 2).map((item) => item.id),
    ).toEqual(['english', 'plain']);
  });

  it('구어체 시점 질문에도 지급 시점을 적은 조각을 먼저 찾는다', () => {
    const chunks = [
      chunk('other', '장바구니 상품은 품절되면 즉시 빠진다'),
      chunk(
        'timing',
        '리뷰 적립금은 글을 올린 즉시가 아니라 검수 뒤 지급한다.',
      ),
    ];

    expect(
      rankPolicyChunksByBm25('리뷰 적립금 즉시 지급돼?', chunks, 2).map(
        (item) => item.id,
      ),
    ).toEqual(['timing', 'other']);
  });

  it('빈 질문은 빈 순위를 돌려주고 동점은 입력 순서를 지킨다', () => {
    const chunks = [chunk('b', '같은 낱말'), chunk('a', '같은 낱말')];

    expect(rankPolicyChunksByBm25('', chunks, 2)).toEqual([]);
    expect(
      rankPolicyChunksByBm25('낱말', chunks, 10).map((item) => item.id),
    ).toEqual(['b', 'a']);
  });

  it('검색 전용 글로 찾되 답변 근거 글에는 드러내지 않는다', () => {
    const retrievalOnly = PolicyChunk.rehydrate({
      id: 'wrap-option',
      policyCode: 'WRAP',
      section: '정책',
      text: '포장 옵션 안내입니다.',
      searchText: '포장 옵션 안내입니다.\n[검색 키워드]\nboxing 상자',
      source: 'policies.csv',
    });

    expect(rankPolicyChunksByBm25('boxing 상자', [retrievalOnly], 1)).toEqual([
      retrievalOnly,
    ]);
    expect(retrievalOnly.text).not.toContain('boxing');
  });

  it('모든 문서를 처음부터 점수 매긴 결과와 순위가 같다', () => {
    const words = [
      '환불',
      '교환',
      '배송비',
      '쿠폰',
      '적립금',
      '등급',
      '실버',
      '골드',
      '반품',
      '포장',
      'refund',
      'shipping',
      'cancel',
      '취소',
      '만료',
      '익일',
      '적립',
      '상품',
      '주문은',
      '리뷰',
      '검증',
      '출고',
    ];
    let seed = 11;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const sentence = (length: number) =>
      Array.from({ length }, () => words[next() % words.length]).join(' ');
    const chunks = Array.from({ length: 180 }, (_, index) =>
      chunk(`row-${index % 140}`, sentence(2 + (next() % 22))),
    );
    const queries = [
      ...Array.from({ length: 40 }, () => sentence(1 + (next() % 5))),
      '쿠폰 취소',
      '사전에없는말',
    ];

    for (const query of queries) {
      for (const limit of [1, 4, 25, 400]) {
        expect(
          rankPolicyChunksByBm25(query, chunks, limit).map(
            (item) => `${item.id}:${chunks.indexOf(item)}`,
          ),
        ).toEqual(
          referenceBm25(query, chunks, limit).map(
            (item) => `${item.id}:${chunks.indexOf(item)}`,
          ),
        );
      }
    }
  });

  it('호출자가 같은 배열을 바꾸면 만들어 둔 색인을 다시 만든다', () => {
    const chunks = [chunk('first', '교환 접수')];
    expect(
      rankPolicyChunksByBm25('반품', chunks, 5).map((item) => item.id),
    ).toEqual([]);

    chunks.push(chunk('added', '반품 기한 안내'));
    expect(
      rankPolicyChunksByBm25('반품', chunks, 5).map((item) => item.id),
    ).toEqual(['added']);

    chunks[1] = chunk('replaced', '반품 반품 수거');
    expect(
      rankPolicyChunksByBm25('반품', chunks, 5).map((item) => item.id),
    ).toEqual(['replaced']);
  });

  it('서비스 사전의 동의어로 찾고, 사전마다 색인을 따로 둔다', () => {
    const vocabulary = mergeVocabulary(DEFAULT_KOREAN_VOCABULARY, {
      synonyms: { 포인트: ['적립금'] },
    });
    const chunks = [chunk('points', '적립금은 결제 금액의 1% 다')];

    expect(
      rankPolicyChunksByBm25('포인트', chunks, 5, vocabulary).map(
        (item) => item.id,
      ),
    ).toEqual(['points']);
    expect(rankPolicyChunksByBm25('포인트', chunks, 5)).toEqual([]);
  });
});

/** 역색인 없이 문서마다 토큰화해 모든 문서의 점수를 매기는 기준 구현 */
function referenceBm25(
  query: string,
  chunks: PolicyChunk[],
  limit: number,
): PolicyChunk[] {
  const queryTerms = tokenizePolicySearchQuery(query);
  if (queryTerms.length === 0 || chunks.length === 0) {
    return [];
  }
  const documents = chunks.map((item, index) => {
    const tokens = tokenizePolicyDocumentText(
      `${item.policyCode} ${item.section} ${item.searchText}`,
    );
    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    return { chunk: item, index, tokens, frequencies };
  });
  const averageLength =
    documents.reduce((sum, document) => sum + document.tokens.length, 0) /
    documents.length;
  const documentFrequency = new Map(
    queryTerms.map((term) => [
      term,
      documents.filter((document) => document.frequencies.has(term)).length,
    ]),
  );
  const termScore = (frequency: number, length: number, df: number) => {
    if (frequency === 0 || df === 0) {
      return 0;
    }
    const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
    const ratio = averageLength > 0 ? length / averageLength : 0;
    return (
      idf *
      ((frequency * (BM25_K1 + 1)) /
        (frequency + BM25_K1 * (1 - BM25_B + BM25_B * ratio)))
    );
  };
  return documents
    .map((document) => ({
      ...document,
      matched: queryTerms.filter((term) => document.frequencies.has(term))
        .length,
      score: queryTerms.reduce(
        (total, term) =>
          total +
          termScore(
            document.frequencies.get(term) ?? 0,
            document.tokens.length,
            documentFrequency.get(term) ?? 0,
          ),
        0,
      ),
    }))
    .filter((document) => document.score > 0)
    .sort(
      (left, right) =>
        right.matched - left.matched ||
        right.score - left.score ||
        left.index - right.index ||
        (left.chunk.id < right.chunk.id
          ? -1
          : left.chunk.id > right.chunk.id
            ? 1
            : 0),
    )
    .slice(0, Math.min(Math.max(Math.floor(limit), 1), chunks.length))
    .map((document) => document.chunk);
}
