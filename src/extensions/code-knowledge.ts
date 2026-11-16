// 코드 지식 계약. 정책은 기획서보다 코드에 먼저 반영되므로, 코드에서 뽑은 사실을 근거로 쓰려면 지식을 만드는 도구와 읽는 쪽이 같은 모양을 봐야 한다.
// 그래서 산출물 레코드(현재 심볼과 실행 사실, 변경 이벤트, 시스템 토폴로지, 저장소 간 그래프, 엔티티 관계, 필드 쓰기 색인)를 조회 계약과 따로 내보낸다.
// 산출물은 등록된 저장소의 원격 기본 브랜치, 고정 커밋에서만 만든다. 개발자 작업 트리는 쓰지 않고, 원본 저장소는 읽기만 한다.
// 비밀값 모양의 리터럴은 색인 전에 가린다. 환경 설정·CSV 데이터 파일은 경로나 확장자 문맥과 상관없이 넣지 않는다.
// 현재 심볼과 변경 이벤트는 섞지 않는다. 정적으로 확인한 연결만 관계로 잇고, 추정한 연결은 간접 관계나 빈자리로 남긴다.
import type { PolicyEvidence } from '../generation/types.js';

// ── 공통 ──

/** 코드 안의 한 자리. 저장소·경로·심볼은 내부 조사용이라 공개 답에 그대로 내보내지 않는다 */
export interface CodeLocation {
  repository: string;
  filePath: string;
  symbol: string;
  lineStart: number;
  lineEnd: number;
}

/**
 * 질문이 코드의 어느 면을 묻는지
 * - current: 지금 코드의 위치와 동작
 * - history: 언제 무엇이 바뀌었나. 과거·변경 단서가 있을 때만 이것으로 본다
 * - rationale: 왜 바뀌었나(커밋, 리뷰 기록)
 * - impact: 바꾸면 어디가 영향받나
 * - comparison: 두 시점이나 두 구현의 차이
 */
export type CodeQuestionKind =
  'current' | 'history' | 'rationale' | 'impact' | 'comparison';

// ── 산출물: 심볼과 실행 사실 ──

/**
 * 심볼 본문에서 뽑은 실행 사실의 종류
 * - condition: 분기 조건
 * - assigns: 필드나 변수에 값을 넣는다
 * - calls: 다른 심볼을 부른다
 * - returns: 값을 돌려준다
 * - throws: 예외를 던진다
 */
export type ExecutionFactKind =
  'condition' | 'assigns' | 'calls' | 'returns' | 'throws';

/** 실행 사실 하나. conditions 는 이 사실이 일어나려면 함께 참이어야 하는 바깥 분기 조건이다 */
export interface ExecutionFact {
  line: number;
  kind: ExecutionFactKind;
  /** 값을 받는 필드, 불리는 심볼처럼 사실이 가리키는 대상 */
  subject?: string;
  /** 넣거나 돌려주는 값의 요약. 비밀값 모양은 가린다 */
  value?: string;
  conditions?: string[];
}

/** 심볼이 다른 심볼·파일·저장소와 맺는 관계 하나. type 은 생성 도구가 정하는 관계 이름이다 */
export interface CodeSymbolRelation {
  type: string;
  target: {
    repository: string;
    filePath?: string;
    symbol?: string;
  };
}

/** 현재 심볼과 변경 이벤트가 함께 쓰는 필드 */
export interface CodeSymbolRecordBase {
  schemaVersion: 1;
  repository: string;
  filePath: string;
  language: string;
  symbol: string;
  /** 저장소·파일 경로·심볼 이름의 해시. 파일을 옮기거나 이름을 바꾸면 바뀐다. 옮김을 잇는 일은 변경 이벤트의 lineage 가 맡는다 */
  stableSymbolId: string;
  /** 함수, 메서드, 클래스, 상수 같은 심볼 종류 */
  kind: string;
  /** 이 레코드를 만든 커밋. 원격 기본 브랜치에 있는 커밋이어야 한다 */
  commitSha: string;
  committedAt: string;
  contentHash: string;
  /** 비밀값을 가린 원문. 산출물을 줄이려고 비워 두고 조회 때 따로 읽어도 된다 */
  content?: string;
  lineStart?: number;
  lineEnd?: number;
  /** 검색에 쓰는 짧은 설명 */
  description?: string;
  relations: CodeSymbolRelation[];
  /** 이 심볼을 실행시키는 쪽(예약 작업, 이벤트, 요청 경로)의 이름 */
  triggeredBy?: string[];
}

