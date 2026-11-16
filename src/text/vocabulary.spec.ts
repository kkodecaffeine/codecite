import { describe, expect, it } from 'vitest';
import { DEFAULT_KOREAN_VOCABULARY, mergeVocabulary } from './vocabulary.js';

describe('vocabulary', () => {
  it('기본 사전은 질문 말투 낱말을 담고 바꿀 수 없다', () => {
    expect(DEFAULT_KOREAN_VOCABULARY.stopwords).toEqual(
      expect.arrayContaining(['뭐가', '있어', '주세요']),
    );
    expect(DEFAULT_KOREAN_VOCABULARY.groupAliases).toEqual({});
    expect(Object.isFrozen(DEFAULT_KOREAN_VOCABULARY)).toBe(true);
    expect(Object.isFrozen(DEFAULT_KOREAN_VOCABULARY.stopwords)).toBe(true);
    expect(Object.isFrozen(DEFAULT_KOREAN_VOCABULARY.synonyms)).toBe(true);
    expect(Object.isFrozen(DEFAULT_KOREAN_VOCABULARY.synonyms['만료'])).toBe(
      true,
    );
  });

  it('서비스 사전을 낱말마다 합치고 중복을 걷어 낸다', () => {
    const merged = mergeVocabulary(DEFAULT_KOREAN_VOCABULARY, {
      synonyms: { 만료: ['소멸', '사라짐'], VIP: ['Gold', 'gold'] },
      stopwords: ['궁금해요', '뭐가'],
      groupAliases: { ' points ': ['적립금', '포인트', '적립금'] },
    });

    expect(merged.synonyms['만료']).toEqual(['expire', '소멸', '사라짐']);
    expect(merged.synonyms['vip']).toEqual(['gold']);
    expect(merged.stopwords.filter((word) => word === '뭐가')).toHaveLength(1);
    expect(merged.stopwords).toContain('궁금해요');
    expect(merged.groupAliases).toEqual({ points: ['적립금', '포인트'] });
  });

  it('기본 사전을 바꾸지 않는다', () => {
    const before = JSON.stringify(DEFAULT_KOREAN_VOCABULARY);

    mergeVocabulary(DEFAULT_KOREAN_VOCABULARY, {
      synonyms: { 만료: ['사라짐'] },
      stopwords: ['궁금해요'],
    });

    expect(JSON.stringify(DEFAULT_KOREAN_VOCABULARY)).toBe(before);
  });
});
