// 저장소 그래프 공유 타입. 설정·스냅샷·추출기·탐지기·연결기가 이 모양으로 주고받는다
// 결과 레코드는 src/extensions/code-knowledge.ts 계약을 그대로 쓰고, 여기에는 만드는 과정의 모양만 둔다
import type {
  CodeSymbolRelation,
  CrossRepositoryRelation,
  CurrentSymbolRecord,
  EntityColumn,
  EntityRelationKind,
  ExecutionFact,
  FieldWriteKind,
} from '../extensions/code-knowledge.js';
import type { Logger } from '../ports.js';
import type { SnapshotWorkspace } from './snapshot.js';

// ── 설정: codecite.graph.json ──

/** 그래프에 넣을 저장소 하나. url 과 path 가운데 하나는 있어야 한다 */
export interface GraphRepositoryConfig {
  /** 결과 파일 안에서 저장소를 부르는 이름 */
  name: string;
  /** 원격 저장소 주소. 이 주소의 기본 브랜치를 읽는다 */
  url?: string;
  /** 이미 받아 둔 저장소 경로. 작업 트리가 아니라 원격 추적 브랜치의 커밋을 따로 꺼내 읽는다 */
  path?: string;
  /** 비우면 원격 HEAD 가 가리키는 브랜치 */
  defaultBranch?: string;
  /** 읽을 경로 glob. 비우면 저장소 전체 */
  include?: string[];
  /** 뺄 경로 glob. 바닥 규칙(환경 설정·CSV·비밀 경로)은 여기 없어도 늘 뺀다 */
  exclude?: string[];
}

/** 회사 코드에 박지 않고 설정으로 받는 연결 힌트 */
export interface GraphHints {
  /** 클라이언트 코드의 주소 변수 이름 → 그 주소가 가리키는 저장소 */
  baseUrls?: Record<string, string>;
  /** 앞단 프록시 경로 접두어 → 실제로 받는 저장소 */
  proxyPrefixes?: Record<string, string>;
  /** 공유 패키지 이름이나 범위 → 그 패키지를 내는 저장소 */
  packages?: Record<string, string>;
  /** GraphQL 스키마 이름 → 리졸버를 찾을 저장소와 경로 */
  graphqlSchemas?: Record<string, { repository: string; paths?: string[] }>;
  /** 바깥 서비스 주소·이름. 이 문맥의 호출은 내부 처리기와 잇지 않는다 */
  external?: string[];
}

/** 프리셋에 없는 자체 도구를 잡는 탐지 규칙 */
export type GraphDetectorKind =
  | 'http-client'
  | 'queue-publisher'
  | 'queue-consumer'
  | 'event-publisher'
  | 'event-handler'
  | 'scheduler';

export interface GraphDetectorRule {
  kind: GraphDetectorKind;
  /** 이 호출식(`orderQueue.send`)이 보이면 잡는다 */
  call?: string;
  /** 이 데코레이터(`QueueHandler`)가 붙은 심볼을 잡는다 */
  decorator?: string;
  /** 큐·이벤트·경로 이름이 들어 있는 인자 순번 */
  nameArgument?: number;
}

/** 읽어서 검사를 마친 그래프 설정. 경로는 모두 절대 경로로 풀려 있다 */
export interface GraphConfig {
  /** 설정 파일이 있던 폴더 */
  cwd: string;
  /** 결과 파일 폴더 */
  output: string;
  /** url 저장소를 받아 두는 캐시 폴더. 저장소마다 `repos/<이름>` 아래에 둔다 */
  cache: string;
  repositories: GraphRepositoryConfig[];
  /** 끌 수 있는 기본 제외 glob(테스트·예제·마이그레이션). 바닥 규칙은 여기와 상관없이 늘 뺀다 */
  defaultExcludes: string[];
  presets: string[];
  hints: GraphHints;
  detectors: GraphDetectorRule[];
  entities: { foreignKeySuffixes: string[] };
  /** 정책 묶음 → `저장소:경로 glob` 목록 */
  groups: Record<string, string[]>;
  /** 수동 연결 파일 */
  manualLinks?: string;
  /** 자체 추출기·프리셋 모듈 경로 */
  extractorModules: string[];
  presetModules: string[];
  /** 못 이은 비율이 이 값을 넘으면 coverage 를 실패로 본다. 비우면 보지 않는다 */
  maxUnresolvedRatio?: number;
}

