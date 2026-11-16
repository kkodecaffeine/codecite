// 데이터 그래프(엔티티 관계, 필드 쓰기 색인)와 결과 검사가 쓰는 상수
import type {
  CrossRepositoryExtractionKind,
  CrossRepositoryRelation,
  EntityRelationKind,
  EntityRelationSource,
  FieldWriteKind,
  RelationConfidence,
  TopologyEdgeType,
  TopologyNodeType,
} from '../../extensions/code-knowledge.js';
import type { UnresolvedReason } from '../types.js';

// ── 결과 파일 이름 ──

export const GRAPH_ENTITIES_FILE = 'entities.json';
export const GRAPH_FIELD_WRITERS_FILE = 'field-writers.json';
export const GRAPH_CROSS_REPOSITORY_FILE = 'cross-repository.json';
export const GRAPH_REPORT_FILE = 'report.json';

// ── 엔티티 관계 ──

/** 이쪽 테이블이 상대를 가리키는 관계. 컬럼이 이쪽에 있어 연결 컬럼 이름 추정과 겹친다 */
export const OWNING_RELATION_KINDS: readonly EntityRelationKind[] = [
  'many-to-one',
  'one-to-one',
];

/**
 * 영어 복수형 가운데 규칙(s, es, ies)으로 만들 수 없는 낱말. 연결 컬럼 이름(`personId`)에서 테이블 이름(`people`)을 찾는 데만 쓴다
 * 흔한 것만 둔다. 여기 없는 낱말은 규칙 복수형과 단수형 둘 다로 찾으므로, 복수형이 틀려도 단수형 테이블 이름은 맞는다
 */
export const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
  mouse: 'mice',
  goose: 'geese',
  foot: 'feet',
  tooth: 'teeth',
  leaf: 'leaves',
  life: 'lives',
  knife: 'knives',
  wife: 'wives',
  half: 'halves',
  shelf: 'shelves',
  analysis: 'analyses',
  criterion: 'criteria',
};

/** 복수형이 단수형과 같은 낱말 */
export const UNCOUNTABLE_WORDS: readonly string[] = [
  'data',
  'metadata',
  'information',
  'news',
  'series',
  'species',
  'equipment',
  'feedback',
];

// ── 필드 쓰기 색인 ──

/** 키 하나(`저장소:필드`)에 남기는 쓰기 수 한도. 넘으면 모듈을 돌아가며 골라 자르고, 자르기 전 수를 truncated 에 남긴다 */
export const MAX_WRITERS_PER_FIELD = 100;
/** 값 요약과 조건 글 하나의 길이 한도. 넘으면 자르고 끝에 `…` 를 붙인다 */
export const FIELD_WRITER_VALUE_MAX_CHARS = 120;
/** 쓰기 하나에 남기는 바깥 조건 수. 바깥 분기부터 남긴다 */
export const FIELD_WRITER_MAX_CONDITIONS = 2;
/** 모듈로 보는 경로 앞 조각 수(`src/order/order.service.ts` → `src/order`) */
export const FIELD_WRITER_MODULE_SEGMENTS = 2;

/**
 * 운영 동작이 아닌 파일(테스트, 목, 스토리, 고정 데이터). 기본 제외를 끈 설정에서도 필드 쓰기 색인에는 넣지 않는다
 * `/` 가 없는 glob 은 경로의 어느 조각에든 맞춘다(대소문자 무시)
 */
export const FIELD_WRITER_SKIPPED_PATHS: readonly string[] = [
  'test',
  'tests',
  'testing',
  '__tests__',
  'spec',
  'specs',
  'e2e',
  'mock',
  'mocks',
  '__mocks__',
  'stub',
  'stubs',
  'fixture',
  'fixtures',
  '__fixtures__',
  'stories',
  '__stories__',
  '*.spec.*',
  '*.test.*',
  '*.e2e-spec.*',
  '*.stories.*',
  '*.story.*',
  '*.mock.*',
  '*.mocks.*',
  '*.fixture.*',
  'test_*.py',
  '*_test.py',
  'conftest.py',
];

