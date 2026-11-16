/** 받침에 따라 모양이 바뀌는 조사. 받침 있는 쪽 모양으로 부른다 */
export type KoreanParticle = '은' | '이' | '을' | '으로';

/**
 * 검색 낱말 사전. 한국어 기본 사전에 서비스마다 다른 말을 더해 쓴다
 * 낱말은 소문자로 비교하므로 `mergeVocabulary` 로 만들면 알아서 맞춘다
 */
export interface Vocabulary {
  /** 낱말 → 함께 검색할 낱말. 질문 안에 낱말이 붙어 있어도 펼친다 */
  synonyms: Readonly<Record<string, readonly string[]>>;
  /** 질문에서 걷어 내는 질문 말투 낱말 */
  stopwords: readonly string[];
  /** 정책 묶음 이름 → 그 묶음을 가리키는 낱말 */
  groupAliases: Readonly<Record<string, readonly string[]>>;
}

/** 토크나이저가 사전마다 한 번 만들어 두는 조회 구조 */
export interface VocabularyLookup {
  stopwords: ReadonlySet<string>;
  synonymKeys: readonly string[];
}
