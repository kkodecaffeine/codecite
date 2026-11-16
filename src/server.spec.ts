import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { LogFields, Logger } from './ports.js';
import { createRequestHandler, startServer } from './server.js';
import type { CodeciteAnswer, CodeciteIndexSummary } from './types.js';

const QUESTION = '묶음 배송으로 주문한 상품은 따로 반품할 수 있나요?';

const INDEX: CodeciteIndexSummary = {
  chunks: 12,
  retrieval: 'bm25',
  reusedVectors: false,
};

const ANSWER: CodeciteAnswer = {
  status: 'answered',
  answer: '묶음 배송 상품도 상품마다 따로 반품을 신청할 수 있습니다.',
  citations: [
    {
      claimId: 'claim-0a1b2c3d4e5f6071',
      policyGroup: 'refund',
      statement: '묶음 배송 상품도 상품마다 따로 반품을 신청할 수 있다.',
      source: '반품 안내 2 항',
    },
  ],
  trace: {
    retrieval: 'bm25',
    generation: 'deterministic',
    candidates: 3,
    packed: 1,
  },
};

interface Sent {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function request(
  method: string,
  url: string,
  body?: string | Buffer,
  headers: Record<string, string> = {},
): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  return Object.assign(Readable.from(chunks), {
    method,
    url,
    headers,
  }) as unknown as IncomingMessage;
}

function response(): { res: ServerResponse; sent: Sent } {
  const sent: Sent = { status: 0, headers: {}, body: '' };
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string>) {
      sent.status = status;
      sent.headers = headers;
      this.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      sent.body = chunk ?? '';
      return this;
    },
  };
  return { res: res as unknown as ServerResponse, sent };
}

function recordingLogger(): { logger: Logger; calls: unknown[] } {
  const calls: unknown[] = [];
  const record = (message: string, fields?: LogFields) => {
    calls.push([message, fields]);
  };
  return {
    calls,
    logger: { debug: record, info: record, warn: record, error: record },
  };
}

async function handle(
  req: IncomingMessage,
  engine: {
    ask?: (question: string) => Promise<CodeciteAnswer>;
    maxBodyBytes?: number;
  } = {},
) {
  const { logger, calls } = recordingLogger();
  const ask = vi.fn(engine.ask ?? (async () => ANSWER));
  const handler = createRequestHandler(
    { ask, indexSummary: INDEX },
    { logger, maxBodyBytes: engine.maxBodyBytes },
  );
  const { res, sent } = response();
  await handler(req, res);
  return {
    ...sent,
    json: sent.body ? (JSON.parse(sent.body) as unknown) : undefined,
    ask,
    calls,
  };
}