/** 대입 대상 맨 앞이 이 이름이면 전역 객체·모듈이라 필드 쓰기로 보지 않는다(`window.title`, `process.exitCode`) */
export const FIELD_WRITER_GLOBAL_ROOTS: readonly string[] = [
  'window',
  'document',
  'globalThis',
  'global',
  'process',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'console',
  'exports',
  'sys',
];
/** 대입 대상 앞 두 조각이 이것이면 환경 변수나 내보내기라 뺀다 */
export const FIELD_WRITER_GLOBAL_PREFIXES: readonly string[] = [
  'module.exports',
  'os.environ',
];
/** 대입 대상 사이에 이 조각이 있으면 메서드 정의나 원형 바꾸기라 상태 쓰기가 아니다 */
export const FIELD_WRITER_SKIPPED_SEGMENTS: readonly string[] = [
  'prototype',
  '__proto__',
];
/** 생성자 심볼의 끝 이름. 생성자에서 매개변수를 그대로 받아 두는 대입(주입)은 상태 쓰기가 아니다 */
export const CONSTRUCTOR_NAMES: readonly string[] = [
  'constructor',
  '__init__',
  'init',
];

/** 대입 대상이 이름과 점으로만 이어진 속성 연쇄인지(`order.status`, `this.#balance`) */
export const PROPERTY_CHAIN_PATTERN =
  /^[A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)+$/;
/** 이름 하나(`orderService`) */
export const PLAIN_NAME_PATTERN = /^[A-Za-z_$][\w$]*$/;
/** 값 요약에서 다시 가리는 꼴. 실행 사실은 이미 가렸지만 프리셋이 낸 값 요약은 원문일 수 있다 */
export const QUOTED_LITERAL_PATTERN =
  /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;
export const ENVIRONMENT_READ_PATTERN =
  /\bprocess\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]*\])?|\bos\.environ(?:\.get\([^)\n]*\)|\[[^\]\n]*\])?|\bos\.getenv\([^)\n]*\)/g;

// ── 결과 검사 ──

/** 한 파일·한 검사에서 보여 줄 문제 수. 넘으면 나머지 수만 알린다 */
export const VALIDATION_MAX_ISSUES_PER_CHECK = 50;

/** 경로를 담는 키. 저장소나 결과 폴더 기준 상대 경로여야 한다 */
export const VALIDATION_PATH_KEYS: readonly string[] = [
  'filePath',
  'symbolsFile',
  'artifact',
];
/** 원문 키. 저장소 소스 글이라 이 컴퓨터의 경로만 보고, 흔한 경로 꼴은 보지 않는다 */
export const VALIDATION_CONTENT_KEY = 'content';
/**
 * 코드의 리터럴 값을 그대로 옮겨 담는 필드. 값 하나가 통째로 무작위 문자열인지 보는 검사는 이 필드에만 한다
 * 심볼·이름·연산 이름·멤버 같은 식별자 필드는 긴 낙타 표기 이름이 많아 이 검사를 하지 않는다(형식이 알려진 토큰 검사는 모든 필드에 한다)
 */
export const VALIDATION_LITERAL_KEYS: readonly string[] = [
  'value',
  'valueSummary',
  'path',
  'url',
  'host',
  'target',
  'message',
  'evidence',
];
export const VALIDATION_EXECUTION_FACTS_KEY = 'executionFacts';
/** 라우트 경로나 그것으로 만든 id 를 담는 키. `/home/…` 같은 라우트가 있어 리눅스 집 경로 꼴은 보지 않는다 */
export const VALIDATION_ROUTE_KEYS: readonly string[] = [
  'path',
  'name',
  'id',
  'aliases',
  'nodeIds',
  'from',
  'to',
  'source',
  'target',
  'value',
  'locator',
  'candidates',
];
/** 만든 컴퓨터의 경로로 보이는 꼴(맥 집 폴더, 맥 임시 폴더, 윈도 드라이브) */
export const HOME_LIKE_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|[^\w.-])\/Users\/[^/\s:{}]+\//,
  /(?:^|[^\w.-])\/(?:private\/)?var\/folders\//,
  /(?:^|[^\w.-])\/private\/(?:var|tmp)\//,
  /(?:^|[\s'"`(=,[])[A-Za-z]:[\\/]/,
  /\\Users\\/,
];
/** 리눅스 집 폴더. 라우트 키 밖에서만 본다 */
export const LINUX_HOME_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|[^\w.-])\/home\/[^/\s:{}]+\//,
  /(?:^|[^\w.-])\/root\//,
];
/** 이 컴퓨터의 경로 가운데 조각이 이보다 적은 것(`/tmp`)은 흔한 글이라 원문·라우트 키에서는 보지 않는다 */
export const MACHINE_ROOT_MIN_SEGMENTS = 2;

