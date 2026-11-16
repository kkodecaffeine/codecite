// 결과 파일을 읽고 쓴다. 같은 입력이면 바이트 단위로 같은 파일이 나오도록 순서와 형식을 고정하고,
// 결과에는 저장소 기준 상대 경로만 남긴다. 파일은 임시 이름으로 다 쓴 뒤 이름을 바꿔, 중간에 멈춰도 반쯤 쓴 파일이 남지 않게 한다
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { CurrentSymbolRecord } from '../extensions/code-knowledge.js';
import {
  EMPTY_FILE_SKIP_COUNTS,
  GRAPH_ARTIFACT_NAME_PATTERN,
  GRAPH_MANIFEST_FILE,
  GRAPH_SCHEMA_VERSION,
  GRAPH_SYMBOL_COLLAPSE_RATIO,
  GRAPH_SYMBOLS_EXTENSION,
  GRAPH_SYMBOLS_FOLDER,
} from './constants.js';
import { compareText } from './files.js';
import { validateCurrentSymbolRecord } from './records.js';
import type {
  ExtractionFailure,
  FileSkipCounts,
  GraphManifest,
  GraphManifestRepository,
  GraphOutputs,
} from './types.js';

/** 심볼 수가 지난번의 절반 아래로 줄어 멈춘 저장소 */
export class GraphCollapseError extends Error {
  constructor(
    readonly repository: string,
    readonly previousCount: number,
    readonly currentCount: number,
  ) {
    super(
      `Repository ${repository}: symbols dropped from ${previousCount} to ${currentCount} (below half of the last build). ` +
        'Previous results are kept. Check repository access, branch and include/exclude; ' +
        `if the drop is expected, build again with acceptSymbolDrop: ['${repository}'].`,
    );
    this.name = 'GraphCollapseError';
  }
}

/** 저장소 심볼 파일의 결과 폴더 기준 경로 */
export function symbolsFilePath(repository: string): string {
  return `${GRAPH_SYMBOLS_FOLDER}/${repository}${GRAPH_SYMBOLS_EXTENSION}`;
}

/** 레코드를 한 줄에 하나씩 쓴다. 레코드가 없으면 빈 파일이다 */
export function serializeSymbols(
  records: readonly CurrentSymbolRecord[],
): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

/** 심볼 파일을 읽어 레코드마다 계약을 검사한다. 다른 저장소의 레코드가 섞여 있으면 거절한다 */
export function parseSymbolsJsonl(
  text: string,
  repository: string,
): CurrentSymbolRecord[] {
  const records: CurrentSymbolRecord[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') {
      continue;
    }
    const label = `${symbolsFilePath(repository)} line ${index + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${label}: not valid JSON`);
    }
    const record = validateCurrentSymbolRecord(parsed, label);
    if (record.repository !== repository) {
      throw new Error(`${label}: record belongs to ${record.repository}`);
    }
    records.push(record);
  }
  return records;
}

