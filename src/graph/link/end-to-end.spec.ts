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
import type { CrossRepositoryGraph } from '../../extensions/code-knowledge.js';
import { parseGraphConfig } from '../config.js';
import { buildCodeGraph } from '../pipeline.js';
import type {
  Detection,
  DetectionPreset,
  ExtractedSymbol,
  GraphReport,
  SymbolExtractor,
} from '../types.js';

// ── 임시 git 저장소 두 개: shop-api(라우트), shop-web(호출) ──

const ENV = {
  GIT_AUTHOR_NAME: 'Dotori Dev',
  GIT_AUTHOR_EMAIL: 'dev@dotori.test',
  GIT_COMMITTER_NAME: 'Dotori Dev',
  GIT_COMMITTER_EMAIL: 'dev@dotori.test',
  GIT_AUTHOR_DATE: '2026-11-05T10:00:00Z',
  GIT_COMMITTER_DATE: '2026-11-05T10:00:00Z',
};

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...ENV },
  });
}

async function createRemote(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const work = join(root, `${name}-work`);
  git(root, ['init', '-q', '-b', 'main', work]);
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

/** `export function 이름` 한 줄을 심볼 하나로 본다 */
const lineExtractor: SymbolExtractor = {
  name: 'dotori-lines',
  extensions: ['.ts'],
  async extract(files) {
    const symbols: ExtractedSymbol[] = [];
    for (const file of files) {
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
          });
        }
      }
    }
    return { symbols, failures: [] };
  },
};

/** 심볼 이름으로 라우트·호출을 정하는 가짜 프리셋 */
const ROUTES: Record<string, { method: string; path: string }> = {
  cancelOrder: { method: 'POST', path: '/orders/:param/cancel' },
  listCoupons: { method: 'GET', path: '/coupons' },
};
const CALLS: Record<string, { path?: string; base: string[] }> = {
  requestCancel: { path: '/orders/:param/cancel', base: ['SHOP_API_URL'] },
  fetchBanner: { base: ['bannerUrl'] },
};
const dotoriPreset: DetectionPreset = {
  name: 'dotori-http',
  languages: ['typescript'],
  detect(symbol, context): Detection[] {
    const base = {
      repository: context.repository,
      filePath: symbol.filePath,
      symbol: symbol.symbol,
      line: symbol.lineStart,
      detector: 'dotori-http',
      confidence: 0.95,
      evidence: `${symbol.symbol} by name`,
    };
    const route = ROUTES[symbol.symbol];
    if (route) {
      return [{ ...base, kind: 'http-route', ...route }];
    }
    const call = CALLS[symbol.symbol];
    return call
      ? [
          {
            ...base,
            kind: 'http-call',
            method: call.path ? 'POST' : 'GET',
            ...(call.path ? { path: call.path } : {}),
            baseIdentifiers: call.base,
            dynamic: call.path === undefined,
          },
        ]
      : [];
  },
};

let root: string;

beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codecite-link-')));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('buildCodeGraph 저장소 간 연결', { timeout: 60_000 }, () => {
  it('두 저장소를 이어 cross-repository.json 과 report.json 을 쓰고, 다시 돌리면 바이트 단위로 같다', async () => {
    const api = await createRemote(root, 'shop-api', {
      'src/orders.ts': 'export function cancelOrder() {}\n',
      'src/coupons.ts': 'export function listCoupons() {}\n',
    });
    const web = await createRemote(root, 'shop-web', {
      'src/cancel.ts': 'export function requestCancel() {}\n',
      'src/banner.ts': 'export function fetchBanner() {}\n',
      'src/home.ts': 'export function showCoupons() {}\n',
    });
    await mkdir(join(root, 'graph'));
    await writeFile(
      join(root, 'graph', 'graph.links.json'),
      JSON.stringify([
        {
          relation: 'HTTP_CALLS',
          from: {
            repository: 'shop-web',
            filePath: 'src/home.ts',
            symbol: 'showCoupons',
          },
          to: {
            repository: 'shop-api',
            filePath: 'src/coupons.ts',
            symbol: 'listCoupons',
          },
          evidence:
            'src/home.ts builds the coupon address from a runtime setting',
          author: 'agent',
        },
      ]),
    );
    const config = parseGraphConfig(
      {
        repositories: [
          { name: 'shop-api', url: api },
          { name: 'shop-web', url: web },
        ],
        presets: ['dotori-http'],
        hints: { baseUrls: { SHOP_API_URL: 'shop-api' } },
        manualLinks: 'graph.links.json',
        maxUnresolvedRatio: 0.5,
      },
      join(root, 'graph'),
    );
    const options = { extractors: [lineExtractor], presets: [dotoriPreset] };
    const result = await buildCodeGraph(config, options);

    expect(result.files).toEqual(
      expect.arrayContaining(['cross-repository.json', 'report.json']),
    );
    const tree = await readTree(config.output);
    const graph = JSON.parse(
      tree['cross-repository.json'],
    ) as CrossRepositoryGraph;
    expect(
      graph.edges.map(
        (edge) =>
          `${edge.relation} ${edge.sourceLocation?.symbol} -> ${edge.targetLocation?.symbol} ${edge.confidence} ${edge.extraction.kind}`,
      ),
    ).toEqual([
      'HTTP_CALLS requestCancel -> cancelOrder high route',
      'HTTP_CALLS showCoupons -> listCoupons high manual',
    ]);
    expect(graph.coverage).toMatchObject({
      status: 'pass',
      providerContracts: 2,
      linkedProviderContracts: 2,
      unresolvedProviderContracts: 0,
    });
    expect(graph.generatedAt).toBe('2026-11-05T10:00:00.000Z');

    const report = JSON.parse(tree['report.json']) as GraphReport;
    expect(report).toEqual(result.report);
    expect(report.unresolved).toEqual([
      {
        reason: 'dynamic-target',
        relation: 'HTTP_CALLS',
        repository: 'shop-web',
        filePath: 'src/banner.ts',
        symbol: 'fetchBanner',
        line: 1,
        value: 'GET <dynamic>',
      },
    ]);
    expect(report.detectors).toEqual({
      'dotori-http': { 'http-call': 2, 'http-route': 2 },
    });
    for (const file of ['cross-repository.json', 'report.json']) {
      for (const local of [
        root,
        tmpdir(),
        await realpath(tmpdir()),
        homedir(),
      ]) {
        expect(tree[file]).not.toContain(local);
      }
    }

    const second = await buildCodeGraph(config, options);
    expect(second.reused).toEqual({ 'shop-api': true, 'shop-web': true });
    expect(await readTree(config.output)).toEqual(tree);
  });

  it('수동 연결의 끝 심볼이 없으면 아무것도 쓰지 않고 멈춘다', async () => {
    const api = await createRemote(root, 'shop-api', {
      'src/orders.ts': 'export function cancelOrder() {}\n',
    });
    const web = await createRemote(root, 'shop-web', {
      'src/cancel.ts': 'export function requestCancel() {}\n',
    });
    await mkdir(join(root, 'graph'));
    await writeFile(
      join(root, 'graph', 'graph.links.json'),
      JSON.stringify([
        {
          relation: 'HTTP_CALLS',
          from: {
            repository: 'shop-web',
            filePath: 'src/cancel.ts',
            symbol: 'requestCancel',
          },
          to: {
            repository: 'shop-api',
            filePath: 'src/orders.ts',
            symbol: 'refundOrder',
          },
          evidence: 'refund route is called after cancel',
        },
      ]),
    );
    const config = parseGraphConfig(
      {
        repositories: [
          { name: 'shop-api', url: api },
          { name: 'shop-web', url: web },
        ],
        presets: ['dotori-http'],
        manualLinks: 'graph.links.json',
      },
      join(root, 'graph'),
    );
    await expect(
      buildCodeGraph(config, {
        extractors: [lineExtractor],
        presets: [dotoriPreset],
      }),
    ).rejects.toThrow(
      'graph.links.json[0]: to shop-api src/orders.ts refundOrder is not a symbol in the graph',
    );
    await expect(readdir(config.output)).rejects.toThrow(/ENOENT/);
  });
});