/** 지금 기본 브랜치에 있는 심볼 하나 */
export interface CurrentSymbolRecord extends CodeSymbolRecordBase {
  recordType: 'current_symbol';
  /** 이 심볼이 주로 받치는 정책 묶음. claim CSV 의 policy_group 과 같은 값을 쓴다. 묶음 설정이 없으면 비어 있다 */
  policyGroup?: string;
  /** 본문에서 뽑은 실행 사실. 뽑지 못하는 언어나 선언만 있는 심볼이면 비어 있다 */
  executionFacts?: ExecutionFact[];
}

// ── 산출물: 변경 이벤트 ──

/** 의미 있는 변경의 종류. signature 는 본문은 그대로이고 시그니처만 바뀐 경우다 */
export type CodeChangeKind =
  'add' | 'modify' | 'signature' | 'delete' | 'rename' | 'move' | 'revert';

/** 심볼이 옮겨지거나 이름이 바뀐 자취 */
export interface CodeSymbolLineage {
  from: { filePath: string; symbol?: string };
  to: { filePath: string; symbol?: string };
}

/** 변경을 만든 커밋의 정보. 작성자는 해시로만 남긴다 */
export interface CodeChangeMetadata {
  commitMessage: string;
  parentCommitShas?: string[];
  authorIdentityHash?: string;
  issueIds?: string[];
  /** 코드 리뷰 요청의 id */
  reviewRequestIds?: string[];
  revertsCommitSha?: string;
}

/** 심볼 하나의 의미 있는 변경 하나. 커밋마다 파일 전체를 다시 저장하지 않고 바뀐 심볼만 남긴다 */
export interface CodeChangeEventRecord extends CodeSymbolRecordBase {
  recordType: 'change_event';
  changeKind: CodeChangeKind;
  previousContentHash?: string;
  lineage?: CodeSymbolLineage;
  metadata?: CodeChangeMetadata;
}

/** 코드 지식 레코드. recordType 으로 현재와 이력을 가른다 */
export type CodeKnowledgeRecord = CurrentSymbolRecord | CodeChangeEventRecord;

// ── 산출물: 시스템 토폴로지 ──

/** 토폴로지 노드 종류 */
export type TopologyNodeType =
  | 'Repository'
  | 'File'
  | 'Class'
  | 'Function'
  | 'API'
  | 'GraphQLOperation'
  | 'Queue'
  | 'Event'
  | 'Scheduler'
  | 'DatabaseTable'
  | 'CacheKey'
  | 'ExternalService'
  | 'DocumentSection'
  | 'TestScenario'
  | 'Enum';

/**
 * 토폴로지 간선 종류. 앞의 것들은 코드에서 확인한 실행·데이터 흐름이다
 * DOCUMENTS·TESTS 는 문서와 테스트가 심볼을 가리킨다는 뜻일 뿐 현재 동작의 증명이 아니다
 * USES_ENUM 은 심볼이 열거형 멤버를 쓰는 것이고, TYPES_COLUMN 은 열거형이 테이블 컬럼 값의 범위를 정하는 것이다
 */
export type TopologyEdgeType =
  | 'CALLS'
  | 'PUBLISHES'
  | 'CONSUMES'
  | 'PRODUCES_EVENT'
  | 'HANDLES_EVENT'
  | 'READS'
  | 'WRITES'
  | 'SCHEDULES'
  | 'TRIGGERS'
  | 'DEPENDS_ON'
  | 'DOCUMENTS'
  | 'TESTS'
  | 'USES_ENUM'
  | 'TYPES_COLUMN';

/** 토폴로지 노드. id 는 그래프 안에서 하나뿐이다 */
export interface TopologyNode extends CodeLocation {
  id: string;
  type: TopologyNodeType;
  name: string;
  aliases?: string[];
  /** 이 노드를 찾은 근거의 짧은 요약 */
  evidence?: string[];
  /** 0~1. 코드 구조에서 바로 읽은 노드는 1, 탐지기가 찾은 노드는 탐지 신뢰도 가운데 가장 높은 값 */
  confidence?: number;
  commitSha?: string;
}

