// 결과 폴더 검사(`codecite graph validate`). 다 만든 결과 폴더만 읽고 아무것도 고치지 않는다
// - 모양: 파일마다 계약 모양(manifest, symbols JSONL, detections, topology, cross-repository, entities, field-writers, report)
// - 참조: 간선 끝, 코드 자리(handlerChain 등), 필드 쓰기의 심볼 id 가 레코드나 노드로 있는지. 수동 연결의 끝 심볼이 있는지
// - 경로·비밀값: 만든 컴퓨터의 절대 경로와 비밀값 모양이 남지 않았는지
// - 순서: 같은 입력이면 같은 바이트가 나오도록 정한 형식·순서로 다시 써 보아 같은지. 손으로 고친 결과 파일을 잡는다
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CodeLocation,
  CrossRepositoryGraph,
  CurrentSymbolRecord,
  EntityRelationGraph,
  FieldWriterIndex,
  SystemTopologyGraph,
} from '../../extensions/code-knowledge.js';
import {
  GRAPH_DETECTIONS_FILE,
  GRAPH_MANIFEST_FILE,
  GRAPH_TOPOLOGY_FILE,
} from '../constants.js';
import { parseDetectionsArtifact, sortDetections } from '../detect.js';
import { compareText, portablePath } from '../files.js';
import { ManualLinkError, parseManualLinks } from '../link/manual.js';
import {
  formatJson,
  serializeSymbols,
  validateGraphManifest,
} from '../output.js';
import { compareRecords, validateCurrentSymbolRecord } from '../records.js';
import type { GraphManifest, ManualLink } from '../types.js';
import {
  GRAPH_CROSS_REPOSITORY_FILE,
  GRAPH_ENTITIES_FILE,
  GRAPH_FIELD_WRITERS_FILE,
  GRAPH_REPORT_FILE,
} from './constants.js';
import { sortEntityGraph } from './entities.js';
import { sortFieldWriterIndex } from './field-writers.js';
import type {
  GraphValidationResult,
  LocationPresence,
  ValidateGraphOutputOptions,
} from './types.js';
import { OutputScanner } from './validate-scan.js';
import {
  crossRepositoryShape,
  entitiesShape,
  fieldWritersShape,
  reportShape,
  topologyShape,
} from './validate-shapes.js';
import { firstDifference, IssueLog, Shape } from './validate-support.js';

/** 읽은 JSON 파일 */
interface JsonFile {
  text: string;
  value: unknown;
}

/** 검사하며 쌓는 색인. 참조 검사가 쓴다 */
class OutputIndex {
  readonly repositories = new Set<string>();
  readonly recordsById = new Map<string, CurrentSymbolRecord>();
  /** 레코드의 저장소·경로·심볼 */
  readonly recordLocations = new Set<string>();
  /** 토폴로지 노드의 저장소·경로·심볼 */
  readonly nodeLocations = new Set<string>();
  readonly files = new Set<string>();
  readonly topologyNodes = new Set<string>();
  readonly crossNodes = new Set<string>();

  addRecord(record: CurrentSymbolRecord): void {
    this.recordsById.set(record.stableSymbolId, record);
    this.recordLocations.add(
      place(record.repository, record.filePath, record.symbol),
    );
    this.files.add(`${record.repository}\u0000${record.filePath}`);
  }

  hasRecord(
    location: Pick<CodeLocation, 'repository' | 'filePath' | 'symbol'>,
  ): boolean {
    return this.recordLocations.has(
      place(location.repository, location.filePath, location.symbol),
    );
  }

  /** 코드 자리가 레코드·토폴로지 노드로 있는지(exact), 같은 파일의 레코드만 있는지(file), 없는지(missing) */
  presence(location: CodeLocation): LocationPresence {
    const key = place(location.repository, location.filePath, location.symbol);
    if (this.recordLocations.has(key) || this.nodeLocations.has(key)) {
      return 'exact';
    }
    return this.files.has(`${location.repository}\u0000${location.filePath}`)
      ? 'file'
      : 'missing';
  }
}

