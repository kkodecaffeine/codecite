// 그래프 설정 파일(codecite.graph.json)을 읽고 검사한다
// 회사·저장소·프레임워크에 묶인 규칙(주소 변수, 프록시 접두어, 패키지 범위, 스키마 위치, 자체 큐·데코레이터)은 코드가 아니라 여기서 받는다
import { readFile, realpath, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  GRAPH_BRANCH_NAME_PATTERN,
  GRAPH_CONFIG_FILE,
  GRAPH_CONFIG_KEYS,
  GRAPH_DEFAULT_CACHE_NAME,
  GRAPH_DEFAULT_EXCLUDES,
  GRAPH_DEFAULT_FOREIGN_KEY_SUFFIXES,
  GRAPH_DEFAULT_OUTPUT,
  GRAPH_DETECTOR_KEYS,
  GRAPH_DETECTOR_KINDS,
  GRAPH_HINT_KEYS,
  GRAPH_REPOSITORY_KEYS,
  GRAPH_REPOSITORY_NAME_PATTERN,
} from './constants.js';
import { validateGlob } from './files.js';
import { parseGroupPattern } from './records.js';
import type {
  GraphConfig,
  GraphConfigFail,
  GraphDetectorKind,
  GraphDetectorRule,
  GraphHints,
  GraphRepositoryConfig,
  LoadGraphConfigOptions,
} from './types.js';

/** 설정 오류. 어느 파일의 어느 항목인지 함께 알려 준다 */
export class GraphConfigError extends Error {
  constructor(
    readonly file: string,
    readonly field: string,
    detail: string,
  ) {
    super(`${file}${field ? ` ${field}` : ''}: ${detail}`);
    this.name = 'GraphConfigError';
  }
}

/**
 * `<cwd>/codecite.graph.json`(또는 options.file)을 읽어 검사하고 기본값을 채운다
 * 설정 안의 상대 경로는 설정 파일이 있는 폴더 기준으로 풀고, path 저장소가 있는지와 결과·캐시 폴더가 그 안에 있지 않은지 본다
 */
export async function loadGraphConfig(
  cwd: string,
  options: LoadGraphConfigOptions = {},
): Promise<GraphConfig> {
  const file = resolve(cwd, options.file ?? GRAPH_CONFIG_FILE);
  const label = basename(file);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new GraphConfigError(
        label,
        '',
        `not found in ${dirname(file)}. Create it with "codecite graph init" or pass the config file path.`,
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new GraphConfigError(
      label,
      '',
      `not valid JSON (${(error as Error).message})`,
    );
  }
  const config = parseGraphConfig(parsed, dirname(file), label);
  await checkLocalPaths(config, label);
  return config;
}

/**
 * 설정 값을 검사하고 기본값을 채운다. 파일을 읽지 않는 순수 함수다
 * 모르는 항목, 이름이 겹치는 저장소, url 과 path 를 함께 주거나 둘 다 비운 저장소, 등록하지 않은 저장소를 가리키는 힌트·묶음은 거절한다
 */
