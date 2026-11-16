import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAiClient } from './openai.js';

const KEY = 'sk-test-acorn-0000';
/** 실제 모델 이름 대신 쓰는 이름. codecite 는 모델 기본값을 두지 않는다 */
const MODELS = { model: 'chat-model', embeddingModel: 'embed-model' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const chat = (content: string | null, extra: object = {}) =>
  json({
    choices: [{ finish_reason: 'stop', message: { content }, ...extra }],
  });

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

const sentBody = (call = 0): Record<string, unknown> =>
  JSON.parse(String(fetchMock.mock.calls[call][1]?.body)) as Record<
    string,
    unknown
  >;

const sentHeaders = (call = 0): Record<string, string> =>
  fetchMock.mock.calls[call][1]?.headers as Record<string, string>;

/** signal 이 끊기면 그 까닭으로 거절하는 fetch */
const hangingFetch: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('OPENAI_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('openAiClient.complete', () => {
  it('Chat Completions 에 지시문과 사용자 글을 보내고 답 글을 다듬어 돌려준다', async () => {
    fetchMock.mockResolvedValue(
      chat('  적립금은 결제 금액의 2 %가 쌓입니다.  '),
    );
    const client = openAiClient({ apiKey: KEY, ...MODELS });

    await expect(
      client.complete({ system: '규칙', user: '<질문>적립률</질문>' }),
    ).resolves.toBe('적립금은 결제 금액의 2 %가 쌓입니다.');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(sentHeaders().authorization).toBe(`Bearer ${KEY}`);
    expect(sentBody()).toEqual({
      model: 'chat-model',
      messages: [
        { role: 'system', content: '규칙' },
        { role: 'user', content: '<질문>적립률</질문>' },
      ],
      max_completion_tokens: 2048,
    });
  });

  it('json 요청이면 JSON 객체 모드를 켠다', async () => {
    fetchMock.mockResolvedValue(chat('{"searchTerms":[],"facets":[]}'));

    await openAiClient({ apiKey: KEY, ...MODELS }).complete({
      system: 'JSON 으로 답한다',
      user: '질문',
      json: true,
    });

    expect(sentBody().response_format).toEqual({ type: 'json_object' });
  });

  it('모델, 주소, 답 길이를 옵션으로 바꾼다', async () => {
    fetchMock.mockResolvedValue(chat('네'));
    const client = openAiClient({
      apiKey: KEY,
      model: 'other-chat-model',
      baseUrl: 'https://llm.dotori.test/v1/',
      maxOutputTokens: 300,
    });

    await client.complete({ system: 's', user: 'u' });

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://llm.dotori.test/v1/chat/completions',
    );
    expect(sentBody()).toMatchObject({
      model: 'other-chat-model',
      max_completion_tokens: 300,
    });
    expect(sentBody()).not.toHaveProperty('reasoning_effort');
    expect(sentBody()).not.toHaveProperty('temperature');
  });

  it('키를 옵션으로 주지 않으면 OPENAI_API_KEY 를 읽는다', async () => {
    vi.stubEnv('OPENAI_API_KEY', KEY);
    fetchMock.mockResolvedValue(chat('네'));

    await openAiClient(MODELS).complete({ system: 's', user: 'u' });

    expect(sentHeaders().authorization).toBe(`Bearer ${KEY}`);
  });

  it('키 없이 OpenAI 를 쓰려 하면 만들 때 바로 알린다', () => {
    expect(() => openAiClient()).toThrow(/OPENAI_API_KEY/);
  });

  it('주소를 바꾼 호환 서버는 키 없이 쓰고 인증 머리를 보내지 않는다', async () => {
    fetchMock.mockResolvedValue(chat('네'));

    await openAiClient({
      ...MODELS,
      baseUrl: 'http://127.0.0.1:8000/v1',
    }).complete({
      system: 's',
      user: 'u',
    });

    expect(sentHeaders()).not.toHaveProperty('authorization');
  });

  it('키는 오류 문장, 객체 출력, JSON 어디에도 나가지 않는다', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          error: {
            message: `Incorrect API key provided: ${KEY}`,
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        },
        401,
      ),
    );
    const client = openAiClient({ apiKey: KEY, ...MODELS });

    const failure = client.complete({ system: 's', user: 'u' });

    await expect(failure).rejects.toThrow(
      'OpenAI chat request failed with status 401 (invalid_api_key)',
    );
    await expect(failure).rejects.not.toThrow(KEY);
    expect(inspect(client, { showHidden: true, depth: 5 })).not.toContain(KEY);
    expect(JSON.stringify(client)).not.toContain(KEY);
    expect(inspect(client.embedder(), { depth: 5 })).not.toContain(KEY);
  });

  it.each([
    ['길이 한도에 잘린 답', chat('반품은', { finish_reason: 'length' }), /cut/],
    [
      '모델의 거절',
      json({ choices: [{ message: { content: null, refusal: 'no' } }] }),
      /refused/,
    ],
    ['빈 답', chat('   '), /empty/],
    ['choices 가 없는 응답', json({}), /empty/],
    [
      'JSON 이 아닌 응답',
      new Response('<html>bad gateway</html>', { status: 200 }),
      /not JSON/,
    ],
  ])(
    '%s 은 throw 해 허브가 결정적 답변으로 물러나게 한다',
    async (_name, response, message) => {
      fetchMock.mockResolvedValue(response);

      await expect(
        openAiClient({ apiKey: KEY, ...MODELS }).complete({
          system: 's',
          user: 'u',
        }),
      ).rejects.toThrow(message);
    },
  );

  it('연결이 안 되면 까닭을 붙여 throw 한다', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      openAiClient({ apiKey: KEY, ...MODELS }).complete({
        system: 's',
        user: 'u',
      }),
    ).rejects.toThrow('OpenAI chat request did not complete: fetch failed');
  });

  it('시간 한도를 넘기면 요청을 끊는다', async () => {
    fetchMock.mockImplementation(hangingFetch);

    await expect(
      openAiClient({ apiKey: KEY, ...MODELS, timeoutMs: 20 }).complete({
        system: 's',
        user: 'u',
      }),
    ).rejects.toThrow('timed out');
  });

  it('호출자의 signal 로도 요청을 끊는다', async () => {
    fetchMock.mockImplementation(hangingFetch);
    const controller = new AbortController();

    const pending = openAiClient({ apiKey: KEY, ...MODELS }).complete({
      system: 's',
      user: 'u',
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow('aborted');
  });
});

