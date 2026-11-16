// 저장소를 원격 기본 브랜치의 고정 커밋으로 임시 폴더에 꺼낸다
// 개발자 작업 트리는 읽지 않고, 원본 저장소에는 아무것도 쓰지 않는다. git 은 인자 배열로만 부른다(셸 문자열 없음)
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  GIT_CHECKOUT_SETTINGS,
  GIT_DROPPED_VARIABLES,
  GIT_ERROR_SUMMARY_MAX_CHARS,
  GIT_FIXED_VARIABLES,
  GIT_MAX_BUFFER_BYTES,
  GIT_REMOTE_QUERY_TIMEOUT_MS,
  GRAPH_CACHE_REPOSITORIES_FOLDER,
  GRAPH_WORKSPACE_PREFIX,
} from './constants.js';
import { redactSecretLiterals } from './redaction.js';
import type {
  GitRunOptions,
  GraphRepositoryConfig,
  RepositoryHead,
  RepositorySnapshot,
} from './types.js';

const execFileAsync = promisify(execFile);

/** git 명령 실패. 저장소 이름과 오류 요약(주소의 계정 정보는 가림)을 담는다 */
export class GitCommandError extends Error {
  constructor(
    readonly repository: string | undefined,
    readonly command: string,
    readonly summary: string,
  ) {
    super(
      `${repository ? `Repository ${repository}: ` : ''}git ${command} failed: ${summary}`,
    );
    this.name = 'GitCommandError';
  }
}

/** git 을 인자 배열로 부른다. 대화형 질문을 끄고, 읽기 명령이 작업 폴더 색인을 고쳐 쓰지 않게 한다 */
export async function runGit(
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd: options.cwd,
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER_BYTES,
      timeout: options.timeoutMs ?? 0,
      env: gitEnvironment(),
    });
    return stdout;
  } catch (error) {
    throw new GitCommandError(
      options.repository,
      commandName(args),
      summarizeGitError(error),
    );
  }
}

/** 원격 HEAD 응답(`ls-remote --symref <원격> HEAD`)에서 기본 브랜치와 커밋을 읽는다 */
export function parseSymrefHead(output: string): RepositoryHead | undefined {
  let branch: string | undefined;
  let commitSha: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const symref = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (symref) {
      branch = symref[1];
      continue;
    }
    const head = /^([0-9a-f]{7,64})\tHEAD$/.exec(line);
    if (head) {
      commitSha = head[1];
    }
  }
  return branch && commitSha ? { branch, commitSha } : undefined;
}

/** `ls-remote` 응답에서 정확히 그 이름인 ref 의 커밋. ls-remote 는 끝부분만 맞춰 보여 주므로 이름 전체를 비교한다 */
export function parseRemoteRef(
  output: string,
  ref: string,
): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const [commitSha, name] = line.split('\t');
    if (name === ref && /^[0-9a-f]{7,64}$/.test(commitSha ?? '')) {
      return commitSha;
    }
  }
  return undefined;
}

/**
 * 읽을 브랜치와 커밋을 정한다. 아직 아무것도 꺼내지 않으므로 지난 결과와 비교해 재사용할지 고르는 데 쓴다
 * - url: 원격에 묻는다. defaultBranch 가 없으면 원격 HEAD 가 가리키는 브랜치다
 * - path: 그 저장소의 원격 추적 브랜치(`<원격>/<브랜치>`) 커밋이다. 그 저장소에서 fetch 하지 않는다
 */
export async function resolveRepositoryHead(
  repository: GraphRepositoryConfig,
): Promise<RepositoryHead> {
  const name = repository.name;
  if (repository.url) {
    return resolveUrlHead(repository.url, name, repository.defaultBranch);
  }
  if (!repository.path) {
    throw new Error(`Repository ${name}: url or path is required`);
  }
  const remote = await selectRemote(repository.path, name);
  const branch =
    repository.defaultBranch ??
    (await localRemoteHead(repository.path, remote)) ??
    (await askRemoteHead(repository.path, remote, name));
  const commitSha = await tryRevParse(
    repository.path,
    `refs/remotes/${remote}/${branch}^{commit}`,
  );
  if (!commitSha) {
    throw new Error(
      `Repository ${name}: remote-tracking branch ${remote}/${branch} not found in ${repository.path}. Fetch it in that repository first, or set defaultBranch.`,
    );
  }
  return { branch, commitSha };
}

/**
 * 저장소를 고정 커밋으로 꺼내 두는 임시 작업 폴더. 다 쓰면 dispose 로 지운다
 * - url 저장소는 캐시 폴더에 blob 없이 받아 두고(`clone --filter=blob:none --no-checkout`), 그 캐시에서 작업 폴더를 꺼낸다
 * - path 저장소는 객체를 공유하는 복제(`clone --shared --no-checkout`)로 꺼낸다. 원본 저장소에는 쓰지 않는다
 */
export class SnapshotWorkspace {
  readonly #worktrees: Array<{ cache: string; path: string }> = [];

  private constructor(readonly root: string) {}

