// 저장소 그래프 공유 타입. 설정·스냅샷·추출기·탐지기·연결기가 이 모양으로 주고받는다
// 결과 레코드는 src/extensions/code-knowledge.ts 계약을 그대로 쓰고, 여기에는 만드는 과정의 모양만 둔다
import type {
  CodeSymbolRelation,
  CrossRepositoryRelation,
  ExecutionFact,
} from '../extensions/code-knowledge.js';
import type { Logger } from '../ports.js';

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
  repositories: GraphRepositoryConfig[];
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
  /** 꺼낸 파일이 있는 임시 폴더. 결과 파일에는 남기지 않는다 */
  root: string;
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