/** 결과 폴더의 manifest.json. 없으면 undefined, 모양이 틀리면 throw 한다 */
export async function readGraphManifest(
  output: string,
): Promise<GraphManifest | undefined> {
  const text = await readOptionalFile(join(output, GRAPH_MANIFEST_FILE));
  if (text === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${GRAPH_MANIFEST_FILE}: not valid JSON`);
  }
  return validateGraphManifest(parsed);
}

/** 저장소 하나의 심볼 파일. 없으면 undefined, 레코드가 계약에 맞지 않으면 throw 한다 */
export async function readRepositorySymbols(
  output: string,
  repository: string,
): Promise<CurrentSymbolRecord[] | undefined> {
  const text = await readOptionalFile(
    join(output, symbolsFilePath(repository)),
  );
  return text === undefined ? undefined : parseSymbolsJsonl(text, repository);
}

/** manifest 모양을 검사하고 키 순서를 고정한 새 객체로 돌려준다 */
export function validateGraphManifest(value: unknown): GraphManifest {
  const manifest = requireObject(value, GRAPH_MANIFEST_FILE);
  if (manifest.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new Error(
      `${GRAPH_MANIFEST_FILE}: schemaVersion must be ${GRAPH_SCHEMA_VERSION}`,
    );
  }
  const tool = requireObject(manifest.tool, `${GRAPH_MANIFEST_FILE} tool`);
  if (!Array.isArray(manifest.repositories)) {
    throw new Error(`${GRAPH_MANIFEST_FILE}: repositories must be an array`);
  }
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    generatedAt: requireText(manifest.generatedAt, 'generatedAt'),
    tool: {
      name: requireText(tool.name, 'tool.name'),
      version: requireText(tool.version, 'tool.version'),
    },
    configFingerprint: requireText(
      manifest.configFingerprint,
      'configFingerprint',
    ),
    repositories: manifest.repositories.map((item, index) =>
      validateManifestRepository(item, `repositories[${index}]`),
    ),
  };
}

/**
 * 결과 파일을 쓴다: 저장소마다 `symbols/<이름>.jsonl`, 단계가 더한 JSON 파일, 마지막으로 manifest.json
 * manifest 를 맨 뒤에 써서, 중간에 멈추면 지난 manifest 가 그대로 남는다. 설정에서 빠진 저장소의 심볼 파일은 지운다
 * 쓴 파일을 결과 폴더 기준 상대 경로로 정렬해 돌려준다
 */
export async function writeGraphOutputs(
  output: string,
  outputs: GraphOutputs,
): Promise<string[]> {
  const symbolsFolder = join(output, GRAPH_SYMBOLS_FOLDER);
  await mkdir(symbolsFolder, { recursive: true });
  const written: string[] = [];
  for (const repository of outputs.manifest.repositories) {
    const records = outputs.symbols.get(repository.name) ?? [];
    await writeFileAtomic(
      join(output, repository.symbolsFile),
      serializeSymbols(records),
    );
    written.push(repository.symbolsFile);
  }
  const artifacts = [...outputs.artifacts.entries()].sort(([left], [right]) =>
    compareText(left, right),
  );
  for (const [name, value] of artifacts) {
    if (
      !GRAPH_ARTIFACT_NAME_PATTERN.test(name) ||
      name === GRAPH_MANIFEST_FILE
    ) {
      throw new Error(`artifact name must be a plain JSON file name: ${name}`);
    }
    await writeFileAtomic(join(output, name), formatJson(value));
    written.push(name);
  }
  await writeFileAtomic(
    join(output, GRAPH_MANIFEST_FILE),
    formatJson(outputs.manifest),
  );
  written.push(GRAPH_MANIFEST_FILE);

  const kept = new Set(
    outputs.manifest.repositories.map((repository) =>
      repository.symbolsFile.slice(GRAPH_SYMBOLS_FOLDER.length + 1),
    ),
  );
  for (const entry of await readdir(symbolsFolder)) {
    if (entry.endsWith(GRAPH_SYMBOLS_EXTENSION) && !kept.has(entry)) {
      await rm(join(symbolsFolder, entry), { force: true });
    }
  }
  return written.sort(compareText);
}

/**
 * 심볼 수가 지난번의 절반 아래로 줄었으면 멈춘다. 접근 권한이나 경로 설정이 틀려 그래프가 조용히 비는 일을 막는다
 * 지난 결과가 없거나 지난번 수가 0 이면 보지 않는다
 */
export function assertNoSymbolCollapse(
  repository: string,
  previousCount: number | undefined,
  currentCount: number,
  accepted: readonly string[] = [],
): void {
  if (
    previousCount === undefined ||
    previousCount === 0 ||
    accepted.includes(repository)
  ) {
    return;
  }
  if (currentCount < previousCount * GRAPH_SYMBOL_COLLAPSE_RATIO) {
    throw new GraphCollapseError(repository, previousCount, currentCount);
  }
}

/** 저장소 커밋 시각 가운데 가장 늦은 것. 결과 파일의 generatedAt 으로 쓴다(만든 시각을 넣으면 같은 입력에 다른 출력이 나온다) */
export function latestCommittedAt(
  repositories: readonly { committedAt: string }[],
): string {
  const latest = repositories
    .map((repository) => repository.committedAt)
    .reduce((current, value) => (value > current ? value : current), '');
  return latest || new Date(0).toISOString();
}

/** 결과 폴더의 JSON 결과 파일 하나. 없으면 undefined, JSON 이 아니면 throw 한다 */
export async function readGraphArtifact(
  output: string,
  name: string,
): Promise<unknown> {
  const text = await readOptionalFile(join(output, name));
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${name}: not valid JSON`);
  }
}

/** 키를 정렬한 JSON. 지문을 만들 때 키 순서가 달라도 같은 값이 되게 한다 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** 값의 지문(`sha256:<16 진수>`) */
export function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

/** 결과 JSON 형식: 두 칸 들여쓰기와 끝 줄바꿈 */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateManifestRepository(
  value: unknown,
  label: string,
): GraphManifestRepository {
  const entry = requireObject(value, label);
  const name = requireText(entry.name, `${label}.name`);
  const symbolsFile = requireText(entry.symbolsFile, `${label}.symbolsFile`);
  if (symbolsFile !== symbolsFilePath(name)) {
    throw new Error(`${label}.symbolsFile must be ${symbolsFilePath(name)}`);
  }
  const skipped = requireObject(entry.skippedFiles, `${label}.skippedFiles`);
  const skippedFiles = { ...EMPTY_FILE_SKIP_COUNTS };
  for (const key of Object.keys(skippedFiles) as Array<keyof FileSkipCounts>) {
    skippedFiles[key] = requireCount(
      skipped[key],
      `${label}.skippedFiles.${key}`,
    );
  }
  if (!Array.isArray(entry.failures)) {
    throw new Error(`${label}.failures must be an array`);
  }
  return {
    name,
    branch: requireText(entry.branch, `${label}.branch`),
    commitSha: requireText(entry.commitSha, `${label}.commitSha`),
    committedAt: requireText(entry.committedAt, `${label}.committedAt`),
    inputFingerprint: requireText(
      entry.inputFingerprint,
      `${label}.inputFingerprint`,
    ),
    symbolsFile,
    symbolCount: requireCount(entry.symbolCount, `${label}.symbolCount`),
    fileCount: requireCount(entry.fileCount, `${label}.fileCount`),
    skippedFiles,
    failures: entry.failures.map((item, index): ExtractionFailure => {
      const failure = requireObject(item, `${label}.failures[${index}]`);
      return {
        filePath: requireText(
          failure.filePath,
          `${label}.failures[${index}].filePath`,
        ),
        message: requireText(
          failure.message,
          `${label}.failures[${index}].message`,
        ),
      };
    }),
  };
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, child]) => [key, sortKeys(child)]),
  );
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireCount(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}