/** 토폴로지 간선. 위치 필드는 이 간선을 확인한 코드 자리다 */
export interface TopologyEdge extends CodeLocation {
  from: string;
  to: string;
  type: TopologyEdgeType;
  /** 높을수록 확실하다. 이름이 같다는 것만으로 찾은 간선은 낮게 둔다 */
  confidence: number;
  evidence: string[];
}

/** 저장소 안의 심볼·실행 흐름 그래프 */
export interface SystemTopologyGraph {
  schemaVersion: 1;
  generatedAt: string;
  repositories: string[];
  /** 색인에서 뺀 경로 규칙(환경 설정, 데이터 파일 등) */
  exclusions: string[];
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** 저장소 하나만 볼 때 쓰는 노드 id 와 간선 순번 */
  localGraphs: Array<{
    repository: string;
    nodeIds: string[];
    edgeIndexes: number[];
  }>;
  /** 그래프를 채운 추출기 이름과 그 산출물 */
  sources?: Array<{ kind: string; artifact?: string }>;
}

// ── 산출물: 저장소 간 그래프 ──

/**
 * 저장소 사이의 관계. HTTP·GraphQL 호출, 큐, 이벤트, 예약 실행, 패키지 의존은 명시적인 연결이다
 * SHARES_ENTITY·SHARES_CACHE_KEY 는 같은 테이블이나 같은 키를 쓴다는 간접 관계일 뿐 호출 관계가 아니다
 * 간선 방향(source → target)
 * - HTTP_CALLS·GRAPHQL_CALLS: 부르는 심볼 → 처리하는 심볼. CRON_TRIGGERS: 예약 작업 심볼 → 그 작업이 닿는 다른 저장소의 처리 심볼
 * - PUBLISHES_TO_QUEUE·PUBLISHES_EVENT: 발행 심볼 → 구독 심볼. 발행 쪽에서 본 다른 저장소 구독자가 하나뿐일 때 쓴다
 * - CONSUMES_FROM_QUEUE·HANDLES_EVENT: 구독 심볼 → 발행 심볼. 구독자가 여러 저장소에 있어 발행 쪽에서 하나를 고를 수 없을 때,
 *   구독 쪽에서 본 다른 저장소 발행자가 하나뿐이면 쓴다. 그래서 같은 짝을 두 관계로 겹쳐 잇지 않는다
 * - DEPENDS_ON_PACKAGE: 가져오는 심볼 → 패키지를 내는 저장소의 심볼. SHARES_*: 저장소 이름 순서로 이웃한 두 저장소의 자원 끝
 */
export type CrossRepositoryRelation =
  | 'HTTP_CALLS'
  | 'GRAPHQL_CALLS'
  | 'PUBLISHES_TO_QUEUE'
  | 'CONSUMES_FROM_QUEUE'
  | 'PUBLISHES_EVENT'
  | 'HANDLES_EVENT'
  | 'CRON_TRIGGERS'
  | 'SHARES_ENTITY'
  | 'SHARES_CACHE_KEY'
  | 'DEPENDS_ON_PACKAGE';

export type RelationConfidence = 'high' | 'medium' | 'low';

/** 저장소 간 관계를 무엇을 맞춰 찾았는지 */
export type CrossRepositoryExtractionKind =
  | 'route'
  | 'graphql-operation'
  | 'queue'
  | 'event'
  | 'cron'
  | 'entity'
  | 'cache-key'
  | 'package'
  | 'symbol-name'
  /** 사람이나 에이전트가 근거와 함께 적은 연결 */
  | 'manual';

/** 저장소 간 그래프의 노드. 여러 저장소에 걸친 같은 대상(경로, 큐, 테이블)을 하나로 묶는다 */
export interface CrossRepositoryNode {
  id: string;
  repositories: string[];
  symbols: string[];
  recordTypes: Array<CodeKnowledgeRecord['recordType']>;
}

/**
 * 저장소 간 간선 하나
 * - extraction: 무엇을(kind) 어디서(locator) 어떤 값(value)으로 맞췄는지
 * - handlerChain: 받는 쪽에서 실제로 처리하는 심볼까지 따라간 자리들
 * - callerConditions·handlerConditions·handlerExceptions: 부르는 쪽과 처리하는 쪽의 조건과 예외 실행 사실
 */