// ── 스냅샷 ──

/** 저장소 하나를 고정 커밋으로 꺼낸 결과 */
export interface RepositorySnapshot {
  repository: string;
  branch: string;
  commitSha: string;
  committedAt: string;
  /** 꺼낸 파일이 있는 임시 폴더. 결과 파일에는 남기지 않는다. 재사용한 저장소는 꺼내지 않아 비어 있다 */
  root?: string;
  /** 지난번과 같은 커밋이라 결과를 재사용하는지 */
  reused: boolean;
}

// ── 추출기 ──

/** 추출기에 넘기는 파일 하나. 경로는 저장소 기준 상대 경로다 */
export interface SourceFile {
  repository: string;
  filePath: string;
  content: string;
}

export interface ExtractContext {
  repository: string;
  logger: Logger;
}

/**
 * 추출기가 돌려주는 심볼 하나. 저장소·커밋·id·해시·정책 묶음은 파이프라인이 채운다
 * content 는 원문이고, 비밀값 가리기는 파이프라인이 저장하기 전에 한다
 */
export interface ExtractedSymbol {
  filePath: string;
  language: string;
  symbol: string;
  /** function, method, class, constant, enum, controller, entity, schema 등 */
  kind: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  description?: string;
  relations: CodeSymbolRelation[];
  executionFacts?: ExecutionFact[];
  triggeredBy?: string[];
  /** 호출·데코레이터 자리. 탐지 단계만 읽고 결과 레코드에는 저장하지 않는다(CodeSite 주석) */
  sites?: CodeSite[];
}

/**
 * 호출·생성·데코레이터 자리 하나. 프리셋 탐지기가 라우트 경로, 클라이언트 호출 주소, 큐·이벤트 이름 같은 인자 값을
 * 정규식 없이 구문 트리에서 읽도록 추출기가 함께 돌려주는 중간 자료다. 언어와 상관없이 같은 꼴이다
 * - 결과 레코드(CurrentSymbolRecord)의 계약은 바뀌지 않는다. sites 는 탐지에만 쓰고 결과 파일에 저장하지 않는다
 * - 클래스 데코레이터는 클래스 심볼에, 멤버·함수 데코레이터와 그 안의 호출은 그 멤버·함수 심볼에 붙는다
 * - name 은 받는 쪽까지 적은 원문이다(`axios.post`, `this.http.get`, `router.get`, `Get`, `app.task`)
 * - 인자의 literal·template·properties 값은 추출기를 떠나기 전에 비밀값 모양을 `<redacted>` 로 바꾼다
 */
export interface CodeSite {
  kind: CodeSiteKind;
  name: string;
  line: number;
  args: CodeSiteArgument[];
}

/** call: 함수 호출, new: 생성자 호출, decorator: 데코레이터(인자가 있으면 그 인자까지) */
export type CodeSiteKind = 'call' | 'new' | 'decorator';

/**
 * 자리의 인자 하나. text 말고는 읽을 수 있을 때만 채운다
 * Python 키워드 인자는 맨 뒤의 인자 하나로 모으고, 그 properties 의 키가 키워드 이름이다
 */
export interface CodeSiteArgument {
  /** 실행 사실과 같은 규칙으로 가린 원문. 문자열은 `<literal>`, 환경 변수 읽기는 `<env>` */
  text: string;
  /** 문자열 리터럴의 값 */
  literal?: string;
  /** 템플릿 문자열이나 문자열 더하기의 고정 조각. 치환 자리 사이의 글이라 substitutions 보다 하나 많다 */
  template?: string[];
  /** 템플릿의 치환 자리. template 의 조각 사이에 차례로 들어간다 */
  substitutions?: CodeSiteArgument[];
  /** 이름 하나나 멤버 연쇄(`ORDER_QUEUE`, `Queues.ORDER`, `this.queueName`). 환경 변수 읽기는 `process.env.이름`, `os.environ.이름` 꼴 */
  identifier?: string;
  /** 객체 리터럴·딕셔너리의 키 → 값 */
  properties?: Record<string, CodeSiteArgument>;
  /** 배열·리스트·튜플의 원소 */
  elements?: CodeSiteArgument[];
}

