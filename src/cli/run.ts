import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createConsoleLogger } from '../logger.js';
import { askCommand, indexCommand, serveCommand } from './commands.js';
import {
  DEFAULT_CLI_LOG_LEVEL,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  GLOBAL_OPTIONS,
} from './constants.js';
import { CliUsageError } from './errors.js';
import { evalCommand } from './eval-command.js';
import type {
  CliCommand,
  CliCommandGroup,
  CliIo,
  CliLeafCommand,
  CliOption,
  CliOptionValues,
} from './types.js';

/**
 * 맨 위 명령 목록
 * 명령 묶음(예: `graph init|build|report|validate`)은 자기 파일에 `CliCommandGroup` 을 만들고 여기에 한 줄 더한다
 * 묶음 안의 하위 명령도 같은 `CliLeafCommand` 라 해석·도움말·종료 코드 규칙을 그대로 받는다
 */
const COMMANDS: readonly CliCommand[] = [
  indexCommand,
  askCommand,
  evalCommand,
  serveCommand,
];

const ROOT_DESCRIPTION = [
  'Answers questions from a policy claim CSV and cites the claims it used.',
  'Reads codecite.config.json in the current folder (or --cwd).',
];

/**
 * 인자를 해석해 명령을 돌리고 종료 코드를 돌려준다. 0 성공, 1 실패나 회귀, 2 사용법 오류
 * 결과는 stdout 에, 오류와 로그는 stderr 에 쓴다. 로그에는 질문 본문을 넣지 않는다
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = processIo(),
  commands: readonly CliCommand[] = COMMANDS,
): Promise<number> {
  const root: CliCommandGroup = {
    name: 'codecite',
    summary: '',
    description: ROOT_DESCRIPTION,
    commands,
  };
  try {
    return await dispatch(root, [...argv], 'codecite', io);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(
        `codecite: ${error.message}\nRun "${error.command ?? 'codecite'} --help" for usage.\n`,
      );
      return EXIT_USAGE;
    }
    io.stderr(`codecite: ${errorMessage(error)}\n`);
    return EXIT_FAILURE;
  }
}

/** 첫 위치 인자로 명령을 고른다. 묶음이면 남은 인자로 한 번 더 고른다 */
async function dispatch(
  group: CliCommandGroup,
  args: readonly string[],
  path: string,
  io: CliIo,
): Promise<number> {
  const { name, rest } = splitCommandName(args);
  if (name === undefined) {
    const { values } = parse(rest, GLOBAL_OPTIONS, path, false);
    if (values.version === true) {
      io.stdout(`${await packageVersion()}\n`);
      return EXIT_OK;
    }
    if (values.help === true) {
      io.stdout(groupHelp(group, path));
      return EXIT_OK;
    }
    throw new CliUsageError('missing command', path);
  }
  const command = group.commands.find((candidate) => candidate.name === name);
  if (!command) {
    throw new CliUsageError(`unknown command "${name}"`, path);
  }
  const commandPath = `${path} ${command.name}`;
  return 'commands' in command
    ? dispatch(command, rest, commandPath, io)
    : runLeaf(command, rest, commandPath, io);
}

async function runLeaf(
  command: CliLeafCommand,
  args: readonly string[],
  path: string,
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parse(
    args,
    { ...GLOBAL_OPTIONS, ...command.options },
    path,
    true,
  );
  if (values.version === true) {
    io.stdout(`${await packageVersion()}\n`);
    return EXIT_OK;
  }
  if (values.help === true) {
    io.stdout(commandHelp(command, path));
    return EXIT_OK;
  }
  const cwd = resolve(
    io.cwd,
    typeof values.cwd === 'string' ? values.cwd : '.',
  );
  const logger = (io.createLogger ?? createConsoleLogger)(
    command.logLevel ?? DEFAULT_CLI_LOG_LEVEL,
  );
  try {
    return await command.run({ cwd, positionals, values, io, logger });
  } catch (error) {
    if (error instanceof CliUsageError) {
      error.command ??= path;
    }
    throw error;
  }
}

/**
 * 명령 이름(첫 위치 인자)을 떼어 낸다. 공통 옵션은 명령 이름 앞에 와도 된다
 * 값을 받는 공통 옵션(`--cwd <dir>`)의 값은 명령 이름으로 보지 않는다
 */
function splitCommandName(args: readonly string[]): {
  name?: string;
  rest: string[];
} {
  const valued = new Set(
    Object.entries(GLOBAL_OPTIONS)
      .filter(([, option]) => option.type === 'string')
      .map(([name]) => `--${name}`),
  );
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      break;
    }
    if (!arg.startsWith('-')) {
      return {
        name: arg,
        rest: [...args.slice(0, index), ...args.slice(index + 1)],
      };
    }
    if (valued.has(arg)) {
      index += 1;
    }
  }
  return { rest: [...args] };
}

function parse(
  args: readonly string[],
  options: Readonly<Record<string, CliOption>>,
  path: string,
  allowPositionals: boolean,
): { values: CliOptionValues; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: Object.fromEntries(
        Object.entries(options).map(([name, option]) => [
          name,
          option.short
            ? { type: option.type, short: option.short }
            : { type: option.type },
        ]),
      ),
      allowPositionals,
      strict: true,
    });
    return {
      values: parsed.values as CliOptionValues,
      positionals: parsed.positionals,
    };
  } catch (error) {
    // parseArgs 오류는 첫 문장만 보인다. 뒤 문장은 '--' 쓰는 법 같은 긴 안내다
    throw new CliUsageError(errorMessage(error).split('. ')[0], path);
  }
}

function groupHelp(group: CliCommandGroup, path: string): string {
  const width = Math.max(...group.commands.map((item) => item.name.length));
  return [
    `Usage: ${path} <command> [options]`,
    '',
    ...descriptionLines(group.description ?? [group.summary]),
    'Commands:',
    ...group.commands.map(
      (item) => `  ${item.name.padEnd(width)}  ${item.summary}`,
    ),
    '',
    ...optionLines(GLOBAL_OPTIONS),
    '',
    `Run "${path} <command> --help" for the options of a command.`,
    '',
  ].join('\n');
}

function commandHelp(command: CliLeafCommand, path: string): string {
  return [
    `Usage: ${path} ${command.usage}`,
    '',
    ...descriptionLines(command.description ?? [command.summary]),
    ...optionLines({ ...command.options, ...GLOBAL_OPTIONS }),
    '',
  ].join('\n');
}

function descriptionLines(lines: readonly string[]): string[] {
  return lines.length > 0 ? [...lines, ''] : [];
}

function optionLines(options: Readonly<Record<string, CliOption>>): string[] {
  const flags = Object.entries(options).map(([name, option]) => ({
    flag: [
      option.short ? `-${option.short}, ` : '',
      `--${name}`,
      option.valueName ? ` ${option.valueName}` : '',
    ].join(''),
    description: option.description,
  }));
  const width = Math.max(...flags.map((item) => item.flag.length));
  return [
    'Options:',
    ...flags.map((item) => `  ${item.flag.padEnd(width)}  ${item.description}`),
  ];
}

/** 빌드 결과(`dist/cli/run.js`)와 소스(`src/cli/run.ts`) 모두 두 단계 위에 package.json 이 있다 */
async function packageVersion(): Promise<string> {
  const raw = await readFile(
    new URL('../../package.json', import.meta.url),
    'utf8',
  );
  const { version } = JSON.parse(raw) as { version?: unknown };
  return typeof version === 'string' ? version : 'unknown';
}

function processIo(): CliIo {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
