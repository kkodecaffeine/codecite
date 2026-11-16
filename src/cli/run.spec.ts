import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogFields, Logger } from '../ports.js';
import { runCli } from './run.js';
import type { CliCommand, CliContext } from './types.js';

const CLAIMS = [
  'policy_group,feature_name,claim_statement,claim_facet,source',
  'coupon,장바구니 쿠폰 사용 조건,"장바구니 쿠폰은 상품 금액 합계가 25,000 원 이상인 주문에만 쓸 수 있다.",eligibility,쿠폰 이용 안내 4 항',
  'review,사진 리뷰 적립금,사진을 붙인 상품 리뷰를 쓰면 리뷰 하나에 적립금 300 원을 준다.,amount,',
].join('\n');

const QUESTION = '장바구니 쿠폰 사용 조건이 뭐예요?';

let folder: string;

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  logs: Array<[string, string, LogFields | undefined]>;
}

async function cli(
  args: string[],
  options: { cwd?: string; commands?: readonly CliCommand[] } = {},
): Promise<CliRun> {
  const result: CliRun = { code: -1, stdout: '', stderr: '', logs: [] };
  const record =
    (level: string) =>
    (message: string, fields?: LogFields): void => {
      result.logs.push([level, message, fields]);
    };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
  result.code = await runCli(
    args,
    {
      cwd: options.cwd ?? folder,
      env: {},
      stdout: (text) => {
        result.stdout += text;
      },
      stderr: (text) => {
        result.stderr += text;
      },
      createLogger: () => logger,
    },
    options.commands,
  );
  return result;
}

async function writeSample(
  config: unknown = { source: { type: 'csv', path: 'claims.csv' } },
  claims: string = CLAIMS,
): Promise<void> {
  await writeFile(join(folder, 'codecite.config.json'), JSON.stringify(config));
  await writeFile(join(folder, 'claims.csv'), claims);
}

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'codecite-cli-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

describe('runCli 인자 해석', () => {
  it('--version 은 package.json 의 버전을 찍는다', async () => {
    const pkg = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    const run = await cli(['--version']);

    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`${pkg.version}\n`);
  });

  it('--help 는 명령 목록과 공통 옵션을 보이고 0 으로 끝난다', async () => {
    const run = await cli(['--help']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage: codecite <command> [options]');
    for (const name of ['index', 'ask', 'eval', 'serve', '--cwd <dir>']) {
      expect(run.stdout).toContain(name);
    }
  });

  it('명령 뒤의 --help 는 그 명령의 사용법과 옵션을 보인다', async () => {
    const run = await cli(['ask', '--help']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage: codecite ask <question> [--json]');
    expect(run.stdout).toContain('--json');
  });

  it.each([
    [[], 'missing command', 'codecite --help'],
    [['reindex'], 'unknown command "reindex"', 'codecite --help'],
    [['ask'], 'ask needs a question', 'codecite ask --help'],
    [['ask', '   '], 'ask needs a question', 'codecite ask --help'],
    [['ask', '--fast', '배송비'], "Unknown option '--fast'", 'codecite ask'],
    [['index', '장바구니'], 'unexpected argument "장바구니"', 'codecite index'],
    [['serve', '--port', '배송'], '--port must be a number', 'codecite serve'],
    [['serve', '--port', '70000'], '--port must be a number', 'codecite serve'],
  ])(
    '사용법 오류 %j 는 종료 코드 2 와 도움말 안내를 낸다',
    async (args, message, help) => {
      const run = await cli(args);

      expect(run.code).toBe(2);
      expect(run.stdout).toBe('');
      expect(run.stderr).toContain(message);
      expect(run.stderr).toContain(`Run "${help}`);
    },
  );

  it('--cwd 는 명령 앞뒤 어디에 와도 되고 상대 경로는 현재 폴더 기준으로 푼다', async () => {
    await writeSample();
    const options = { cwd: dirname(folder) };

    const after = await cli(['index', '--cwd', basename(folder)], options);
    const before = await cli([`--cwd=${basename(folder)}`, 'index'], options);

    for (const run of [after, before]) {
      expect(run.code).toBe(0);
      expect(run.stdout).toBe(
        'Indexed 2 chunks (retrieval: bm25, reused vectors: no)\n',
      );
    }
  });
});

describe('ask', () => {
  it('--json 은 CodeciteAnswer 를 그대로 찍는다', async () => {
    await writeSample();

    const run = await cli(['ask', QUESTION, '--json']);

    expect(run.code).toBe(0);
    const answer = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(Object.keys(answer).sort()).toEqual([
      'answer',
      'citations',
      'status',
      'trace',
    ]);
    expect(answer.status).toBe('answered');
    expect(answer.trace).toEqual({
      retrieval: 'bm25',
      generation: 'deterministic',
      candidates: expect.any(Number),
      packed: expect.any(Number),
    });
    expect(answer.citations).toContainEqual({
      claimId: expect.stringMatching(/^claim-/),
      policyGroup: 'coupon',
      statement:
        '장바구니 쿠폰은 상품 금액 합계가 25,000 원 이상인 주문에만 쓸 수 있다.',
      source: '쿠폰 이용 안내 4 항',
    });
  });

  it('기본 출력은 답 다음에 번호 붙은 인용과 출처를 보인다', async () => {
    await writeSample();

    const run = await cli(['ask', QUESTION]);

    expect(run.code).toBe(0);
    const [answer, ...rest] = run.stdout.split('\n\nCitations\n');
    expect(answer.trim()).not.toBe('');
    expect(rest.join('')).toContain(
      '1. 장바구니 쿠폰은 상품 금액 합계가 25,000 원 이상인 주문에만 쓸 수 있다.\n   source: 쿠폰 이용 안내 4 항\n',
    );
  });

  it('따옴표 없이 나뉜 낱말도 한 질문으로 묻는다', async () => {
    await writeSample();

    const run = await cli(['ask', ...QUESTION.split(' '), '--json']);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: 'answered' });
  });

  it('로그와 오류 출력에 질문 본문을 남기지 않는다', async () => {
    await writeSample();

    const run = await cli(['ask', QUESTION]);

    expect(run.code).toBe(0);
    expect(run.logs.map(([, message]) => message)).toContain(
      'question answered',
    );
    expect(JSON.stringify(run.logs)).not.toContain(QUESTION);
    expect(run.stderr).not.toContain(QUESTION);
  });
});