export interface ExtractionFailure {
  filePath: string;
  message: string;
}

export interface ExtractionResult {
  symbols: ExtractedSymbol[];
  failures: ExtractionFailure[];
}

/** 언어별 추출기. 같은 인터페이스로 자체 추출기를 붙인다 */
export interface SymbolExtractor {
  readonly name: string;
  /** 맡는 파일 확장자(`.ts`) */
  readonly extensions: readonly string[];
  extract(
    files: readonly SourceFile[],
    context: ExtractContext,
  ): Promise<ExtractionResult>;
}

// ── 보고서 ──

/** 연결을 못 한 까닭 */
export type UnresolvedReason =
  | 'no-provider'
  | 'ambiguous-provider'
  | 'dynamic-target'
  | 'external'
  | 'no-caller';

/** 못 이은 항목 하나. 그래프를 넓히는 일은 이 목록을 읽는 데서 시작한다 */
export interface UnresolvedItem {
  reason: UnresolvedReason;
  relation: CrossRepositoryRelation;
  repository: string;
  filePath: string;
  symbol: string;
  line?: number;
  /** 맞추려던 값(경로, 연산 이름, 큐 이름) */
  value: string;
  /** 후보가 여럿일 때 후보 심볼 */
  candidates?: string[];
}

/** 수동 연결 파일의 한 줄 */
export interface ManualLink {
  relation: CrossRepositoryRelation;
  from: { repository: string; filePath: string; symbol: string };
  to: { repository: string; filePath: string; symbol: string };
  /** 왜 이 연결이 맞는지. 코드 자리를 함께 적는다 */
  evidence: string;
  author?: string;
}

// ── 설정 읽기 ──

/** 설정 검사 실패를 알린다. 항목 이름과 까닭을 받아 throw 한다 */
export type GraphConfigFail = (field: string, detail: string) => never;

export interface LoadGraphConfigOptions {
  /** 설정 파일 경로. 비우면 `<cwd>/codecite.graph.json`. 설정 안의 상대 경로는 이 파일이 있는 폴더 기준이다 */
  file?: string;
}

// ── 스냅샷 과정 ──

/** 원격 기본 브랜치에서 읽을 커밋. 꺼내기 전에 정해 지난 결과와 비교한다 */
export interface RepositoryHead {
  branch: string;
  commitSha: string;
}

/** git 한 번 부르기 */
export interface GitRunOptions {
  cwd?: string;
  /** 오류 메시지 앞에 붙일 저장소 이름 */
  repository?: string;
  /** 비우면 기다림에 상한이 없다 */
  timeoutMs?: number;
}

// ── 파일 고르기 ──

/** 저장소 하나에 거는 파일 고르기 규칙 */
export interface FileSelectionRules {
  /** 비우면 저장소 전체 */
  include?: readonly string[];
  exclude?: readonly string[];
  defaultExcludes: readonly string[];
  /** 추출기가 맡는 확장자. 주면 여기 없는 확장자는 읽지 않는다 */
  extensions?: readonly string[];
}

/** 고르지 않은 파일 수를 까닭별로 센다. 그래프가 조용히 비는 일을 알아채려고 남긴다 */
export interface FileSkipCounts {
  /** 바닥 규칙(환경 설정·CSV·비밀 경로·의존성 폴더) */
  floor: number;
  /** 기본 제외(테스트·예제·마이그레이션) */
  defaultExcludes: number;
  /** 저장소 exclude */
  exclude: number;
  /** 저장소 include 에 맞지 않음 */
  notIncluded: number;
  /** 맡는 추출기가 없는 확장자 */
  unsupported: number;
  /** 글이 아닌 파일 */
  binary: number;
  /** 크기 상한을 넘는 파일 */
  tooLarge: number;
}

export interface FileSelection {
  /** 고른 파일. 저장소 기준 상대 경로, 정렬돼 있다 */
  selected: string[];
  skipped: FileSkipCounts;
}