export function parseGraphConfig(
  value: unknown,
  cwd: string,
  label = GRAPH_CONFIG_FILE,
): GraphConfig {
  const fail: GraphConfigFail = (field, detail) => {
    throw new GraphConfigError(label, field, detail);
  };
  const root = requireObject(value, '', fail);
  rejectUnknownKeys(root, GRAPH_CONFIG_KEYS, '', fail);

  const base = resolve(cwd);
  const output = resolve(
    base,
    optionalText(root.output, 'output', fail) ?? GRAPH_DEFAULT_OUTPUT,
  );
  const cacheSetting = optionalText(root.cache, 'cache', fail);
  const cache = cacheSetting
    ? resolve(base, cacheSetting)
    : join(dirname(output), GRAPH_DEFAULT_CACHE_NAME);

  if (!Array.isArray(root.repositories) || root.repositories.length === 0) {
    fail('repositories', 'must be a non-empty array');
  }
  const repositories = (root.repositories as unknown[]).map((item, index) =>
    parseRepository(item, `repositories[${index}]`, base, fail),
  );
  const names = new Set<string>();
  const locations = new Map<string, string>();
  for (const [index, repository] of repositories.entries()) {
    if (names.has(repository.name)) {
      fail(
        `repositories[${index}].name`,
        `duplicate repository name ${repository.name}`,
      );
    }
    names.add(repository.name);
    const location = repository.url ?? repository.path ?? '';
    const owner = locations.get(location);
    if (owner) {
      fail(
        `repositories[${index}]`,
        `${repository.name} points to the same repository as ${owner}`,
      );
    }
    locations.set(location, repository.name);
  }

  const maxUnresolvedRatio =
    root.maxUnresolvedRatio === undefined
      ? undefined
      : requireRatio(root.maxUnresolvedRatio, 'maxUnresolvedRatio', fail);
  const manualLinks = optionalText(root.manualLinks, 'manualLinks', fail);
  return {
    cwd: base,
    output,
    cache,
    repositories,
    defaultExcludes:
      root.defaultExcludes === undefined
        ? [...GRAPH_DEFAULT_EXCLUDES]
        : requireGlobs(root.defaultExcludes, 'defaultExcludes', fail),
    presets: optionalTextArray(root.presets, 'presets', fail) ?? [],
    hints: parseHints(root.hints, names, fail),
    detectors: parseDetectors(root.detectors, fail),
    entities: parseEntities(root.entities, fail),
    groups: parseGroups(root.groups, names, fail),
    ...(manualLinks ? { manualLinks: resolve(base, manualLinks) } : {}),
    extractorModules: (
      optionalTextArray(root.extractorModules, 'extractorModules', fail) ?? []
    ).map((path) => resolve(base, path)),
    presetModules: (
      optionalTextArray(root.presetModules, 'presetModules', fail) ?? []
    ).map((path) => resolve(base, path)),
    ...(maxUnresolvedRatio !== undefined ? { maxUnresolvedRatio } : {}),
  };
}

function parseRepository(
  value: unknown,
  field: string,
  base: string,
  fail: GraphConfigFail,
): GraphRepositoryConfig {
  const entry = requireObject(value, field, fail);
  rejectUnknownKeys(entry, GRAPH_REPOSITORY_KEYS, field, fail);
  const name = requireText(entry.name, `${field}.name`, fail);
  if (!GRAPH_REPOSITORY_NAME_PATTERN.test(name)) {
    fail(
      `${field}.name`,
      `${name} must use letters, digits, ".", "_" or "-" and start with a letter or digit`,
    );
  }
  const url = optionalText(entry.url, `${field}.url`, fail);
  const path = optionalText(entry.path, `${field}.path`, fail);
  if ((url === undefined) === (path === undefined)) {
    fail(field, `${name} needs exactly one of url or path`);
  }
  if (url !== undefined && (url.startsWith('-') || /[\s\0]/.test(url))) {
    fail(`${field}.url`, 'must not start with "-" or contain spaces');
  }
  const defaultBranch = optionalText(
    entry.defaultBranch,
    `${field}.defaultBranch`,
    fail,
  );
  if (defaultBranch !== undefined && !isPlainBranchName(defaultBranch)) {
    fail(
      `${field}.defaultBranch`,
      `${defaultBranch} is not a plain branch name`,
    );
  }
  const include =
    entry.include === undefined
      ? undefined
      : requireGlobs(entry.include, `${field}.include`, fail);
  const exclude =
    entry.exclude === undefined
      ? undefined
      : requireGlobs(entry.exclude, `${field}.exclude`, fail);
  return {
    name,
    ...(url !== undefined ? { url } : {}),
    ...(path !== undefined ? { path: resolve(base, path) } : {}),
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
  };
}

function parseHints(
  value: unknown,
  names: ReadonlySet<string>,
  fail: GraphConfigFail,
): GraphHints {
  if (value === undefined) {
    return {};
  }
  const hints = requireObject(value, 'hints', fail);
  rejectUnknownKeys(hints, GRAPH_HINT_KEYS, 'hints', fail);
  const result: GraphHints = {};
  for (const key of ['baseUrls', 'proxyPrefixes', 'packages'] as const) {
    if (hints[key] !== undefined) {
      result[key] = requireRepositoryMap(
        hints[key],
        `hints.${key}`,
        names,
        fail,
      );
    }
  }
  if (hints.graphqlSchemas !== undefined) {
    const schemas = requireObject(
      hints.graphqlSchemas,
      'hints.graphqlSchemas',
      fail,
    );
    result.graphqlSchemas = {};
    for (const [schema, item] of Object.entries(schemas)) {
      const field = `hints.graphqlSchemas.${schema}`;
      const entry = requireObject(item, field, fail);
      rejectUnknownKeys(entry, ['repository', 'paths'], field, fail);
      const repository = requireText(
        entry.repository,
        `${field}.repository`,
        fail,
      );
      requireKnownRepository(repository, `${field}.repository`, names, fail);
      result.graphqlSchemas[schema] = {
        repository,
        ...(entry.paths !== undefined
          ? { paths: requireGlobs(entry.paths, `${field}.paths`, fail) }
          : {}),
      };
    }
  }
  if (hints.external !== undefined) {
    result.external = optionalTextArray(hints.external, 'hints.external', fail);
  }
  return result;
}