export interface CrossRepositoryEdge {
  id: string;
  relation: CrossRepositoryRelation;
  source: string;
  target: string;
  extraction: {
    kind: CrossRepositoryExtractionKind;
    locator: string;
    value: string;
  };
  confidence: RelationConfidence;
  evidence?: string[];
  sourceLocation?: CodeLocation;
  targetLocation?: CodeLocation;
  handlerChain?: CodeLocation[];
  callerConditions?: ExecutionFact[];
  handlerConditions?: ExecutionFact[];
  handlerExceptions?: ExecutionFact[];
}

/**
 * 저장소 간 그래프를 얼마나 덮었는지
 * 처리하는 쪽 계약 가운데 부르는 쪽과 잇지 못한 것은 unresolvedProviderContracts 로 세고, 억지로 잇지 않는다
 */
export interface CrossRepositoryCoverage {
  status: 'pass' | 'fail';
  expectedRepositories: string[];
  auditedRepositories: string[];
  relationCounts: Partial<Record<CrossRepositoryRelation, number>>;
  providerContracts: number;
  linkedProviderContracts: number;
  unresolvedProviderContracts: number;
}

/** 저장소 사이의 연결 그래프 */
export interface CrossRepositoryGraph {
  schemaVersion?: 1;
  generatedAt?: string;
  repositories?: string[];
  coverage?: CrossRepositoryCoverage;
  nodes: CrossRepositoryNode[];
  edges: CrossRepositoryEdge[];
}

// ── 산출물: 엔티티 관계 ──

export type EntityRelationKind =
  'many-to-one' | 'one-to-one' | 'one-to-many' | 'many-to-many';

/** declared 는 코드의 관계 선언에서 찾은 관계, naming 은 연결 컬럼 이름 규칙으로 추정한 관계다 */
export type EntityRelationSource = 'declared' | 'naming';

export interface EntityColumn {
  name: string;
  dataType?: string;
  comment?: string;
  /** 값 범위를 정하는 열거형 이름 */
  enumName?: string;
}

export interface EntityRelation {
  targetTable: string;
  kind: EntityRelationKind;
  source: EntityRelationSource;
  /** 이쪽 테이블이 상대를 가리킬 때 쓰는 컬럼. 상대가 이쪽을 가리키는 관계라면 비어 있다 */
  column?: string;
  /** 코드에서 관계를 들고 있는 속성 이름 */
  property?: string;
}

/** 저장 단위(테이블, 컬렉션) 하나. 같은 이름의 저장 단위를 여러 저장소가 선언해도 노드는 하나다 */
export interface EntityTableNode {
  table: string;
  /** 관계형이 아닌 저장소면 그 종류. 관계형 테이블은 비운다 */
  store?: string;
  entityNames: string[];
  policyGroups: string[];
  sources: CodeLocation[];
  columns: EntityColumn[];
  relations: EntityRelation[];
}

/** 엔티티와 테이블의 관계 그래프 */
export interface EntityRelationGraph {
  schemaVersion: 1;
  generatedAt: string;
  tables: EntityTableNode[];
}

// ── 산출물: 필드 쓰기 색인 ──

/**
 * 필드에 값을 쓰는 방식
 * - assignment: 객체 필드에 바로 대입
 * - update-builder: 쿼리 빌더의 갱신 절에 필드를 넣음
 * - update-call: 갱신 호출에 바꿀 필드 묶음을 넘김
 * - document-set: 문서 저장소의 필드 설정 연산
 */
export type FieldWriteKind =
  'assignment' | 'update-builder' | 'update-call' | 'document-set';

/** 필드 쓰기 한 건. symbol·filePath 는 조사 도구만 보고 공개 답에는 싣지 않는다 */
export interface FieldWriterEntry {
  symbolId: string;
  symbol: string;
  filePath: string;
  lineStart: number;
  kind: FieldWriteKind;
  /** 값을 받는 필드가 속한 엔티티. ORM 갱신처럼 대상을 알 때만 단다. 필드 이름만 같은 다른 엔티티와 섞지 않으려고 둔다 */
  entity?: string;
  /** 넣는 값을 줄여 쓴 글. 문자열 리터럴 내용은 가린다 */
  valueSummary: string;
  conditions?: string[];
}

