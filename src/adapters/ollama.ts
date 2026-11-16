import type { Embedder, LlmClient, LlmCompletionRequest } from '../ports.js';
import {
  LLM_DEFAULT_MAX_OUTPUT_TOKENS,
  MISSING_CHAT_MODEL_MESSAGE,
  MISSING_EMBEDDING_MODEL_MESSAGE,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_TIMEOUT_MS,
  OLLAMA_EMBEDDING_BATCH_SIZE,
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
  OllamaChatResponse,
  OllamaClientOptions,
  OllamaEmbedResponse,
} from './types.js';

/**
 * 로컬 Ollama 의 `/api/chat` 으로 답변 모델을 부르는 클라이언트. `embedder()` 로 `/api/embed` 임베딩도 쓴다
 * 모델을 부르는 일만 하고 답변 검사·정제는 허브의 순수 함수가 맡는다. 모델 이름은 기본값 없이 쓰는 쪽이 정한다
 */
export class OllamaClient implements LlmClient {
  readonly model: string | undefined;
  readonly embeddingModel: string | undefined;
  readonly baseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxOutputTokens: number;
  readonly #keepAlive: string | undefined;

  constructor(options: OllamaClientOptions = {}) {
    this.baseUrl = trimBaseUrl(options.baseUrl ?? OLLAMA_DEFAULT_BASE_URL);
    this.model = options.model?.trim() || undefined;
    this.embeddingModel = options.embeddingModel?.trim() || undefined;
    this.#timeoutMs = positiveNumber(
      options.timeoutMs,
      OLLAMA_DEFAULT_TIMEOUT_MS,
    );
    this.#maxOutputTokens = Math.floor(
      positiveNumber(options.maxOutputTokens, LLM_DEFAULT_MAX_OUTPUT_TOKENS),
    );
    this.#keepAlive = options.keepAlive?.trim() || undefined;
  }

  /** 지시문과 사용자 글을 보내 모델이 쓴 글을 돌려준다. 모델을 정하지 않았거나 덜 끝났거나 길이 한도에 잘린 답, 빈 답은 throw 한다 */
  async complete(request: LlmCompletionRequest): Promise<string> {
    if (!this.model) {
      throw new Error(`Ollama ${MISSING_CHAT_MODEL_MESSAGE}`);
    }
    const data = (await postJson(
      `${this.baseUrl}/api/chat`,
      {
        model: this.model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        stream: false,
        options: { temperature: 0, num_predict: this.#maxOutputTokens },
        ...(request.json ? { format: 'json' } : {}),
        ...(this.#keepAlive ? { keep_alive: this.#keepAlive } : {}),
      },
      {
        label: 'Ollama chat',
        signal: requestSignal(this.#timeoutMs, request.signal),
        exposeErrorText: true,
      },
    )) as OllamaChatResponse;
    if (data.done === false || data.done_reason === 'length') {
      throw new Error('Ollama chat answer is incomplete');
    }
    const content = data.message?.content?.trim();
    if (!content) {
      throw new Error('Ollama chat answer is empty');
    }
    return content;
  }

  /** 같은 서버의 임베딩 모델을 부르는 Embedder. fingerprint 는 제공자와 모델 이름이다. 임베딩 모델을 정하지 않았으면 throw 한다 */
  embedder(): Embedder {
    const model = this.embeddingModel;
    if (!model) {
      throw new Error(`Ollama ${MISSING_EMBEDDING_MODEL_MESSAGE}`);
    }
    return {
      fingerprint: `ollama:${model}`,
      embed: (texts) => this.#embed(model, texts),
    };
  }

  async #embed(model: string, texts: readonly string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (const batch of inBatches(texts, OLLAMA_EMBEDDING_BATCH_SIZE)) {
      const data = (await postJson(
        `${this.baseUrl}/api/embed`,
        {
          model,
          input: batch,
          ...(this.#keepAlive ? { keep_alive: this.#keepAlive } : {}),
        },
        {
          label: 'Ollama embeddings',
          signal: requestSignal(this.#timeoutMs),
          exposeErrorText: true,
        },
      )) as OllamaEmbedResponse;
      const embeddings = Array.isArray(data.embeddings) ? data.embeddings : [];
      if (embeddings.length !== batch.length) {
        throw new Error(
          `Ollama embeddings returned ${embeddings.length} vectors for ${batch.length} texts`,
        );
      }
      for (const embedding of embeddings) {
        vectors.push(embeddingVector(embedding, 'Ollama embeddings'));
      }
    }
    return vectors;
  }
}

/** 로컬 Ollama 클라이언트를 만든다. API 키는 쓰지 않는다 */
export function ollamaClient(options: OllamaClientOptions = {}): OllamaClient {
  return new OllamaClient(options);
}
