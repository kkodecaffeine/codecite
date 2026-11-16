// 탐지 단계. 다시 추출한 저장소마다 켠 프리셋을 심볼에 돌려 제공 쪽(라우트, 리졸버, 구독자)과 부르는 쪽(호출, 연산, 발행) 계약을 찾는다
// 재사용한 저장소는 다시 추출하지 않으므로 지난 detections.json 에 남긴 그 저장소의 결과를 그대로 쓴다
// 결과는 저장소마다 정해진 순서로 정렬하고, 탐지기가 낸 값의 비밀값 모양은 한 번 더 가린다
import type { Logger } from '../ports.js';
import { createConstantResolver } from './constant-resolver.js';
import {
  DETECTION_BASE_KEYS,
  DETECTION_IDENTITY_KEYS,
  DETECTION_KINDS,
  DETECTION_REQUIRED_FIELDS,
  GRAPH_DETECTIONS_FILE,
  GRAPH_SCHEMA_VERSION,
  SILENT_LOGGER,
} from './constants.js';
import { redactSecretValue } from './extractors/site-secrets.js';
import { compareText } from './files.js';
import { canonicalJson } from './output.js';
import type {
  Detection,
  DetectionKind,
  DetectionPreset,
  DetectionsArtifact,
  ExtractedSymbol,
  GraphBuildState,
  GraphConfig,
  PresetContext,
  RepositoryDetectionState,
  RunDetectionOptions,
} from './types.js';

/**
 * 저장소마다 탐지 결과를 만든다. 저장소 이름 → 정렬한 탐지 결과
 * - 다시 추출한 저장소: 심볼마다 언어가 맞는 프리셋을 모두 부른다. 탐지기 문맥(PresetContext)은 저장소마다 하나를 만들고,
 *   symbols 에는 그 저장소의 추출 결과 배열을 그대로(같은 배열로) 넘긴다. resolveConstant 만 지금 보는 심볼의 파일을 먼저 찾게 바꿔 넘긴다
 * - 재사용한 저장소: 지난 결과(build.previousDetections)
 * 프리셋이 throw 하거나 모양이 틀린 결과를 내면 저장소·프리셋·심볼을 밝혀 멈춘다
 */
export async function runDetection(
  state: GraphBuildState,
  presets: readonly DetectionPreset[],
  options: RunDetectionOptions = {},
): Promise<Map<string, Detection[]>> {
  const logger = options.logger ?? SILENT_LOGGER;
  const result = new Map<string, Detection[]>();
  for (const build of state.repositories) {
    const repository = build.manifest.name;
    if (!build.extracted) {
      result.set(
        repository,
        sortDetections(build.previousDetections?.detections ?? []),
      );
      continue;
    }
    const detections =
      presets.length === 0
        ? []
        : await detectRepository(
            repository,
            build.extracted,
            presets,
            state.config,
            logger,
            options,
          );
    logger.info('graph detections found', {
      repository,
      detections: detections.length,
      ...countByKind(detections),
    });
    result.set(repository, detections);
  }
  return result;
}

/** 탐지 결과 정렬: 파일 경로 → 줄 → 심볼 → 종류 → 탐지기 → 나머지 값. 같은 탐지는 하나로 합친다 */
export function sortDetections(detections: readonly Detection[]): Detection[] {
  const keyed = new Map<string, Detection>();
  for (const detection of detections) {
    const key = canonicalJson(detection);
    if (!keyed.has(key)) {
      keyed.set(key, detection);
    }
  }
  return [...keyed.entries()]
    .sort(
      ([leftKey, left], [rightKey, right]) =>
        compareText(left.filePath, right.filePath) ||
        left.line - right.line ||
        compareText(left.symbol, right.symbol) ||
        compareText(left.kind, right.kind) ||
        compareText(left.detector, right.detector) ||
        compareText(leftKey, rightKey),
    )
    .map(([, detection]) => detection);
}

/** detections.json 의 값. 저장소 이름 순서로 그 저장소의 탐지 결과를 담는다 */
export function detectionsArtifact(state: GraphBuildState): DetectionsArtifact {
  const names = state.repositories
    .map((build) => build.manifest.name)
    .sort(compareText);
  const repositories: Record<string, RepositoryDetectionState> = {};
  for (const name of names) {
    repositories[name] = { detections: state.detections.get(name) ?? [] };
  }
  return { schemaVersion: GRAPH_SCHEMA_VERSION, repositories };
}

/** 지난 detections.json 을 저장소 이름 → 탐지 결과로 읽는다. 모양이 틀리면 throw 한다 */
export function parseDetectionsArtifact(
  value: unknown,
): Map<string, RepositoryDetectionState> {
  const artifact = requireObject(value, GRAPH_DETECTIONS_FILE);
  if (artifact.schemaVersion !== GRAPH_SCHEMA_VERSION) {
    throw new Error(
      `${GRAPH_DETECTIONS_FILE}: schemaVersion must be ${GRAPH_SCHEMA_VERSION}`,
    );
  }
  const repositories = requireObject(
    artifact.repositories,
    `${GRAPH_DETECTIONS_FILE} repositories`,
  );
  const result = new Map<string, RepositoryDetectionState>();
  for (const [repository, item] of Object.entries(repositories)) {
    const label = `${GRAPH_DETECTIONS_FILE} ${repository}`;
    const entry = requireObject(item, label);
    if (!Array.isArray(entry.detections)) {
      throw new Error(`${label}: detections must be an array`);
    }
    const detections = entry.detections.map((detection, index) =>
      checkStoredDetection(detection, repository, `${label}[${index}]`),
    );
    result.set(repository, { detections });
  }
  return result;
}

