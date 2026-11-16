import type { RetrievalMode } from './retrieval/types.js';
import type {
  Embedder,
  LlmClient,
  Logger,
  PolicySource,
  VectorIndex,
} from './ports.js';
import type { Vocabulary } from './text/types.js';

/** 답에 쓰인 claim 하나. source 는 CSV 의 `source` 열처럼 공개해도 된다고 적힌 출처가 있을 때만 있다 */
export interface CodeciteCitation {
  claimId: string;
  policyGroup: string;
  statement: string;
  source?: string;
}

/** 답 하나가 어떤 경로로 나왔는지. 디버깅용이다 */
export interface CodeciteTrace {
  /** dense 검색까지 돌았으면 hybrid, BM25 만 돌았으면 bm25 */
  retrieval: RetrievalMode;
  /** 답변 모델이 쓴 답이 관문을 통과했으면 llm, 모델 없이 근거 문장으로 만들었으면 deterministic */
  generation: 'llm' | 'deterministic';
  /** 검색이 돌려준 근거 수(기준 근거 포함) */
  candidates: number;
  /** 근거 묶기를 거쳐 답에 쓰인 근거 수 */
  packed: number;
}

/** `ask` 결과 */
export interface CodeciteAnswer {
  status: 'answered' | 'insufficient_evidence';
  /** Slack 이나 웹에 바로 보여 줄 문장 */
  answer: string;
  citations: CodeciteCitation[];
  trace: CodeciteTrace;
}

/** 검색·근거 묶기·답변 모델 대기 한도. 비운 값은 기본값을 쓴다 */
export interface CodeciteLimits {
  /** dense 검색에서 뽑을 후보 수 */
  denseLimit?: number;
  /** BM25 에서 뽑을 후보 수 */
  lexicalLimit?: number;
  /** 둘을 합친 뒤 남길 후보 수 */
  fusedLimit?: number;
  /** 답변 모델에 넘길 근거 수 */
  maxItems?: number;
  /** 답변 모델에 넘길 근거 글 전체 글자 수 */
  maxTotalChars?: number;
  /** 근거 하나의 글자 수 */
  maxItemChars?: number;
  /** 답변 모델을 기다리는 최대 시간(밀리초). 넘기면 결정적 답변으로 물러난다 */
  answerTimeoutMs?: number;
}

/** `createCodecite` 재료. source 만 있으면 BM25 와 결정적 답변으로 돈다 */
export interface CodeciteOptions {
  source: PolicySource;
  /** 답변 모델. 없으면 질문 계획을 건너뛰고 근거 문장으로 결정적인 답을 만든다 */
  llm?: LlmClient;
  /** 임베더. 없으면 BM25 만으로 검색한다 */
  embedder?: Embedder;
  /** 한국어 기본 사전에 더할 서비스 사전(동의어, 질문 말투 낱말, 묶음 별칭) */
  vocabulary?: Partial<Vocabulary>;
  /** 벡터 색인. 임베더가 있을 때만 쓰고, 없으면 메모리 색인을 만든다 */
  index?: VectorIndex;
  /** 임베딩 결과를 담아 두는 JSON 캐시 파일. 없으면 `.codecite/index.json`(현재 폴더 기준) */
  indexCachePath?: string;
  /** 없으면 아무것도 남기지 않는다. 질문 본문은 어느 로그에도 넘기지 않는다 */
  logger?: Logger;
  limits?: CodeciteLimits;
}

/** 색인을 만든 결과 */
export interface CodeciteIndexSummary {
  /** 검색에 쓰는 활성 조각 수 */
  chunks: number;
  /** 임베딩까지 마쳤으면 hybrid, 임베더가 없거나 임베딩이 실패했으면 bm25 */
  retrieval: RetrievalMode;
  /** 내용과 임베딩 모델이 같은 캐시를 써서 다시 임베딩하지 않았는지 */
  reusedVectors: boolean;
}

/** `createCodecite` 가 돌려주는 엔진 */
export interface Codecite {
  /** 질문 하나에 근거로 답한다 */
  ask(question: string): Promise<CodeciteAnswer>;
  /** 정책 소스를 다시 읽어 색인을 새로 만든다. CSV 형식 오류는 행 번호와 함께 throw 한다 */
  reindex(): Promise<CodeciteIndexSummary>;
  /** 가장 최근에 만든 색인의 요약 */
  readonly indexSummary: CodeciteIndexSummary;
}

/** 답변 모델·임베딩 제공자 설정. 모델 이름은 기본값이 없어 제공자를 정했으면 함께 적는다 */
export interface CodeciteProviderConfig {
  provider: 'openai' | 'ollama';
  model?: string;
  /** OpenAI 호환 서버나 Ollama 서버 주소 */
  baseUrl?: string;
}

/** `codecite.config.json` 의 모양. `loadConfig` 가 돌려줄 때 경로는 절대 경로로 풀려 있다 */
export interface CodeciteConfig {
  source: { type: 'csv'; path: string };
  llm?: CodeciteProviderConfig;
  embedding?: CodeciteProviderConfig;
  index: { path: string };
  vocabulary?: Partial<Vocabulary>;
}

/** `loadConfig` 선택 사항 */
export interface LoadConfigOptions {
  /** 설정 경고를 남기고, 만든 엔진에도 같은 로거를 넘긴다 */
  logger?: Logger;
  /** API 키를 읽을 환경 변수. 없으면 `process.env` */
  env?: Readonly<Record<string, string | undefined>>;
}

/** `loadConfig` 결과. options 를 그대로 `createCodecite` 에 넘긴다 */
export interface LoadedConfig {
  config: CodeciteConfig;
  options: CodeciteOptions;
}

/** 로그 수준. 낮은 것부터 debug, info, warn, error */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
