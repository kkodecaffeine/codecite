// `codecite graph` 명령 묶음. 그래프 모듈은 명령을 돌릴 때만 불러, 답변 엔진 명령은 그래프 도구를 읽지 않는다
import { access, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import {
  EXIT_OK,
  GRAPH_INIT_NODE_BASE_PRESETS,
  GRAPH_INIT_NODE_PRESETS,
  GRAPH_INIT_PLACEHOLDER_REPOSITORY,
  GRAPH_INIT_PYTHON_FILES,
  GRAPH_INIT_PYTHON_PRESETS,
} from './constants.js';
import { CliUsageError } from './errors.js';
import type {
  CliCommandGroup,
  CliContext,
  CliLeafCommand,
  CliOption,
} from './types.js';

const CONFIG_OPTION: CliOption = {
  type: 'string',
  valueName: '<file>',
  description:
    'Graph config file, relative to --cwd (default: codecite.graph.json)',
};

/** `codecite graph init`: 저장소 목록으로 codecite.graph.json 뼈대를 만들고, 받아 둔 저장소의 의존성으로 프리셋을 고른다 */
export const graphInitCommand: CliLeafCommand = {
  name: 'init',
  summary: 'Write a codecite.graph.json skeleton for your repositories',
  usage: '[<repository>...] [--force]',
  description: [
    'Each <repository> is a local clone path or a git URL. Local clones are read from',
    'the remote-tracking default branch at build time, never from the working tree.',
    'For local clones, presets are picked from package.json and Python dependency files.',
    'Without arguments it writes a placeholder repository to edit by hand.',
  ],
  options: {
    config: CONFIG_OPTION,
    force: {
      type: 'boolean',
      description: 'Overwrite an existing config file',
    },
  },
  async run(context) {
    const file = configPath(context);
    if (context.values.force !== true && (await exists(file))) {
      throw new Error(
        `${relative(context.cwd, file) || file} already exists; pass --force to overwrite it.`,
      );
    }
    const repositories =
      context.positionals.length > 0
        ? uniqueNames(
            context.positionals.map((target) =>
              repositoryEntry(target, context.cwd),
            ),
          )
        : [{ ...GRAPH_INIT_PLACEHOLDER_REPOSITORY }];
    const presets = new Set<string>();
    const unread: string[] = [];
    for (const repository of repositories) {
      if (context.positionals.length === 0) {
        break;
      }
      if (repository.path === undefined) {
        unread.push(repository.name);
        continue;
      }
      for (const preset of await detectPresets(
        resolve(context.cwd, repository.path),
      )) {
        presets.add(preset);
      }
    }
    const config = {
      repositories,
      presets: [...presets].sort(),
    };
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
    const lines = [
      `Wrote ${relative(context.cwd, file) || file} with ${repositories.length} repositories.`,
      `Presets: ${config.presets.length > 0 ? config.presets.join(', ') : '(none)'}`,
    ];
    if (context.positionals.length === 0) {
      lines.push(
        'Replace the placeholder repository, then run "codecite graph build".',
      );
    }
    if (unread.length > 0) {
      lines.push(
        `Could not read dependencies of ${unread.join(', ')} (URL only); add their presets by hand.`,
      );
    }
    context.io.stdout(`${lines.join('\n')}\n`);
    return EXIT_OK;
  },
};

/** `codecite graph build`: 원격 기본 브랜치 커밋을 읽어 심볼·탐지·토폴로지 결과 파일을 쓴다 */
export const graphBuildCommand: CliLeafCommand = {
  name: 'build',
  summary: 'Snapshot, extract, detect and link; write the graph output',
  usage: '[--config <file>] [--accept-symbol-drop <names>]',
  description: [
    'Reads the default branch commit of every repository (never a working tree),',
    'extracts symbols, runs the presets, and writes the output folder.',
    'A repository whose commit and inputs did not change reuses its last result.',
    'TypeScript/JavaScript repositories need the "typescript" package; Python ones need python3.',
  ],
  logLevel: 'info',
  options: {
    config: CONFIG_OPTION,
    'accept-symbol-drop': {
      type: 'string',
      valueName: '<names>',
      description:
        'Comma-separated repositories allowed to lose more than half their symbols (check why first)',
    },
  },
  async run(context) {
    rejectPositionals(context);
    const graph = await import('../graph/index.js');
    const config = await graph.loadGraphConfig(context.cwd, {
      file: configPath(context),
    });
    const accept = splitList(context.values['accept-symbol-drop']);
    const result = await graph.buildCodeGraph(config, {
      logger: context.logger,
      ...(accept.length > 0 ? { acceptSymbolDrop: accept } : {}),
    });
    const rows = result.manifest.repositories.map((repository) => [
      repository.name,
      `${repository.branch}@${repository.commitSha.slice(0, 7)}`,
      `${repository.symbolCount} symbols`,
      `${repository.fileCount} files`,
      result.reused[repository.name] ? 'reused' : 'built',
      repository.failures.length > 0
        ? `${repository.failures.length} skipped`
        : '',
    ]);
    context.io.stdout(
      `${formatTable(rows)}Wrote ${result.files.length} files to ${displayPath(context.cwd, result.output)} in ${(result.durationMs / 1000).toFixed(1)}s\n`,
    );
    return EXIT_OK;
  },
};

export const graphCommand: CliCommandGroup = {
  name: 'graph',
  summary: 'Build a call and relation graph across your repositories',
  description: [
    'Reads codecite.graph.json (see "codecite graph init") and writes the graph output folder.',
  ],
  commands: [graphInitCommand, graphBuildCommand],
};

function configPath(context: CliContext): string {
  const value = context.values.config;
  return resolve(
    context.cwd,
    typeof value === 'string' ? value : 'codecite.graph.json',
  );
}

function repositoryEntry(
  target: string,
  cwd: string,
): { name: string; url?: string; path?: string } {
  const name = repositoryName(target);
  if (isGitUrl(target)) {
    return { name, url: target };
  }
  const absolute = resolve(cwd, target);
  const path = relative(cwd, absolute) || '.';
  return { name, path: isAbsolute(path) ? absolute : path };
}

function isGitUrl(target: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^[^/\s]+@[^:\s]+:/.test(target)
  );
}