/**
 * 결과 폴더를 검사한다. errors 가 비어 있으면 ok 다
 * - manifest.json 과 저장소마다의 symbols JSONL 은 있어야 한다(없으면 오류)
 * - detections·topology·entities·field-writers 는 없으면 경고, cross-repository·report 는 있을 때만 본다
 * - options.config 를 주면 설정의 수동 연결 파일 끝 심볼과 설정 저장소 목록, 설정 폴더 경로도 본다
 */
export async function validateGraphOutput(
  output: string,
  options: ValidateGraphOutputOptions = {},
): Promise<GraphValidationResult> {
  const log = new IssueLog();
  const scanner = await OutputScanner.create(log, output, options.config);
  const index = new OutputIndex();

  const manifest = await checkManifest(output, log, scanner);
  if (!manifest) {
    return log.result();
  }
  for (const repository of manifest.repositories) {
    index.repositories.add(repository.name);
    await checkSymbols(output, repository, log, scanner, index);
  }
  if (options.config) {
    const configured = options.config.repositories
      .map((item) => item.name)
      .sort(compareText);
    const built = [...index.repositories].sort(compareText);
    if (configured.join('\u0000') !== built.join('\u0000')) {
      log.warn(
        'consistency',
        GRAPH_MANIFEST_FILE,
        `repositories (${built.join(', ')}) differ from the config (${configured.join(', ')}); build again`,
      );
    }
  }

  await checkDetections(output, log, scanner, index);
  await checkTopology(output, log, scanner, index, manifest);
  await checkCrossRepository(output, log, scanner, index);
  await checkEntities(output, log, scanner, index, manifest);
  await checkFieldWriters(output, log, scanner, index, manifest);
  await checkReport(output, log, scanner);
  if (options.config?.manualLinks) {
    await checkManualLinkFile(
      options.config.manualLinks,
      options.config.cwd,
      log,
      scanner,
      index,
    );
  }
  return log.result();
}

// ── manifest 와 심볼 ──

async function checkManifest(
  output: string,
  log: IssueLog,
  scanner: OutputScanner,
): Promise<GraphManifest | undefined> {
  const file = await readJson(output, GRAPH_MANIFEST_FILE, log);
  if (file === 'missing') {
    log.error(
      'missing',
      GRAPH_MANIFEST_FILE,
      'manifest.json is missing; this is not a finished graph output folder',
    );
    return undefined;
  }
  if (!file) {
    return undefined;
  }
  scanner.scan(GRAPH_MANIFEST_FILE, file.value);
  let manifest: GraphManifest;
  try {
    manifest = validateGraphManifest(file.value);
  } catch (error) {
    log.error('shape', GRAPH_MANIFEST_FILE, (error as Error).message);
    return undefined;
  }
  const names = manifest.repositories.map((item) => item.name);
  if (new Set(names).size !== names.length) {
    log.error(
      'shape',
      GRAPH_MANIFEST_FILE,
      'repositories has the same name twice',
    );
  }
  const raw = file.value as GraphManifest;
  checkOrder(log, GRAPH_MANIFEST_FILE, file, {
    ...raw,
    repositories: [...raw.repositories]
      .sort((left, right) => compareText(left.name, right.name))
      .map((item) => ({
        ...item,
        failures: [...item.failures].sort(
          (left, right) =>
            compareText(left.filePath, right.filePath) ||
            compareText(left.message, right.message),
        ),
      })),
  });
  return manifest;
}