async function detectRepository(
  repository: string,
  symbols: readonly ExtractedSymbol[],
  presets: readonly DetectionPreset[],
  config: GraphConfig,
  logger: Logger,
  options: RunDetectionOptions,
): Promise<Detection[]> {
  const resolver = await createConstantResolver(symbols, {
    repository,
    logger,
    loadTypeScript: options.loadTypeScript,
  });
  const base: PresetContext = {
    repository,
    config,
    logger,
    symbols,
    resolveConstant: (identifier) => resolver.resolve(identifier),
  };
  const found: Detection[] = [];
  for (const symbol of symbols) {
    const context: PresetContext = {
      ...base,
      resolveConstant: (identifier) => resolver.resolve(identifier, symbol),
    };
    for (const preset of presets) {
      if (!readsLanguage(preset, symbol.language)) {
        continue;
      }
      const where = `Repository ${repository}: preset ${preset.name} on ${symbol.filePath} ${symbol.symbol}`;
      let output: unknown;
      try {
        output = preset.detect(symbol, context);
      } catch (error) {
        throw new Error(`${where} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      if (!Array.isArray(output)) {
        throw new Error(`${where} must return an array of detections`);
      }
      for (const item of output) {
        found.push(normalizeDetection(item, symbol, repository, preset, where));
      }
    }
  }
  return sortDetections(found);
}

function readsLanguage(preset: DetectionPreset, language: string): boolean {
  return (
    !preset.languages ||
    preset.languages.length === 0 ||
    preset.languages.includes(language)
  );
}

/**
 * 탐지기가 낸 값 하나를 결과 모양으로 다듬는다
 * - 저장소와 파일 경로는 심볼의 것으로 정한다(탐지기는 심볼 하나만 보므로 다른 파일의 탐지를 낼 수 없다)
 * - 심볼·줄·탐지기 이름을 비우면 심볼 이름·시작 줄·프리셋 이름으로 채우고, 신뢰도는 0~1 로 자른다
 * - 종류별로 있어야 하는 필드가 없거나 꼴이 틀리면 멈춘다
 * - 이름 필드 밖의 글 값은 비밀값 모양을 한 번 더 가린다(탐지기가 원문을 직접 읽었을 때를 막는다)
 * - 결과 파일의 바이트가 탐지기 구현에 흔들리지 않게 앞자리 필드 뒤에 나머지 필드를 이름 순으로 놓는다
 */
function normalizeDetection(
  value: unknown,
  symbol: ExtractedSymbol,
  repository: string,
  preset: DetectionPreset,
  where: string,
): Detection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} returned a detection that is not an object`);
  }
  const raw = value as Record<string, unknown>;
  const kind = raw.kind as DetectionKind;
  if (!DETECTION_KINDS.includes(kind)) {
    throw new Error(
      `${where} returned an unknown detection kind ${String(raw.kind)}`,
    );
  }
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)) {
    throw new Error(
      `${where}: ${kind} confidence must be a number from 0 to 1`,
    );
  }
  checkRequiredFields(raw, kind, where);
  const detection: Record<string, unknown> = {
    kind,
    repository,
    filePath: symbol.filePath,
    symbol: nonEmptyText(raw.symbol) ?? symbol.symbol,
    line:
      Number.isInteger(raw.line) && (raw.line as number) > 0
        ? raw.line
        : symbol.lineStart,
    detector: nonEmptyText(raw.detector) ?? preset.name,
    confidence: Math.min(1, Math.max(0, raw.confidence)),
    evidence: typeof raw.evidence === 'string' ? raw.evidence : '',
  };
  for (const key of Object.keys(raw)
    .filter((name) => !DETECTION_BASE_KEYS.includes(name))
    .sort(compareText)) {
    if (raw[key] !== undefined) {
      detection[key] = raw[key];
    }
  }
  return redactDetection(detection) as unknown as Detection;
}

function checkRequiredFields(
  detection: Record<string, unknown>,
  kind: DetectionKind,
  where: string,
): void {
  for (const [field, shape] of Object.entries(
    DETECTION_REQUIRED_FIELDS[kind],
  )) {
    const value = detection[field];
    const valid =
      shape === 'array' ? Array.isArray(value) : typeof value === shape;
    if (!valid) {
      throw new Error(`${where}: ${kind} needs ${field} (${shape})`);
    }
  }
}

function redactDetection(
  detection: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(detection).map(([key, value]) => [
      key,
      DETECTION_IDENTITY_KEYS.includes(key) ? value : redactValue(value),
    ]),
  );
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSecretValue(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactValue(child)]),
    );
  }
  return value;
}

/** 지난 결과 파일의 탐지 하나. 다시 쓸 때 다른 저장소의 탐지나 모르는 종류가 섞이지 않게 본다 */
function checkStoredDetection(
  value: unknown,
  repository: string,
  label: string,
): Detection {
  const detection = requireObject(value, label);
  if (!DETECTION_KINDS.includes(detection.kind as DetectionKind)) {
    throw new Error(`${label}: unknown kind ${String(detection.kind)}`);
  }
  if (detection.repository !== repository) {
    throw new Error(`${label}: belongs to ${String(detection.repository)}`);
  }
  for (const field of ['filePath', 'symbol', 'detector']) {
    if (nonEmptyText(detection[field]) === undefined) {
      throw new Error(`${label}: ${field} must be a non-empty string`);
    }
  }
  if (
    !Number.isInteger(detection.line) ||
    typeof detection.confidence !== 'number'
  ) {
    throw new Error(`${label}: line and confidence must be numbers`);
  }
  checkRequiredFields(detection, detection.kind as DetectionKind, label);
  return detection as unknown as Detection;
}

function countByKind(detections: readonly Detection[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const detection of detections) {
    counts[detection.kind] = (counts[detection.kind] ?? 0) + 1;
  }
  return counts;
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
