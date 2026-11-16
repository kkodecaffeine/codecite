import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  JSON_CONTENT_TYPE,
} from './constants.js';
import { noopLogger } from './logger.js';
import type { Logger } from './ports.js';
import type {
  Codecite,
  CodeciteRequestHandler,
  CodeciteRequestHandlerOptions,
  CodeciteServer,
  CodeciteServerOptions,
} from './types.js';

type ServedEngine = Pick<Codecite, 'ask' | 'indexSummary'>;

interface HandlerContext {
  codecite: ServedEngine;
  logger: Logger;
  maxBodyBytes: number;
}

/**
 * 엔진을 HTTP 요청 처리 함수로 감싼다. 소켓 없이도 부를 수 있어 `node:http` 서버나 다른 서버에 그대로 붙인다
 * - `POST /ask` 는 `{ "question": "..." }` 를 받아 `CodeciteAnswer` 를 JSON 으로 돌려준다
 * - `GET /health` 는 색인 요약을 돌려준다
 * 오류 응답과 로그에는 질문을 다시 싣지 않는다. 로그에는 경로 이름과 상태만 남긴다
 */
export function createRequestHandler(
  codecite: ServedEngine,
  options: CodeciteRequestHandlerOptions = {},
): CodeciteRequestHandler {
  const context: HandlerContext = {
    codecite,
    logger: options.logger ?? noopLogger,
    maxBodyBytes:
      options.maxBodyBytes !== undefined &&
      Number.isFinite(options.maxBodyBytes) &&
      options.maxBodyBytes > 0
        ? Math.floor(options.maxBodyBytes)
        : DEFAULT_MAX_REQUEST_BODY_BYTES,
  };
  return async (request, response) => {
    const startedAt = Date.now();
    const route = routeOf(request.url);
    let status: number;
    try {
      status = await respond(request, response, route, context);
    } catch (error) {
      // respond 는 오류를 응답으로 바꾸므로 여기까지 오면 처리 함수 자체의 잘못이다
      context.logger.error('request failed', {
        route,
        error: errorName(error),
      });
      status = sendError(response, 500, 'internal error');
    }
    context.logger.info('request handled', {
      route,
      method: request.method,
      status,
      elapsedMs: Date.now() - startedAt,
    });
  };
}

/** 엔진을 `node:http` 서버로 연다. 주소를 다 받은 뒤에 돌려준다 */
export async function startServer(
  codecite: ServedEngine,
  options: CodeciteServerOptions = {},
): Promise<CodeciteServer> {
  const handler = createRequestHandler(codecite, options);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(
      options.port ?? DEFAULT_SERVER_PORT,
      options.host ?? DEFAULT_SERVER_HOST,
      () => {
        server.off('error', reject);
        resolve();
      },
    );
  });
  const address = server.address() as AddressInfo;
  const host =
    address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    server,
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** 경로만 본다. 질의 문자열은 버리고, 모르는 경로는 로그에 경로 글 대신 unknown 으로 남긴다 */
function routeOf(url: string | undefined): 'ask' | 'health' | 'unknown' {
  let pathname: string;
  try {
    pathname = new URL(url ?? '/', 'http://localhost').pathname;
  } catch {
    return 'unknown';
  }
  if (pathname === '/ask') {
    return 'ask';
  }
  if (pathname === '/health') {
    return 'health';
  }
  return 'unknown';
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  route: 'ask' | 'health' | 'unknown',
  context: HandlerContext,
): Promise<number> {
  if (route === 'health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return sendError(response, 405, 'method not allowed', {
        allow: 'GET, HEAD',
      });
    }
    return sendJson(response, 200, {
      status: 'ok',
      index: context.codecite.indexSummary,
    });
  }
  if (route === 'ask') {
    if (request.method !== 'POST') {
      return sendError(response, 405, 'method not allowed', {
        allow: 'POST',
      });
    }
    return answer(request, response, context);
  }
  return sendError(response, 404, 'not found');
}

async function answer(
  request: IncomingMessage,
  response: ServerResponse,
  context: HandlerContext,
): Promise<number> {
  let body: Buffer | undefined;
  try {
    body = await readBody(request, context.maxBodyBytes);
  } catch {
    return sendError(response, 400, 'request body could not be read');
  }
  if (body === undefined) {
    // 남은 본문을 다 읽지 않고 연결을 닫아, 큰 본문을 끝까지 받아 주지 않는다
    return sendError(
      response,
      413,
      `request body is larger than ${context.maxBodyBytes} bytes`,
      { connection: 'close' },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return sendError(response, 400, 'request body must be JSON');
  }
  const question =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).question
      : undefined;
  if (typeof question !== 'string' || !question.trim()) {
    return sendError(response, 400, 'question must be a non-empty string');
  }
  try {
    return sendJson(response, 200, await context.codecite.ask(question));
  } catch (error) {
    // 엔진 오류 문장에 질문이 섞여 있어도 로그에는 가린 문장만 남긴다
    const detail = withoutQuestion(errorMessage(error), question);
    if (error instanceof TypeError) {
      context.logger.warn('question rejected', { error: detail });
      return sendError(response, 400, 'invalid question');
    }
    context.logger.error('answer failed', { error: detail });
    return sendError(response, 500, 'internal error');
  }
}

/** 본문을 상한까지만 모은다. 상한을 넘으면 undefined, 연결이 끊기면 throw */
function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<Buffer | undefined> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    return Promise.resolve(undefined);
  }
  return new Promise<Buffer | undefined>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        request.off('data', onData);
        request.resume();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    };
    request.on('data', onData);
    request.once('end', () => resolve(Buffer.concat(chunks)));
    request.once('error', reject);
    // 끝나기 전에 닫히면 기다림을 끊는다. 다 읽은 뒤의 close 는 이미 정해진 결과를 바꾸지 않는다
    request.once('close', () =>
      reject(new Error('request closed before the body ended')),
    );
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): number {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': String(Buffer.byteLength(payload)),
    ...headers,
  });
  response.end(payload);
  return status;
}

function sendError(
  response: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): number {
  if (response.headersSent) {
    return status;
  }
  return sendJson(response, status, { error: message }, headers);
}

function withoutQuestion(message: string, question: string): string {
  return [question, question.trim()]
    .filter(Boolean)
    .reduce((text, part) => text.split(part).join('[question]'), message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
