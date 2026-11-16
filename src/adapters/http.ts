import {
  HTTP_ERROR_CODE_PATTERN,
  HTTP_ERROR_TEXT_MAX_CHARS,
} from './constants.js';
import type { JsonPostOptions } from './types.js';

/**
 * JSON 을 POST 하고 JSON 응답을 돌려준다. 연결 실패, 시간 초과, 실패 상태, JSON 이 아닌 응답은 모두 throw 한다
 * 오류 문장에는 요청 이름, 상태, 오류 코드만 넣는다. 요청 머리(키)와 응답 메시지 본문은 넣지 않는다
 */
export async function postJson(
  url: string,
  body: unknown,
  options: JsonPostOptions,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (error) {
    // 연결 오류에는 요청 머리가 담기지 않아 원인으로 붙여도 키가 나가지 않는다
    throw new Error(
      `${options.label} request did not complete: ${transportFailure(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const detail = await failureDetail(
      response,
      options.exposeErrorText === true,
    );
    throw new Error(
      `${options.label} request failed with status ${response.status}${detail ? ` (${detail})` : ''}`,
    );
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${options.label} response is not JSON`);
  }
}

/** 호출자의 signal 과 시간 한도 중 먼저 오는 쪽에서 끊는 signal */
export function requestSignal(
  timeoutMs: number,
  signal?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** 끝의 `/` 를 떼어 경로를 이어 붙일 수 있게 한다 */
export function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

/** 1 이상의 유한한 수만 받고, 아니면 기본값을 쓴다 */
export function positiveNumber(
  value: number | undefined,
  fallback: number,
): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/** 글 목록을 정해진 크기로 나눈다 */
export function inBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/** 임베딩 응답의 벡터 하나를 검사한다. 비었거나 숫자가 아닌 값이 있으면 throw 한다 */
export function embeddingVector(value: unknown, label: string): number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === 'number' && Number.isFinite(item))
  ) {
    throw new Error(`${label} returned an invalid embedding vector`);
  }
  return value as number[];
}

function transportFailure(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') {
      return 'timed out';
    }
    if (error.name === 'AbortError') {
      return 'aborted';
    }
    return error.message;
  }
  return String(error);
}

/** 실패 응답에서 보여도 되는 것만 꺼낸다. 오류 코드 꼴의 값, 또는 허용한 경우의 짧은 오류 글이다 */
async function failureDetail(
  response: Response,
  exposeErrorText: boolean,
): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  const error =
    typeof body === 'object' && body !== null
      ? (body as { error?: unknown }).error
      : undefined;
  if (typeof error === 'string') {
    return exposeErrorText
      ? error.slice(0, HTTP_ERROR_TEXT_MAX_CHARS)
      : undefined;
  }
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { code, type } = error as { code?: unknown; type?: unknown };
  return [code, type].find(
    (value): value is string =>
      typeof value === 'string' && HTTP_ERROR_CODE_PATTERN.test(value),
  );
}