/**
 * 필드 → 그 필드에 값을 쓰는 심볼 색인. 키는 `저장소:필드` 다
 * 상태 값을 다시 켜는 곳을 찾을 때 쓴다. 필드 이름만으로 읽는 쪽과 잇지 않고, 엔티티와 함께 본다
 */
export interface FieldWriterIndex {
  schemaVersion: 1;
  generatedAt: string;
  /** 키 하나에 담는 쓰기 수의 한도 */
  maxWritersPerField: number;
  writers: Record<string, FieldWriterEntry[]>;
  /** 한도를 넘어 잘라 낸 키마다 자르기 전 쓰기 수 */
  truncated: Record<string, number>;
}

// ── 조회 계약 ──

/** 현재 심볼을 찾는 조건. id, symbol, filePath 가운데 하나는 있어야 한다 */
export interface CodeSymbolQuery {
  /** stableSymbolId 전체, 또는 앞에서부터 일부 */
  id?: string;
  symbol?: string;
  repository?: string;
  filePath?: string;
  limit: number;
}

/** 현재 심볼 레코드를 찾고, 고른 심볼의 원문(비밀값 가림)을 따로 읽는다 */
export interface CodeSymbolLookup {
  findCurrentSymbols(query: CodeSymbolQuery): Promise<CurrentSymbolRecord[]>;
  loadSymbolSource(record: CurrentSymbolRecord): Promise<string | undefined>;
}

/** 현재 코드와 변경 이력을 나눠 찾는 색인 */
export interface TemporalCodeIndex {
  /** 질문에 맞는 저장소로 범위를 좁힌다. 좁힐 단서가 없으면 undefined 를 돌려 전체를 찾게 한다 */
  routeRepositories?(question: string): Promise<string[] | undefined>;
  searchCurrent(
    query: string,
    limit: number,
    repository?: string,
  ): Promise<CurrentSymbolRecord[]>;
  /** 이력 색인이 없으면 구현하지 않는다. 그때 이력 질문은 현재 코드로 답하고 그 사실을 답 앞에 밝힌다 */
  searchHistory?(
    query: string,
    limit: number,
    repository?: string,
  ): Promise<CodeChangeEventRecord[]>;
  /** 검색에서 고른 현재 심볼의 본문. 비밀값 모양은 가린 채로 준다 */
  loadCurrentSource?(record: CurrentSymbolRecord): Promise<string | undefined>;
  /** 답을 늦추지 않으려고 뒤로 미룬 캐시 쓰기를 모두 끝낸다. 백업 직전에 부른다 */
  flushPendingWrites?(): Promise<void>;
}

/** 시스템 토폴로지와 저장소 간 그래프를 읽는다. 산출물이 없거나 읽지 못하면 undefined */
export interface CodeTopologySource {
  loadSystemTopology(): Promise<SystemTopologyGraph | undefined>;
  loadCrossRepositoryGraph(): Promise<CrossRepositoryGraph | undefined>;
}

/** 엔티티 관계 그래프를 읽는다. 산출물이 없거나 읽지 못하면 undefined */
export interface EntityRelationGraphSource {
  load(): Promise<EntityRelationGraph | undefined>;
}

/** 필드 쓰기 색인을 읽는다. 산출물이 없거나 읽지 못하면 undefined */
export interface FieldWriterIndexSource {
  load(): Promise<FieldWriterIndex | undefined>;
}

/** 코드 검색이 찾은 근거 하나. 그래프를 따라갈 출발점으로도 쓴다 */
export interface CodeRetrievalEvidence {
  recordType: CodeKnowledgeRecord['recordType'];
  repository: string;
  filePath: string;
  symbol: string;
  stableSymbolId: string;
  commitSha: string;
  committedAt: string;
  record: CodeKnowledgeRecord;
}

export interface CodeGraphLookupInput {
  question: string;
  seeds: CodeRetrievalEvidence[];
}

/**
 * 코드 검색 결과를 출발점으로 실행 흐름·저장소 간 관계·엔티티 관계를 따라가 근거로 돌려준다
 * 돌려준 근거는 v0 근거 모양이라 정책 근거와 같은 묶기·답변 검사·정제를 지난다
 * 정책 우선 질문에서는 기준 정책 근거의 앞자리를 빼앗지 않는다
 */
export interface CodeGraphEvidenceLookup {
  lookup(input: CodeGraphLookupInput): Promise<PolicyEvidence[]>;
}
