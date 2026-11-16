import type { Vocabulary, VocabularyLookup } from './types.js';
import { DEFAULT_KOREAN_VOCABULARY } from './vocabulary.js';

/** 사전마다 한 번만 만드는 조회 구조. 사전 객체는 쓰는 동안 바꾸지 않는다고 본다 */
const lookups = new WeakMap<Vocabulary, VocabularyLookup>();

/** 한국어와 영문 검색 문장을 동의어가 포함된 고유 토큰 목록으로 바꾼다 */
export function tokenizePolicySearchText(
  value: string,
  vocabulary: Vocabulary = DEFAULT_KOREAN_VOCABULARY,
): string[] {
  return Array.from(new Set(expandPolicySearchText(value, vocabulary)));
}

/** 자연어 정책 질문에서 조사와 질문 말투 낱말을 걷어 낸 검색 토큰을 만든다 */
export function tokenizePolicySearchQuery(
  value: string,
  vocabulary: Vocabulary = DEFAULT_KOREAN_VOCABULARY,
): string[] {
  const { stopwords } = lookupFor(vocabulary);
  const terms = rawTerms(value)
    .map(normalizeKoreanSearchTerm)
    .filter((term) => term && !stopwords.has(term));
  return Array.from(new Set(expandTerms(value, terms, vocabulary)));
}

/** BM25 문서 길이와 낱말 빈도를 보존하는 토큰 목록을 만든다 */
export function tokenizePolicyDocumentText(
  value: string,
  vocabulary: Vocabulary = DEFAULT_KOREAN_VOCABULARY,
): string[] {
  return expandPolicySearchText(value, vocabulary);
}

function expandPolicySearchText(
  value: string,
  vocabulary: Vocabulary,
): string[] {
  const terms = rawTerms(value).flatMap((term) => {
    const normalized = normalizeKoreanSearchTerm(term);
    return normalized && normalized !== term ? [term, normalized] : [term];
  });
  return expandTerms(value, terms, vocabulary);
}

function rawTerms(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function expandTerms(
  value: string,
  terms: string[],
  vocabulary: Vocabulary,
): string[] {
  const normalized = value.toLowerCase();
  const embeddedSynonymKeys = lookupFor(vocabulary).synonymKeys.filter(
    (term) => normalized.includes(term) && !terms.includes(term),
  );

  return terms
    .flatMap((term) => [term, ...synonymsFor(term, vocabulary)])
    .concat(
      embeddedSynonymKeys.flatMap((term) => [
        term,
        ...synonymsFor(term, vocabulary),
      ]),
    );
}

/** 낱말 끝의 조사·어미·질문 말투를 걷어 낸다. 두 글자 이하는 명사가 깨지지 않게 그대로 둔다 */
function normalizeKoreanSearchTerm(term: string): string {
  if (term.length <= 2) {
    return term;
  }
  return term
    .replace(/말고$/u, '')
    .replace(/(?<=.{2})(?:이란|란)$/u, '')
    .replace(/(?:했는데|했지만|했어요|했어|했다|합니다|해요)$/u, '')
    .replace(/(?:은|는|이|가|을|를|의|에|에서|으로|로|와|과|도|만)$/u, '')
    .replace(
      /(?:이야|인가요|인가|되는지|되나요|됩니까|돼요|되니|하나요|해요|됨|돼)$/u,
      '',
    );
}

function synonymsFor(term: string, vocabulary: Vocabulary): readonly string[] {
  return Object.prototype.hasOwnProperty.call(vocabulary.synonyms, term)
    ? vocabulary.synonyms[term]
    : [];
}

function lookupFor(vocabulary: Vocabulary): VocabularyLookup {
  const cached = lookups.get(vocabulary);
  if (cached) {
    return cached;
  }
  // 질문 낱말은 어미를 걷어 낸 뒤 비교하므로 "궁금해요" 같은 불용어도 걷어 낸 모양("궁금")을 함께 둔다
  const stopwords = new Set(vocabulary.stopwords);
  for (const stopword of vocabulary.stopwords) {
    const normalized = normalizeKoreanSearchTerm(stopword);
    if (normalized) {
      stopwords.add(normalized);
    }
  }
  const lookup: VocabularyLookup = {
    stopwords,
    synonymKeys: Object.keys(vocabulary.synonyms),
  };
  lookups.set(vocabulary, lookup);
  return lookup;
}
