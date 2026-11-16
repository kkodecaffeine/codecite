import type { PolicyChunk } from './domain/policy-chunk.js';
import type { Policy } from './domain/policy.js';
import type { PolicyContextKind } from './domain/types.js';

/** 구조화 로그 필드. 값은 JSON 으로 바꿀 수 있는 것을 쓴다 */
export type LogFields = Record<string, unknown>;

/** 로그를 남기는 포트. console 이나 쓰는 쪽의 로거를 붙인다 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

/** 정책 행을 읽어 오는 포트. CSV 파일이나 쓰는 쪽의 저장소를 붙인다 */
export interface PolicySource {
  /** 정책 행을 모두 읽는다. 형식이 틀린 행이 있으면 조용히 건너뛰지 않고 throw 한다 */
  loadPolicies(): Promise<Policy[]>;
}

/** 글을 벡터로 바꾸는 포트. 검색 조각과 질문을 같은 모델로 바꿔야 dense 검색이 맞는다 */
export interface Embedder {
  /** 모델과 설정을 가리키는 값. 바뀌면 만들어 둔 색인을 다시 만든다 */
  readonly fingerprint: string;
  /** 글마다 벡터 하나를 받은 순서대로 돌려준다 */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** dense 검색에서 볼 조각 종류. 여러 종류면 종류별 순위를 번갈아 넣는다 */
export interface VectorSearchOptions {
  contextKinds?: readonly PolicyContextKind[];
}

/** 조각 벡터를 담아 두고 질문 벡터와 가까운 조각을 찾는 포트 */
export interface VectorIndex {
  /** 조각과 그 벡터(같은 순서, 조각의 searchText 를 바꾼 것)로 색인을 통째로 다시 만든다 */
  rebuild(
    chunks: readonly PolicyChunk[],
    embeddings: readonly (readonly number[])[],
  ): Promise<void>;
  /** 질문 벡터와 가까운 조각을 가까운 순서로 limit 개까지 돌려준다 */
  search(
    queryVector: readonly number[],
    limit: number,
    options?: VectorSearchOptions,
  ): Promise<PolicyChunk[]>;
}

/** 답변 모델에 보내는 요청 하나 */
export interface LlmCompletionRequest {
  /** 모델이 지킬 지시문 */
  system: string;
  /** 경계 태그로 감싼 질문과 근거 */
  user: string;
  /** true 면 JSON 객체 하나만 돌려 달라고 요청한다. 지시문에도 JSON 이라는 말을 넣어야 받아 주는 모델이 있다 */
  json?: boolean;
  /** 호출자가 기다림을 끊을 때 쓴다 */
  signal?: AbortSignal;
}

/**
 * 답변 모델을 부르는 포트. 모델이 쓴 글을 그대로 돌려줄 뿐 답변 검사·계약·정제는 하지 않는다
 * 요청이 실패하거나 시간을 넘기거나 빈 글이 오면 throw 한다. 허브는 그때 결정적 답변으로 물러난다
 */
export interface LlmClient {
  complete(request: LlmCompletionRequest): Promise<string>;
}
