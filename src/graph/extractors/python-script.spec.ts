import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  CLIPPED_TEXT_MARK,
  CONDITION_LABELS,
  ENV_PLACEHOLDER,
  LITERAL_PLACEHOLDER,
} from './constants.js';
import { PYTHON_EXTRACTOR_SCRIPT } from './python-script.js';

const hasPython =
  spawnSync('python3', [
    '-c',
    'import sys; sys.exit(sys.version_info < (3, 9))',
  ]).status === 0;

describe('PYTHON_EXTRACTOR_SCRIPT', () => {
  it.skipIf(!hasPython)('python3 이 읽을 수 있는 프로그램이다', () => {
    const result = spawnSync(
      'python3',
      ['-I', '-c', 'import ast, sys; ast.parse(sys.stdin.read())'],
      { input: PYTHON_EXTRACTOR_SCRIPT, encoding: 'utf8' },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('가림 표시·자름 표시·부정 꼴을 박아 두지 않고 요청의 settings 에서 읽는다', () => {
    for (const value of [
      LITERAL_PLACEHOLDER,
      ENV_PLACEHOLDER,
      CLIPPED_TEXT_MARK,
      `${CONDITION_LABELS.not} (`,
    ]) {
      expect(PYTHON_EXTRACTOR_SCRIPT).not.toContain(value);
    }
  });
});
