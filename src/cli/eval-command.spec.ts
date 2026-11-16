import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GoldenBaseline, GoldenQuestion } from '../evaluation/types.js';
import { runCli } from './run.js';

const SAMPLE = fileURLToPath(
  new URL('../../examples/dotori-market/', import.meta.url),
);
const SAMPLE_FILES = [
  'codecite.config.json',
  'policies.csv',
  'golden-questions.json',
  'baseline.json',
];

let folder: string;

async function evalCli(
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const run = { code: -1, stdout: '', stderr: '' };
  const quiet = () => undefined;
  run.code = await runCli(['eval', ...args], {
    cwd: folder,
    env,
    stdout: (text) => {
      run.stdout += text;
    },
    stderr: (text) => {
      run.stderr += text;
    },
    createLogger: () => ({
      debug: quiet,
      info: quiet,
      warn: quiet,
      error: quiet,
    }),
  });
  return run;
}

async function readSampleJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(folder, name), 'utf8')) as T;
}

async function writeSampleJson(name: string, value: unknown): Promise<void> {
  await writeFile(join(folder, name), JSON.stringify(value, null, 2));
}

/** 임시 사본의 기준선에서 질문 하나의 기록을 바꾼다 */
async function editBaseline(
  id: string,
  change: Partial<GoldenBaseline['questions'][number]>,
): Promise<void> {
  const baseline = await readSampleJson<GoldenBaseline>('baseline.json');
  const entry = baseline.questions.find((question) => question.id === id);
  if (!entry) {
    throw new Error(`baseline has no ${id}`);
  }
  Object.assign(entry, change);
  await writeSampleJson('baseline.json', baseline);
}

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'codecite-eval-'));
  for (const file of SAMPLE_FILES) {
    await cp(join(SAMPLE, file), join(folder, file));
  }
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('codecite eval', () => {
  it('샘플은 기준선과 같아 회귀 없이 0 으로 끝난다', async () => {
    const run = await evalCli();

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Regressions: 0\nImprovements: 0\n');
  });

  it('API 키가 있어도 모델과 임베딩을 부르지 않는다', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const run = await evalCli([], { OPENAI_API_KEY: 'sk-test-only' });

    expect(run.code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('기준선에서 맞던 질문이 틀리면 회귀로 보이고 1 로 끝난다', async () => {
    // 지금 틀리는 질문을 기준선에서는 맞았던 것으로 바꾼다
    await editBaseline('refund-06', { passed: true, hitAll: true });

    const run = await evalCli();

    expect(run.code).toBe(1);
    expect(run.stdout).toContain(
      'Regressions: 1\n  refund-06  hitAll: pass -> fail\n',
    );
  });

  it('기준선에서 틀리던 질문이 맞으면 개선으로만 보이고 0 으로 끝난다', async () => {
    await editBaseline('points-01', {
      passed: false,
      hitAny: false,
      hitAll: false,
    });

    const run = await evalCli();

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Regressions: 0\n');
    expect(run.stdout).toContain(
      'Improvements: 2\n  points-01  hitAny: fail -> pass\n  points-01  hitAll: fail -> pass\n',
    );
  });

  it('기준선의 질문이 골든 질문에서 빠지면 회귀로 1 로 끝난다', async () => {
    const questions = await readSampleJson<GoldenQuestion[]>(
      'golden-questions.json',
    );
    await writeSampleJson(
      'golden-questions.json',
      questions.filter((question) => question.id !== 'coupon-03'),
    );

    const run = await evalCli();

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('coupon-03  missing from the results');
  });

  it('기준선 파일이 없으면 만드는 법을 알리고 1 로 끝난다', async () => {
    await rm(join(folder, 'baseline.json'));

    const run = await evalCli();

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('baseline.json was not found');
    expect(run.stderr).toContain('codecite eval --write-baseline');
  });

  it('--write-baseline 은 저장소의 기준선과 같은 파일을 쓰고 골든 질문은 건드리지 않는다', async () => {
    const committed = await readFile(join(folder, 'baseline.json'), 'utf8');
    const golden = await readFile(
      join(folder, 'golden-questions.json'),
      'utf8',
    );
    await rm(join(folder, 'baseline.json'));

    const run = await evalCli(['--write-baseline']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Wrote baseline.json (30/35 passed)');
    expect(await readFile(join(folder, 'baseline.json'), 'utf8')).toBe(
      committed,
    );
    expect(await readFile(join(folder, 'golden-questions.json'), 'utf8')).toBe(
      golden,
    );
  });

  it('--write-baseline 은 데이터에 없는 claim id 를 기대하는 질문이 있으면 쓰지 않고 1 로 끝난다', async () => {
    const before = await readFile(join(folder, 'baseline.json'), 'utf8');
    const questions = await readSampleJson<GoldenQuestion[]>(
      'golden-questions.json',
    );
    questions[0] = {
      ...questions[0],
      expectedClaimIds: ['claim-0000000000000000'],
    };
    await writeSampleJson('golden-questions.json', questions);

    const run = await evalCli(['--write-baseline']);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`${questions[0].id}: claim-0000000000000000`);
    expect(await readFile(join(folder, 'baseline.json'), 'utf8')).toBe(before);
  });

  it('위치 인자는 사용법 오류로 2 로 끝난다', async () => {
    const run = await evalCli(['refund']);

    expect(run.code).toBe(2);
  });
});