function parseDetectors(
  value: unknown,
  fail: GraphConfigFail,
): GraphDetectorRule[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return fail('detectors', 'must be an array');
  }
  return value.map((item, index) => {
    const field = `detectors[${index}]`;
    const entry = requireObject(item, field, fail);
    rejectUnknownKeys(entry, GRAPH_DETECTOR_KEYS, field, fail);
    const kind = requireText(entry.kind, `${field}.kind`, fail);
    if (!GRAPH_DETECTOR_KINDS.includes(kind as GraphDetectorKind)) {
      fail(
        `${field}.kind`,
        `must be one of ${GRAPH_DETECTOR_KINDS.join(', ')}`,
      );
    }
    const call = optionalText(entry.call, `${field}.call`, fail);
    const decorator = optionalText(entry.decorator, `${field}.decorator`, fail);
    if (call === undefined && decorator === undefined) {
      fail(field, 'needs call or decorator');
    }
    const nameArgument = entry.nameArgument;
    if (
      nameArgument !== undefined &&
      (!Number.isInteger(nameArgument) || (nameArgument as number) < 0)
    ) {
      fail(`${field}.nameArgument`, 'must be a non-negative integer');
    }
    return {
      kind: kind as GraphDetectorKind,
      ...(call !== undefined ? { call } : {}),
      ...(decorator !== undefined ? { decorator } : {}),
      ...(nameArgument !== undefined
        ? { nameArgument: nameArgument as number }
        : {}),
    };
  });
}

function parseEntities(
  value: unknown,
  fail: GraphConfigFail,
): GraphConfig['entities'] {
  if (value === undefined) {
    return { foreignKeySuffixes: [...GRAPH_DEFAULT_FOREIGN_KEY_SUFFIXES] };
  }
  const entities = requireObject(value, 'entities', fail);
  rejectUnknownKeys(entities, ['foreignKeySuffixes'], 'entities', fail);
  return {
    foreignKeySuffixes: optionalTextArray(
      entities.foreignKeySuffixes,
      'entities.foreignKeySuffixes',
      fail,
    ) ?? [...GRAPH_DEFAULT_FOREIGN_KEY_SUFFIXES],
  };
}

function parseGroups(
  value: unknown,
  names: ReadonlySet<string>,
  fail: GraphConfigFail,
): Record<string, string[]> {
  if (value === undefined) {
    return {};
  }
  const groups = requireObject(value, 'groups', fail);
  const result: Record<string, string[]> = {};
  for (const [group, patterns] of Object.entries(groups)) {
    const field = `groups.${group}`;
    if (group.trim() === '') {
      fail('groups', 'group names must not be empty');
    }
    const list = optionalTextArray(patterns, field, fail) ?? [];
    for (const pattern of list) {
      const parsed = parseGroupPattern(pattern);
      if (!parsed) {
        fail(field, `${pattern} must look like <repository>:<path glob>`);
      } else {
        requireKnownRepository(parsed.repository, field, names, fail);
        checkGlob(parsed.glob, field, fail);
      }
    }
    result[group] = list;
  }
  return result;
}

