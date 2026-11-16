import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ollamaClient } from './ollama.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const chat = (content: string, extra: object = {}) =>
  json({ message: { role: 'assistant', content }, done: true, ...extra });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

const sentBody = (call = 0): Record<string, unknown> =>
  JSON.parse(String(fetchMock.mock.calls[call][1]?.body)) as Record<
    string,
    unknown
  >;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 실제 모델 이름 대신 쓰는 이름. codecite 는 모델 기본값을 두지 않는다 */
const MODELS = { model: 'chat-model', embeddingModel: 'embed-model' };

describe('ollamaClient.complete', () => {
  it('/api/chat 에 스트림 없이 보내고 temperature 0 으로 고정한다', async () => {
    fetchMock.mockResolvedValue(
      chat(' 멤버십 등급은 매달 1 일에 다시 매깁니다. '),
    );

    await expect(
      ollamaClient(MODELS).complete({
        system: '규칙',
        user: '<질문>등급</질문>',
      }),
    ).resolves.toBe('멤버십 등급은 매달 1 일에 다시 매깁니다.');

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/chat');
    expect(fetchMock.mock.calls[0][1]?.headers).not.toHaveProperty(
      'authorization',
    );
    expect(sentBody()).toEqual({
      model: 'chat-model',
      messages: [
        { role: 'system', content: '규칙' },
        { role: 'user', content: '<질문>등급</질문>' },
      ],
      stream: false,
      options: { temperature: 0, num_predict: 2048 },
    });
  });

  it('json 요청이면 JSON 형식을 켜고, 옵션으로 모델·주소·유지 시간을 바꾼다', async () => {
    fetchMock.mockResolvedValue(chat('{"searchTerms":[],"facets":[]}'));

    await ollamaClient({
      model: 'other-chat-model',
      baseUrl: 'http://gpu-box:11434/',
      keepAlive: '10m',
      maxOutputTokens: 400,
    }).complete({ system: 's', user: 'u', json: true });

    expect(fetchMock.mock.calls[0][0]).toBe('http://gpu-box:11434/api/chat');
    expect(sentBody()).toMatchObject({
      model: 'other-chat-model',
      format: 'json',
      keep_alive: '10m',
      options: { temperature: 0, num_predict: 400 },
    });
  });

  it.each([
    ['덜 끝난 답', chat('배송은', { done: false }), /incomplete/],
    [
      '길이 한도에 잘린 답',
      chat('배송은', { done_reason: 'length' }),
      /incomplete/,
    ],
    ['빈 답', chat('  '), /empty/],
  ])('%s 은 throw 한다', async (_name, response, message) => {
    fetchMock.mockResolvedValue(response);

    await expect(
      ollamaClient(MODELS).complete({ system: 's', user: 'u' }),
    ).rejects.toThrow(message);
  });

  it('실패 응답의 오류 글을 붙여 모델 이름 오타 같은 원인을 보이게 한다', async () => {
    fetchMock.mockResolvedValue(
      json({ error: "model 'missing-model' not found" }, 404),
    );

    await expect(
      ollamaClient({ model: 'missing-model' }).complete({
        system: 's',
        user: 'u',
      }),
    ).rejects.toThrow(
      "Ollama chat request failed with status 404 (model 'missing-model' not found)",
    );
  });

  it('서버가 꺼져 있으면 까닭을 붙여 throw 한다', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      ollamaClient(MODELS).complete({ system: 's', user: 'u' }),
    ).rejects.toThrow('Ollama chat request did not complete: fetch failed');
  });
});

describe('ollamaClient.embedder', () => {
  it('fingerprint 에 제공자와 임베딩 모델을 담는다', () => {
    expect(ollamaClient(MODELS).embedder().fingerprint).toBe(
      'ollama:embed-model',
    );
    expect(
      ollamaClient({
        ...MODELS,
        embeddingModel: 'other-embed-model',
      }).embedder().fingerprint,
    ).toBe('ollama:other-embed-model');
  });

  it('/api/embed 에 글을 나눠 보내고 받은 순서대로 벡터를 돌려준다', async () => {
    const texts = Array.from({ length: 40 }, (_, index) => `리뷰 ${index}`);
    fetchMock.mockImplementation(async (_input, init) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      return json({
        embeddings: input.map((text) => [Number(text.split(' ')[1]), 0.5]),
      });
    });

    const vectors = await ollamaClient(MODELS).embedder().embed(texts);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/embed');
    expect(sentBody(0)).toMatchObject({ model: 'embed-model' });
    expect((sentBody(0).input as string[]).length).toBe(32);
    expect((sentBody(1).input as string[]).length).toBe(8);
    expect(vectors.map((vector) => vector[0])).toEqual(
      texts.map((_, index) => index),
    );
  });

  it('벡터 수가 맞지 않으면 throw 한다', async () => {
    fetchMock.mockResolvedValue(json({ embeddings: [[1, 2]] }));

    await expect(
      ollamaClient(MODELS).embedder().embed(['포장', '완충재']),
    ).rejects.toThrow('1 vectors for 2 texts');
  });
});

describe('ollamaClient 모델 이름', () => {
  it('답변 모델을 정하지 않고 부르면 요청하지 않고 throw 한다', async () => {
    await expect(
      ollamaClient().complete({ system: 's', user: 'u' }),
    ).rejects.toThrow('llm.model');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('임베딩 모델을 정하지 않으면 embedder 를 만들 때 throw 한다', () => {
    expect(() => ollamaClient().embedder()).toThrow('embedding.model');
  });
});
