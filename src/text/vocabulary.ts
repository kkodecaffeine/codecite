import {
  DEFAULT_KOREAN_STOPWORDS,
  DEFAULT_KOREAN_SYNONYMS,
} from './constants.js';
import type { Vocabulary } from './types.js';

/** 특정 서비스의 말이 없는 한국어 기본 사전. 서비스 낱말은 `mergeVocabulary` 로 더한다 */
export const DEFAULT_KOREAN_VOCABULARY: Vocabulary = Object.freeze({
  synonyms: Object.freeze(
    Object.fromEntries(
      Object.entries(DEFAULT_KOREAN_SYNONYMS).map(([term, synonyms]) => [
        term,
        Object.freeze([...synonyms]),
      ]),
    ),
  ),
  stopwords: Object.freeze([...DEFAULT_KOREAN_STOPWORDS]),
  groupAliases: Object.freeze({}),
});

/**
 * 기본 사전에 서비스 사전을 더한다. 같은 낱말의 동의어·별칭은 합치고 중복은 걷어 낸다
 * 낱말은 NFC·소문자로 맞춰 검색 낱말과 비교되게 한다. 묶음 이름(groupAliases 의 키)은 앞뒤 공백만 걷어 낸다
 */
export function mergeVocabulary(
  base: Vocabulary,
  extra: Partial<Vocabulary> = {},
): Vocabulary {
  return {
    synonyms: mergeWordLists(base.synonyms, extra.synonyms, normalizeWord),
    stopwords: uniqueWords([...base.stopwords, ...(extra.stopwords ?? [])]),
    groupAliases: mergeWordLists(base.groupAliases, extra.groupAliases, (key) =>
      key.trim(),
    ),
  };
}

function mergeWordLists(
  base: Readonly<Record<string, readonly string[]>>,
  extra: Readonly<Record<string, readonly string[]>> | undefined,
  normalizeKey: (key: string) => string,
): Record<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const entries of [base, extra ?? {}]) {
    for (const [rawKey, words] of Object.entries(entries)) {
      const key = normalizeKey(rawKey);
      if (!key) {
        continue;
      }
      merged.set(key, uniqueWords([...(merged.get(key) ?? []), ...words]));
    }
  }
  return Object.fromEntries(merged);
}

function uniqueWords(words: readonly string[]): string[] {
  return [...new Set(words.map(normalizeWord).filter(Boolean))];
}

function normalizeWord(word: string): string {
  return word.normalize('NFC').trim().toLowerCase();
}