/** path 저장소가 있는 폴더인지, 같은 저장소를 두 번 적지 않았는지, 결과·캐시 폴더가 그 안에 있지 않은지 본다 */
async function checkLocalPaths(
  config: GraphConfig,
  label: string,
): Promise<void> {
  const seen = new Map<string, string>();
  const repositoryRoots: Array<{ name: string; root: string }> = [];
  for (const [index, repository] of config.repositories.entries()) {
    if (!repository.path) {
      continue;
    }
    const field = `repositories[${index}].path`;
    let root: string;
    try {
      root = await realpath(repository.path);
      if (!(await stat(root)).isDirectory()) {
        throw new Error('not a directory');
      }
    } catch {
      throw new GraphConfigError(
        label,
        field,
        `${repository.name}: ${repository.path} is not an existing folder`,
      );
    }
    const owner = seen.get(root);
    if (owner) {
      throw new GraphConfigError(
        label,
        field,
        `${repository.name} points to the same folder as ${owner}`,
      );
    }
    seen.set(root, repository.name);
    repositoryRoots.push({ name: repository.name, root });
  }
  for (const [field, folder] of [
    ['output', config.output],
    ['cache', config.cache],
  ] as const) {
    const resolved = await realpathOfNearest(folder);
    for (const { name, root } of repositoryRoots) {
      if (isSameOrInside(root, resolved)) {
        throw new GraphConfigError(
          label,
          field,
          `${folder} is inside repository ${name}. Source repositories are read-only; put ${field} outside them.`,
        );
      }
    }
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  fail: GraphConfigFail,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(
        field ? `${field}.${key}` : key,
        `unknown setting. Allowed: ${allowed.join(', ')}`,
      );
    }
  }
}

function requireObject(
  value: unknown,
  field: string,
  fail: GraphConfigFail,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function requireText(
  value: unknown,
  field: string,
  fail: GraphConfigFail,
): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail(field, 'must be a non-empty string');
  }
  return value;
}

function optionalText(
  value: unknown,
  field: string,
  fail: GraphConfigFail,
): string | undefined {
  return value === undefined ? undefined : requireText(value, field, fail);
}

function optionalTextArray(
  value: unknown,
  field: string,
  fail: GraphConfigFail,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return fail(field, 'must be an array of strings');
  }
  return value.map((item, index) =>
    requireText(item, `${field}[${index}]`, fail),
  );
}

function requireGlobs(
  value: unknown,
  field: string,
  fail: GraphConfigFail,
): string[] {
  const globs = optionalTextArray(value, field, fail) ?? [];
  for (const [index, glob] of globs.entries()) {
    checkGlob(glob, `${field}[${index}]`, fail);
  }
  return globs;
}

function checkGlob(glob: string, field: string, fail: GraphConfigFail): void {
  try {
    validateGlob(glob);
  } catch (error) {
    fail(field, (error as Error).message);
  }
}

function requireRepositoryMap(
  value: unknown,
  field: string,
  names: ReadonlySet<string>,
  fail: GraphConfigFail,
): Record<string, string> {
  const map = requireObject(value, field, fail);
  const result: Record<string, string> = {};
  for (const [key, repository] of Object.entries(map)) {
    if (key.trim() === '') {
      fail(field, 'keys must not be empty');
    }
    const name = requireText(repository, `${field}.${key}`, fail);
    requireKnownRepository(name, `${field}.${key}`, names, fail);
    result[key] = name;
  }
  return result;
}

function requireKnownRepository(
  name: string,
  field: string,
  names: ReadonlySet<string>,
  fail: GraphConfigFail,
): void {
  if (!names.has(name)) {
    fail(field, `repository ${name} is not in repositories`);
  }
}

function requireRatio(
  value: unknown,
  field: string,
  fail: GraphConfigFail,
): number {
  if (typeof value !== 'number' || !(value >= 0 && value <= 1)) {
    return fail(field, 'must be a number from 0 to 1');
  }
  return value;
}

/** git 이 받는 평범한 브랜치 이름인지. 옵션처럼 보이는 이름, 상위 경로, 숨김 조각은 막는다 */
function isPlainBranchName(branch: string): boolean {
  return (
    GRAPH_BRANCH_NAME_PATTERN.test(branch) &&
    !branch.startsWith('-') &&
    !branch.includes('..') &&
    !branch.endsWith('.') &&
    branch
      .split('/')
      .every(
        (part) =>
          part !== '' && !part.startsWith('.') && !part.endsWith('.lock'),
      )
  );
}

/** 아직 없는 폴더는 있는 가장 가까운 위 폴더의 실제 경로에 나머지를 붙인다(심볼릭 링크로 저장소 안을 가리키는 경우를 잡으려고) */
async function realpathOfNearest(folder: string): Promise<string> {
  const rest: string[] = [];
  let current = folder;
  for (;;) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return folder;
      }
      rest.push(basename(current));
      current = parent;
    }
  }
}

function isSameOrInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}