/** 계약의 유니온 값 목록. 객체로 적어 계약에 값이 늘면 타입 검사가 알려 준다 */
const TOPOLOGY_NODE_TYPE_SET: Record<TopologyNodeType, true> = {
  Repository: true,
  File: true,
  Class: true,
  Function: true,
  API: true,
  GraphQLOperation: true,
  Queue: true,
  Event: true,
  Scheduler: true,
  DatabaseTable: true,
  CacheKey: true,
  ExternalService: true,
  DocumentSection: true,
  TestScenario: true,
  Enum: true,
};
const TOPOLOGY_EDGE_TYPE_SET: Record<TopologyEdgeType, true> = {
  CALLS: true,
  PUBLISHES: true,
  CONSUMES: true,
  PRODUCES_EVENT: true,
  HANDLES_EVENT: true,
  READS: true,
  WRITES: true,
  SCHEDULES: true,
  TRIGGERS: true,
  DEPENDS_ON: true,
  DOCUMENTS: true,
  TESTS: true,
  USES_ENUM: true,
  TYPES_COLUMN: true,
};
const CROSS_REPOSITORY_RELATION_SET: Record<CrossRepositoryRelation, true> = {
  HTTP_CALLS: true,
  GRAPHQL_CALLS: true,
  PUBLISHES_TO_QUEUE: true,
  CONSUMES_FROM_QUEUE: true,
  PUBLISHES_EVENT: true,
  HANDLES_EVENT: true,
  CRON_TRIGGERS: true,
  SHARES_ENTITY: true,
  SHARES_CACHE_KEY: true,
  DEPENDS_ON_PACKAGE: true,
};
const EXTRACTION_KIND_SET: Record<CrossRepositoryExtractionKind, true> = {
  route: true,
  'graphql-operation': true,
  queue: true,
  event: true,
  cron: true,
  entity: true,
  'cache-key': true,
  package: true,
  'symbol-name': true,
  manual: true,
};
const RELATION_CONFIDENCE_SET: Record<RelationConfidence, true> = {
  high: true,
  medium: true,
  low: true,
};
const ENTITY_RELATION_KIND_SET: Record<EntityRelationKind, true> = {
  'many-to-one': true,
  'one-to-one': true,
  'one-to-many': true,
  'many-to-many': true,
};
const ENTITY_RELATION_SOURCE_SET: Record<EntityRelationSource, true> = {
  declared: true,
  naming: true,
};
const FIELD_WRITE_KIND_SET: Record<FieldWriteKind, true> = {
  assignment: true,
  'update-builder': true,
  'update-call': true,
  'document-set': true,
};
const UNRESOLVED_REASON_SET: Record<UnresolvedReason, true> = {
  'no-provider': true,
  'ambiguous-provider': true,
  'dynamic-target': true,
  external: true,
  'no-caller': true,
};

export const TOPOLOGY_NODE_TYPES = Object.keys(
  TOPOLOGY_NODE_TYPE_SET,
) as readonly TopologyNodeType[];
export const TOPOLOGY_EDGE_TYPES = Object.keys(
  TOPOLOGY_EDGE_TYPE_SET,
) as readonly TopologyEdgeType[];
export const CROSS_REPOSITORY_RELATIONS = Object.keys(
  CROSS_REPOSITORY_RELATION_SET,
) as readonly CrossRepositoryRelation[];
export const CROSS_REPOSITORY_EXTRACTION_KINDS = Object.keys(
  EXTRACTION_KIND_SET,
) as readonly CrossRepositoryExtractionKind[];
export const RELATION_CONFIDENCES = Object.keys(
  RELATION_CONFIDENCE_SET,
) as readonly RelationConfidence[];
export const ENTITY_RELATION_KINDS = Object.keys(
  ENTITY_RELATION_KIND_SET,
) as readonly EntityRelationKind[];
export const ENTITY_RELATION_SOURCES = Object.keys(
  ENTITY_RELATION_SOURCE_SET,
) as readonly EntityRelationSource[];
export const FIELD_WRITE_KINDS = Object.keys(
  FIELD_WRITE_KIND_SET,
) as readonly FieldWriteKind[];
export const UNRESOLVED_REASONS = Object.keys(
  UNRESOLVED_REASON_SET,
) as readonly UnresolvedReason[];
export const COVERAGE_STATUSES: readonly string[] = ['pass', 'fail'];
export const RECORD_TYPES: readonly string[] = [
  'current_symbol',
  'change_event',
];
