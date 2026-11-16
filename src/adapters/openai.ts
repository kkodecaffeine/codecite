import type { Embedder, LlmClient, LlmCompletionRequest } from '../ports.js';
import {
  LLM_DEFAULT_MAX_OUTPUT_TOKENS,
  LLM_DEFAULT_TIMEOUT_MS,
  OPENAI_API_KEY_ENV,
  MISSING_CHAT_MODEL_MESSAGE,
  MISSING_EMBEDDING_MODEL_MESSAGE,
  OPENAI_DEFAULT_BASE_URL,
  OPENAI_EMBEDDING_BATCH_SIZE,
} from './constants.js';
import {
  embeddingVector,
  inBatches,
  positiveNumber,
  postJson,
  requestSignal,
  trimBaseUrl,
} from './http.js';
import type {
  OpenAiChatResponse,
  OpenAiClientOptions,
  OpenAiEmbeddingResponse,
} from './types.js';

/**
 * OpenAI Chat Completions 로 답변 모델을 부르는 클라이언트. `embedder()` 로 같은 계정의 임베딩도 쓴다
 * OpenAI 호환 서버는 baseUrl 만 바꿔 붙인다. 모델을 부르는 일만 하고 답변 검사·정제는 허브의 순수 함수가 맡는다
 * 모델 이름은 기본값 없이 쓰는 쪽이 정한다. 모델은 자주 바뀌고, 어떤 모델이 맞는지는 쓰는 곳의 비용·품질 판단이기 때문이다
 */
export class OpenAiClient implements LlmClient {
  readonly model: string | undefined;
  readonly embeddingModel: string | undefined;
  readonly baseUrl: string;
  /** 키는 클래스 밖에서 읽을 수 없게 두어 객체를 로그로 찍어도 나가지 않는다 */
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxOutputTokens: number;
  readonly #sampling: { temperature?: number; reasoning_effort?: string };

  constructor(options: OpenAiClientOptions = {}) {
    this.baseUrl = trimBaseUrl(options.baseUrl ?? OPENAI_DEFAULT_BASE_URL);
    this.model = options.model?.trim() || undefined;
    this.embeddingModel = options.embeddingModel?.trim() || undefined;
    this.#sampling = {
      ...(options.temperature !== undefined
        ? { temperature: options.temperature }
        : {}),
      ...(options.reasoningEffort?.trim()
        ? { reasoning_effort: options.reasoningEffort.trim() }
        : {}),
    };
    this.#apiKey =
      options.apiKey?.trim() || process.env[OPENAI_API_KEY_ENV]?.trim();
    // 키 없이 OpenAI 를 부르면 요청마다 401 로 실패해 조용히 결정적 답변만 나가므로 만들 때 바로 알린다
    if (!this.#apiKey && this.baseUrl === OPENAI_DEFAULT_BASE_URL) {
      throw new Error(
        `OpenAI API key is missing: pass apiKey or set ${OPENAI_API_KEY_ENV}.`,
      );
    }
    this.#timeoutMs = positiveNumber(options.timeoutMs, LLM_DEFAULT_TIMEOUT_MS);
    this.#maxOutputTokens = Math.floor(
      positiveNumber(options.maxOutputTokens, LLM_DEFAULT_MAX_OUTPUT_TOKENS),
    );
  }

  /** 지시문과 사용자 글을 보내 모델이 쓴 글을 돌려준다. 모델을 정하지 않았거나 잘린 답, 거절, 빈 답은 throw 한다 */
  async complete(request: LlmCompletionRequest): Promise<string> {
    if (!this.model) {
      throw new Error(`OpenAI ${MISSING_CHAT_MODEL_MESSAGE}`);
    }
    const data = (await postJson(
      `${this.baseUrl}/chat/completions`,
      {
        model: this.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        max_completion_tokens: this.#maxOutputTokens,
        ...this.#sampling,
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      },
      {
        label: 'OpenAI chat',
        headers: this.#headers(),
        signal: requestSignal(this.#timeoutMs, request.signal),
      },
    )) as OpenAiChatResponse;
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') {
      throw new Error('OpenAI chat answer was cut at the output token limit');
    }
    if (choice?.message?.refusal) {
      throw new Error('OpenAI chat model refused to answer');
    }
    const content = choice?.message?.content?.trim();
    if (!content) {
      throw new Error('OpenAI chat answer is empty');
    }
    return content;
  }

  /** 같은 주소와 키로 임베딩 모델을 부르는 Embedder. fingerprint 는 제공자와 모델 이름이다. 임베딩 모델을 정하지 않았으면 throw 한다 */
  embedder(): Embedder {
    const model = this.embeddingModel;
    if (!model) {
      throw new Error(`OpenAI ${MISSING_EMBEDDING_MODEL_MESSAGE}`);
    }
    return {
      fingerprint: `openai:${model}`,
      embed: (texts) => this.#embed(model, texts),
    };
  }

  async #embed(model: string, texts: readonly string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const batch of inBatches(texts, OPENAI_EMBEDDING_BATCH_SIZE)) {
      const data = (await postJson(
        `${this.baseUrl}/embeddings`,
        { model, input: batch, encoding_format: 'float' },
        {
          label: 'OpenAI embeddings',
          headers: this.#headers(),
          signal: requestSignal(this.#timeoutMs),
        },
      )) as OpenAiEmbeddingResponse;
      const items = data.data ?? [];
      if (items.length !== batch.length) {
        throw new Error(
          `OpenAI embeddings returned ${items.length} vectors for ${batch.length} texts`,
        );
      }
      // 응답 순서가 아니라 index 로 맞춘다
      const ordered = [...items].sort(
        (left, right) => (left.index ?? 0) - (right.index ?? 0),
      );
      for (const item of ordered) {
        vectors.push(embeddingVector(item.embedding, 'OpenAI embeddings'));
      }
    }
    return vectors;
  }

  #headers(): Record<string, string> {
    return this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {};
  }
}

/** OpenAI 클라이언트를 만든다. 키는 옵션이나 `OPENAI_API_KEY` 에서만 읽는다 */
export function openAiClient(options: OpenAiClientOptions = {}): OpenAiClient {
  return new OpenAiClient(options);
}
