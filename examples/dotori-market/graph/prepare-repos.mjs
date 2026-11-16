// 도토리 마켓 예제 저장소(../repos/*)를 git 저장소로 만든다
// codecite graph 는 작업 트리가 아니라 원격 기본 브랜치 커밋을 읽으므로, 저장소마다 원격(bare)과 그것을 받은 클론을 만든다
//   <root>/.codecite/remotes/<이름>.git  원격 역할
//   <root>/.codecite/repos/<이름>        받아 둔 클론. codecite.graph.json 의 path 가 가리킨다
// 커밋 시각과 작성자를 고정해, 몇 번을 만들어도 커밋 SHA 와 그래프 결과가 같다
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXED_DATE = '2026-01-01T00:00:00Z';

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Dotori Market',
  GIT_AUTHOR_EMAIL: 'dev@dotori.example.com',
  GIT_COMMITTER_NAME: 'Dotori Market',
  GIT_COMMITTER_EMAIL: 'dev@dotori.example.com',
  GIT_AUTHOR_DATE: FIXED_DATE,
  GIT_COMMITTER_DATE: FIXED_DATE,
};

function git(cwd, args) {
  execFileSync('git', args, { cwd, env, stdio: 'pipe' });
}

/**
 * 예제 저장소를 root 아래에 원격과 클론으로 만든다. 이미 있으면 지우고 다시 만든다
 * @param {string} [root] 결과를 둘 폴더. 비우면 examples/dotori-market
 * @returns {Promise<string[]>} 만든 저장소 이름
 */
export async function prepareExampleRepositories(root = EXAMPLE_ROOT) {
  const sources = join(EXAMPLE_ROOT, 'repos');
  const remotes = join(root, '.codecite', 'remotes');
  const clones = join(root, '.codecite', 'repos');
  const work = join(root, '.codecite', 'work');
  await rm(remotes, { recursive: true, force: true });
  await rm(clones, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
  await mkdir(remotes, { recursive: true });
  await mkdir(clones, { recursive: true });
  const names = (await readdir(sources, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const tree = join(work, name);
    await cp(join(sources, name), tree, { recursive: true });
    git(tree, ['init', '-q', '-b', 'main']);
    git(tree, ['add', '-A']);
    git(tree, ['commit', '-q', '-m', `${name} 예제`]);
    git(root, ['clone', '-q', '--bare', tree, join(remotes, `${name}.git`)]);
    git(root, [
      'clone',
      '-q',
      join(remotes, `${name}.git`),
      join(clones, name),
    ]);
  }
  await rm(work, { recursive: true, force: true });
  return names;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const names = await prepareExampleRepositories();
  process.stdout.write(
    `Prepared ${names.join(', ')} under examples/dotori-market/.codecite/repos\n`,
  );
}