describe('createRequestHandler', () => {
  it('POST /ask 는 질문을 엔진에 넘기고 CodeciteAnswer 를 JSON 으로 돌려준다', async () => {
    const result = await handle(
      request('POST', '/ask', JSON.stringify({ question: QUESTION })),
    );

    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    );
    expect(result.ask).toHaveBeenCalledWith(QUESTION);
    expect(result.json).toEqual(ANSWER);
  });

  it('GET /health 는 색인 요약을 돌려준다', async () => {
    const result = await handle(request('GET', '/health?probe=1'));

    expect(result.status).toBe(200);
    expect(result.json).toEqual({ status: 'ok', index: INDEX });
  });

  it.each([
    ['JSON 이 아닌 본문', '{"question": "배송', 'request body must be JSON'],
    [
      'question 필드가 빠진 본문',
      '{"text": "배송비"}',
      'question must be a non-empty',
    ],
    ['빈 question', '{"question": "  "}', 'question must be a non-empty'],
    [
      '문자열이 아닌 question',
      '{"question": 3}',
      'question must be a non-empty',
    ],
    ['객체가 아닌 본문', '["배송비"]', 'question must be a non-empty'],
  ])('%s 는 400 으로 답하고 엔진을 부르지 않는다', async (_, body, error) => {
    const result = await handle(request('POST', '/ask', body));

    expect(result.status).toBe(400);
    expect(result.json).toEqual({ error: expect.stringContaining(error) });
    expect(result.ask).not.toHaveBeenCalled();
  });

  it('엔진이 TypeError 를 던지면 400, 그 밖의 오류는 500 으로 답한다', async () => {
    const rejected = await handle(
      request('POST', '/ask', JSON.stringify({ question: QUESTION })),
      {
        ask: async () => {
          throw new TypeError('question is not usable');
        },
      },
    );
    const failed = await handle(
      request('POST', '/ask', JSON.stringify({ question: QUESTION })),
      {
        ask: async () => {
          throw new Error('index is not ready');
        },
      },
    );

    expect(rejected.status).toBe(400);
    expect(rejected.json).toEqual({ error: 'invalid question' });
    expect(failed.status).toBe(500);
    expect(failed.json).toEqual({ error: 'internal error' });
  });

  it('본문이 상한을 넘으면 길이 머리가 있든 없든 413 으로 답하고 연결을 닫는다', async () => {
    const body = JSON.stringify({ question: '상품 리뷰 '.repeat(20) });

    const declared = await handle(
      request('POST', '/ask', body, {
        'content-length': String(Buffer.byteLength(body)),
      }),
      { maxBodyBytes: 64 },
    );
    const streamed = await handle(request('POST', '/ask', body), {
      maxBodyBytes: 64,
    });

    for (const result of [declared, streamed]) {
      expect(result.status).toBe(413);
      expect(result.headers.connection).toBe('close');
      expect(result.ask).not.toHaveBeenCalled();
    }
  });

  it('기본 본문 상한은 16 KB 다', async () => {
    // 한글 한 글자는 UTF-8 로 3 바이트다
    const under = JSON.stringify({ question: '가'.repeat(5_000) });
    const over = JSON.stringify({ question: '가'.repeat(5_500) });

    const accepted = await handle(request('POST', '/ask', under));
    const refused = await handle(request('POST', '/ask', over));

    expect(Buffer.byteLength(under)).toBeLessThan(16 * 1024);
    expect(Buffer.byteLength(over)).toBeGreaterThan(16 * 1024);
    expect(accepted.status).toBe(200);
    expect(refused.status).toBe(413);
  });

  it('경로마다 받지 않는 메서드는 405 와 Allow 머리로, 모르는 경로는 404 로 답한다', async () => {
    const getAsk = await handle(request('GET', '/ask'));
    const postHealth = await handle(request('POST', '/health', '{}'));
    const unknown = await handle(request('GET', '/policies'));

    expect(getAsk.status).toBe(405);
    expect(getAsk.headers.allow).toBe('POST');
    expect(postHealth.status).toBe(405);
    expect(postHealth.headers.allow).toBe('GET, HEAD');
    expect(unknown.status).toBe(404);
    expect(unknown.json).toEqual({ error: 'not found' });
  });

  it('요청마다 경로 이름, 메서드, 상태, 걸린 시간만 남긴다', async () => {
    const result = await handle(request('GET', '/health'));

    expect(result.calls).toEqual([
      [
        'request handled',
        {
          route: 'health',
          method: 'GET',
          status: 200,
          elapsedMs: expect.any(Number),
        },
      ],
    ]);
  });

  it('어떤 응답과 로그에도 질문 본문을 싣지 않는다', async () => {
    const body = JSON.stringify({ question: QUESTION });
    const results = [
      await handle(request('POST', '/ask', body)),
      await handle(request('POST', '/ask', body), {
        ask: async (question) => {
          throw new TypeError(`cannot read "${question}"`);
        },
      }),
      await handle(request('POST', '/ask', body), {
        ask: async (question) => {
          throw new Error(`no index for ${question}`);
        },
      }),
      await handle(request('POST', '/ask', body), { maxBodyBytes: 16 }),
      await handle(request('POST', `/${encodeURIComponent(QUESTION)}`, body)),
      await handle(request('POST', '/ask', `{"question": "${QUESTION}"`)),
    ];

    for (const result of results) {
      expect(JSON.stringify(result.calls)).not.toContain(QUESTION);
      expect(JSON.stringify(result.calls)).not.toContain(
        encodeURIComponent(QUESTION),
      );
    }
    for (const result of results) {
      expect(result.body).not.toContain(QUESTION);
    }
    expect(JSON.stringify(results[2].calls)).toContain('[question]');
  });
});

describe('startServer', () => {
  it('빈 포트로 열어 실제 요청에 답하고 닫힌다', async () => {
    const server = await startServer(
      { ask: async () => ANSWER, indexSummary: INDEX },
      { port: 0, host: '127.0.0.1' },
    );
    try {
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const health = await fetch(`${server.url}/health`);
      const asked = await fetch(`${server.url}/ask`, {
        method: 'POST',
        body: JSON.stringify({ question: QUESTION }),
      });

      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok', index: INDEX });
      expect(asked.status).toBe(200);
      expect(await asked.json()).toEqual(ANSWER);
    } finally {
      await server.close();
    }
  });
});
