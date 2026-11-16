// 그래프 만들기 파이프라인. 지금은 스냅샷 → 파일 고르기 → 추출 → 레코드 → 결과 파일까지 한다
// 탐지·저장소 안 토폴로지·저장소 간 연결·엔티티·필드 쓰기·보고서 단계는 buildCodeGraph 안의 표시한 자리에 더한다
import { readFile, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../ports.js';
import {
  GRAPH_FAILURE_MESSAGE_MAX_CHARS,
  GRAPH_FLOOR_EXCLUDES,
  GRAPH_OUTPUT_FORMAT,
  GRAPH_SCHEMA_VERSION,
  GRAPH_TOOL_NAME,
  SILENT_LOGGER,
} from './constants.js';
import {
  compareText,
  matchingExtension,
  readSourceFiles,
  selectSourceFiles,
} from './files.js';
import {
  assertNoSymbolCollapse,
  fingerprint,
  readGraphManifest,
  readRepositorySymbols,
  symbolsFilePath,
  writeGraphOutputs,
} from './output.js';
import { buildRepositoryRecords, parseGroupPattern } from './records.js';
import { scrubMessage } from './redaction.js';
import {
  listTrackedFiles,
  resolveRepositoryHead,
  SnapshotWorkspace,
} from './snapshot.js';
import type {
  BuildCodeGraphOptions,
  CodeGraphBuildResult,
  ExtractedSymbol,
  ExtractionFailure,
  GraphBuildState,
  GraphConfig,
  GraphManifest,
  GraphRepositoryConfig,
  RepositoryBuild,
  RepositoryBuildContext,
  SourceFile,
  SymbolExtractor,
} from './types.js';

/**
 * 설정의 저장소로 코드 그래프를 만들어 결과 폴더에 쓴다
 * - 저장소마다 원격 기본 브랜치 커밋을 정하고, 지난 결과와 커밋·입력 지문이 같으면 꺼내지 않고 재사용한다
 * - 바뀐 저장소만 임시 폴더에 꺼내, 고른 파일을 확장자로 추출기에 나눠 넘긴다. 추출기가 없으면 빈 결과를 쓴다
 * - 심볼 수가 지난번의 절반 아래로 줄면 아무것도 쓰지 않고 멈춘다
 * 임시 폴더는 성공·실패와 상관없이 지운다
 */
export async function buildCodeGraph(
  config: GraphConfig,
  options: BuildCodeGraphOptions = {},
): Promise<CodeGraphBuildResult> {
  const logger = options.logger ?? SILENT_LOGGER;
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  const extractors = [
    ...(options.extractors ?? []),
    ...(await loadExtractorModules(config)),
  ];
  const routes = extractorRoutes(extractors);
  const toolVersion = await readToolVersion();
  const previous = await readPreviousManifest(config.output, logger);
  const localRoots = await localPathRoots(config);
  const workspace = await SnapshotWorkspace.create();
  localRoots.push(workspace.root);
  try {
    const repositories: RepositoryBuild[] = [];
    for (const repository of [...config.repositories].sort((left, right) =>
      compareText(left.name, right.name),
    )) {
      const startedRepository = now().getTime();
      const build = await buildRepository(repository, {
        config,
        extractors,
        routes,
        toolVersion,
        previous: previous?.repositories.find(
          (entry) => entry.name === repository.name,
        ),
        workspace,
        localRoots,
        logger,
        acceptSymbolDrop: options.acceptSymbolDrop ?? [],
      });
      logger.info('graph repository built', {
        repository: repository.name,
        commit: build.manifest.commitSha,
        reused: build.snapshot.reused,
        files: build.manifest.fileCount,
        symbols: build.manifest.symbolCount,
        failures: build.manifest.failures.length,
        durationMs: now().getTime() - startedRepository,
      });
      repositories.push(build);
    }
    const state: GraphBuildState = {
      config,
      repositories,
      records: repositories.flatMap((build) => build.records),
      artifacts: new Map(),
    };

    // ── 탐지와 저장소 안 토폴로지가 여기에 단계를 더한다 ──
    // state.records(와 꺼낸 저장소는 snapshot.root)를 읽어 계약을 찾고, state.artifacts 에 topology.json 을 넣는다
    // ── 저장소 간 연결·엔티티·필드 쓰기·보고서가 그 뒤에 단계를 더한다 ──
    // cross-repository.json, entities.json, field-writers.json, report.json 을 state.artifacts 에 넣는다

    const manifest = buildManifest(config, repositories, toolVersion);
    const files = await writeGraphOutputs(config.output, {
      manifest,
      symbols: new Map(
        repositories.map((build) => [build.manifest.name, build.records]),
      ),
      artifacts: state.artifacts,
    });
    logger.info('graph written', {
      repositories: repositories.length,
      symbols: state.records.length,
      files: files.length,
    });
    return {
      output: config.output,
      manifest,
      reused: Object.fromEntries(
        repositories.map((build) => [
          build.manifest.name,
          build.snapshot.reused,
        ]),
      ),
      records: state.records,
      files,
      durationMs: now().getTime() - startedAt,
    };
  } finally {
    await workspace.dispose();
  }
}

/** 저장소 하나를 만든다. 지난 결과를 재사용할 수 있으면 꺼내지 않는다 */
async function buildRepository(
  repository: GraphRepositoryConfig,
  context: RepositoryBuildContext,
): Promise<RepositoryBuild> {
  const { config, previous, logger } = context;
  const name = repository.name;
  const head = await resolveRepositoryHead(repository);
  const inputFingerprint = repositoryFingerprint(
    repository,
    config,
    context.extractors,
    context.toolVersion,
  );
  if (
    previous &&
    previous.commitSha === head.commitSha &&
    previous.inputFingerprint === inputFingerprint
  ) {
    const records = await readRepositorySymbols(config.output, name).catch(
      (error: unknown) => {
        logger.warn('graph previous symbols unreadable; rebuilding', {
          repository: name,
          error: (error as Error).message,
        });
        return undefined;
      },
    );
    if (records && records.length === previous.symbolCount) {
      return {
        snapshot: {
          repository: name,
          branch: head.branch,
          commitSha: head.commitSha,
          committedAt: previous.committedAt,
          reused: true,
        },
        manifest: { ...previous, branch: head.branch },
        records,
      };
    }
  }

  const snapshot = await context.workspace.checkout(
    repository,
    head,
    config.cache,
  );
  const root = snapshot.root ?? '';
  const selection = selectSourceFiles(await listTrackedFiles(root, name), {
    include: repository.include,
    exclude: repository.exclude,
    defaultExcludes: config.defaultExcludes,
    extensions: [...context.routes.keys()],
  });
  const read = await readSourceFiles(root, name, selection.selected);
  const skippedFiles = { ...selection.skipped, ...read.skipped };
  if (context.routes.size > 0 && read.files.length === 0) {
    logger.warn('graph repository has no files to extract', {
      repository: name,
      ...skippedFiles,
    });
  }
  const extracted = await runExtractors(
    name,
    read.files,
    context.extractors,
    context.routes,
    logger,
  );
  const built = buildRepositoryRecords(extracted.symbols, {
    repository: name,
    commitSha: snapshot.commitSha,
    committedAt: snapshot.committedAt,
    groups: config.groups,
  });
  assertNoSymbolCollapse(
    name,
    previous?.symbolCount,
    built.records.length,
    context.acceptSymbolDrop,
  );
  const roots = [root, ...context.localRoots];
  const failures = [...extracted.failures, ...built.failures]
    .map((failure) => cleanFailure(failure, roots))
    .sort(
      (left, right) =>
        compareText(left.filePath, right.filePath) ||
        compareText(left.message, right.message),
    );
  return {
    snapshot,
    manifest: {
      name,
      branch: snapshot.branch,
      commitSha: snapshot.commitSha,
      committedAt: snapshot.committedAt,
      inputFingerprint,
      symbolsFile: symbolsFilePath(name),
      symbolCount: built.records.length,
      fileCount: read.files.length,
      skippedFiles,
      failures,
    },
    records: built.records,
    extracted: extracted.symbols,
  };
}

/**
 * 파일을 확장자로 나눠 추출기마다 한 번씩 부른다(하위 프로세스를 쓰는 추출기도 저장소마다 한 번 뜬다)
 * 추출기가 throw 하면(도구가 없을 때 등) 저장소와 추출기 이름을 붙여 멈춘다. 파일 하나의 구문 오류는 추출기가 failures 로 돌려준다
 */
async function runExtractors(
  repository: string,
  files: readonly SourceFile[],
  extractors: readonly SymbolExtractor[],
  routes: ReadonlyMap<string, SymbolExtractor>,
  logger: Logger,
): Promise<{ symbols: ExtractedSymbol[]; failures: ExtractionFailure[] }> {
  const groups = new Map<SymbolExtractor, SourceFile[]>();
  const extensions = [...routes.keys()];
  for (const file of files) {
    const extension = matchingExtension(file.filePath, extensions);
    const extractor = extension ? routes.get(extension) : undefined;
    if (extractor) {
      groups.set(extractor, [...(groups.get(extractor) ?? []), file]);
    }
  }
  const symbols: ExtractedSymbol[] = [];
  const failures: ExtractionFailure[] = [];
  for (const extractor of extractors) {
    const group = groups.get(extractor);
    if (!group || group.length === 0) {
      continue;
    }
    let result: Awaited<ReturnType<SymbolExtractor['extract']>>;
    try {
      result = await extractor.extract(group, { repository, logger });
    } catch (error) {
      throw new Error(
        `Repository ${repository}: extractor ${extractor.name} failed: ${(error as Error).message}`,
        { cause: error },
      );
    }
    if (!Array.isArray(result?.symbols) || !Array.isArray(result?.failures)) {
      throw new Error(
        `Repository ${repository}: extractor ${extractor.name} must return { symbols, failures }`,
      );
    }
    const given = new Set(group.map((file) => file.filePath));
    for (const symbol of result.symbols) {
      if (!given.has(symbol?.filePath)) {
        throw new Error(
          `Repository ${repository}: extractor ${extractor.name} returned a symbol for ${String(symbol?.filePath)}, which it was not given`,
        );
      }
    }
    symbols.push(...result.symbols);
    failures.push(...result.failures);
  }
  return { symbols, failures };
}

/** 확장자(소문자) → 추출기. 이름이 겹치거나 같은 확장자를 둘이 맡으면 어느 쪽을 쓸지 모르므로 멈춘다 */
function extractorRoutes(
  extractors: readonly SymbolExtractor[],
): Map<string, SymbolExtractor> {
  const names = new Set<string>();
  const routes = new Map<string, SymbolExtractor>();
  for (const extractor of extractors) {
    if (!isSymbolExtractor(extractor)) {
      throw new Error(
        'extractor must have name, extensions (".ts" style) and extract()',
      );
    }
    if (names.has(extractor.name)) {
      throw new Error(`two extractors are named ${extractor.name}`);
    }
    names.add(extractor.name);
    for (const extension of extractor.extensions) {
      const key = extension.toLowerCase();
      const owner = routes.get(key);
      if (owner) {
        throw new Error(
          `extension ${extension} is claimed by both ${owner.name} and ${extractor.name}`,
        );
      }
      routes.set(key, extractor);
    }
  }
  return routes;
}

/** 설정 extractorModules 의 모듈을 불러온다. 기본 내보내기(추출기 하나나 배열)나 extractors·extractor 이름 내보내기를 받는다 */
async function loadExtractorModules(
  config: GraphConfig,
): Promise<SymbolExtractor[]> {
  const extractors: SymbolExtractor[] = [];
  for (const modulePath of config.extractorModules) {
    const display = portablePath(config.cwd, modulePath);
    let loaded: Record<string, unknown>;
    try {
      loaded = (await import(pathToFileURL(modulePath).href)) as Record<
        string,
        unknown
      >;
    } catch (error) {
      throw new Error(
        `extractor module ${display} could not be loaded: ${(error as Error).message}`,
        { cause: error },
      );
    }
    const exported = loaded.default ?? loaded.extractors ?? loaded.extractor;
    const list = Array.isArray(exported) ? exported : [exported];
    for (const candidate of list) {
      if (!isSymbolExtractor(candidate)) {
        throw new Error(
          `extractor module ${display} must export a SymbolExtractor (name, extensions, extract)`,
        );
      }
      extractors.push(candidate);
    }
  }
  return extractors;
}

function isSymbolExtractor(value: unknown): value is SymbolExtractor {
  const candidate = value as Partial<SymbolExtractor> | undefined;
  return (
    typeof candidate?.name === 'string' &&
    candidate.name.trim() !== '' &&
    Array.isArray(candidate.extensions) &&
    candidate.extensions.length > 0 &&
    candidate.extensions.every(
      (extension) =>
        typeof extension === 'string' && /^\.[A-Za-z0-9.+_-]+$/.test(extension),
    ) &&
    typeof candidate.extract === 'function'
  );
}

/**
 * 저장소 결과를 만든 입력의 지문. 커밋이 같아도 이 값이 다르면 다시 만든다
 * 도구 판·결과 형식·파일 고르기 규칙·이 저장소에 걸린 정책 묶음·추출기 이름과 확장자를 넣는다
 */
function repositoryFingerprint(
  repository: GraphRepositoryConfig,
  config: GraphConfig,
  extractors: readonly SymbolExtractor[],
  toolVersion: string,
): string {
  const groups = Object.entries(config.groups)
    .map(([group, patterns]) => [
      group,
      patterns.filter(
        (pattern) => parseGroupPattern(pattern)?.repository === repository.name,
      ),
    ])
    .filter(([, patterns]) => patterns.length > 0);
  return fingerprint({
    format: GRAPH_OUTPUT_FORMAT,
    tool: toolVersion,
    repository: repository.name,
    include: repository.include ?? [],
    exclude: repository.exclude ?? [],
    defaultExcludes: config.defaultExcludes,
    floor: GRAPH_FLOOR_EXCLUDES,
    groups,
    extractors: extractors
      .map((extractor) => ({
        name: extractor.name,
        extensions: [...extractor.extensions].sort(compareText),
      }))
      .sort((left, right) => compareText(left.name, right.name)),
  });
}

/** 설정 지문. 로컬 경로는 설정 폴더 기준 상대 경로로, 주소의 계정 정보는 빼서 만든 컴퓨터와 상관없게 한다 */
function configFingerprint(config: GraphConfig): string {
  return fingerprint({
    format: GRAPH_OUTPUT_FORMAT,
    repositories: [...config.repositories]
      .sort((left, right) => compareText(left.name, right.name))
      .map((repository) => ({
        name: repository.name,
        url: repository.url?.replace(
          /^([a-z][a-z0-9+.-]{0,30}:\/\/)[^@/]*@/i,
          '$1',
        ),
        path: repository.path
          ? portablePath(config.cwd, repository.path)
          : undefined,
        defaultBranch: repository.defaultBranch,
        include: repository.include,
        exclude: repository.exclude,
      })),
    defaultExcludes: config.defaultExcludes,
    presets: config.presets,
    hints: config.hints,
    detectors: config.detectors,
    entities: config.entities,
    groups: config.groups,
    manualLinks: config.manualLinks
      ? portablePath(config.cwd, config.manualLinks)
      : undefined,
    extractorModules: config.extractorModules.map((path) =>
      portablePath(config.cwd, path),
    ),
    presetModules: config.presetModules.map((path) =>
      portablePath(config.cwd, path),
    ),
    maxUnresolvedRatio: config.maxUnresolvedRatio,
  });
}

function buildManifest(
  config: GraphConfig,
  repositories: readonly RepositoryBuild[],
  toolVersion: string,
): GraphManifest {
  const entries = repositories
    .map((build) => build.manifest)
    .sort((left, right) => compareText(left.name, right.name));
  const generatedAt = entries
    .map((entry) => entry.committedAt)
    .reduce((latest, value) => (value > latest ? value : latest), '');
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    generatedAt: generatedAt || new Date(0).toISOString(),
    tool: { name: GRAPH_TOOL_NAME, version: toolVersion },
    configFingerprint: configFingerprint(config),
    repositories: entries,
  };
}