async function checkSymbols(
  output: string,
  repository: GraphManifest['repositories'][number],
  log: IssueLog,
  scanner: OutputScanner,
  index: OutputIndex,
): Promise<void> {
  const file = repository.symbolsFile;
  const text = await readText(join(output, file));
  if (text === undefined) {
    log.error('missing', file, `symbols of ${repository.name} are missing`);
    return;
  }
  const records: CurrentSymbolRecord[] = [];
  const ids = new Set<string>();
  let valid = true;
  text.split('\n').forEach((line, position) => {
    if (line.trim() === '') {
      return;
    }
    const label = `line ${position + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.error('shape', file, `${label}: not valid JSON`);
      valid = false;
      return;
    }
    scanner.scan(file, parsed, label);
    let record: CurrentSymbolRecord;
    try {
      record = validateCurrentSymbolRecord(parsed, label);
    } catch (error) {
      log.error('shape', file, (error as Error).message);
      valid = false;
      return;
    }
    if (record.repository !== repository.name) {
      log.error(
        'shape',
        file,
        `${label}: record belongs to ${record.repository}`,
      );
      valid = false;
      return;
    }
    if (record.commitSha !== repository.commitSha) {
      log.error(
        'consistency',
        file,
        `${label}: commitSha differs from manifest.json`,
      );
    }
    if (ids.has(record.stableSymbolId)) {
      log.error('shape', file, `${label}: stableSymbolId appears twice`);
    }
    ids.add(record.stableSymbolId);
    records.push(record);
    index.addRecord(record);
  });
  if (records.length !== repository.symbolCount) {
    log.error(
      'consistency',
      file,
      `has ${records.length} records but manifest.json says ${repository.symbolCount}`,
    );
  }
  if (!valid) {
    return;
  }
  const expected = serializeSymbols([...records].sort(compareRecords));
  if (expected !== text) {
    const actualLines = text.split('\n');
    const expectedLines = expected.split('\n');
    const line = actualLines.findIndex(
      (item, position) => item !== expectedLines[position],
    );
    log.error(
      'order',
      file,
      `line ${line + 1} is not in the fixed order or format; build again instead of editing it by hand`,
    );
  }
}

// ── 탐지와 토폴로지 ──

async function checkDetections(
  output: string,
  log: IssueLog,
  scanner: OutputScanner,
  index: OutputIndex,
): Promise<void> {
  const file = await readExpected(output, GRAPH_DETECTIONS_FILE, log);
  if (!file) {
    return;
  }
  scanner.scan(GRAPH_DETECTIONS_FILE, file.value);
  let parsed: ReturnType<typeof parseDetectionsArtifact>;
  try {
    parsed = parseDetectionsArtifact(file.value);
  } catch (error) {
    log.error('shape', GRAPH_DETECTIONS_FILE, (error as Error).message);
    return;
  }
  for (const repository of parsed.keys()) {
    if (!index.repositories.has(repository)) {
      log.error(
        'consistency',
        GRAPH_DETECTIONS_FILE,
        `${repository} is not in manifest.json`,
      );
    }
  }
  const raw = file.value as {
    repositories: Record<string, Record<string, unknown>>;
  };
  checkOrder(log, GRAPH_DETECTIONS_FILE, file, {
    ...raw,
    repositories: Object.fromEntries(
      Object.keys(raw.repositories)
        .sort(compareText)
        .map((name) => {
          const state = parsed.get(name);
          return [
            name,
            {
              ...raw.repositories[name],
              detections: sortDetections(state?.detections ?? []),
              receivers: [...(state?.receivers ?? [])].sort(
                (left, right) =>
                  compareText(left.filePath, right.filePath) ||
                  compareText(left.symbol, right.symbol),
              ),
            },
          ];
        }),
    ),
  });
}

async function checkTopology(
  output: string,
  log: IssueLog,
  scanner: OutputScanner,
  index: OutputIndex,
  manifest: GraphManifest,
): Promise<SystemTopologyGraph | undefined> {
  const name = GRAPH_TOPOLOGY_FILE;
  const file = await readExpected(output, name, log);
  if (!file) {
    return undefined;
  }
  scanner.scan(name, file.value);
  const graph = topologyShape(new Shape(log, name), file.value);
  if (!graph) {
    return undefined;
  }
  checkGeneratedAt(log, name, graph.generatedAt, manifest);
  for (const node of graph.nodes) {
    if (index.topologyNodes.has(node.id)) {
      log.error('shape', name, `node id ${node.id} appears twice`);
    }
    index.topologyNodes.add(node.id);
    index.nodeLocations.add(place(node.repository, node.filePath, node.symbol));
    if (!index.repositories.has(node.repository)) {
      log.error(
        'reference',
        name,
        `node ${node.id} names repository ${node.repository}, which is not in manifest.json`,
      );
    }
  }
  for (const node of graph.nodes) {
    if (
      ['Class', 'Function', 'Enum'].includes(node.type) &&
      !index.hasRecord(node)
    ) {
      log.error('reference', name, `node ${node.id} has no symbol record`);
    }
  }
  graph.edges.forEach((edge, position) => {
    for (const end of [edge.from, edge.to]) {
      if (!index.topologyNodes.has(end)) {
        log.error(
          'reference',
          name,
          `edges[${position}] points to missing node ${end}`,
        );
      }
    }
  });
  graph.localGraphs.forEach((local, position) => {
    for (const id of local.nodeIds) {
      if (!index.topologyNodes.has(id)) {
        log.error(
          'reference',
          name,
          `localGraphs[${position}] lists missing node ${id}`,
        );
      }
    }
    for (const edge of local.edgeIndexes) {
      if (edge >= graph.edges.length) {
        log.error(
          'reference',
          name,
          `localGraphs[${position}] lists missing edge ${edge}`,
        );
      }
    }
  });
  const sorted = (values: readonly string[] | undefined) =>
    values ? [...values].sort(compareText) : undefined;
  const nodes = [...graph.nodes]
    .sort((left, right) => compareText(left.id, right.id))
    .map((node) => ({
      ...node,
      ...(node.aliases ? { aliases: sorted(node.aliases) } : {}),
      ...(node.evidence ? { evidence: sorted(node.evidence) } : {}),
    }));
  const edges = [...graph.edges]
    .sort(
      (left, right) =>
        compareText(left.repository, right.repository) ||
        compareText(left.from, right.from) ||
        compareText(left.type, right.type) ||
        compareText(left.to, right.to),
    )
    .map((edge) => ({ ...edge, evidence: sorted(edge.evidence) ?? [] }));
  const repositories = [...graph.repositories].sort(compareText);
  checkOrder(log, name, file, {
    ...graph,
    repositories,
    nodes,
    edges,
    localGraphs: [...graph.localGraphs]
      .sort((left, right) => compareText(left.repository, right.repository))
      .map((local) => ({
        ...local,
        nodeIds: [...local.nodeIds].sort(compareText),
        edgeIndexes: [...local.edgeIndexes].sort((left, right) => left - right),
      })),
    ...(graph.sources
      ? {
          sources: [...graph.sources].sort((left, right) =>
            compareText(left.kind, right.kind),
          ),
        }
      : {}),
  });
  return graph;
}

// ── 저장소 간 연결 ──

async function checkCrossRepository(
  output: string,
  log: IssueLog,
  scanner: OutputScanner,
  index: OutputIndex,
): Promise<void> {
  const name = GRAPH_CROSS_REPOSITORY_FILE;
  const file = await readJson(output, name, log);
  if (!file || file === 'missing') {
    return;
  }
  scanner.scan(name, file.value);
  const graph: CrossRepositoryGraph | undefined = crossRepositoryShape(
    new Shape(log, name),
    file.value,
  );
  if (!graph) {
    return;
  }
  // 연결 단계의 노드·간선 순서는 그 단계가 정한다. 여기서는 형식(다시 쓴 바이트)만 본다
  checkOrder(log, name, file);
  for (const node of graph.nodes) {
    if (index.crossNodes.has(node.id)) {
      log.error('shape', name, `node id ${node.id} appears twice`);
    }
    index.crossNodes.add(node.id);
  }
  const known = (id: string) =>
    index.crossNodes.has(id) ||
    index.topologyNodes.has(id) ||
    index.recordsById.has(id);
  graph.edges.forEach((edge, position) => {
    const at = `edges[${position}]`;
    for (const end of [edge.source, edge.target]) {
      if (!known(end)) {
        log.error(
          'reference',
          name,
          `${at} points to ${end}, which is neither a node nor a symbol record`,
        );
      }
    }
    const locations: Array<[string, CodeLocation | undefined]> = [
      ['sourceLocation', edge.sourceLocation],
      ['targetLocation', edge.targetLocation],
      ...(edge.handlerChain ?? []).map(
        (location, step): [string, CodeLocation] => [
          `handlerChain[${step}]`,
          location,
        ],
      ),
    ];
    for (const [field, location] of locations) {
      if (location) {
        reportLocation(log, name, `${at}.${field}`, location, index);
      }
    }
    if (edge.extraction.kind === 'manual') {
      for (const [field, location] of locations.slice(0, 2)) {
        if (!location || !index.hasRecord(location)) {
          log.error(
            'manual-link',
            name,
            `${at}.${field}: manual link end must be an existing symbol`,
          );
        }
      }
    }
  });
}

// ── 엔티티와 필드 쓰기 ──

async function checkEntities(
  output: string,
  log: IssueLog,
  scanner: OutputScanner,
  index: OutputIndex,
  manifest: GraphManifest,
): Promise<void> {
  const name = GRAPH_ENTITIES_FILE;
  const file = await readExpected(output, name, log);
  if (!file) {
    return;
  }
  scanner.scan(name, file.value);
  const graph: EntityRelationGraph | undefined = entitiesShape(
    new Shape(log, name),
    file.value,
  );
  if (!graph) {
    return;
  }
  checkGeneratedAt(log, name, graph.generatedAt, manifest);
  const tables = new Set<string>();
  const keys = new Set<string>();
  for (const table of graph.tables) {
    tables.add(table.table);
    const key = `${table.store ?? ''}\u0000${table.table.toLowerCase()}`;
    if (keys.has(key)) {
      log.error(
        'shape',
        name,
        `table ${table.table} appears twice; tables with the same name and store are one node`,
      );
    }
    keys.add(key);
  }
  graph.tables.forEach((table, position) => {
    const at = `tables[${position}]`;
    table.relations.forEach((relation, step) => {
      if (!tables.has(relation.targetTable)) {
        log.error(
          'reference',
          name,
          `${at}.relations[${step}] points to missing table ${relation.targetTable}`,
        );
      }
    });
    table.sources.forEach((source, step) =>
      reportLocation(log, name, `${at}.sources[${step}]`, source, index),
    );
  });
  checkOrder(log, name, file, sortEntityGraph(graph));
}

async function checkFieldWriters(
  output: string,
  log: IssueLog,
  scanner: OutputScanner,
  index: OutputIndex,
  manifest: GraphManifest,
): Promise<void> {
  const name = GRAPH_FIELD_WRITERS_FILE;
  const file = await readExpected(output, name, log);
  if (!file) {
    return;
  }
  scanner.scan(name, file.value);
  const writers: FieldWriterIndex | undefined = fieldWritersShape(
    new Shape(log, name),
    file.value,
  );
  if (!writers) {
    return;
  }
  checkGeneratedAt(log, name, writers.generatedAt, manifest);
  for (const [key, entries] of Object.entries(writers.writers)) {
    const separator = key.indexOf(':');
    const repository = separator > 0 ? key.slice(0, separator) : '';
    if (!index.repositories.has(repository) || separator === key.length - 1) {
      log.error(
        'reference',
        name,
        `key ${key} must be <repository>:<field> with a repository from manifest.json`,
      );
      continue;
    }
    if (entries.length > writers.maxWritersPerField) {
      log.error(
        'shape',
        name,
        `${key} has ${entries.length} writers, more than maxWritersPerField`,
      );
    }
    entries.forEach((entry, position) => {
      const record = index.recordsById.get(entry.symbolId);
      if (
        !record ||
        record.repository !== repository ||
        record.filePath !== entry.filePath ||
        record.symbol !== entry.symbol
      ) {
        log.error(
          'reference',
          name,
          `writers.${key}[${position}] symbolId does not match a symbol record`,
        );
      }
    });
  }
  for (const [key, count] of Object.entries(writers.truncated)) {
    const kept = writers.writers[key]?.length;
    if (kept === undefined || count <= kept) {
      log.error(
        'consistency',
        name,
        `truncated.${key} must count more writers than writers.${key} keeps`,
      );
    }
  }
  checkOrder(log, name, file, sortFieldWriterIndex(writers));
}

// ── 보고서와 수동 연결 ──

async function checkReport(
  output: string,
  log: IssueLog,
  scanner: OutputScanner,
): Promise<void> {
  const file = await readJson(output, GRAPH_REPORT_FILE, log);
  if (!file || file === 'missing') {
    return;
  }
  scanner.scan(GRAPH_REPORT_FILE, file.value);
  if (reportShape(new Shape(log, GRAPH_REPORT_FILE), file.value)) {
    checkOrder(log, GRAPH_REPORT_FILE, file);
  }
}

async function checkManualLinkFile(
  path: string,
  cwd: string,
  log: IssueLog,
  scanner: OutputScanner,
  index: OutputIndex,
): Promise<void> {
  const label = portablePath(cwd, path);
  const text = await readText(path);
  if (text === undefined) {
    log.warn(
      'missing',
      label,
      'the manual links file in the config does not exist',
    );
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    log.error('shape', label, 'not valid JSON');
    return;
  }
  scanner.scan(label, value);
  // 수동 연결의 모양은 그래프 만들기와 같은 parseManualLinks 로 본다
  let links: ManualLink[];
  try {
    links = parseManualLinks(value, label);
  } catch (error) {
    if (!(error instanceof ManualLinkError)) {
      throw error;
    }
    log.error(
      'shape',
      label,
      `${error.index === undefined ? '(root)' : `[${error.index}]`}: ${error.reason}`,
    );
    return;
  }
  links.forEach((link, position) => {
    for (const end of ['from', 'to'] as const) {
      const place = link[end];
      if (!index.hasRecord(place)) {
        log.error(
          'manual-link',
          label,
          `[${position}].${end}: ${place.repository} ${place.filePath} ${place.symbol} is not a symbol in the graph`,
        );
      }
    }
  });
}

// ── 도우미 ──

function place(repository: string, filePath: string, symbol: string): string {
  return `${repository}\u0000${filePath}\u0000${symbol}`;
}

function reportLocation(
  log: IssueLog,
  file: string,
  at: string,
  location: CodeLocation,
  index: OutputIndex,
): void {
  const presence = index.presence(location);
  if (presence === 'missing') {
    log.error(
      'reference',
      file,
      `${at}: ${location.repository} ${location.filePath} is not in the graph`,
    );
  } else if (presence === 'file') {
    log.warn(
      'reference',
      file,
      `${at}: symbol ${location.symbol} is not a record or node in ${location.filePath}`,
    );
  }
}

function checkGeneratedAt(
  log: IssueLog,
  file: string,
  generatedAt: string,
  manifest: GraphManifest,
): void {
  if (generatedAt !== manifest.generatedAt) {
    log.warn(
      'consistency',
      file,
      'generatedAt differs from manifest.json; files may come from different builds',
    );
  }
}

/**
 * 정한 형식으로 다시 써 보아 바이트가 같은지 본다. canonical 을 주면 정한 순서로 다시 놓은 값과도 견준다
 * 다르면 손으로 고쳤거나 만든 도구가 결정적이지 않은 것이다
 */
function checkOrder(
  log: IssueLog,
  file: string,
  json: JsonFile,
  canonical?: unknown,
): void {
  if (formatJson(json.value) !== json.text) {
    log.error(
      'order',
      file,
      'is not in the fixed JSON format (two-space indent, trailing newline); build again',
    );
    return;
  }
  if (canonical !== undefined && formatJson(canonical) !== json.text) {
    const at = firstDifference(json.value, canonical) ?? '(root)';
    log.error(
      'order',
      file,
      `is not in the fixed order (first difference at ${at}); build again instead of editing it by hand`,
    );
  }
}

async function readExpected(
  output: string,
  name: string,
  log: IssueLog,
): Promise<JsonFile | undefined> {
  const file = await readJson(output, name, log);
  if (file === 'missing') {
    log.warn(
      'missing',
      name,
      `${name} is missing; build again with the current version`,
    );
    return undefined;
  }
  return file;
}

async function readJson(
  output: string,
  name: string,
  log: IssueLog,
): Promise<JsonFile | 'missing' | undefined> {
  const text = await readText(join(output, name));
  if (text === undefined) {
    return 'missing';
  }
  try {
    return { text, value: JSON.parse(text) as unknown };
  } catch {
    log.error('shape', name, 'not valid JSON');
    return undefined;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
