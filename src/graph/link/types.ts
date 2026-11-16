// 저장소 간 연결 단계가 주고받는 모양. 결과 파일은 src/extensions/code-knowledge.ts 계약을 그대로 쓴다
import type {
  CrossRepositoryEdge,
  CrossRepositoryGraph,
  CrossRepositoryRelation,
  CurrentSymbolRecord,
  RelationConfidence,
} from '../../extensions/code-knowledge.js';
import type { ManualLink, UnresolvedItem } from '../types.js';

/** 연결기가 만든 간선 초안. 마무리 단계가 id·위치·handlerChain·조건 실행 사실을 채워 계약 모양 간선으로 바꾼다 */
export interface LinkDraft {
  relation: CrossRepositoryRelation;
  source: CurrentSymbolRecord;
  target: CurrentSymbolRecord;
  extraction: CrossRepositoryEdge['extraction'];
  confidence: RelationConfidence;
  evidence: string[];
  /**
   * 실행 관계에서 부르는(발행하는) 쪽과 처리하는 쪽. 간선 방향과 상관없이 처리하는 쪽에서 handlerChain 을 딴다
   * 간접 관계(SHARES_*)와 패키지 의존에는 없다
   */
  roles?: LinkRoles;
}

export interface LinkRoles {
  caller: CurrentSymbolRecord;
  handler: CurrentSymbolRecord;
}

/** 연결기 하나의 결과 */
export interface LinkResult {
  drafts: LinkDraft[];
  unresolved: UnresolvedItem[];
}

/** 읽어서 모양을 검사한 수동 연결 파일 */
export interface ManualLinkSet {
  /** 설정 폴더 기준 상대 경로. 오류 메시지와 extraction.locator 에 쓴다 */
  file: string;
  links: ManualLink[];
}

export interface BuildCrossRepositoryOptions {
  /** 수동 연결. 양 끝이 레코드에 없으면 파일·순번·까닭을 밝혀 멈춘다 */
  manualLinks?: ManualLinkSet;
}

/** 저장소 간 그래프와 못 이은 항목 */
export interface CrossRepositoryBuild {
  graph: CrossRepositoryGraph;
  /** 관계·저장소·파일·줄 순서 */
  unresolved: UnresolvedItem[];
}

/** 저장소 안 CALLS 를 따라 닿은 심볼 하나 */
export interface ReachedSymbol {
  record: CurrentSymbolRecord;
  depth: number;
}

/** 경로 힌트로 정한 대상 저장소 */
export interface HttpTargetHint {
  repository: string;
  /** 프록시 접두어를 뗀 경로 */
  path: string;
  note: string;
}

/** hints.packages 에 맞은 가져오기 */
export interface PackageMatch {
  key: string;
  repository: string;
  packageName: string;
  /** 패키지 이름 뒤의 하위 경로(`@dotori/shared/money` 의 `money`). 없으면 비운다 */
  subpath?: string;
}

/** coverage 계산의 입력 */
export interface CoverageInput {
  expectedRepositories: readonly string[];
  auditedRepositories: readonly string[];
  edges: readonly CrossRepositoryEdge[];
  /** 받는 쪽 계약(처리 심볼 id) */
  providers: ReadonlySet<string>;
  maxUnresolvedRatio?: number;
}

/** 사람이 읽는 보고서 글의 선택 */
export interface FormatGraphReportOptions {
  /** 까닭마다 보일 못 이은 항목 수. 나머지는 수만 적는다 */
  itemsPerReason?: number;
}
