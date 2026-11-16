import type { PolicyChunk } from '../domain/policy-chunk.js';
import type { Logger } from '../ports.js';
import type { CLAIM_CSV_COLUMNS } from './constants.js';

/** `openAiClient` 옵션. 키는 옵션이나 `OPENAI_API_KEY` 에서만 읽는다 */
export interface OpenAiClientOptions {
  /** 없으면 `OPENAI_API_KEY` 를 읽는다. baseUrl 을 바꾼 호환 서버면 키 없이도 쓴다 */
  apiKey?: string;
  /** 답변·질문 계획 모델. 기본값이 없다. 비워 두면 `complete` 가 throw 한다 */
  model?: string;
  /** OpenAI 호환 서버 주소. `/chat/completions`, `/embeddings` 를 이 아래에서 부른다 */
  baseUrl?: string;
  /** 임베딩 모델. 기본값이 없다. 비워 두면 `embedder()` 가 throw 한다 */
  embeddingModel?: string;
  /** 요청 하나를 기다리는 시간(밀리초) */
  timeoutMs?: number;
  /** 답 길이 상한(토큰) */
  maxOutputTokens?: number;
  /** 줄 때만 보낸다. 같은 근거에 같은 답이 나오게 하려면 모델이 받는 경우 0 을 권한다 */
  temperature?: number;
  /** 추론 강도(`reasoning_effort`). 줄 때만 보낸다. 받는 값은 모델마다 다르다 */
  reasoningEffort?: string;
}

/** `ollamaClient` 옵션 */
export interface OllamaClientOptions {
  /** 답변·질문 계획 모델. 기본값이 없다. 비워 두면 `complete` 가 throw 한다 */
  model?: string;
  /** Ollama 서버 주소. `/api/chat`, `/api/embed` 를 이 아래에서 부른다 */
  baseUrl?: string;
  /** 임베딩 모델. 기본값이 없다. 비워 두면 `embedder()` 가 throw 한다 */
  embeddingModel?: string;
  /** 요청 하나를 기다리는 시간(밀리초) */
  timeoutMs?: number;
  /** 답 길이 상한(토큰). Ollama 의 num_predict */
  maxOutputTokens?: number;
  /** 요청 뒤 모델을 메모리에 남겨 둘 시간(예: `5m`). 없으면 서버 기본값 */
  keepAlive?: string;
}

/** JSON 요청 하나의 설정 */
export interface JsonPostOptions {
  /** 오류 문장 앞에 붙일 요청 이름 */
  label: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  /** 실패 응답의 오류 글을 문장에 붙일지. 비밀값을 받지 않는 로컬 서버에만 켠다 */
  exposeErrorText?: boolean;
}

/** OpenAI Chat Completions 응답 중 읽는 부분 */
export interface OpenAiChatResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null };
  }>;
}

/** OpenAI 임베딩 응답 중 읽는 부분 */
export interface OpenAiEmbeddingResponse {
  data?: Array<{ index?: number; embedding?: unknown }>;
}

/** Ollama `/api/chat` 응답 중 읽는 부분 */
export interface OllamaChatResponse {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
}

/** Ollama `/api/embed` 응답 중 읽는 부분 */
export interface OllamaEmbedResponse {
  embeddings?: unknown;
}

/** `csvPolicySource` 옵션 */
export interface CsvPolicySourceOptions {
  /** claim CSV 파일, 또는 `.csv` 파일을 담은 폴더(바로 아래 파일만 이름 순서로 읽는다) */
  path: string;
}

/** CSV 기록 하나. row 는 머리 행을 1 로 센 기록 번호, line 은 그 기록이 시작하는 줄 번호다 */
export interface CsvRecord {
  cells: string[];
  row: number;
  line: number;
}

/** claim CSV 가 읽는 열 이름 */
export type ClaimCsvColumn = (typeof CLAIM_CSV_COLUMNS)[number];

/** `jsonIndexCache` 옵션 */
export interface JsonIndexCacheOptions {
  /** 캐시 파일 경로. 없으면 `.codecite/index.json` */
  path?: string;
  logger?: Logger;
}

/** 색인 캐시 한 벌. vectors[i] 는 chunks[i].searchText 의 벡터다 */
export interface CachedIndex {
  fingerprint: string;
  chunks: PolicyChunk[];
  vectors: number[][];
}

/** `vectorsFor` 결과. reused 면 캐시의 벡터를 그대로 썼다 */
export interface CachedVectors {
  fingerprint: string;
  vectors: number[][];
  reused: boolean;
}
