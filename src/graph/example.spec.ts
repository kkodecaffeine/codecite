// 도토리 마켓 다중 저장소 예제(examples/dotori-market)로 그래프를 만들어 기대 연결과 견준다
// 기대 연결이 사라지거나 기대하지 않은 연결이 생기면 실패한다. 처음부터 두 번 만들어 결과가 바이트 단위로 같은지도 본다
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  CrossRepositoryGraph,
  EntityRelationGraph,
  FieldWriterIndex,
} from '../extensions/code-knowledge.js';
import { loadGraphConfig } from './config.js';
import { validateGraphOutput } from './data/index.js';
import { buildCodeGraph } from './pipeline.js';

const EXAMPLE = new URL('../../examples/dotori-market/graph/', import.meta.url);

interface ExpectedGraph {
  links: Array<{ relation: string; from: string; to: string }>;
  unresolved: Array<{ reason: string; relation: string; at: string }>;
  entities: Record<string, string[]>;
  fieldWriters: string[];
}

interface Location {
  repository: string;
  filePath: string;
  symbol: string;
}

const at = (location: Location): string =>
  `${location.repository}:${location.filePath}#${location.symbol}`;

const sorted = <T>(items: T[]): T[] =>
  [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

async function readTree(folder: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      files.set(relative(folder, path), await readFile(path, 'utf8'));
    }
  }
  return files;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

let root: string;

beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('도토리 마켓 다중 저장소 예제', { timeout: 120_000 }, () => {
  it('기대한 연결·못 이은 항목·엔티티·필드 쓰기를 내고, 두 번 만들어도 결과가 같다', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'codecite-example-')));
    const prepare = (await import(
      new URL('prepare-repos.mjs', EXAMPLE).href
    )) as { prepareExampleRepositories(root: string): Promise<string[]> };
    expect(await prepare.prepareExampleRepositories(root)).toEqual([
      'shop-api',
      'shop-web',
      'shop-worker',
    ]);
    await mkdir(join(root, 'graph'));
    await copyFile(
      new URL('codecite.graph.json', EXAMPLE),
      join(root, 'graph', 'codecite.graph.json'),
    );
    const expected = await readJson<ExpectedGraph>(
      new URL('expected-links.json', EXAMPLE).pathname,
    );
    const config = await loadGraphConfig(join(root, 'graph'));

    const result = await buildCodeGraph(config);

    const cross = await readJson<CrossRepositoryGraph>(
      join(result.output, 'cross-repository.json'),
    );
    expect(
      sorted(
        cross.edges.map((edge) => ({
          relation: edge.relation,
          from: at(edge.sourceLocation as Location),
          to: at(edge.targetLocation as Location),
        })),
      ),
    ).toEqual(sorted(expected.links));
    expect(
      sorted(
        result.report.unresolved.map((item) => ({
          reason: item.reason,
          relation: item.relation,
          at: at(item),
        })),
      ),
    ).toEqual(sorted(expected.unresolved));
    const entities = await readJson<EntityRelationGraph>(
      join(result.output, 'entities.json'),
    );
    expect(
      Object.fromEntries(
        entities.tables.map((table) => [
          table.table,
          table.relations.map((relation) => relation.targetTable).sort(),
        ]),
      ),
    ).toEqual(expected.entities);
    const writers = await readJson<FieldWriterIndex>(
      join(result.output, 'field-writers.json'),
    );
    expect(Object.keys(writers.writers).sort()).toEqual(expected.fieldWriters);
    expect(await validateGraphOutput(result.output, { config })).toMatchObject({
      ok: true,
      errors: [],
    });

    // 결과·캐시를 지우고 처음부터 다시 만들어도 같은 바이트가 나와야 한다
    const first = await readTree(result.output);
    await rm(result.output, { recursive: true, force: true });
    await rm(config.cache, { recursive: true, force: true });
    const again = await buildCodeGraph(config);
    expect(Object.values(again.reused).every((reused) => !reused)).toBe(true);
    expect(await readTree(again.output)).toEqual(first);
    for (const [file, text] of first) {
      expect(text, file).not.toContain(root);
    }
  });
});