/** 지난 manifest. 깨졌으면 경고하고 없는 것으로 본다(이때는 재사용과 급감 검사를 하지 않는다) */
async function readPreviousManifest(
  output: string,
  logger: Logger,
): Promise<GraphManifest | undefined> {
  try {
    return await readGraphManifest(output);
  } catch (error) {
    logger.warn('graph previous manifest unreadable; building from scratch', {
      error: (error as Error).message,
    });
    return undefined;
  }
}

/** 실패 메시지와 경로에서 이 컴퓨터의 경로를 지운다 */
function cleanFailure(
  failure: ExtractionFailure,
  roots: readonly string[],
): ExtractionFailure {
  const message = scrubMessage(
    String(failure?.message ?? ''),
    roots,
    GRAPH_FAILURE_MESSAGE_MAX_CHARS,
  );
  const filePath = scrubMessage(
    String(failure?.filePath ?? ''),
    roots,
    GRAPH_FAILURE_MESSAGE_MAX_CHARS,
  ).replace(/^\/+/, '');
  return {
    filePath: filePath || '.',
    message: message || 'extractor reported a failure without a message',
  };
}

/** 메시지에서 지울 이 컴퓨터의 경로: 설정 폴더, 결과·캐시 폴더, 임시 폴더, 홈 폴더(실제 경로 포함) */
async function localPathRoots(config: GraphConfig): Promise<string[]> {
  const roots = [config.cwd, config.output, config.cache, tmpdir(), homedir()];
  const resolved = await Promise.all(
    roots.map((root) => realpath(root).catch(() => root)),
  );
  return [...roots, ...resolved];
}

/** 설정 폴더 기준 상대 경로(`/` 구분). 결과에 이 컴퓨터의 절대 경로를 남기지 않으려고 쓴다 */
function portablePath(base: string, path: string): string {
  return relative(base, path).split(sep).join('/') || '.';
}

async function readToolVersion(): Promise<string> {
  try {
    const text = await readFile(
      new URL('../../package.json', import.meta.url),
      'utf8',
    );
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === 'string' && version ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