// ── 레코드 ──

/** 레코드를 만들 때 저장소마다 같은 값 */
export interface RecordContext {
  repository: string;
  commitSha: string;
  committedAt: string;
  /** 설정 groups. 파일이 받치는 정책 묶음을 정한다 */
  groups: Record<string, string[]>;
}

/** 정책 묶음 규칙 하나. 설정 groups 의 `저장소:경로 glob` 을 푼 것이다 */
export interface GraphGroupRule {
  group: string;
  repository: string;
  glob: string;
  /** glob 에서 와일드카드를 뺀 글자 수. 클수록 좁은 규칙이다 */
  specificity: number;
  /** 설정에 적은 순서 */
  order: number;
}

// ── 결과 파일 ──

/** manifest.json 의 저장소 한 줄. 경로는 결과 폴더 기준 상대 경로만 쓴다 */
export interface GraphManifestRepository {
  name: string;
  branch: string;
  commitSha: string;
  committedAt: string;
  /** 이 저장소 결과를 만든 입력(설정 일부·도구 판·추출기)의 지문. 커밋과 함께 같으면 다음 번에 재사용한다 */
  inputFingerprint: string;
  /** `symbols/<이름>.jsonl` */
  symbolsFile: string;
  symbolCount: number;
  /** 추출기에 넘긴 파일 수 */
  fileCount: number;
  skippedFiles: FileSkipCounts;
  /** 추출기가 건너뛴 파일과 까닭. 메시지의 로컬 경로와 비밀값 모양은 지운다 */
  failures: ExtractionFailure[];
}

/** 결과 폴더의 manifest.json. 같은 커밋·같은 설정이면 바이트 단위로 같다 */
export interface GraphManifest {
  schemaVersion: 1;
  /** 저장소 커밋 시각 가운데 가장 늦은 것. 만든 시각을 넣지 않아야 같은 입력에 같은 출력이 나온다 */
  generatedAt: string;
  tool: { name: string; version: string };
  /** 설정 지문. 로컬 경로와 주소의 계정 정보는 빼고 만든다 */
  configFingerprint: string;
  /** 이름 순서 */
  repositories: GraphManifestRepository[];
}

/** 한 번에 쓰는 결과 파일 묶음 */
export interface GraphOutputs {
  manifest: GraphManifest;
  /** 저장소 이름 → 레코드 */
  symbols: ReadonlyMap<string, readonly CurrentSymbolRecord[]>;
  /** 결과 폴더 안 파일 이름 → JSON 값 */
  artifacts: ReadonlyMap<string, unknown>;
}

// ── 파이프라인 ──

export interface BuildCodeGraphOptions {
  logger?: Logger;
  /** 확장자로 골라 부르는 추출기. 설정의 extractorModules 에서 읽은 추출기 앞에 둔다 */
  extractors?: readonly SymbolExtractor[];
  /** 걸린 시간을 재는 시계. 결과 파일에는 쓰지 않는다 */
  now?: () => Date;
  /** 심볼 수가 절반 아래로 줄어도 멈추지 않을 저장소 이름. 줄어든 까닭을 확인한 뒤에만 쓴다 */
  acceptSymbolDrop?: readonly string[];
}

/** 저장소 하나를 만들 때 파이프라인이 넘기는 것 */
export interface RepositoryBuildContext {
  config: GraphConfig;
  extractors: readonly SymbolExtractor[];
  /** 확장자(소문자) → 추출기 */
  routes: ReadonlyMap<string, SymbolExtractor>;
  toolVersion: string;
  /** 지난 manifest 의 이 저장소 줄 */
  previous: GraphManifestRepository | undefined;
  workspace: SnapshotWorkspace;
  /** 실패 메시지에서 지울 이 컴퓨터의 경로 */
  localRoots: readonly string[];
  logger: Logger;
  acceptSymbolDrop: readonly string[];
}

