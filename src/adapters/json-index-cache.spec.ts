import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectPolicyChunks } from '../domain/chunk-projector.js';
import type { PolicyChunk } from '../domain/policy-chunk.js';
import type { Embedder, Logger } from '../ports.js';
import { policiesFromClaimCsv } from './csv-policy-source.js';
import {
  indexFingerprint,
  jsonIndexCache,
  JsonIndexCache,
} from './json-index-cache.js';

const csv = (shippingStatement = '오후 2 시 전 결제는 그날 출고한다.') =>
  [
    'policy_group,feature_name,claim_statement',
    'points,리뷰 적립,사진 리뷰를 남기면 적립금 500 원을 준다.',
    `shipping,당일 출고,${shippingStatement}`,
  ].join('\n');

const chunksFrom = (content: string): PolicyChunk[] =>
  policiesFromClaimCsv(content).flatMap((policy) =>
    projectPolicyChunks(policy),
  );

const fakeEmbedder = (fingerprint = 'fake:acorn-1'): Embedder => ({
  fingerprint,
  embed: vi.fn<Embedder['embed']>(async (texts) =>
    texts.map((text) => [text.length, 1, 0.5]),
  ),
});

const fakeLogger = (): Logger => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

let folder: string;
let cachePath: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'codecite-cache-'));
  cachePath = join(folder, 'nested', 'index.json');
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('indexFingerprint', () => {
  it('조각 내용·순서와 임베더 fingerprint 가 같을 때만 같다', () => {
    const chunks = chunksFrom(csv());
    const base = indexFingerprint(chunks, 'fake:acorn-1');

    expect(indexFingerprint(chunksFrom(csv()), 'fake:acorn-1')).toBe(base);
    expect(base).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(indexFingerprint([...chunks].reverse(), 'fake:acorn-1')).not.toBe(
      base,
    );
    expect(indexFingerprint(chunks, 'fake:acorn-2')).not.toBe(base);
    expect(
      indexFingerprint(
        chunksFrom(csv('오후 3 시 전 결제는 그날 출고한다.')),
        'fake:acorn-1',
      ),
    ).not.toBe(base);
  });
});

