// 배포 전에 묶은 패키지가 ESM·CommonJS 양쪽에서 불러지는지, 타입 선언이 있는지 본다
// npm pack 으로 만든 묶음을 임시 프로젝트에 설치하므로 실제 사용자가 받는 파일 그대로 검사한다
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'codecite-package-'));
try {
  const tarball = execFileSync(
    'npm',
    ['pack', '--silent', '--pack-destination', work],
    { cwd: root, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .pop();
  writeFileSync(
    join(work, 'package.json'),
    '{"name":"consumer","private":true}\n',
  );
  execFileSync(
    'npm',
    ['install', '--silent', '--no-audit', '--no-fund', join(work, tarball)],
    { cwd: work, stdio: 'inherit' },
  );
  const run = (type, code) =>
    execFileSync(process.execPath, [`--input-type=${type}`, '-e', code], {
      cwd: work,
      encoding: 'utf8',
    }).trim();
  const checks = [
    ['commonjs', "console.log(typeof require('codecite').createCodecite)"],
    [
      'commonjs',
      "console.log(typeof require('codecite/graph').buildCodeGraph)",
    ],
    [
      'module',
      "import { createCodecite } from 'codecite'; console.log(typeof createCodecite)",
    ],
    [
      'module',
      "import { buildCodeGraph } from 'codecite/graph'; console.log(typeof buildCodeGraph)",
    ],
  ];
  for (const [type, code] of checks) {
    const output = run(type, code);
    if (output !== 'function') {
      throw new Error(`${type}: ${code} printed ${output}`);
    }
  }
  for (const file of [
    'dist/index.d.ts',
    'dist/graph/index.d.ts',
    'dist/cli.js',
    'LICENSE',
    'NOTICE',
    'README.md',
  ]) {
    if (!existsSync(join(work, 'node_modules', 'codecite', file))) {
      throw new Error(`missing ${file} in the package`);
    }
  }
  console.log('package ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