/** 경로나 주소의 마지막 마디에서 `.git` 을 뗀 이름. 설정 이름 규칙에 맞지 않는 글자는 `-` 로 바꾼다 */
function repositoryName(target: string): string {
  const last = basename(target.replace(/[/\\]+$/, '').replace(/:$/, ''))
    .replace(/\.git$/i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '');
  if (!last) {
    throw new CliUsageError(`cannot name a repository from "${target}"`);
  }
  return last.slice(0, 100);
}

/** 같은 이름이 나오면 뒤에 번호를 붙인다(`api`, `api-2`) */
function uniqueNames<T extends { name: string }>(entries: T[]): T[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const count = (seen.get(entry.name) ?? 0) + 1;
    seen.set(entry.name, count);
    return count === 1 ? entry : { ...entry, name: `${entry.name}-${count}` };
  });
}

/** 받아 둔 저장소의 의존성 파일을 보고 켤 프리셋을 고른다. 파일을 못 읽으면 고르지 않는다 */
export async function detectPresets(root: string): Promise<string[]> {
  const presets = new Set<string>();
  const pkg = await readJson(join(root, 'package.json'));
  if (pkg) {
    for (const preset of GRAPH_INIT_NODE_BASE_PRESETS) {
      presets.add(preset);
    }
    const names = [
      ...Object.keys(objectField(pkg, 'dependencies')),
      ...Object.keys(objectField(pkg, 'devDependencies')),
      ...Object.keys(objectField(pkg, 'peerDependencies')),
    ];
    for (const name of names) {
      const preset = GRAPH_INIT_NODE_PRESETS[name];
      if (preset) {
        presets.add(preset);
      }
    }
  }
  for (const file of GRAPH_INIT_PYTHON_FILES) {
    const text = await readText(join(root, file));
    if (text === undefined) {
      continue;
    }
    for (const name of pythonDependencyNames(text)) {
      const preset = GRAPH_INIT_PYTHON_PRESETS[name];
      if (preset) {
        presets.add(preset);
      }
    }
  }
  return [...presets].sort();
}

/** 의존성 파일에서 패키지 이름처럼 보이는 낱말을 모은다. 버전·추가 기능 표기(`celery[redis]>=5`)는 떼고 소문자로 맞춘다 */
function pythonDependencyNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(
    /(?:^|["'\s,[])([A-Za-z][A-Za-z0-9_.-]*)(?=\s*(?:\[|[<>=!~;]|["',\]]|$))/gm,
  )) {
    names.add(match[1].toLowerCase().replace(/_/g, '-'));
  }
  return names;
}

function objectField(value: unknown, key: string): Record<string, unknown> {
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === 'object' && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : {};
}

async function readJson(file: string): Promise<unknown> {
  const text = await readText(file);
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function splitList(value: string | boolean | undefined): string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function rejectPositionals(context: CliContext): void {
  if (context.positionals.length > 0) {
    throw new CliUsageError(`unexpected argument "${context.positionals[0]}"`);
  }
}

function displayPath(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}

/** 칸 너비를 맞춘 표. 빈 칸은 줄 끝 공백을 남기지 않는다 */
function formatTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) {
    return '';
  }
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  return rows
    .map(
      (row) =>
        `${row
          .map((cell, column) => cell.padEnd(widths[column]))
          .join('  ')
          .trimEnd()}\n`,
    )
    .join('');
}
