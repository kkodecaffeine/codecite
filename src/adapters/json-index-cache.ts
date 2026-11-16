import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PolicyChunk } from '../domain/policy-chunk.js';
import type { PolicyChunkProps } from '../domain/types.js';
import type { Embedder, Logger } from '../ports.js';
import {
  DEFAULT_INDEX_CACHE_PATH,
  INDEX_CACHE_FORMAT_VERSION,
} from './constants.js';
import type {
  CachedIndex,
  CachedVectors,
  JsonIndexCacheOptions,
} from './types.js';

/**
 * 색인 지문. 조각 내용(정책 소스에서 만든 그대로)과 순서, 임베더 fingerprint, 캐시 형식 판을 함께 해시한다
 * 소스 내용이나 임베딩 모델 중 하나라도 바뀌면 지문이 바뀌어 다시 임베딩한다
 */
export function indexFingerprint(
  chunks: readonly PolicyChunk[],
  embedderFingerprint: string,
): string {
  const hash = createHash('sha256');
  hash.update(`codecite-index:${INDEX_CACHE_FORMAT_VERSION}\n`);
  hash.update(`${embedderFingerprint}\n`);
  for (const chunk of chunks) {
    hash.update(JSON.stringify(chunk.toJSON()));
    hash.update('\n');
  }
  return `sha256:${hash.digest('hex')}`;
}

/**
 * 조각과 벡터를 JSON 파일 하나(`{ fingerprint, chunks, vectors }`)에 담아 두는 색인 캐시
 * 지문이 같으면 다시 임베딩하지 않는다. 캐시는 빠르게 하려는 것이라, 없거나 깨졌으면 다시 만들면 될 뿐 실패로 보지 않는다
 */
export class JsonIndexCache {
  readonly path: string;
  readonly #logger: Logger | undefined;

  constructor(options: JsonIndexCacheOptions = {}) {
    this.path = options.path ?? DEFAULT_INDEX_CACHE_PATH;
    this.#logger = options.logger;
  }

  /** 지문이 같은 캐시가 있으면 조각과 벡터를 돌려준다. 없거나, 지문이 다르거나, 모양이 깨졌으면 undefined 다 */
  async load(fingerprint: string): Promise<CachedIndex | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#warn('index cache could not be read; rebuilding', error);
      }
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.#warn('index cache is not valid JSON; rebuilding', error);
      return undefined;
    }
    const stored = parsed as {
      fingerprint?: unknown;
      chunks?: unknown;
      vectors?: unknown;
    };
    if (stored?.fingerprint !== fingerprint) {
      this.#logger?.debug('index cache fingerprint changed; rebuilding', {
        path: this.path,
      });
      return undefined;
    }
    if (!isChunkPropsList(stored.chunks) || !isVectorList(stored.vectors)) {
      this.#warn('index cache has an unexpected shape; rebuilding');
      return undefined;
    }
    if (stored.chunks.length !== stored.vectors.length) {
      this.#warn('index cache chunk and vector counts differ; rebuilding');
      return undefined;
    }
    return {
      fingerprint,
      chunks: stored.chunks.map((props) => PolicyChunk.rehydrate(props)),
      vectors: stored.vectors,
    };
  }

  /** 캐시를 통째로 쓴다. 임시 파일에 쓴 뒤 이름을 바꿔, 쓰다 멈춰도 반쯤 쓴 파일이 남지 않는다 */
  async save(entry: CachedIndex): Promise<void> {
    if (entry.chunks.length !== entry.vectors.length) {
      throw new Error(
        `Index cache needs one vector per chunk: ${entry.chunks.length} chunks, ${entry.vectors.length} vectors.`,
      );
    }
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({
          fingerprint: entry.fingerprint,
          chunks: entry.chunks.map((chunk) => chunk.toJSON()),
          vectors: entry.vectors,
        }),
        'utf8',
      );
      await rename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /**
   * 조각의 searchText 벡터를 돌려준다. 지문이 같은 캐시가 있으면 그 벡터를 쓰고, 없으면 임베딩해 캐시에 쓴다
   * 임베딩 실패는 throw 해 허브가 BM25 만으로 물러나게 하고, 캐시 쓰기 실패는 경고만 남긴다
   */
  async vectorsFor(
    chunks: readonly PolicyChunk[],
    embedder: Embedder,
  ): Promise<CachedVectors> {
    const fingerprint = indexFingerprint(chunks, embedder.fingerprint);
    const cached = await this.load(fingerprint);
    if (cached) {
      return { fingerprint, vectors: cached.vectors, reused: true };
    }
    const vectors =
      chunks.length > 0
        ? await embedder.embed(chunks.map((chunk) => chunk.searchText))
        : [];
    if (vectors.length !== chunks.length) {
      throw new Error(
        `Embedder returned ${vectors.length} vectors for ${chunks.length} chunks.`,
      );
    }
    try {
      await this.save({ fingerprint, chunks: [...chunks], vectors });
    } catch (error) {
      this.#warn('index cache could not be saved', error);
    }
    return { fingerprint, vectors, reused: false };
  }

  #warn(message: string, error?: unknown): void {
    this.#logger?.warn(message, {
      path: this.path,
      ...(error === undefined
        ? {}
        : { error: error instanceof Error ? error.message : String(error) }),
    });
  }
}

/** JSON 색인 캐시를 만든다. 경로를 주지 않으면 `.codecite/index.json` 이다 */
export function jsonIndexCache(
  options: JsonIndexCacheOptions = {},
): JsonIndexCache {
  return new JsonIndexCache(options);
}

function isChunkPropsList(value: unknown): value is PolicyChunkProps[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        ['id', 'policyCode', 'section', 'text', 'source'].every(
          (key) => typeof (item as Record<string, unknown>)[key] === 'string',
        ),
    )
  );
}

/** 모든 벡터가 같은 차원의 유한한 수 배열인지 */
function isVectorList(value: unknown): value is number[][] {
  if (!Array.isArray(value)) {
    return false;
  }
  const dimension = Array.isArray(value[0]) ? value[0].length : 0;
  return value.every(
    (vector) =>
      Array.isArray(vector) &&
      vector.length > 0 &&
      vector.length === dimension &&
      vector.every((item) => typeof item === 'number' && Number.isFinite(item)),
  );
}