  static async create(): Promise<SnapshotWorkspace> {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), GRAPH_WORKSPACE_PREFIX)),
    );
    return new SnapshotWorkspace(root);
  }

  /** 저장소를 꺼낸다. url 저장소는 받는 사이 브랜치가 움직였으면 받은 커밋을 쓴다 */
  async checkout(
    repository: GraphRepositoryConfig,
    head: RepositoryHead,
    cache: string,
  ): Promise<RepositorySnapshot> {
    const name = repository.name;
    const target = join(this.root, name);
    let commitSha = head.commitSha;
    if (repository.url) {
      const cacheRoot = join(cache, GRAPH_CACHE_REPOSITORIES_FOLDER, name);
      await ensureUrlCache(repository.url, cacheRoot, name);
      await runGit(
        [
          'fetch',
          '--quiet',
          '--no-tags',
          '--filter=blob:none',
          '--',
          'origin',
          `+refs/heads/${head.branch}:refs/remotes/origin/${head.branch}`,
        ],
        { cwd: cacheRoot, repository: name },
      );
      commitSha =
        (await tryRevParse(
          cacheRoot,
          `refs/remotes/origin/${head.branch}^{commit}`,
        )) ?? commitSha;
      await runGit(['worktree', 'prune'], { cwd: cacheRoot, repository: name });
      await runGit(
        [
          ...GIT_CHECKOUT_SETTINGS,
          'worktree',
          'add',
          '--quiet',
          '--detach',
          '--',
          target,
          commitSha,
        ],
        { cwd: cacheRoot, repository: name },
      );
      this.#worktrees.push({ cache: cacheRoot, path: target });
    } else if (repository.path) {
      await runGit(
        [
          'clone',
          '--quiet',
          '--shared',
          '--no-checkout',
          '--',
          repository.path,
          target,
        ],
        { cwd: this.root, repository: name },
      );
      await runGit(
        [
          ...GIT_CHECKOUT_SETTINGS,
          'checkout',
          '--quiet',
          '--detach',
          commitSha,
          '--',
        ],
        { cwd: target, repository: name },
      );
    } else {
      throw new Error(`Repository ${name}: url or path is required`);
    }
    const checkedOut = (
      await runGit(['rev-parse', 'HEAD'], { cwd: target, repository: name })
    ).trim();
    if (checkedOut !== commitSha) {
      throw new Error(
        `Repository ${name}: checked out ${checkedOut} instead of ${commitSha}`,
      );
    }
    return {
      repository: name,
      branch: head.branch,
      commitSha,
      committedAt: await commitTime(target, name),
      root: target,
      reused: false,
    };
  }

  /** 꺼낸 폴더와 캐시에 남은 작업 폴더 기록을 지운다. 실패해도 다른 정리는 이어 간다 */
  async dispose(): Promise<void> {
    for (const worktree of this.#worktrees) {
      await runGit(['worktree', 'remove', '--force', '--', worktree.path], {
        cwd: worktree.cache,
      }).catch(() => undefined);
    }
    await rm(this.root, { recursive: true, force: true });
    for (const cache of new Set(this.#worktrees.map((item) => item.cache))) {
      await runGit(['worktree', 'prune'], { cwd: cache }).catch(
        () => undefined,
      );
    }
    this.#worktrees.length = 0;
  }
}

/**
 * 꺼낸 커밋에서 추적 중인 일반 파일 경로. 심볼릭 링크와 하위 모듈은 빼서, 링크를 따라 저장소 밖 파일을 읽는 일을 막는다
 */
export async function listTrackedFiles(
  root: string,
  repository?: string,
): Promise<string[]> {
  const output = await runGit(['ls-tree', '-r', '-z', '--full-tree', 'HEAD'], {
    cwd: root,
    repository,
  });
  const files: string[] = [];
  for (const entry of output.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab === -1) {
      continue;
    }
    const [mode, type] = entry.slice(0, tab).split(' ');
    if (type === 'blob' && (mode === '100644' || mode === '100755')) {
      files.push(entry.slice(tab + 1));
    }
  }
  return files;
}

async function resolveUrlHead(
  url: string,
  name: string,
  defaultBranch: string | undefined,
): Promise<RepositoryHead> {
  if (defaultBranch) {
    const ref = `refs/heads/${defaultBranch}`;
    const output = await runGit(['ls-remote', '--', url, ref], {
      repository: name,
      timeoutMs: GIT_REMOTE_QUERY_TIMEOUT_MS,
    });
    const commitSha = parseRemoteRef(output, ref);
    if (!commitSha) {
      throw new Error(
        `Repository ${name}: remote branch ${defaultBranch} not found`,
      );
    }
    return { branch: defaultBranch, commitSha };
  }
  const output = await runGit(['ls-remote', '--symref', '--', url, 'HEAD'], {
    repository: name,
    timeoutMs: GIT_REMOTE_QUERY_TIMEOUT_MS,
  });
  const head = parseSymrefHead(output);
  if (!head) {
    throw new Error(
      `Repository ${name}: remote HEAD does not point to a branch; set defaultBranch`,
    );
  }
  return head;
}

