// 연결기들이 함께 쓰는 문맥: 레코드 찾기, 탐지 고르기, 신뢰도, 못 이은 항목 만들기
import type {
  CrossRepositoryRelation,
  CurrentSymbolRecord,
  RelationConfidence,
} from '../../extensions/code-knowledge.js';
import { sortDetections } from '../detect.js';
import { MODULE_SYMBOL_KIND } from '../extractors/constants.js';
import { compareText } from '../files.js';
import { compareRecords } from '../records.js';
import type {
  Detection,
  DetectionKind,
  GraphBuildState,
  GraphConfig,
  UnresolvedItem,
  UnresolvedReason,
} from '../types.js';
import {
  ENV_IDENTIFIER_PREFIXES,
  EXECUTION_RELATIONS,
  HANDLER_SOURCE_RELATIONS,
  LINK_HIGH_DETECTION_FLOOR,
  LINK_MEDIUM_DETECTION_FLOOR,
  RELATION_CONFIDENCE_RANK,
} from './constants.js';
import { CallGraph } from './handler-chain.js';
import type { LinkRoles } from './types.js';

/**
 * 연결 단계의 읽기 전용 문맥. 입력 순서와 상관없이 같은 출력이 나오도록 레코드와 탐지를 다시 정렬해 둔다
 * 탐지는 붙은 심볼의 레코드로 찾고, 레코드가 없으면 그 파일의 모듈 심볼(파일 최상위 문장 묶음)로 찾는다
 */
export class LinkContext {
  readonly config: GraphConfig;
  /** 설정의 저장소 이름 순서 */
  readonly repositories: string[];
  /** 저장소 → 파일 경로·시작 줄 순서의 레코드 */
  readonly recordsByRepository = new Map<string, CurrentSymbolRecord[]>();
  readonly calls: CallGraph;
  private readonly byLocation = new Map<string, CurrentSymbolRecord>();
  private readonly modules = new Map<string, CurrentSymbolRecord>();
  private readonly detectionsByKind = new Map<DetectionKind, Detection[]>();

  constructor(readonly state: GraphBuildState) {
    this.config = state.config;
    this.repositories = state.config.repositories
      .map((repository) => repository.name)
      .sort(compareText);
    const records = [...state.records].sort(
      (left, right) =>
        compareText(left.repository, right.repository) ||
        compareRecords(left, right),
    );
    for (const record of records) {
      const list = this.recordsByRepository.get(record.repository) ?? [];
      list.push(record);
      this.recordsByRepository.set(record.repository, list);
      const key = locationKey(
        record.repository,
        record.filePath,
        record.symbol,
      );
      if (!this.byLocation.has(key)) {
        this.byLocation.set(key, record);
      }
      const fileKey = locationKey(record.repository, record.filePath);
      if (record.kind === MODULE_SYMBOL_KIND && !this.modules.has(fileKey)) {
        this.modules.set(fileKey, record);
      }
    }
    for (const repository of [...state.detections.keys()].sort(compareText)) {
      for (const detection of sortDetections(
        state.detections.get(repository) ?? [],
      )) {
        const list = this.detectionsByKind.get(detection.kind) ?? [];
        list.push(detection);
        this.detectionsByKind.set(detection.kind, list);
      }
    }
    this.calls = new CallGraph(state.topology, this);
  }

  /** 이 종류의 탐지 전부. 저장소 이름 → 파일 경로 → 줄 순서 */
  detectionsOf<K extends DetectionKind>(
    ...kinds: K[]
  ): Array<Extract<Detection, { kind: K }>> {
    const result: Detection[] = [];
    for (const kind of kinds) {
      result.push(...(this.detectionsByKind.get(kind) ?? []));
    }
    return (
      kinds.length > 1 ? sortAcrossRepositories(result) : result
    ) as Array<Extract<Detection, { kind: K }>>;
  }

  recordAt(
    repository: string,
    filePath: string,
    symbol: string,
  ): CurrentSymbolRecord | undefined {
    return this.byLocation.get(locationKey(repository, filePath, symbol));
  }

  /** 파일의 모듈 심볼 레코드 */
  moduleOf(
    repository: string,
    filePath: string,
  ): CurrentSymbolRecord | undefined {
    return this.modules.get(locationKey(repository, filePath));
  }

  /** 탐지가 붙은 심볼의 레코드. 없으면 그 파일의 모듈 심볼 */
  recordFor(detection: Detection): CurrentSymbolRecord | undefined {
    return (
      this.recordAt(
        detection.repository,
        detection.filePath,
        detection.symbol,
      ) ?? this.moduleOf(detection.repository, detection.filePath)
    );
  }
}

/** 못 이은 항목의 후보와 근거 글에 쓰는 심볼 이름(`shop-api:src/order/order.controller.ts#OrderController.cancel`) */
export function recordLabel(record: {
  repository: string;
  filePath: string;
  symbol: string;
}): string {
  return `${record.repository}:${record.filePath}#${record.symbol}`;
}

