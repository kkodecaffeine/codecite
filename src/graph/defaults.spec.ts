import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { SystemTopologyGraph } from '../extensions/code-knowledge.js';
import { parseGraphConfig } from './config.js';
import { DEFAULT_GRAPH_PRESETS, defaultGraphExtractors } from './defaults.js';
import { buildCodeGraph } from './pipeline.js';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

/** 파일을 커밋한 작업 저장소를 만들고, 그것을 원격으로 쓸 bare 저장소 경로를 돌려준다 */
async function createRemote(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const work = join(root, `${name}-work`);
  await mkdir(work, { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'user.email', 'dotori@example.com']);
  git(work, ['config', 'user.name', 'Dotori']);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'init']);
  const bare = join(root, `${name}.git`);
  git(root, ['clone', '-q', '--bare', work, bare]);
  return bare;
}

let root: string;

beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codecite-defaults-')));
  await mkdir(join(root, 'graph'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('기본 추출기와 프리셋', { timeout: 60_000 }, () => {
  it('기본 프리셋은 네 묶음을 모두 담고, 기본 추출기는 GraphQL 문서와 Prisma 스키마도 맡는다', () => {
    const names = new Set(DEFAULT_GRAPH_PRESETS.map((preset) => preset.name));
    for (const name of [
      'express',
      'fetch',
      'graphql-codegen',
      'celery',
      'typeorm',
    ]) {
      expect(names.has(name)).toBe(true);
    }
    const extensions = defaultGraphExtractors().flatMap(
      (extractor) => extractor.extensions,
    );
    expect(extensions).toEqual(
      expect.arrayContaining(['.ts', '.js', '.py', '.graphql', '.prisma']),
    );
  });

  it('옵션 없이 부르면 기본 추출기와 설정에서 고른 프리셋으로 라우트를 찾는다', async () => {
    const api = await createRemote(root, 'shop-api', {
      'src/app.ts': [
        "import express from 'express';",
        'const app = express();',
        'export function listOrders() {}',
        "app.get('/orders', listOrders);",
        '',
      ].join('\n'),
    });
    const config = parseGraphConfig(
      { repositories: [{ name: 'shop-api', url: api }], presets: ['express'] },
      join(root, 'graph'),
    );

    await buildCodeGraph(config);

    const topology = JSON.parse(
      await readFile(join(config.output, 'topology.json'), 'utf8'),
    ) as SystemTopologyGraph;
    expect(
      topology.nodes.some(
        (node) => node.type === 'API' && node.name.includes('/orders'),
      ),
    ).toBe(true);
  });

  it('설정의 자체 추출기가 .ts 를 맡아도 .js 는 기본 추출기가 계속 맡는다', async () => {
    const api = await createRemote(root, 'shop-api', {
      'src/points.ts': 'export function earnPoints() {}\n',
      'src/coupon.js': 'export function issueCoupon() {}\n',
    });
    await writeFile(
      join(root, 'graph', 'points-extractor.mjs'),
      [
        'export default {',
        "  name: 'points-only',",
        "  extensions: ['.ts'],",
        '  async extract(files) {',
        '    return {',
        '      symbols: files.map((file) => ({',
        '        filePath: file.filePath,',
        "        language: 'typescript',",
        "        symbol: 'pointsOnly',",
        "        kind: 'function',",
        '        content: file.content,',
        '        lineStart: 1,',
        '        lineEnd: 1,',
        '        relations: [],',
        '      })),',
        '      failures: [],',
        '    };',
        '  },',
        '};',
        '',
      ].join('\n'),
    );
    const config = parseGraphConfig(
      {
        repositories: [{ name: 'shop-api', url: api }],
        extractorModules: ['points-extractor.mjs'],
      },
      join(root, 'graph'),
    );

    const result = await buildCodeGraph(config);

    const symbols = result.records.map(
      (record) => `${record.filePath}#${record.symbol}`,
    );
    expect(symbols).toContain('src/points.ts#pointsOnly');
    expect(symbols).toContain('src/coupon.js#issueCoupon');
    expect(symbols).not.toContain('src/points.ts#earnPoints');
  });
});
