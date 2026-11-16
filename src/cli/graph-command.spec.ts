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
import type { Logger } from '../ports.js';
import { detectPresets } from './graph-command.js';
import { runCli } from './run.js';

let folder: string;

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function cli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = { code: -1, stdout: '', stderr: '' };
  result.code = await runCli(args, {
    cwd: folder,
    env: {},
    stdout: (text) => {
      result.stdout += text;
    },
    stderr: (text) => {
      result.stderr += text;
    },
    createLogger: () => silent,
  });
  return result;
}

async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  folder = await realpath(await mkdtemp(join(tmpdir(), 'codecite-graph-cli-')));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('detectPresets', () => {
  it('package.json 의존성과 Python 의존성 파일에서 프리셋을 고른다', async () => {
    await writeFiles(folder, {
      'shop-api/package.json': JSON.stringify({
        dependencies: { '@nestjs/core': '^10', typeorm: '^0.3' },
        devDependencies: { '@graphql-codegen/cli': '^5' },
      }),
      'shop-worker/requirements.txt':
        '# 작업자 의존성\ncelery[redis]>=5.3\nrequests==2.32\nSQLAlchemy~=2.0\n',
      'shop-batch/pyproject.toml':
        '[project]\ndependencies = ["fastapi>=0.110", "httpx"]\n',
    });

    expect(await detectPresets(join(folder, 'shop-api'))).toEqual([
      'fetch',
      'graphql-codegen',
      'nestjs',
      'typeorm',
    ]);
    expect(await detectPresets(join(folder, 'shop-worker'))).toEqual([
      'celery',
      'python-requests',
      'sqlalchemy',
    ]);
    expect(await detectPresets(join(folder, 'shop-batch'))).toEqual([
      'fastapi',
    ]);
    expect(await detectPresets(join(folder, 'missing'))).toEqual([]);
  });
});

describe('codecite graph init', () => {
  it('경로와 주소로 저장소 목록을 쓰고 받아 둔 저장소의 프리셋을 고른다', async () => {
    await writeFiles(folder, {
      'repos/shop-web/package.json': JSON.stringify({
        dependencies: { next: '^14', '@apollo/client': '^3' },
      }),
      'graph/.keep': '',
    });

    const run = await cli([
      'graph',
      'init',
      '--cwd',
      'graph',
      '../repos/shop-web',
      'https://example.com/dotori-market/shop-api.git',
      'git@example.com:dotori-market/shop-api.git',
    ]);

    expect(run.code).toBe(0);
    const config = JSON.parse(
      await readFile(join(folder, 'graph', 'codecite.graph.json'), 'utf8'),
    ) as unknown;
    expect(config).toEqual({
      repositories: [
        { name: 'shop-web', path: '../repos/shop-web' },
        {
          name: 'shop-api',
          url: 'https://example.com/dotori-market/shop-api.git',
        },
        {
          name: 'shop-api-2',
          url: 'git@example.com:dotori-market/shop-api.git',
        },
      ],
      presets: ['apollo-client', 'fetch', 'nextjs'],
    });
    expect(run.stdout).toContain(
      'Could not read dependencies of shop-api, shop-api-2',
    );
  });

  it('저장소를 주지 않으면 자리표시 저장소를 쓰고, 있는 파일은 --force 없이 덮어쓰지 않는다', async () => {
    const first = await cli(['graph', 'init']);
    const again = await cli(['graph', 'init']);
    const forced = await cli(['graph', 'init', '--force', '../shop-api']);

    expect(first.code).toBe(0);
    expect(first.stdout).toContain('Replace the placeholder repository');
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already exists; pass --force');
    expect(forced.code).toBe(0);
    const config = JSON.parse(
      await readFile(join(folder, 'codecite.graph.json'), 'utf8'),
    ) as { repositories: unknown[] };
    expect(config.repositories).toEqual([
      { name: 'shop-api', path: '../shop-api' },
    ]);
  });
});

describe('codecite graph build', { timeout: 60_000 }, () => {
  it('설정을 읽어 결과 폴더를 쓰고, 두 번째는 지난 결과를 재사용한다', async () => {
    const work = join(folder, 'shop-api-work');
    await writeFiles(work, {
      'src/app.ts': [
        "import express from 'express';",
        'const app = express();',
        'export function listOrders() {}',
        "app.get('/orders', listOrders);",
        '',
      ].join('\n'),
    });
    git(work, ['init', '-q', '-b', 'main']);
    git(work, ['config', 'user.email', 'dotori@example.com']);
    git(work, ['config', 'user.name', 'Dotori']);
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'init']);
    git(folder, ['clone', '-q', '--bare', work, join(folder, 'shop-api.git')]);
    await writeFile(
      join(folder, 'codecite.graph.json'),
      JSON.stringify({
        repositories: [{ name: 'shop-api', url: join(folder, 'shop-api.git') }],
        presets: ['express'],
      }),
    );

    const first = await cli(['graph', 'build']);
    const second = await cli(['graph', 'build']);

    expect(first.stderr).toBe('');
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/shop-api\s+main@[0-9a-f]{7}\s+\d+ symbols/);
    expect(first.stdout).toContain('built');
    expect(first.stdout).toContain('to .codecite/graph');
    expect(second.stdout).toContain('reused');
    const topology = await readFile(
      join(folder, '.codecite', 'graph', 'topology.json'),
      'utf8',
    );
    expect(topology).toContain('/orders');
  });

  it('설정 파일이 없으면 graph init 을 안내하고 1 로 끝난다', async () => {
    const run = await cli(['graph', 'build']);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('codecite graph init');
  });
});
