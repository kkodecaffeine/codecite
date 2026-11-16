import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
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
import {
  GitCommandError,
  listTrackedFiles,
  parseRemoteRef,
  parseSymrefHead,
  resolveRepositoryHead,
  SnapshotWorkspace,
} from './snapshot.js';

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
): Promise<string> {
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
  return git(work, ['rev-parse', 'HEAD']);
}

/** 작업 저장소와 그것을 받는 bare 원격을 만든다. 원격 HEAD 는 branch 를 가리킨다 */
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

/** 폴더 안 모든 항목의 경로·크기·수정 시각. 원본 저장소에 아무것도 쓰지 않았는지 볼 때 쓴다 */
async function fingerprintTree(folder: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const info = await stat(path);
      result.push(`${path} ${info.size} ${info.mtimeMs}`);
      if (entry.isDirectory()) {
        await walk(path);
      }
    }
  };
  await walk(folder);
  return result.sort();
}

let root: string;
let workspace: SnapshotWorkspace | undefined;

beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codecite-snapshot-')));
});

afterEach(async () => {
  await workspace?.dispose();
  workspace = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('parseSymrefHead · parseRemoteRef', () => {
  it('원격 HEAD 응답에서 브랜치와 커밋을, ref 목록에서 이름이 정확히 같은 ref 만 읽는다', () => {
    const sha = 'c'.repeat(40);
    expect(
      parseSymrefHead(`ref: refs/heads/trunk\tHEAD\n${sha}\tHEAD\n`),
    ).toEqual({
      branch: 'trunk',
      commitSha: sha,
    });
    expect(parseSymrefHead(`${sha}\tHEAD\n`)).toBeUndefined();
    const listing = `${'d'.repeat(40)}\trefs/heads/team/release\n${sha}\trefs/heads/release\n`;
    expect(parseRemoteRef(listing, 'refs/heads/release')).toBe(sha);
    expect(parseRemoteRef(listing, 'refs/heads/main')).toBeUndefined();
  });
});

describe('url 저장소', { timeout: 30_000 }, () => {
  it('원격 HEAD 가 가리키는 브랜치의 끝 커밋을 캐시에서 꺼내고, 다 쓰면 작업 폴더를 지운다', async () => {
    const { bare } = await createRemote(root, 'shop-api', 'trunk', {
      'src/coupon/coupon.ts': 'export const couponLimit = 3;\n',
    });
    const repository = { name: 'shop-api', url: bare };
    const head = await resolveRepositoryHead(repository);
    expect(head).toEqual({
      branch: 'trunk',
      commitSha: git(bare, ['rev-parse', 'trunk']),
    });

    const cache = join(root, 'cache');
    workspace = await SnapshotWorkspace.create();
    const snapshot = await workspace.checkout(repository, head, cache);

    expect(snapshot).toMatchObject({
      repository: 'shop-api',
      branch: 'trunk',
      commitSha: head.commitSha,
      committedAt: '2026-11-01T09:00:00.000Z',
      reused: false,
    });
    expect(
      await readFile(join(snapshot.root ?? '', 'src/coupon/coupon.ts'), 'utf8'),
    ).toBe('export const couponLimit = 3;\n');
    const cacheRepository = join(cache, 'repos', 'shop-api');
    expect(git(cacheRepository, ['config', '--get', 'remote.origin.url'])).toBe(
      bare,
    );

    await workspace.dispose();
    workspace = undefined;
    await expect(stat(snapshot.root ?? '')).rejects.toThrow();
    expect(git(cacheRepository, ['worktree', 'list']).split('\n')).toHaveLength(
      1,
    );
  });

  it('defaultBranch 를 주면 그 브랜치를 읽고, 다음 번에는 캐시에 새 커밋만 받는다', async () => {
    const { work, bare } = await createRemote(root, 'shop-api', 'trunk', {
      'src/coupon/coupon.ts': 'export const couponLimit = 3;\n',
    });
    git(work, ['checkout', '-q', '-b', 'release']);
    await commitFiles(work, {
      'src/coupon/coupon.ts': 'export const couponLimit = 5;\n',
    });
    git(work, ['push', '-q', 'origin', 'release']);
    const repository = {
      name: 'shop-api',
      url: bare,
      defaultBranch: 'release',
    };
    const cache = join(root, 'cache');

    workspace = await SnapshotWorkspace.create();
    const first = await workspace.checkout(
      repository,
      await resolveRepositoryHead(repository),
      cache,
    );
    expect(
      await readFile(join(first.root ?? '', 'src/coupon/coupon.ts'), 'utf8'),
    ).toContain('5');
    await workspace.dispose();

    await commitFiles(
      work,
      { 'src/coupon/coupon.ts': 'export const couponLimit = 7;\n' },
      '2026-11-03T10:00:00Z',
    );
    git(work, ['push', '-q', 'origin', 'release']);
    workspace = await SnapshotWorkspace.create();
    const second = await workspace.checkout(
      repository,
      await resolveRepositoryHead(repository),
      cache,
    );
    expect(second.commitSha).toBe(git(bare, ['rev-parse', 'release']));
    expect(second.committedAt).toBe('2026-11-03T10:00:00.000Z');
    expect(
      await readFile(join(second.root ?? '', 'src/coupon/coupon.ts'), 'utf8'),
    ).toContain('7');
  });

  it('같은 이름의 저장소 주소가 바뀌면 캐시를 새로 받는다', async () => {
    const first = await createRemote(root, 'shop-api', 'main', {
      'a.ts': 'export const a = 1;\n',
    });
    const moved = await createRemote(root, 'shop-api-moved', 'main', {
      'b.ts': 'export const b = 2;\n',
    });
    const cache = join(root, 'cache');
    workspace = await SnapshotWorkspace.create();
    const old = { name: 'shop-api', url: first.bare };
    await workspace.checkout(old, await resolveRepositoryHead(old), cache);
    await workspace.dispose();

    workspace = await SnapshotWorkspace.create();
    const renamed = { name: 'shop-api', url: moved.bare };
    const snapshot = await workspace.checkout(
      renamed,
      await resolveRepositoryHead(renamed),
      cache,
    );
    expect(await listTrackedFiles(snapshot.root ?? '')).toEqual(['b.ts']);
  });

  it('닿지 않는 원격은 저장소 이름과 git 오류 요약으로 알린다', async () => {
    const repository = { name: 'shop-api', url: join(root, 'missing.git') };
    const error = await resolveRepositoryHead(repository).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(GitCommandError);
    expect((error as Error).message).toMatch(
      /^Repository shop-api: git ls-remote failed: /,
    );
  });
});

describe('path 저장소', { timeout: 30_000 }, () => {
  it('작업 트리와 밀어 넣지 않은 커밋이 아니라 원격 추적 브랜치 커밋을 읽고, 원본에는 쓰지 않는다', async () => {
    const { bare } = await createRemote(root, 'shop-web', 'main', {
      'src/cart/cart.ts': 'export const cartLimit = 20;\n',
    });
    const clone = join(root, 'shop-web');
    git(root, ['clone', '-q', bare, clone]);
    const pushed = git(clone, ['rev-parse', 'HEAD']);
    await commitFiles(clone, {
      'src/cart/draft.ts': 'export const draft = true;\n',
    });
    await writeFile(
      join(clone, 'src/cart/cart.ts'),
      'export const cartLimit = 99;\n',
    );
    const before = await fingerprintTree(clone);

    const repository = { name: 'shop-web', path: clone };
    const head = await resolveRepositoryHead(repository);
    expect(head).toEqual({ branch: 'main', commitSha: pushed });
    workspace = await SnapshotWorkspace.create();
    const snapshot = await workspace.checkout(
      repository,
      head,
      join(root, 'cache'),
    );

    expect(await listTrackedFiles(snapshot.root ?? '')).toEqual([
      'src/cart/cart.ts',
    ]);
    expect(
      await readFile(join(snapshot.root ?? '', 'src/cart/cart.ts'), 'utf8'),
    ).toBe('export const cartLimit = 20;\n');
    await workspace.dispose();
    workspace = undefined;
    expect(await fingerprintTree(clone)).toEqual(before);
  });

  it('기본 브랜치는 그 저장소가 아는 원격 HEAD 를 따른다', async () => {
    const { work, bare } = await createRemote(root, 'shop-worker', 'develop', {
      'jobs/settle.py': 'LIMIT = 10\n',
    });
    git(work, ['checkout', '-q', '-b', 'main']);
    await commitFiles(work, { 'jobs/settle.py': 'LIMIT = 11\n' });
    git(work, ['push', '-q', 'origin', 'main']);
    const clone = join(root, 'shop-worker');
    git(root, ['clone', '-q', bare, clone]);

    const head = await resolveRepositoryHead({
      name: 'shop-worker',
      path: clone,
    });
    expect(head).toEqual({
      branch: 'develop',
      commitSha: git(bare, ['rev-parse', 'develop']),
    });
  });

  it('원격이 없는 저장소는 원격 추적 브랜치가 없다고 알린다', async () => {
    const local = join(root, 'shop-admin');
    git(root, ['init', '-q', '-b', 'main', local]);
    await commitFiles(local, { 'a.ts': 'export const a = 1;\n' });
    await expect(
      resolveRepositoryHead({ name: 'shop-admin', path: local }),
    ).rejects.toThrow(/Repository shop-admin: .* has no remote/);
  });
});

describe('listTrackedFiles', { timeout: 30_000 }, () => {
  it('추적 중인 일반 파일만 돌려주고 심볼릭 링크는 뺀다', async () => {
    const { work } = await createRemote(root, 'shop-api', 'main', {
      'src/review/review.ts': 'export const reviewMax = 5;\n',
    });
    await symlink('/etc', join(work, 'src/outside'));
    await commitFiles(work, {});
    await writeFile(join(work, 'untracked.ts'), 'export const x = 1;\n');
    expect(await listTrackedFiles(work)).toEqual(['src/review/review.ts']);
  });
});
