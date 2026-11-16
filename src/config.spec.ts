import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CsvPolicySource } from './adapters/csv-policy-source.js';
import { OllamaClient } from './adapters/ollama.js';
import { OpenAiClient } from './adapters/openai.js';
import { createCodecite } from './codecite.js';
import { loadConfig } from './config.js';
import type { Logger } from './ports.js';

const fakeLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const CLAIMS = [
  'policy_group,feature_name,claim_statement,claim_facet',
  'shipping,출고 마감,평일 오후 3 시 전에 결제한 주문은 그날 창고에서 내보낸다.,schedule',
].join('\n');

let folder: string;

const writeConfig = (config: unknown) =>
  writeFile(
    join(folder, 'codecite.config.json'),
    typeof config === 'string' ? config : JSON.stringify(config),
    'utf8',
  );

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'codecite-config-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('OPENAI_API_KEY 가 없으면 답변 모델과 임베딩 없이 돌고 경고를 한 번만 남긴다', async () => {
    await writeConfig({
      source: { type: 'csv', path: 'claims.csv' },
      llm: { provider: 'openai', model: 'chat-model' },
      embedding: { provider: 'openai', model: 'embed-model' },
    });
    const logger = fakeLogger();

    const { options } = await loadConfig(folder, { env: {}, logger });

    expect(options.llm).toBeUndefined();
    expect(options.embedder).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('OPENAI_API_KEY'),
      { disabled: ['llm', 'embedding'] },
    );
  });

  it('키 없이 돌 때는 모델 이름이 없어도 실패하지 않는다', async () => {
    await writeConfig({
      source: { path: 'claims.csv' },
      llm: { provider: 'openai' },
      embedding: { provider: 'openai' },
    });

    const { options } = await loadConfig(folder, { env: {} });

    expect(options.llm).toBeUndefined();
    expect(options.embedder).toBeUndefined();
  });

  it('키 없는 모드로 만든 엔진은 BM25 와 결정적 답변으로 답한다', async () => {
    await writeFile(join(folder, 'claims.csv'), CLAIMS, 'utf8');
    await writeConfig({
      source: { type: 'csv', path: 'claims.csv' },
      llm: { provider: 'openai', model: 'chat-model' },
    });

    const { options } = await loadConfig(folder, { env: {} });
    const codecite = await createCodecite(options);
    const result = await codecite.ask('평일 몇 시 전에 결제해야 그날 나가요?');

    expect(result.status).toBe('answered');
    expect(result.trace).toMatchObject({
      retrieval: 'bm25',
      generation: 'deterministic',
    });
    expect(result.answer).toContain('오후 3 시');
  });

  it('키가 있는데 llm.model 이 비었으면 그 설정 이름을 적어 실패한다', async () => {
    await writeConfig({
      source: { path: 'claims.csv' },
      llm: { provider: 'openai' },
    });

    await expect(
      loadConfig(folder, { env: { OPENAI_API_KEY: 'test-key' } }),
    ).rejects.toThrow(/llm\.model is required/);
  });

  it('키가 있는데 embedding.model 이 비었으면 그 설정 이름을 적어 실패한다', async () => {
    await writeConfig({
      source: { path: 'claims.csv' },
      llm: { provider: 'openai', model: 'chat-model' },
      embedding: { provider: 'openai', model: '  ' },
    });

    await expect(
      loadConfig(folder, { env: { OPENAI_API_KEY: 'test-key' } }),
    ).rejects.toThrow(/embedding\.model is required/);
  });

  it('Ollama 는 키 없이 쓰므로 모델 이름이 없으면 바로 실패한다', async () => {
    await writeConfig({
      source: { path: 'claims.csv' },
      llm: { provider: 'ollama' },
    });

    await expect(loadConfig(folder, { env: {} })).rejects.toThrow(
      /llm\.model is required when llm\.provider is "ollama"/,
    );
  });

  it('키가 있으면 설정의 모델 이름으로 어댑터를 만든다', async () => {
    await writeConfig({
      source: { path: 'claims.csv' },
      llm: { provider: 'openai', model: 'chat-model' },
      embedding: { provider: 'openai', model: 'embed-model' },
    });
    const logger = fakeLogger();

    const { options } = await loadConfig(folder, {
      env: { OPENAI_API_KEY: 'test-key' },
      logger,
    });

    expect(options.llm).toBeInstanceOf(OpenAiClient);
    expect((options.llm as OpenAiClient).model).toBe('chat-model');
    expect(options.embedder?.fingerprint).toBe('openai:embed-model');
    expect(options.logger).toBe(logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('Ollama 제공자는 설정의 주소와 모델로 만든다', async () => {
    await writeConfig({
      source: { path: 'claims.csv' },
      llm: {
        provider: 'ollama',
        model: 'chat-model',
        baseUrl: 'http://127.0.0.1:9999',
      },
      embedding: { provider: 'ollama', model: 'embed-model' },
    });

    const { options } = await loadConfig(folder, { env: {} });

    expect(options.llm).toBeInstanceOf(OllamaClient);
    expect((options.llm as OllamaClient).baseUrl).toBe('http://127.0.0.1:9999');
    expect(options.embedder?.fingerprint).toBe('ollama:embed-model');
  });

  it('호환 서버 주소를 적은 openai 제공자는 키 없이도 만든다', async () => {
    await writeConfig({
      source: { path: 'claims.csv' },
      llm: {
        provider: 'openai',
        model: 'chat-model',
        baseUrl: 'http://127.0.0.1:8080/v1',
      },
    });
    const logger = fakeLogger();

    const { options } = await loadConfig(folder, { env: {}, logger });

    expect((options.llm as OpenAiClient).baseUrl).toBe(
      'http://127.0.0.1:8080/v1',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('상대 경로는 설정 파일이 있는 폴더를 기준으로 푼다', async () => {
    await mkdir(join(folder, 'data'));
    await writeConfig({
      source: { type: 'csv', path: 'data/claims.csv' },
      index: { path: 'cache/acorn-index.json' },
    });

    const { config, options } = await loadConfig(folder, { env: {} });

    expect(config.source.path).toBe(join(folder, 'data', 'claims.csv'));
    expect(config.index.path).toBe(join(folder, 'cache', 'acorn-index.json'));
    expect(options.source).toBeInstanceOf(CsvPolicySource);
    expect((options.source as CsvPolicySource).path).toBe(
      join(folder, 'data', 'claims.csv'),
    );
    expect(options.indexCachePath).toBe(
      join(folder, 'cache', 'acorn-index.json'),
    );
  });

  it('색인 경로를 비우면 폴더 안 .codecite/index.json 을 쓴다', async () => {
    await writeConfig({ source: { path: 'claims.csv' } });

    const { config } = await loadConfig(folder, { env: {} });

    expect(config.index.path).toBe(join(folder, '.codecite', 'index.json'));
  });

  it('서비스 사전은 그대로 넘겨 엔진이 한국어 기본 사전에 더하게 한다', async () => {
    const vocabulary = {
      synonyms: { 도토리: ['적립금'] },
      stopwords: ['알려줄래'],
      groupAliases: { points: ['도토리'] },
    };
    await writeConfig({ source: { path: 'claims.csv' }, vocabulary });

    const { config, options } = await loadConfig(folder, { env: {} });

    expect(config.vocabulary).toEqual(vocabulary);
    expect(options.vocabulary).toEqual(vocabulary);
  });

  it('도토리 마켓 예제 설정을 키 없는 모드로 읽는다', async () => {
    const exampleFolder = fileURLToPath(
      new URL('../examples/dotori-market/', import.meta.url),
    );

    const { config, options } = await loadConfig(exampleFolder, { env: {} });

    expect(config.source.path).toBe(join(exampleFolder, 'policies.csv'));
    expect(config.index.path).toBe(
      join(exampleFolder, '.codecite', 'index.json'),
    );
    expect(options.llm).toBeUndefined();
    expect(options.embedder).toBeUndefined();
    expect(options.vocabulary?.groupAliases).toHaveProperty('points');
  });

  it('설정 파일이 없으면 폴더를 적어 알려 준다', async () => {
    await expect(loadConfig(folder, { env: {} })).rejects.toThrow(
      /codecite\.config\.json was not found/,
    );
  });

  it.each([
    ['{ "source": ', /not valid JSON/],
    [{ llm: { provider: 'openai' } }, /source is required/],
    [{ source: { path: '' } }, /source\.path is required/],
    [
      { source: { type: 'sheet', path: 'a.csv' } },
      /source\.type must be "csv"/,
    ],
    [
      { source: { path: 'a.csv' }, llm: { provider: 'acorn-ai' } },
      /llm\.provider must be "openai" or "ollama"/,
    ],
    [
      { source: { path: 'a.csv' }, vocabulary: { stopwords: '알려줘' } },
      /vocabulary\.stopwords must be an array of strings/,
    ],
    [
      { source: { path: 'a.csv' }, vocabulary: { synonyms: { 쿠폰: [1] } } },
      /vocabulary\.synonyms\.쿠폰 must be an array of strings/,
    ],
  ])('틀린 설정은 어느 값인지 적어 실패한다 (%#)', async (config, message) => {
    await writeConfig(config);

    await expect(loadConfig(folder, { env: {} })).rejects.toThrow(message);
  });
});
