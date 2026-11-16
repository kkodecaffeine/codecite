import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_FILE_SKIP_COUNTS } from './constants.js';
import {
  assertNoSymbolCollapse,
  canonicalJson,
  fingerprint,
  GraphCollapseError,
  parseSymbolsJsonl,
  readGraphManifest,
  readRepositorySymbols,
  serializeSymbols,
  symbolsFilePath,
  writeGraphOutputs,
} from './output.js';
import { toCurrentSymbolRecord } from './records.js';
import type { GraphManifest, GraphManifestRepository } from './types.js';

const record = (repository: string, symbol: string, lineStart: number) =>
  toCurrentSymbolRecord(
    {
      filePath: 'src/coupon/coupon.service.ts',
      language: 'typescript',
      symbol,
      kind: 'method',
      content: `${symbol}() { return 'coupon'; }`,
      lineStart,
      lineEnd: lineStart + 2,
      relations: [],
    },
    {
      repository,
      commitSha: 'b'.repeat(40),
      committedAt: '2026-10-30T09:00:00.000Z',
      groups: {},
    },
  );

const entry = (name: string, symbolCount: number): GraphManifestRepository => ({
  name,
  branch: 'main',
  commitSha: 'b'.repeat(40),
  committedAt: '2026-10-30T09:00:00.000Z',
  inputFingerprint: 'sha256:00',
  symbolsFile: symbolsFilePath(name),
  symbolCount,
  fileCount: 1,
  skippedFiles: { ...EMPTY_FILE_SKIP_COUNTS },
  failures: [],
});

const manifest = (repositories: GraphManifestRepository[]): GraphManifest => ({
  schemaVersion: 1,
  generatedAt: '2026-10-30T09:00:00.000Z',
  tool: { name: 'codecite', version: '0.0.0' },
  configFingerprint: 'sha256:11',
  repositories,
});

let output: string;

beforeEach(async () => {
  output = await mkdtemp(join(tmpdir(), 'codecite-output-'));
});

afterEach(async () => {
  await rm(output, { recursive: true, force: true });
});

describe('symbols JSONL', () => {
  it('한 줄에 레코드 하나를 쓰고 읽을 때 레코드마다 검사한다', () => {
    const records = [
      record('shop-api', 'issue', 4),
      record('shop-api', 'redeem', 12),
    ];
    const text = serializeSymbols(records);
    expect(text.split('\n')).toHaveLength(3);
    expect(parseSymbolsJsonl(text, 'shop-api')).toEqual(records);
    expect(serializeSymbols([])).toBe('');
  });

  it('다른 저장소의 레코드나 깨진 줄이 있으면 줄 번호와 함께 거절한다', () => {
    const text = serializeSymbols([record('shop-web', 'issue', 4)]);
    expect(() => parseSymbolsJsonl(text, 'shop-api')).toThrow(
      /symbols\/shop-api\.jsonl line 1: record belongs to shop-web/,
    );
    expect(() => parseSymbolsJsonl('{"schemaVersion":\n', 'shop-api')).toThrow(
      /line 1: not valid JSON/,
    );
  });
});

describe('writeGraphOutputs', () => {
  it('심볼 파일·단계 결과·manifest 를 쓰고, 설정에서 빠진 저장소 파일은 지운다', async () => {
    await mkdir(join(output, 'symbols'), { recursive: true });
    await writeFile(join(output, 'symbols', 'old-admin.jsonl'), '');

    const files = await writeGraphOutputs(output, {
      manifest: manifest([entry('shop-api', 2), entry('shop-web', 0)]),
      symbols: new Map([
        [
          'shop-api',
          [record('shop-api', 'issue', 4), record('shop-api', 'redeem', 12)],
        ],
      ]),
      artifacts: new Map([['topology.json', { nodes: [], edges: [] }]]),
    });

    expect(files).toEqual([
      'manifest.json',
      'symbols/shop-api.jsonl',
      'symbols/shop-web.jsonl',
      'topology.json',
    ]);
    expect((await readdir(join(output, 'symbols'))).sort()).toEqual([
      'shop-api.jsonl',
      'shop-web.jsonl',
    ]);
    expect(
      await readFile(join(output, 'symbols', 'shop-web.jsonl'), 'utf8'),
    ).toBe('');
    expect(await readFile(join(output, 'topology.json'), 'utf8')).toBe(
      '{\n  "nodes": [],\n  "edges": []\n}\n',
    );
    expect(await readGraphManifest(output)).toEqual(
      manifest([entry('shop-api', 2), entry('shop-web', 0)]),
    );
    expect(await readRepositorySymbols(output, 'shop-api')).toHaveLength(2);
    expect(await readRepositorySymbols(output, 'shop-worker')).toBeUndefined();
  });

  it('결과 폴더 밖이나 하위 폴더를 가리키는 단계 결과 이름은 거절한다', async () => {
    await expect(
      writeGraphOutputs(output, {
        manifest: manifest([]),
        symbols: new Map(),
        artifacts: new Map([['../escape.json', {}]]),
      }),
    ).rejects.toThrow(/plain JSON file name/);
  });

  it('manifest 가 없으면 undefined, 모양이 틀리면 throw 한다', async () => {
    expect(await readGraphManifest(output)).toBeUndefined();
    await writeFile(
      join(output, 'manifest.json'),
      JSON.stringify({ ...manifest([]), schemaVersion: 2 }),
    );
    await expect(readGraphManifest(output)).rejects.toThrow(/schemaVersion/);
  });
});

describe('assertNoSymbolCollapse', () => {
  it('지난번의 절반 아래로 줄면 멈추고, 허용한 저장소는 지나간다', () => {
    expect(() => assertNoSymbolCollapse('shop-api', 40, 19)).toThrow(
      GraphCollapseError,
    );
    expect(() => assertNoSymbolCollapse('shop-api', 40, 20)).not.toThrow();
    expect(() =>
      assertNoSymbolCollapse('shop-api', 40, 3, ['shop-api']),
    ).not.toThrow();
    expect(() =>
      assertNoSymbolCollapse('shop-api', undefined, 0),
    ).not.toThrow();
    expect(() => assertNoSymbolCollapse('shop-api', 0, 0)).not.toThrow();
  });
});

describe('fingerprint', () => {
  it('키 순서가 달라도 같은 값이면 같다', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
    expect(fingerprint({ b: 1, a: 2 })).toBe(fingerprint({ a: 2, b: 1 }));
    expect(fingerprint({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