describe('JsonIndexCache', () => {
  it('기본 경로는 현재 폴더의 .codecite/index.json 이다', () => {
    expect(jsonIndexCache().path).toBe('.codecite/index.json');
    expect(new JsonIndexCache({ path: cachePath }).path).toBe(cachePath);
  });

  it('{ fingerprint, chunks, vectors } 로 쓰고 같은 지문으로 다시 읽는다', async () => {
    const cache = jsonIndexCache({ path: cachePath });
    const chunks = chunksFrom(csv());
    const vectors = [
      [0.1, 0.2],
      [0.3, 0.4],
    ];

    await cache.save({ fingerprint: 'sha256:abc', chunks, vectors });

    const stored = JSON.parse(await readFile(cachePath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(stored)).toEqual(['fingerprint', 'chunks', 'vectors']);
    const loaded = await cache.load('sha256:abc');
    expect(loaded?.vectors).toEqual(vectors);
    expect(loaded?.chunks.map((chunk) => chunk.toJSON())).toEqual(
      chunks.map((chunk) => chunk.toJSON()),
    );
    expect(loaded?.chunks[0].policyClaims[0].statement).toBe(
      '사진 리뷰를 남기면 적립금 500 원을 준다.',
    );
  });

  it('지문이 다르거나 파일이 없으면 경고 없이 undefined 다', async () => {
    const logger = fakeLogger();
    const cache = jsonIndexCache({ path: cachePath, logger });

    await expect(cache.load('sha256:abc')).resolves.toBeUndefined();
    await cache.save({ fingerprint: 'sha256:abc', chunks: [], vectors: [] });
    await expect(cache.load('sha256:other')).resolves.toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['JSON 이 아닌 파일', '{ broken'],
    [
      '조각과 벡터 수가 다른 파일',
      JSON.stringify({ fingerprint: 'sha256:abc', chunks: [], vectors: [[1]] }),
    ],
    [
      '벡터 차원이 섞인 파일',
      JSON.stringify({
        fingerprint: 'sha256:abc',
        chunks: [],
        vectors: [[1, 2], [3]],
      }),
    ],
    [
      '조각 모양이 틀린 파일',
      JSON.stringify({
        fingerprint: 'sha256:abc',
        chunks: [{ id: 1 }],
        vectors: [[1]],
      }),
    ],
  ])(
    '%s 은 경고를 남기고 undefined 로 다시 만들게 한다',
    async (_name, content) => {
      const logger = fakeLogger();
      await jsonIndexCache({ path: cachePath }).save({
        fingerprint: 'x',
        chunks: [],
        vectors: [],
      });
      await writeFile(cachePath, content, 'utf8');

      await expect(
        jsonIndexCache({ path: cachePath, logger }).load('sha256:abc'),
      ).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    },
  );

  it('save 는 조각과 벡터 수가 다르면 throw 한다', async () => {
    await expect(
      jsonIndexCache({ path: cachePath }).save({
        fingerprint: 'sha256:abc',
        chunks: chunksFrom(csv()),
        vectors: [[1]],
      }),
    ).rejects.toThrow('2 chunks, 1 vectors');
  });
});

describe('JsonIndexCache.vectorsFor', () => {
  it('처음에는 searchText 를 임베딩해 쓰고, 내용과 임베더가 같으면 다시 임베딩하지 않는다', async () => {
    const cache = jsonIndexCache({ path: cachePath });
    const embedder = fakeEmbedder();
    const chunks = chunksFrom(csv());

    const first = await cache.vectorsFor(chunks, embedder);
    const second = await jsonIndexCache({ path: cachePath }).vectorsFor(
      chunksFrom(csv()),
      embedder,
    );

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.vectors).toEqual(first.vectors);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(embedder.embed).toHaveBeenCalledTimes(1);
    expect(vi.mocked(embedder.embed).mock.calls[0][0]).toEqual(
      chunks.map((chunk) => chunk.searchText),
    );
  });

  it('claim 문장이나 임베더 fingerprint 가 바뀌면 다시 임베딩한다', async () => {
    const cache = jsonIndexCache({ path: cachePath });
    const embedder = fakeEmbedder();
    await cache.vectorsFor(chunksFrom(csv()), embedder);

    const edited = await cache.vectorsFor(
      chunksFrom(csv('주말 결제는 월요일에 출고한다.')),
      embedder,
    );
    const otherModel = fakeEmbedder('fake:acorn-2');
    const remodeled = await cache.vectorsFor(
      chunksFrom(csv('주말 결제는 월요일에 출고한다.')),
      otherModel,
    );

    expect(edited.reused).toBe(false);
    expect(remodeled.reused).toBe(false);
    expect(embedder.embed).toHaveBeenCalledTimes(2);
    expect(otherModel.embed).toHaveBeenCalledTimes(1);
  });

  it('조각이 없으면 임베더를 부르지 않는다', async () => {
    const embedder = fakeEmbedder();

    await expect(
      jsonIndexCache({ path: cachePath }).vectorsFor([], embedder),
    ).resolves.toMatchObject({ vectors: [], reused: false });
    expect(embedder.embed).not.toHaveBeenCalled();
  });

  it('임베더가 다른 수의 벡터를 주면 throw 하고 캐시를 쓰지 않는다', async () => {
    const embedder: Embedder = {
      fingerprint: 'fake:short',
      embed: async () => [[1, 2]],
    };

    await expect(
      jsonIndexCache({ path: cachePath }).vectorsFor(
        chunksFrom(csv()),
        embedder,
      ),
    ).rejects.toThrow('1 vectors for 2 chunks');
    await expect(readFile(cachePath, 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('캐시를 쓰지 못해도 경고만 남기고 벡터를 돌려준다', async () => {
    const blocker = join(folder, 'not-a-folder');
    await writeFile(blocker, 'file', 'utf8');
    const logger = fakeLogger();

    const result = await jsonIndexCache({
      path: join(blocker, 'index.json'),
      logger,
    }).vectorsFor(chunksFrom(csv()), fakeEmbedder());

    expect(result.vectors).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(
      'index cache could not be saved',
      expect.objectContaining({ path: join(blocker, 'index.json') }),
    );
  });
});
