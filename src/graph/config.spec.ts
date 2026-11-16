import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GraphConfigError,
  loadGraphConfig,
  parseGraphConfig,
} from './config.js';
import { GRAPH_DEFAULT_EXCLUDES } from './constants.js';

const CWD = '/work/dotori-graph';

const minimal = (extra: Record<string, unknown> = {}) => ({
  repositories: [
    { name: 'shop-api', url: 'https://git.example.test/dotori/shop-api.git' },
    { name: 'shop-web', path: '../shop-web' },
  ],
  ...extra,
});

describe('parseGraphConfig', () => {
  it('비운 항목을 기본값으로 채우고 경로를 설정 폴더 기준으로 푼다', () => {
    const config = parseGraphConfig(minimal(), CWD);
    expect(config).toEqual({
      cwd: CWD,
      output: '/work/dotori-graph/.codecite/graph',
      cache: '/work/dotori-graph/.codecite/cache',
      repositories: [
        {
          name: 'shop-api',
          url: 'https://git.example.test/dotori/shop-api.git',
        },
        { name: 'shop-web', path: '/work/shop-web' },
      ],
      defaultExcludes: [...GRAPH_DEFAULT_EXCLUDES],
      presets: [],
      hints: {},
      detectors: [],
      entities: { foreignKeySuffixes: ['Id', '_id'] },
      groups: {},
      extractorModules: [],
      presetModules: [],
    });
  });

  it('힌트·탐지 규칙·묶음·모듈 경로를 받는다', () => {
    const config = parseGraphConfig(
      minimal({
        output: 'out/graph',
        defaultExcludes: [],
        presets: ['nestjs', 'fetch'],
        hints: {
          baseUrls: { ACORN_API_URL: 'shop-api' },
          proxyPrefixes: { '/bff': 'shop-api' },
          packages: { '@dotori/shared': 'shop-api' },
          graphqlSchemas: {
            shop: { repository: 'shop-api', paths: ['src/graphql/**'] },
          },
          external: ['pay.example.test'],
        },
        detectors: [
          { kind: 'queue-publisher', call: 'acornQueue.push', nameArgument: 0 },
          { kind: 'queue-consumer', decorator: 'AcornHandler' },
        ],
        entities: { foreignKeySuffixes: ['No'] },
        groups: { points: ['shop-api:src/points/**'] },
        manualLinks: 'graph.links.json',
        extractorModules: ['./tools/kotlin-extractor.js'],
        maxUnresolvedRatio: 0.25,
      }),
      CWD,
    );
    expect(config.output).toBe('/work/dotori-graph/out/graph');
    expect(config.cache).toBe('/work/dotori-graph/out/cache');
    expect(config.defaultExcludes).toEqual([]);
    expect(config.hints.graphqlSchemas?.shop).toEqual({
      repository: 'shop-api',
      paths: ['src/graphql/**'],
    });
    expect(config.detectors[1]).toEqual({
      kind: 'queue-consumer',
      decorator: 'AcornHandler',
    });
    expect(config.manualLinks).toBe('/work/dotori-graph/graph.links.json');
    expect(config.extractorModules).toEqual([
      '/work/dotori-graph/tools/kotlin-extractor.js',
    ]);
    expect(config.maxUnresolvedRatio).toBe(0.25);
  });

  it.each([
    [{ repositories: [] }, /repositories: must be a non-empty array/],
    [{ repository: [] }, /repository: unknown setting/],
    [
      {
        repositories: [
          { name: 'shop-api', path: '../a' },
          { name: 'shop-api', path: '../b' },
        ],
      },
      /repositories\[1\]\.name: duplicate repository name shop-api/,
    ],
    [
      {
        repositories: [
          { name: 'shop-api', path: '../a', url: 'https://x.test/a.git' },
        ],
      },
      /repositories\[0\]: shop-api needs exactly one of url or path/,
    ],
    [
      { repositories: [{ name: 'shop-api' }] },
      /needs exactly one of url or path/,
    ],
    [
      { repositories: [{ name: '../shop', path: '../a' }] },
      /repositories\[0\]\.name/,
    ],
    [
      { repositories: [{ name: 'shop-api', url: '--upload-pack=x' }] },
      /repositories\[0\]\.url: must not start with "-"/,
    ],
    [
      {
        repositories: [
          { name: 'shop-api', path: '../a', defaultBranch: '-main' },
        ],
      },
      /defaultBranch: -main is not a plain branch name/,
    ],
    [
      {
        repositories: [
          { name: 'shop-api', path: '../a', include: ['../other/**'] },
        ],
      },
      /include\[0\]: glob must stay inside the repository/,
    ],
    [
      {
        repositories: [
          { name: 'shop-api', path: '../a', exclude: ['src/{a,b'] },
        ],
      },
      /exclude\[0\]: invalid glob/,
    ],
    [
      {
        repositories: [
          { name: 'shop-api', path: '../a' },
          { name: 'shop-api-copy', path: '../a' },
        ],
      },
      /shop-api-copy points to the same repository as shop-api/,
    ],
  ])('틀린 설정은 어느 항목인지 밝혀 거절한다 (%#)', (value, message) => {
    expect(() => parseGraphConfig(value, CWD)).toThrow(GraphConfigError);
    expect(() => parseGraphConfig(value, CWD)).toThrow(message);
  });

  it.each([
    [
      { hints: { baseUrls: { ACORN_API_URL: 'shop-admin' } } },
      /hints\.baseUrls\.ACORN_API_URL: repository shop-admin/,
    ],
    [
      { hints: { graphqlSchemas: { shop: { repository: 'shop-admin' } } } },
      /graphqlSchemas\.shop\.repository/,
    ],
    [{ hints: { aliases: {} } }, /hints\.aliases: unknown setting/],
    [
      { groups: { points: ['shop-admin:src/**'] } },
      /groups\.points: repository shop-admin/,
    ],
    [
      { groups: { points: ['src/points/**'] } },
      /must look like <repository>:<path glob>/,
    ],
    [
      { detectors: [{ kind: 'mailer', call: 'send' }] },
      /detectors\[0\]\.kind: must be one of/,
    ],
    [
      { detectors: [{ kind: 'scheduler' }] },
      /detectors\[0\]: needs call or decorator/,
    ],
    [
      { detectors: [{ kind: 'scheduler', call: 'every', nameArgument: -1 }] },
      /nameArgument/,
    ],
    [
      { maxUnresolvedRatio: 1.5 },
      /maxUnresolvedRatio: must be a number from 0 to 1/,
    ],
  ])(
    '등록하지 않은 저장소를 가리키거나 모양이 틀린 힌트·규칙·묶음을 거절한다 (%#)',
    (extra, message) => {
      expect(() => parseGraphConfig(minimal(extra), CWD)).toThrow(message);
    },
  );
});

