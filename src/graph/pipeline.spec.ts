import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
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
import { parseGraphConfig } from './config.js';
import { GraphCollapseError } from './output.js';
import { buildCodeGraph } from './pipeline.js';
import type {
  ExtractedSymbol,
  GraphConfig,
  SourceFile,
  SymbolExtractor,
} from './types.js';

// ── 임시 git 저장소 ──

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Dotori Dev',
  GIT_AUTHOR_EMAIL: 'dev@dotori.test',
  GIT_COMMITTER_NAME: 'Dotori Dev',
  GIT_COMMITTER_EMAIL: 'dev@dotori.test',
};

function git(
  cwd: string,
  args: string[],
  date = '2026-11-01T09:00:00Z',
): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...IDENTITY,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  }).trim();
}

async function commitFiles(
  work: string,
  files: Record<string, string | null>,
  date?: string,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await rm(join(work, path));
    } else {
      await mkdir(dirname(join(work, path)), { recursive: true });
      await writeFile(join(work, path), content);
    }
  }
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'change'], date);
}

async function createRemote(
  root: string,
  name: string,
  branch: string,
  files: Record<string, string>,
): Promise<{ work: string; bare: string }> {
  const work = join(root, `${name}-work`);
  git(root, ['init', '-q', '-b', branch, work]);
  await commitFiles(work, files);
  const bare = join(root, `${name}.git`);
  git(root, ['clone', '-q', '--bare', work, bare]);
  git(work, ['remote', 'add', 'origin', bare]);
  return { work, bare };
}

/** 결과 폴더의 모든 파일 내용. 폴더 기준 상대 경로 → 내용 */
async function readTree(folder: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        result[relative(folder, path)] = await readFile(path, 'utf8');
      }
    }
  };
  await walk(folder);
  return Object.fromEntries(Object.entries(result).sort());
}

// ── 가짜 추출기: `export function 이름` 한 줄을 심볼 하나로 본다 ──

function fakeExtractor(calls: SourceFile[][] = []): SymbolExtractor {
  return {
    name: 'fake-ts',
    extensions: ['.ts'],
    async extract(files) {
      calls.push([...files]);
      const symbols: ExtractedSymbol[] = [];
      const failures = [];
      for (const file of files) {
        if (file.content.includes('@@broken')) {
          failures.push({
            filePath: file.filePath,
            message: `cannot parse ${join(tmpdir(), 'scratch', file.filePath)} near @@broken`,
          });
          continue;
        }
        for (const [index, line] of file.content.split('\n').entries()) {
          const match = /^export function (\w+)/.exec(line);
          if (match) {
            symbols.push({
              filePath: file.filePath,
              language: 'typescript',
              symbol: match[1],
              kind: 'function',
              content: line,
              lineStart: index + 1,
              lineEnd: index + 1,
              relations: [],
              // 탐지 단계가 쓰는 중간 데이터. 결과 파일에는 들어가면 안 된다
              sites: [{ kind: 'call', callee: 'acornQueue.push' }],
            } as ExtractedSymbol);
          }
        }
      }
      return { symbols, failures };
    },
  };
}

// 비밀값 모양은 소스에 글자 그대로 두지 않고 실행할 때 만든다
const FAKE_SECRET = ['dotori', 'Vault', String(6 * 7), 'acorn'].join('-');

let root: string;
let shopApi: { work: string; bare: string };
let shopWeb: string;

beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codecite-pipeline-')));
  shopApi = await createRemote(root, 'shop-api', 'trunk', {
    'src/points/earn.ts':
      'export function earnPoints() {}\nexport function previewPoints() {}\n',
    'src/refund/refund.ts': [
      'export function requestRefund() {}',
      `export function connectPayments() { const apiKey = '${FAKE_SECRET}'; }`,
      '',
    ].join('\n'),
    'src/refund/refund.spec.ts': 'export function refundCase() {}\n',
    'src/broken.ts': 'export function @@broken\n',
    '.env': `ACORN_TOKEN=${FAKE_SECRET}\n`,
    'data/members.csv': 'name,grade\nacorn,gold\n',
    'docs/refund.md': '# 환불\n',
  });
  const web = await createRemote(root, 'shop-web', 'main', {
    'src/cart/cart.ts': 'export function addToCart() {}\n',
  });
  shopWeb = join(root, 'shop-web');
  git(root, ['clone', '-q', web.bare, shopWeb]);
  await commitFiles(shopWeb, {
    'src/cart/draft.ts': 'export function draftCart() {}\n',
  });
  await mkdir(join(root, 'graph'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const configFor = (extra: Record<string, unknown> = {}): GraphConfig =>
  parseGraphConfig(
    {
      repositories: [
        { name: 'shop-web', path: '../shop-web' },
        { name: 'shop-api', url: shopApi.bare },
      ],
      groups: { points: ['shop-api:src/points/**'] },
      ...extra,
    },
    join(root, 'graph'),
  );

describe('buildCodeGraph', { timeout: 60_000 }, () => {
  it('추출기가 없으면 저장소마다 빈 심볼 파일과 manifest 를 쓴다', async () => {
    const config = configFor();
    const result = await buildCodeGraph(config);

    expect(result.files).toEqual([
      'manifest.json',
      'symbols/shop-api.jsonl',
      'symbols/shop-web.jsonl',
    ]);
    expect(result.records).toEqual([]);
    const tree = await readTree(config.output);
    expect(tree['symbols/shop-api.jsonl']).toBe('');
    const manifest = JSON.parse(tree['manifest.json']);
    expect(
      manifest.repositories.map((entry: { name: string }) => entry.name),
    ).toEqual(['shop-api', 'shop-web']);
    expect(manifest.repositories[0]).toMatchObject({
      branch: 'trunk',
      commitSha: git(shopApi.bare, ['rev-parse', 'trunk']),
      symbolCount: 0,
      fileCount: 0,
    });
    expect(manifest.generatedAt).toBe('2026-11-01T09:00:00.000Z');
  });

  it('고른 파일만 추출기에 넘기고 레코드·묶음·비밀값 가리기를 결과에 반영한다', async () => {
    const calls: SourceFile[][] = [];
    const config = configFor();
    const result = await buildCodeGraph(config, {
      extractors: [fakeExtractor(calls)],
    });

    const given = calls
      .flat()
      .map((file) => `${file.repository}:${file.filePath}`)
      .sort();
    expect(given).toEqual([
      'shop-api:src/broken.ts',
      'shop-api:src/points/earn.ts',
      'shop-api:src/refund/refund.ts',
      'shop-web:src/cart/cart.ts',
    ]);
    expect(
      result.records.map((record) => `${record.repository}:${record.symbol}`),
    ).toEqual([
      'shop-api:earnPoints',
      'shop-api:previewPoints',
      'shop-api:requestRefund',
      'shop-api:connectPayments',
      'shop-web:addToCart',
    ]);
    expect(result.records[0].policyGroup).toBe('points');
    expect(result.records[2]).not.toHaveProperty('policyGroup');

    const api = result.manifest.repositories[0];
    expect(api.skippedFiles).toMatchObject({
      floor: 2,
      defaultExcludes: 1,
      unsupported: 1,
    });
    expect(api.failures).toEqual([
      {
        filePath: 'src/broken.ts',
        message: 'cannot parse scratch/src/broken.ts near @@broken',
      },
    ]);

    const tree = await readTree(config.output);
    const everything = Object.values(tree).join('\n');
    expect(everything).not.toContain(FAKE_SECRET);
    expect(tree['symbols/shop-api.jsonl']).toContain(
      "const apiKey = '[REDACTED]'",
    );
    expect(everything).not.toContain('acornQueue');
    const written = tree['symbols/shop-api.jsonl']
      .trim()
      .split('\n')
      .map((line) => Object.keys(JSON.parse(line)));
    for (const keys of written) {
      expect(keys).toEqual([
        'schemaVersion',
        'recordType',
        'repository',
        'filePath',
        'language',
        'symbol',
        'stableSymbolId',
        'kind',
        'commitSha',
        'committedAt',
        'contentHash',
        'content',
        'lineStart',
        'lineEnd',
        'relations',
        ...(keys.includes('policyGroup') ? ['policyGroup'] : []),
      ]);
    }
    for (const local of [root, tmpdir(), await realpath(tmpdir()), homedir()]) {
      expect(everything).not.toContain(local);
    }
  });

  it('같은 커밋이면 추출기를 부르지 않고 재사용하며 결과는 바이트 단위로 같다', async () => {
    const config = configFor();
    await buildCodeGraph(config, { extractors: [fakeExtractor()] });
    const first = await readTree(config.output);

    const calls: SourceFile[][] = [];
    const second = await buildCodeGraph(config, {
      extractors: [fakeExtractor(calls)],
    });
    expect(calls).toEqual([]);
    expect(second.reused).toEqual({ 'shop-api': true, 'shop-web': true });
    expect(second.records).toHaveLength(5);
    expect(await readTree(config.output)).toEqual(first);

    const elsewhere = configFor({ output: 'fresh/graph' });
    const fresh = await buildCodeGraph(elsewhere, {
      extractors: [fakeExtractor()],
    });
    expect(fresh.reused).toEqual({ 'shop-api': false, 'shop-web': false });
    expect(await readTree(elsewhere.output)).toEqual(first);
  });

  it('원격에 새 커밋이 생긴 저장소만 다시 만들고, 설정이 바뀌면 커밋이 같아도 다시 만든다', async () => {
    const config = configFor();
    await buildCodeGraph(config, { extractors: [fakeExtractor()] });
    await commitFiles(
      shopApi.work,
      { 'src/coupon/coupon.ts': 'export function issueCoupon() {}\n' },
      '2026-11-04T12:00:00Z',
    );
    git(shopApi.work, ['push', '-q', 'origin', 'trunk']);

    const calls: SourceFile[][] = [];
    const result = await buildCodeGraph(config, {
      extractors: [fakeExtractor(calls)],
    });
    expect(result.reused).toEqual({ 'shop-api': false, 'shop-web': true });
    expect(calls.flat().every((file) => file.repository === 'shop-api')).toBe(
      true,
    );
    expect(result.records.map((record) => record.symbol)).toContain(
      'issueCoupon',
    );
    expect(result.manifest.generatedAt).toBe('2026-11-04T12:00:00.000Z');

    const narrowed = await buildCodeGraph(configFor({ defaultExcludes: [] }), {
      extractors: [fakeExtractor()],
    });
    expect(narrowed.reused).toEqual({ 'shop-api': false, 'shop-web': false });
    expect(narrowed.records.map((record) => record.symbol)).toContain(
      'refundCase',
    );
  });

  it('심볼 수가 절반 아래로 줄면 아무것도 쓰지 않고 멈추고, 허용하면 지나간다', async () => {
    const config = configFor();
    await buildCodeGraph(config, { extractors: [fakeExtractor()] });
    const before = await readTree(config.output);
    await commitFiles(
      shopApi.work,
      { 'src/points/earn.ts': null, 'src/refund/refund.ts': null },
      '2026-11-05T08:00:00Z',
    );
    git(shopApi.work, ['push', '-q', 'origin', 'trunk']);

    await expect(
      buildCodeGraph(config, { extractors: [fakeExtractor()] }),
    ).rejects.toThrow(GraphCollapseError);
    await expect(
      buildCodeGraph(config, { extractors: [fakeExtractor()] }),
    ).rejects.toThrow(/Repository shop-api: symbols dropped from 4 to 0/);
    expect(await readTree(config.output)).toEqual(before);

    const accepted = await buildCodeGraph(config, {
      extractors: [fakeExtractor()],
      acceptSymbolDrop: ['shop-api'],
    });
    expect(accepted.manifest.repositories[0].symbolCount).toBe(0);
  });

  it('설정의 extractorModules 에서 추출기를 불러온다', async () => {
    await writeFile(
      join(root, 'graph', 'acorn-extractor.mjs'),
      [
        'export default {',
        "  name: 'acorn',",
        "  extensions: ['.ts'],",
        '  async extract(files) {',
        '    return {',
        '      symbols: files.map((file) => ({',
        '        filePath: file.filePath,',
        "        language: 'typescript',",
        "        symbol: 'module',",
        "        kind: 'module',",
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
    const result = await buildCodeGraph(
      configFor({ extractorModules: ['./acorn-extractor.mjs'] }),
    );
    expect(result.records).toHaveLength(4);
    expect(new Set(result.records.map((record) => record.kind))).toEqual(
      new Set(['module']),
    );
  });

  it('추출기가 throw 하면 저장소와 추출기 이름을 밝혀 멈추고, 확장자를 둘이 맡으면 시작하지 않는다', async () => {
    const failing: SymbolExtractor = {
      name: 'needs-parser',
      extensions: ['.ts'],
      async extract() {
        throw new Error('parser is not installed; run npm i -D parser');
      },
    };
    await expect(
      buildCodeGraph(configFor(), { extractors: [failing] }),
    ).rejects.toThrow(
      /Repository shop-api: extractor needs-parser failed: parser is not installed/,
    );
    await expect(
      buildCodeGraph(configFor(), {
        extractors: [fakeExtractor(), { ...fakeExtractor(), name: 'other' }],
      }),
    ).rejects.toThrow(/extension \.ts is claimed by both fake-ts and other/);
  });
});