/** 탐지에서 못 이은 항목을 만든다. 위치는 탐지 자리다 */
export function unresolvedAt(
  detection: Detection,
  relation: CrossRepositoryRelation,
  reason: UnresolvedReason,
  value: string,
  candidates: readonly CurrentSymbolRecord[] = [],
): UnresolvedItem {
  return {
    reason,
    relation,
    repository: detection.repository,
    filePath: detection.filePath,
    symbol: detection.symbol,
    line: detection.line,
    value,
    ...(candidates.length > 0
      ? { candidates: candidates.map(recordLabel).sort(compareText) }
      : {}),
  };
}

/** 레코드에서 못 이은 항목을 만든다. 위치는 레코드 시작 줄이다 */
export function unresolvedForRecord(
  record: CurrentSymbolRecord,
  relation: CrossRepositoryRelation,
  reason: UnresolvedReason,
  value: string,
  candidates: readonly CurrentSymbolRecord[] = [],
): UnresolvedItem {
  return {
    reason,
    relation,
    repository: record.repository,
    filePath: record.filePath,
    symbol: record.symbol,
    ...(record.lineStart !== undefined ? { line: record.lineStart } : {}),
    value,
    ...(candidates.length > 0
      ? { candidates: candidates.map(recordLabel).sort(compareText) }
      : {}),
  };
}

/**
 * 관계 신뢰도. 설정 힌트로 대상 저장소를 좁혔으면 high, 힌트 없이 하나뿐이면 medium 에서 시작하고,
 * 연결에 쓴 탐지 가운데 가장 낮은 탐지 신뢰도가 허락하는 값을 넘지 않는다
 */
export function relationConfidence(
  hinted: boolean,
  detectionConfidences: readonly number[],
): RelationConfidence {
  const lowest = Math.min(1, ...detectionConfidences);
  const allowed: RelationConfidence =
    lowest >= LINK_HIGH_DETECTION_FLOOR
      ? 'high'
      : lowest >= LINK_MEDIUM_DETECTION_FLOOR
        ? 'medium'
        : 'low';
  return atMost(hinted ? 'high' : 'medium', allowed);
}

/** 두 신뢰도 가운데 낮은 쪽 */
export function atMost(
  value: RelationConfidence,
  cap: RelationConfidence,
): RelationConfidence {
  return RELATION_CONFIDENCE_RANK[value] <= RELATION_CONFIDENCE_RANK[cap]
    ? value
    : cap;
}

/**
 * 실행 관계의 부르는 쪽과 처리하는 쪽. CONSUMES_FROM_QUEUE·HANDLES_EVENT 는 source 가 처리하는 쪽이다
 * 실행 관계가 아니면 undefined
 */
export function rolesFor(
  relation: CrossRepositoryRelation,
  source: CurrentSymbolRecord,
  target: CurrentSymbolRecord,
): LinkRoles | undefined {
  if (!EXECUTION_RELATIONS.includes(relation)) {
    return undefined;
  }
  return HANDLER_SOURCE_RELATIONS.includes(relation)
    ? { caller: target, handler: source }
    : { caller: source, handler: target };
}

/** 같은 레코드를 한 번만 남긴다(처음 나온 순서) */
export function uniqueRecords(
  records: readonly CurrentSymbolRecord[],
): CurrentSymbolRecord[] {
  const seen = new Map<string, CurrentSymbolRecord>();
  for (const record of records) {
    if (!seen.has(record.stableSymbolId)) {
      seen.set(record.stableSymbolId, record);
    }
  }
  return [...seen.values()];
}

/**
 * 코드의 주소 변수 이름이 설정에 적은 이름을 가리키는지. 환경 변수 읽기 꼴(`process.env.`, `os.environ.`)은 떼고 보고,
 * 멤버 연쇄의 끝이 그 이름이어도 맞는 것으로 본다(`this.config.SHOP_API_URL`)
 */
export function identifierMatches(identifier: string, name: string): boolean {
  const bare = stripEnvPrefix(identifier.trim());
  const wanted = stripEnvPrefix(name.trim());
  return wanted !== '' && (bare === wanted || bare.endsWith(`.${wanted}`));
}

function stripEnvPrefix(text: string): string {
  const prefix = ENV_IDENTIFIER_PREFIXES.find((candidate) =>
    text.startsWith(candidate),
  );
  return prefix ? text.slice(prefix.length) : text;
}

function locationKey(...parts: string[]): string {
  return parts.join('\0');
}

function sortAcrossRepositories(detections: Detection[]): Detection[] {
  return [...detections].sort(
    (left, right) =>
      compareText(left.repository, right.repository) ||
      compareText(left.filePath, right.filePath) ||
      left.line - right.line ||
      compareText(left.symbol, right.symbol) ||
      compareText(left.kind, right.kind),
  );
}