describe('loadGraphConfig', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await realpath(await mkdtemp(join(tmpdir(), 'codecite-config-')));
    await mkdir(join(folder, 'shop-web'));
    await mkdir(join(folder, 'graph'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('설정 파일을 읽고 path 저장소가 있는지 본다', async () => {
    await writeFile(
      join(folder, 'graph', 'codecite.graph.json'),
      JSON.stringify({
        repositories: [{ name: 'shop-web', path: '../shop-web' }],
      }),
    );
    const config = await loadGraphConfig(join(folder, 'graph'));
    expect(config.cwd).toBe(join(folder, 'graph'));
    expect(config.repositories[0].path).toBe(join(folder, 'shop-web'));
  });

  it('설정 파일이 없거나 JSON 이 아니면 알아볼 수 있게 알린다', async () => {
    await expect(loadGraphConfig(join(folder, 'graph'))).rejects.toThrow(
      /codecite\.graph\.json: not found/,
    );
    await writeFile(
      join(folder, 'graph', 'codecite.graph.json'),
      '{ repositories: ',
    );
    await expect(loadGraphConfig(join(folder, 'graph'))).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('없는 path 저장소와 같은 폴더를 두 번 적은 설정을 거절한다', async () => {
    await writeFile(
      join(folder, 'graph', 'other.json'),
      JSON.stringify({
        repositories: [{ name: 'shop-worker', path: '../shop-worker' }],
      }),
    );
    await expect(
      loadGraphConfig(join(folder, 'graph'), { file: 'other.json' }),
    ).rejects.toThrow(
      /repositories\[0\]\.path: shop-worker: .* is not an existing folder/,
    );

    await writeFile(
      join(folder, 'graph', 'other.json'),
      JSON.stringify({
        repositories: [
          { name: 'shop-web', path: '../shop-web' },
          { name: 'shop-web-again', path: '../graph/../shop-web/' },
        ],
      }),
    );
    await expect(
      loadGraphConfig(join(folder, 'graph'), { file: 'other.json' }),
    ).rejects.toThrow(/points to the same/);
  });

  it('결과·캐시 폴더가 원본 저장소 안이면 거절한다(원본 저장소는 읽기만 한다)', async () => {
    await writeFile(
      join(folder, 'shop-web', 'codecite.graph.json'),
      JSON.stringify({ repositories: [{ name: 'shop-web', path: '.' }] }),
    );
    await expect(loadGraphConfig(join(folder, 'shop-web'))).rejects.toThrow(
      /output: .* is inside repository shop-web/,
    );
    await writeFile(
      join(folder, 'shop-web', 'codecite.graph.json'),
      JSON.stringify({
        output: '../graph/out',
        cache: './.cache',
        repositories: [{ name: 'shop-web', path: '.' }],
      }),
    );
    await expect(loadGraphConfig(join(folder, 'shop-web'))).rejects.toThrow(
      /cache: .* is inside repository shop-web/,
    );
  });
});