describe('openAiClient 모델과 표집 설정', () => {
  it('temperature 와 reasoningEffort 는 줄 때만 그대로 보낸다', async () => {
    fetchMock.mockResolvedValue(chat('네'));

    await openAiClient({
      apiKey: KEY,
      ...MODELS,
      temperature: 0,
      reasoningEffort: 'low',
    }).complete({ system: 's', user: 'u' });

    expect(sentBody()).toMatchObject({
      temperature: 0,
      reasoning_effort: 'low',
    });
  });

  it('답변 모델을 정하지 않고 부르면 요청하지 않고 throw 한다', async () => {
    await expect(
      openAiClient({ apiKey: KEY }).complete({ system: 's', user: 'u' }),
    ).rejects.toThrow('llm.model');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('임베딩 모델을 정하지 않으면 embedder 를 만들 때 throw 한다', () => {
    expect(() => openAiClient({ apiKey: KEY }).embedder()).toThrow(
      'embedding.model',
    );
  });
});

describe('openAiClient.embedder', () => {
  it('fingerprint 에 제공자와 임베딩 모델을 담는다', () => {
    const client = openAiClient({ apiKey: KEY, ...MODELS });

    expect(client.embedder().fingerprint).toBe('openai:embed-model');
    expect(
      openAiClient({
        apiKey: KEY,
        embeddingModel: 'other-embed-model',
      }).embedder().fingerprint,
    ).toBe('openai:other-embed-model');
  });

  it('글을 나눠 보내고 응답의 index 순서로 벡터를 맞춘다', async () => {
    const texts = Array.from({ length: 130 }, (_, index) => `상품 ${index}`);
    fetchMock.mockImplementation(async (_input, init) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      // 일부러 거꾸로 돌려준다
      return json({
        data: input
          .map((text, index) => ({
            index,
            embedding: [Number(text.split(' ')[1]), 1],
          }))
          .reverse(),
      });
    });

    const vectors = await openAiClient({ apiKey: KEY, ...MODELS })
      .embedder()
      .embed(texts);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.openai.com/v1/embeddings',
    );
    expect(sentBody(0)).toMatchObject({
      model: 'embed-model',
      encoding_format: 'float',
    });
    expect((sentBody(0).input as string[]).length).toBe(128);
    expect((sentBody(1).input as string[]).length).toBe(2);
    expect(vectors.map((vector) => vector[0])).toEqual(
      texts.map((_, index) => index),
    );
  });

  it('빈 목록은 요청하지 않는다', async () => {
    await expect(
      openAiClient({ apiKey: KEY, ...MODELS })
        .embedder()
        .embed([]),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('벡터 수가 맞지 않거나 숫자가 아니면 throw 한다', async () => {
    const embedder = openAiClient({ apiKey: KEY, ...MODELS }).embedder();

    fetchMock.mockResolvedValueOnce(
      json({ data: [{ index: 0, embedding: [1] }] }),
    );
    await expect(embedder.embed(['쿠폰', '배송'])).rejects.toThrow(
      '1 vectors for 2 texts',
    );

    fetchMock.mockResolvedValueOnce(
      json({ data: [{ index: 0, embedding: [1, 'x'] }] }),
    );
    await expect(embedder.embed(['쿠폰'])).rejects.toThrow(
      'invalid embedding vector',
    );
  });
});
