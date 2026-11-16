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
import type { SystemTopologyGraph } from '../extensions/code-knowledge.js';
import { parseGraphConfig } from './config.js';
import { typescriptExtractor } from './extractors/typescript.js';
import { GraphCollapseError } from './output.js';
import { buildCodeGraph } from './pipeline.js';
import type {
  DetectionPreset,
  ExtractedSymbol,
  GraphConfig,
  HttpRouteDetection,
  MessageDetection,
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
              sites: [
                {
                  kind: 'call',
                  name: 'acornQueue.push',
                  line: index + 1,
                  args: [],
                },
              ],
            } as ExtractedSymbol);
          }
        }
      }
      return { symbols, failures };
    },
  };
}

// ── 가짜 프리셋: `acornQueue.push` 호출 자리를 큐 발행으로 본다 ──

function acornQueuePreset(
  calls: string[] = [],
  languages = ['typescript'],
): DetectionPreset {
  return {
    name: 'acorn-queue',
    languages,
    detect(symbol, context) {
      calls.push(`${context.repository}:${symbol.symbol}`);
      return (symbol.sites ?? [])
        .filter((site) => site.name === 'acornQueue.push')
        .map((site): MessageDetection => ({
          kind: 'queue-publish',
          repository: context.repository,
          filePath: symbol.filePath,
          symbol: symbol.symbol,
          line: site.line,
          detector: 'acorn-queue',
          confidence: 0.8,
          evidence: `acornQueue.push in ${symbol.symbol}`,
          name: `${symbol.symbol}-queue`,
          dynamic: false,
        }));
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
  it('추출기를 비우면 저장소마다 빈 심볼 파일과 manifest 를 쓴다', async () => {
    const config = configFor();
    const result = await buildCodeGraph(config, { extractors: [] });

    expect(result.files).toEqual([
      'detections.json',
      'manifest.json',
      'symbols/shop-api.jsonl',
      'symbols/shop-web.jsonl',
      'topology.json',
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

describe('buildCodeGraph 탐지 단계', { timeout: 60_000 }, () => {
  const withPresets = (extra: Record<string, unknown> = {}) =>
    configFor({ presets: ['acorn-queue'], ...extra });

  it('켠 프리셋으로 탐지해 detections.json 에 쓰고, 재사용한 저장소는 프리셋을 부르지 않고 지난 탐지 결과를 쓴다', async () => {
    const config = withPresets();
    const first = await buildCodeGraph(config, {
      extractors: [fakeExtractor()],
      presets: [acornQueuePreset()],
    });
    expect(first.files).toContain('detections.json');
    const tree = await readTree(config.output);
    const detections = JSON.parse(tree['detections.json']);
    expect(Object.keys(detections.repositories)).toEqual([
      'shop-api',
      'shop-web',
    ]);
    expect(
      detections.repositories['shop-api'].detections.map(
        (item: MessageDetection) => `${item.filePath}:${item.name}`,
      ),
    ).toEqual([
      'src/points/earn.ts:earnPoints-queue',
      'src/points/earn.ts:previewPoints-queue',
      'src/refund/refund.ts:requestRefund-queue',
      'src/refund/refund.ts:connectPayments-queue',
    ]);
    expect(detections.repositories['shop-web'].detections).toHaveLength(1);
    for (const local of [root, tmpdir(), await realpath(tmpdir()), homedir()]) {
      expect(tree['detections.json']).not.toContain(local);
    }

    const calls: string[] = [];
    const second = await buildCodeGraph(config, {
      extractors: [fakeExtractor()],
      presets: [acornQueuePreset(calls)],
    });
    expect(second.reused).toEqual({ 'shop-api': true, 'shop-web': true });
    expect(calls).toEqual([]);
    expect(await readTree(config.output)).toEqual(tree);
  });

  it('presets·detectors·presetModules 나 켠 프리셋이 바뀌면 커밋이 같아도 다시 추출하고 다시 탐지한다', async () => {
    await buildCodeGraph(withPresets(), {
      extractors: [fakeExtractor()],
      presets: [acornQueuePreset()],
    });

    const calls: string[] = [];
    const wider = await buildCodeGraph(withPresets(), {
      extractors: [fakeExtractor()],
      presets: [acornQueuePreset(calls, ['typescript', 'javascript'])],
    });
    expect(wider.reused).toEqual({ 'shop-api': false, 'shop-web': false });
    expect(calls).toHaveLength(5);

    const off = await buildCodeGraph(configFor(), {
      extractors: [fakeExtractor()],
      presets: [acornQueuePreset()],
    });
    expect(off.reused).toEqual({ 'shop-api': false, 'shop-web': false });
    const detections = JSON.parse(
      await readFile(join(off.output, 'detections.json'), 'utf8'),
    );
    expect(detections.repositories['shop-api'].detections).toEqual([]);

    const rules = await buildCodeGraph(
      configFor({
        detectors: [
          { kind: 'queue-publisher', call: 'acornQueue.push', nameArgument: 0 },
        ],
      }),
      {
        extractors: [fakeExtractor()],
        rulesPreset: () => ({ ...acornQueuePreset(), name: 'rules' }),
      },
    );
    expect(rules.reused).toEqual({ 'shop-api': false, 'shop-web': false });

    await writeFile(
      join(root, 'graph', 'acorn-presets.mjs'),
      "export default { name: 'acorn-extra', detect: () => [] };\n",
    );
    const modules = await buildCodeGraph(
      configFor({
        detectors: [
          { kind: 'queue-publisher', call: 'acornQueue.push', nameArgument: 0 },
        ],
        presetModules: ['./acorn-presets.mjs'],
      }),
      {
        extractors: [fakeExtractor()],
        rulesPreset: () => ({ ...acornQueuePreset(), name: 'rules' }),
      },
    );
    expect(modules.reused).toEqual({ 'shop-api': false, 'shop-web': false });
  });

  it('지난 detections.json 이 없거나 깨졌으면 재사용하지 않고 다시 탐지한다', async () => {
    const config = withPresets();
    await buildCodeGraph(config, {
      extractors: [fakeExtractor()],
      presets: [acornQueuePreset()],
    });
    await rm(join(config.output, 'detections.json'));
    const calls: string[] = [];
    const missing = await buildCodeGraph(config, {
      extractors: [fakeExtractor()],
      presets: [acornQueuePreset(calls)],
    });
    expect(missing.reused).toEqual({ 'shop-api': false, 'shop-web': false });
    expect(calls).toHaveLength(5);

    await writeFile(join(config.output, 'detections.json'), '{ not json');
    const broken = await buildCodeGraph(config, {
      extractors: [fakeExtractor()],
      presets: [acornQueuePreset()],
    });
    expect(broken.reused).toEqual({ 'shop-api': false, 'shop-web': false });
  });

  it('모르는 프리셋 이름이면 저장소를 꺼내기 전에 멈춘다', async () => {
    await expect(
      buildCodeGraph(configFor({ presets: ['acorn-mail'] }), {
        presets: [acornQueuePreset()],
      }),
    ).rejects.toThrow(
      'unknown preset "acorn-mail" in presets. Known presets: acorn-queue',
    );
  });
});

describe('buildCodeGraph 저장소 안 토폴로지', { timeout: 60_000 }, () => {
  /** 메서드의 `@Post('경로')` 데코레이터를 라우트로 본다 */
  const routePreset: DetectionPreset = {
    name: 'acorn-http',
    languages: ['typescript'],
    detect(symbol, context) {
      return (symbol.sites ?? [])
        .filter((site) => site.kind === 'decorator' && site.name === 'Post')
        .map((site): HttpRouteDetection => ({
          kind: 'http-route',
          repository: context.repository,
          filePath: symbol.filePath,
          symbol: symbol.symbol,
          line: site.line,
          detector: 'acorn-http',
          confidence: 0.95,
          evidence: `@Post on ${symbol.symbol}`,
          method: 'POST',
          path: `/${site.args[0]?.literal ?? ''}`,
        }));
    },
  };
  /** `publish(큐, …)` 호출을 큐 발행으로 보고, 큐 이름은 상수로 푼다 */
  const queuePreset: DetectionPreset = {
    name: 'acorn-queue',
    languages: ['typescript'],
    detect(symbol, context) {
      return (symbol.sites ?? [])
        .filter((site) => site.kind === 'call' && site.name === 'publish')
        .map((site): MessageDetection => {
          const argument = site.args[0];
          const name = argument?.identifier
            ? context.resolveConstant(argument.identifier)
            : argument?.literal;
          return {
            kind: 'queue-publish',
            repository: context.repository,
            filePath: symbol.filePath,
            symbol: symbol.symbol,
            line: site.line,
            detector: 'acorn-queue',
            confidence: name ? 0.9 : 0.4,
            evidence: `publish(${argument?.text ?? ''})`,
            name: name ?? argument?.text ?? '',
            dynamic: name === undefined,
          };
        });
    },
  };

  it('실제 추출 결과와 프리셋으로 토폴로지를 그리고, 다시 돌리면 재사용해도 바이트 단위로 같으며 절대 경로가 없다', async () => {
    const shop = await createRemote(root, 'acorn-shop', 'main', {
      'src/queues.ts':
        "export const Queues = { REFUND: 'refund-requested' } as const;\n",
      'src/refund/refund.service.ts': [
        "import { Queues } from '../queues';",
        'export class RefundService {',
        '  approve(id: string) {',
        '    publish(Queues.REFUND, id);',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/refund/refund.controller.ts': [
        "import { RefundService } from './refund.service';",
        'export class RefundController {',
        '  constructor(private readonly refunds: RefundService) {}',
        "  @Post('refunds/:id')",
        '  approve(id: string) {',
        '    return this.refunds.approve(id);',
        '  }',
        '}',
        '',
      ].join('\n'),
      'src/server.ts': 'export function start() {}\n',
      'src/main.ts': "import { start } from './server';\nstart();\n",
    });
    const config = parseGraphConfig(
      {
        repositories: [{ name: 'shop-api', url: shop.bare }],
        presets: ['acorn-http', 'acorn-queue'],
      },
      join(root, 'graph'),
    );
    const options = {
      extractors: [typescriptExtractor()],
      presets: [routePreset, queuePreset],
    };
    const first = await buildCodeGraph(config, options);
    expect(first.files).toContain('topology.json');
    const tree = await readTree(config.output);
    const topology = JSON.parse(tree['topology.json']) as SystemTopologyGraph;
    const edges = topology.edges.map(
      (edge) => `${edge.type} ${edge.from} -> ${edge.to}`,
    );
    const symbolId = (filePath: string, name: string) =>
      `symbol:shop-api:${filePath}#${name}`;
    const controller = 'src/refund/refund.controller.ts';
    const service = 'src/refund/refund.service.ts';

    expect(edges).toContain(
      `TRIGGERS api:shop-api:POST /refunds/:id -> ${symbolId(controller, 'RefundController.approve')}`,
    );
    expect(edges).toContain(
      `CALLS ${symbolId(controller, 'RefundController.approve')} -> ${symbolId(service, 'RefundService.approve')}`,
    );
    expect(edges).toContain(
      `PUBLISHES ${symbolId(service, 'RefundService.approve')} -> queue:shop-api:refund-requested`,
    );
    expect(edges).toContain(
      `CALLS file:shop-api:src/main.ts -> ${symbolId('src/server.ts', 'start')}`,
    );
    expect(topology.generatedAt).toBe('2026-11-01T09:00:00.000Z');
    expect(topology.sources).toEqual([
      { kind: 'extractor:typescript' },
      { kind: 'preset:acorn-http' },
      { kind: 'preset:acorn-queue' },
    ]);
    const detections = JSON.parse(tree['detections.json']);
    expect(detections.repositories['shop-api'].receivers).toEqual([
      {
        filePath: controller,
        symbol: 'RefundController',
        members: { refunds: 'RefundService' },
      },
    ]);
    for (const file of ['topology.json', 'detections.json']) {
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
    expect(second.reused).toEqual({ 'shop-api': true });
    expect(await readTree(config.output)).toEqual(tree);
  });
});