/** 저장소 하나의 만들기 결과 */
export interface RepositoryBuild {
  snapshot: RepositorySnapshot;
  manifest: GraphManifestRepository;
  /** 파일 경로·시작 줄·심볼 이름 순서 */
  records: CurrentSymbolRecord[];
  /**
   * 추출기가 돌려준 심볼 그대로(탐지 단계가 쓰는 중간 데이터 포함). 메모리에만 두고 결과 파일에는 쓰지 않는다
   * 재사용한 저장소는 다시 추출하지 않으므로 비어 있다
   */
  extracted?: ExtractedSymbol[];
}

/**
 * 파이프라인 단계가 주고받는 상태. 탐지·연결 단계는 records 를 읽고 결과를 artifacts 에 넣는다
 * artifacts 의 키는 결과 폴더 안 파일 이름(`topology.json`)이고, 값은 JSON 으로 쓴다
 */
export interface GraphBuildState {
  config: GraphConfig;
  /** 저장소 이름 순서 */
  repositories: RepositoryBuild[];
  /** 모든 저장소의 레코드. 저장소 이름 순서 */
  records: CurrentSymbolRecord[];
  artifacts: Map<string, unknown>;
}

export interface CodeGraphBuildResult {
  /** 결과 폴더(절대 경로). 결과 파일 안에는 쓰지 않는다 */
  output: string;
  manifest: GraphManifest;
  /** 저장소마다 지난 결과를 재사용했는지 */
  reused: Record<string, boolean>;
  records: CurrentSymbolRecord[];
  /** 쓴 파일. 결과 폴더 기준 상대 경로 */
  files: string[];
  durationMs: number;
}

// ── 탐지 ──

/**
 * 탐지 결과 공통 필드. 탐지는 심볼의 sites·실행 사실·관계를 보고 `제공 쪽`(라우트, 리졸버, 구독자)과 `부르는 쪽`(호출, 연산, 발행) 사실을 낸다
 * 연결(저장소 간 그래프)과 토폴로지는 이 결과만 보고 잇는다. 주석·문자열 안의 낱말로는 탐지하지 않는다
 */
export interface DetectionBase {
  repository: string;
  filePath: string;
  /** 탐지가 붙은 심볼 이름(`OrderController.cancel`) */
  symbol: string;
  line: number;
  /** 낸 탐지기 이름. 프리셋 이름이거나 설정 규칙이면 `rule:<순번>` */
  detector: string;
  /** 0~1. 탐지기마다 정한 값 */
  confidence: number;
  /** 사람이 읽는 짧은 근거. 비밀값·절대 경로를 넣지 않는다 */
  evidence: string;
}

/** 받는 HTTP 경로. path 는 정규화한 꼴(앞 `/`, 매개변수는 `:param`, 끝 `/` 없음) */
export interface HttpRouteDetection extends DetectionBase {
  kind: 'http-route';
  /** 대문자 메서드. 모든 메서드를 받으면 `*` */
  method: string;
  path: string;
}

/** 부르는 HTTP 호출 */
export interface HttpCallDetection extends DetectionBase {
  kind: 'http-call';
  method: string;
  /** 정적으로 읽은 경로(정규화). 못 읽었으면 비운다 */
  path?: string;
  /** 주소 앞부분이 나온 식별자(`SHOP_API_URL`, `process.env.SHOP_API_URL`, `this.baseUrl`). hints.baseUrls 로 대상 저장소를 좁힌다 */
  baseIdentifiers: string[];
  /** 주소에 적힌 호스트. hints.external 과 견준다 */
  host?: string;
  /** 경로 일부가 실행 중에 정해져 정적으로 다 읽지 못했는지 */
  dynamic: boolean;
}

export type GraphqlOperationType = 'query' | 'mutation' | 'subscription';

/** 받는 GraphQL 루트 필드 */
export interface GraphqlResolverDetection extends DetectionBase {
  kind: 'graphql-resolver';
  operationType: GraphqlOperationType;
  field: string;
}

/** 이름 붙은 GraphQL 연산 문서(.graphql 파일이나 gql 태그 글) */
export interface GraphqlDocumentDetection extends DetectionBase {
  kind: 'graphql-document';
  operationType: GraphqlOperationType;
  operationName: string;
  rootFields: string[];
  /** 문서가 속한 스키마 이름. hints.graphqlSchemas 의 키 */
  schema?: string;
}