/** path 저장소에서 읽을 원격. origin 이 있으면 origin, 원격이 하나뿐이면 그것이다 */
async function selectRemote(path: string, name: string): Promise<string> {
  const remotes = (await runGit(['remote'], { cwd: path, repository: name }))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (remotes.includes('origin')) {
    return 'origin';
  }
  if (remotes.length === 1) {
    return remotes[0];
  }
  throw new Error(
    remotes.length === 0
      ? `Repository ${name}: ${path} has no remote. Only remote-tracking branches are read; add a remote or use url instead of path.`
      : `Repository ${name}: ${path} has several remotes and none is origin (${remotes.join(', ')}).`,
  );
}

/** 그 저장소가 알고 있는 원격 HEAD(`refs/remotes/<원격>/HEAD`). 네트워크를 쓰지 않는다 */
async function localRemoteHead(
  path: string,
  remote: string,
): Promise<string | undefined> {
  const prefix = `refs/remotes/${remote}/`;
  try {
    const ref = (
      await runGit(['symbolic-ref', '--quiet', `${prefix}HEAD`], { cwd: path })
    ).trim();
    return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
  } catch {
    return undefined;
  }
}

/** 원격 HEAD 를 원격에 직접 묻는다. 그 저장소에는 쓰지 않는다 */
async function askRemoteHead(
  path: string,
  remote: string,
  name: string,
): Promise<string> {
  try {
    const output = await runGit(
      ['ls-remote', '--symref', '--', remote, 'HEAD'],
      {
        cwd: path,
        repository: name,
        timeoutMs: GIT_REMOTE_QUERY_TIMEOUT_MS,
      },
    );
    const head = parseSymrefHead(output);
    if (head) {
      return head.branch;
    }
  } catch {
    // 원격에 닿지 않으면 아래에서 defaultBranch 를 적으라고 알린다
  }
  throw new Error(
    `Repository ${name}: cannot tell the default branch of remote ${remote}; set defaultBranch`,
  );
}

/** url 캐시를 준비한다. 없거나 깨졌거나 주소가 바뀌었으면 지우고 새로 받는다 */
async function ensureUrlCache(
  url: string,
  cacheRoot: string,
  name: string,
): Promise<void> {
  if (await exists(cacheRoot)) {
    const current = await runGit(['config', '--get', 'remote.origin.url'], {
      cwd: cacheRoot,
    }).catch(() => '');
    const gitDirectory = await runGit(['rev-parse', '--git-dir'], {
      cwd: cacheRoot,
    }).catch(() => '');
    if (current.trim() === url && gitDirectory.trim() === '.git') {
      return;
    }
    await rm(cacheRoot, { recursive: true, force: true });
  }
  await mkdir(dirname(cacheRoot), { recursive: true });
  await runGit(
    [
      'clone',
      '--quiet',
      '--filter=blob:none',
      '--no-checkout',
      '--no-tags',
      '--',
      url,
      cacheRoot,
    ],
    { repository: name },
  );
}

async function commitTime(root: string, name: string): Promise<string> {
  const seconds = Number(
    (
      await runGit(['show', '-s', '--format=%ct', 'HEAD'], {
        cwd: root,
        repository: name,
      })
    ).trim(),
  );
  if (!Number.isFinite(seconds)) {
    throw new Error(`Repository ${name}: cannot read the commit time`);
  }
  return new Date(seconds * 1000).toISOString();
}

async function tryRevParse(
  cwd: string,
  revision: string,
): Promise<string | undefined> {
  try {
    const sha = (
      await runGit(['rev-parse', '--verify', '--quiet', revision], { cwd })
    ).trim();
    return /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 부른 쪽 환경을 물려받되, 다른 저장소를 가리키게 하는 변수는 빼고 고정 값을 덮어쓴다 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const variable of GIT_DROPPED_VARIABLES) {
    delete environment[variable];
  }
  return { ...environment, ...GIT_FIXED_VARIABLES };
}

/** `-c 설정` 앞머리를 건너뛴 하위 명령 이름 */
function commandName(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-c' || args[index] === '-C') {
      index += 1;
      continue;
    }
    return args[index];
  }
  return '';
}

function summarizeGitError(error: unknown): string {
  const failure = error as {
    code?: string | number;
    stderr?: string;
    killed?: boolean;
    message?: string;
  };
  if (failure.code === 'ENOENT') {
    return 'git is not installed or not on PATH';
  }
  if (failure.killed) {
    return 'timed out';
  }
  const lines = String(failure.stderr ?? failure.message ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('hint:'));
  // 주소의 계정 부분은 비밀번호 없이 토큰만 있어도 통째로 가린다
  const summary =
    redactSecretLiterals(lines.join(' / ')).replace(
      /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@'"`]+@/gi,
      '$1[REDACTED]@',
    ) || 'unknown error';
  return summary.length > GIT_ERROR_SUMMARY_MAX_CHARS
    ? `${summary.slice(0, GIT_ERROR_SUMMARY_MAX_CHARS - 1)}…`
    : summary;
}