describe('실패 안내', () => {
  it('설정 파일이 없으면 종료 코드 1 과 찾은 폴더를 알린다', async () => {
    const run = await cli(['index']);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('codecite.config.json was not found');
  });

  it('설정 값이 틀리면 고칠 설정 이름을 알린다', async () => {
    await writeSample({ source: { type: 'csv' } });

    const run = await cli(['index']);

    expect(run.code).toBe(1);
    expect(run.stderr).toBe(
      'codecite: codecite.config.json: source.path is required.\n',
    );
  });

  it('정책 CSV 가 없으면 source.path 를 고치라고 알린다', async () => {
    await writeSample({ source: { type: 'csv', path: 'missing.csv' } });

    const run = await cli(['index']);

    expect(run.code).toBe(1);
    expect(run.stderr).toBe(
      'codecite: codecite.config.json: source.path points to missing.csv, which was not found.\n',
    );
  });

  it('CSV 형식 오류는 행 번호를 알린다', async () => {
    await writeSample(
      undefined,
      `${CLAIMS}\nshipping,묶음 배송,같은 날 주문한 상품은 한 상자로 보낸다.,bundle\n`,
    );

    const run = await cli(['ask', QUESTION]);

    expect(run.code).toBe(1);
    expect(run.stderr).toMatch(/claims\.csv row 4: .*bundle/);
  });
});

describe('명령 묶음', () => {
  const build = vi.fn(async (context: CliContext) =>
    context.values.force === true ? 0 : 1,
  );
  const group: CliCommand = {
    name: 'catalog',
    summary: 'Catalog tools',
    commands: [
      {
        name: 'build',
        summary: 'Build the catalog',
        usage: '[--force]',
        options: { force: { type: 'boolean', description: 'Rebuild all' } },
        run: build,
      },
    ],
  };

  it('묶음 이름 다음 위치 인자로 하위 명령을 고르고 옵션을 넘긴다', async () => {
    const run = await cli(['--cwd', 'shop', 'catalog', 'build', '--force'], {
      cwd: folder,
      commands: [group],
    });

    expect(run.code).toBe(0);
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: join(folder, 'shop'),
        positionals: [],
        values: expect.objectContaining({ force: true }),
      }),
    );
  });

  it('묶음의 --help 는 하위 명령 목록을 보이고, 하위 명령이 없거나 모르면 2 로 끝난다', async () => {
    const help = await cli(['catalog', '--help'], { commands: [group] });
    const missing = await cli(['catalog'], { commands: [group] });
    const unknown = await cli(['catalog', 'drop'], { commands: [group] });

    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: codecite catalog <command>');
    expect(help.stdout).toContain('build  Build the catalog');
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('Run "codecite catalog --help"');
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown command "drop"');
  });

  it('하위 명령 도움말은 묶음 이름까지 붙은 사용법을 보인다', async () => {
    const run = await cli(['catalog', 'build', '-h'], { commands: [group] });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Usage: codecite catalog build [--force]');
    expect(run.stdout).toContain('--force');
  });
});
