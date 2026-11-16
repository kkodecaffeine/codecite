import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  DEFAULT_INDEX_CACHE_PATH,
  OPENAI_API_KEY_ENV,
} from './adapters/constants.js';
import { csvPolicySource } from './adapters/csv-policy-source.js';
import { ollamaClient } from './adapters/ollama.js';
import { openAiClient } from './adapters/openai.js';
import { CONFIG_FILE_NAME } from './constants.js';
import { noopLogger } from './logger.js';
import type { Embedder, LlmClient } from './ports.js';
import type { Vocabulary } from './text/types.js';
import type {
  CodeciteConfig,
  CodeciteOptions,
  CodeciteProviderConfig,
  LoadConfigOptions,
  LoadedConfig,
} from './types.js';

/**
 * 폴더의 `codecite.config.json` 을 읽어 `createCodecite` 재료를 만든다. 경로는 그 폴더 기준으로 푼다
 * - `llm`·`embedding` 의 provider 가 openai 인데 `OPENAI_API_KEY` 가 없으면(호환 서버 주소도 없으면) 둘 다 빼고 BM25 와 결정적 답변으로 돈다. 경고는 한 번만 남긴다
 * - 쓸 수 있는 제공자인데 model 이 비었으면 어느 설정을 채울지 적어 throw 한다. 모델 이름은 기본값이 없다
 * - API 키는 설정 파일이 아니라 환경 변수에서만 읽는다
 */
export async function loadConfig(
  cwd: string = process.cwd(),
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const logger = options.logger ?? noopLogger;
  const env = options.env ?? process.env;
  const config = parseConfig(await readConfigFile(cwd), cwd);

  const apiKey = env[OPENAI_API_KEY_ENV]?.trim() || undefined;
  const withoutKey = (provider?: CodeciteProviderConfig): boolean =>
    provider?.provider === 'openai' && !apiKey && !provider.baseUrl;
  const disabled = (['llm', 'embedding'] as const).filter((field) =>
    withoutKey(config[field]),
  );
  if (disabled.length > 0) {
    logger.warn(
      `${OPENAI_API_KEY_ENV} is not set; answering with BM25 search and deterministic answers only`,
      { disabled },
    );
  }

  const llm =
    config.llm && !disabled.includes('llm')
      ? answerModel(config.llm, apiKey)
      : undefined;
  const embedder =
    config.embedding && !disabled.includes('embedding')
      ? embeddingModel(config.embedding, apiKey)
      : undefined;
  const codeciteOptions: CodeciteOptions = {
    source: csvPolicySource({ path: config.source.path }),
    ...(llm ? { llm } : {}),
    ...(embedder ? { embedder } : {}),
    ...(config.vocabulary ? { vocabulary: config.vocabulary } : {}),
    indexCachePath: config.index.path,
    logger,
  };
  return { config, options: codeciteOptions };
}

async function readConfigFile(cwd: string): Promise<unknown> {
  const path = join(cwd, CONFIG_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${CONFIG_FILE_NAME} was not found in ${resolve(cwd)}.`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${CONFIG_FILE_NAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** 설정 모양을 확인하고 경로를 cwd 기준 절대 경로로 푼다. 틀린 값은 어느 설정인지 적어 throw 한다 */
function parseConfig(value: unknown, cwd: string): CodeciteConfig {
  const root = record(value, 'the top level');
  if (root.source === undefined) {
    throw configError('source is required.');
  }
  const source = record(root.source, 'source');
  if (source.type !== undefined && source.type !== 'csv') {
    throw configError('source.type must be "csv".');
  }
  const sourcePath = text(source.path, 'source.path');
  if (!sourcePath) {
    throw configError('source.path is required.');
  }
  const index = root.index === undefined ? {} : record(root.index, 'index');
  const indexPath = text(index.path, 'index.path') || DEFAULT_INDEX_CACHE_PATH;
  const llm = provider(root.llm, 'llm');
  const embedding = provider(root.embedding, 'embedding');
  const vocabulary =
    root.vocabulary === undefined
      ? undefined
      : vocabularyConfig(root.vocabulary);
  return {
    source: { type: 'csv', path: resolve(cwd, sourcePath) },
    ...(llm ? { llm } : {}),
    ...(embedding ? { embedding } : {}),
    index: { path: resolve(cwd, indexPath) },
    ...(vocabulary ? { vocabulary } : {}),
  };
}

function provider(
  value: unknown,
  field: 'llm' | 'embedding',
): CodeciteProviderConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const entry = record(value, field);
  if (entry.provider !== 'openai' && entry.provider !== 'ollama') {
    throw configError(`${field}.provider must be "openai" or "ollama".`);
  }
  const model = text(entry.model, `${field}.model`);
  const baseUrl = text(entry.baseUrl, `${field}.baseUrl`);
  return {
    provider: entry.provider,
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

/** 쓸 수 있는 제공자인데 모델을 적지 않았으면, 어댑터가 부를 때마다 실패해 조용히 결정적 답변만 나가므로 미리 멈춘다 */
function requireModel(
  entry: CodeciteProviderConfig,
  field: 'llm' | 'embedding',
): string {
  if (!entry.model) {
    throw configError(
      `${field}.model is required when ${field}.provider is "${entry.provider}"; codecite has no default model.`,
    );
  }
  return entry.model;
}

function answerModel(
  entry: CodeciteProviderConfig,
  apiKey: string | undefined,
): LlmClient {
  const model = requireModel(entry, 'llm');
  return entry.provider === 'openai'
    ? openAiClient({ apiKey, model, baseUrl: entry.baseUrl })
    : ollamaClient({ model, baseUrl: entry.baseUrl });
}

function embeddingModel(
  entry: CodeciteProviderConfig,
  apiKey: string | undefined,
): Embedder {
  const model = requireModel(entry, 'embedding');
  return entry.provider === 'openai'
    ? openAiClient({
        apiKey,
        embeddingModel: model,
        baseUrl: entry.baseUrl,
      }).embedder()
    : ollamaClient({
        embeddingModel: model,
        baseUrl: entry.baseUrl,
      }).embedder();
}

function vocabularyConfig(value: unknown): Partial<Vocabulary> {
  const entry = record(value, 'vocabulary');
  const synonyms = wordLists(entry.synonyms, 'vocabulary.synonyms');
  const groupAliases = wordLists(entry.groupAliases, 'vocabulary.groupAliases');
  const stopwords =
    entry.stopwords === undefined
      ? undefined
      : words(entry.stopwords, 'vocabulary.stopwords');
  return {
    ...(synonyms ? { synonyms } : {}),
    ...(stopwords ? { stopwords } : {}),
    ...(groupAliases ? { groupAliases } : {}),
  };
}

function wordLists(
  value: unknown,
  field: string,
): Record<string, string[]> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(record(value, field)).map(([key, list]) => [
      key,
      words(list, `${field}.${key}`),
    ]),
  );
}

function words(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw configError(`${field} must be an array of strings.`);
  }
  return value as string[];
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw configError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw configError(`${field} must be a string.`);
  }
  return value.trim() || undefined;
}

function configError(detail: string): Error {
  return new Error(`${CONFIG_FILE_NAME}: ${detail}`);
}