/** 클라이언트 코드가 연산을 부르는 자리(생성된 훅·문서 상수·클라이언트 메서드) */
export interface GraphqlClientCallDetection extends DetectionBase {
  kind: 'graphql-client-call';
  operationName: string;
  schema?: string;
}

/** 큐·이벤트 발행과 구독. name 은 정규화 전 원래 이름 */
export interface MessageDetection extends DetectionBase {
  kind: 'queue-publish' | 'queue-consume' | 'event-publish' | 'event-handle';
  name: string;
  /** 이름을 정적으로 못 읽었는지 */
  dynamic: boolean;
}

/** 예약 작업. 이 심볼이 일정에 따라 실행된다 */
export interface ScheduleDetection extends DetectionBase {
  kind: 'schedule';
  /** cron 식, 주기 설명, 또는 정적으로 못 읽으면 `runtime` */
  expression: string;
}

/** 엔티티(테이블·컬렉션) 선언 */
export interface EntityDeclarationDetection extends DetectionBase {
  kind: 'entity-declaration';
  table: string;
  className: string;
  /** 관계형이 아닌 저장소면 그 종류(`document` 등) */
  store?: string;
  columns: EntityColumn[];
  relations: Array<{
    /** 상대 엔티티 클래스 이름. 연결 단계가 테이블 이름으로 푼다 */
    targetClass: string;
    kind: EntityRelationKind;
    column?: string;
    property?: string;
  }>;
}

/** 엔티티·캐시를 읽고 쓰는 자리 */
export interface DataAccessDetection extends DetectionBase {
  kind: 'entity-read' | 'entity-write' | 'cache-read' | 'cache-write';
  /** 엔티티 클래스 이름, 테이블 이름, 또는 캐시 키 */
  target: string;
  targetType: 'class' | 'table' | 'key';
}

/** 필드에 값을 쓰는 자리(ORM 갱신 패턴). 대입문은 연결 단계가 실행 사실에서 따로 모은다 */
export interface FieldWriteDetection extends DetectionBase {
  kind: 'field-write';
  entity?: string;
  field: string;
  writeKind: FieldWriteKind;
  valueSummary: string;
  conditions?: string[];
}

export type Detection =
  | HttpRouteDetection
  | HttpCallDetection
  | GraphqlResolverDetection
  | GraphqlDocumentDetection
  | GraphqlClientCallDetection
  | MessageDetection
  | ScheduleDetection
  | EntityDeclarationDetection
  | DataAccessDetection
  | FieldWriteDetection;

export type DetectionKind = Detection['kind'];

/** 탐지기에 넘기는 저장소 문맥 */
export interface PresetContext {
  repository: string;
  config: GraphConfig;
  logger: Logger;
  /**
   * 같은 저장소의 상수 이름(`ORDER_QUEUE`, `Queues.ORDER`)을 문자열 값으로 푼다. 못 풀면 undefined
   * 실행 사실은 문자열을 가리므로 상수 심볼의 원문에서 푼다
   */
  resolveConstant(identifier: string): string | undefined;
  /**
   * 같은 저장소에서 꺼낸 심볼 전부(파일 경로·시작 줄 순서). 다른 심볼을 봐야 하는 탐지에 쓴다
   * 예: 메서드 경로에 클래스의 기본 경로 붙이기, 같은 파일의 처리 함수 찾기, `axios.create` 로 만든 인스턴스 알아보기
   * 같은 배열이 저장소마다 한 번 넘어오므로 탐지기는 이 배열을 열쇠로 색인을 한 번만 만들어 쓴다
   */
  symbols?: readonly ExtractedSymbol[];
}

/**
 * 프레임워크 탐지 프리셋. 설정 presets 의 이름으로 켠다
 * 같은 인터페이스로 자체 프리셋을 만들어 presetModules 에 넣는다. 회사 고유 규칙은 프리셋이 아니라 설정 detectors 로 둔다
 */
export interface DetectionPreset {
  readonly name: string;
  /** 보는 언어(ExtractedSymbol.language). 비우면 모든 언어 */
  readonly languages?: readonly string[];
  detect(symbol: ExtractedSymbol, context: PresetContext): Detection[];
}
