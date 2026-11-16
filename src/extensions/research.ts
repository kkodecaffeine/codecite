// 조사 루프 계약. 원인을 찾아야 하는 질문은 검색 한 번으로 답이 나오지 않아, 모델이 읽기 전용 도구를 골라 몇 번 더 찾게 한다.
// 루프는 쓰는 쪽 코드가 돌리고, 모델은 턴마다 부를 도구 이름과 인자만 고른다. 도구는 지식 산출물과 코드 색인만 읽고 아무것도 쓰지 않는다.
// 턴·도구 호출·시간·모은 근거·결과 길이는 예산으로 묶는다. 예산을 다 쓰면 그때까지 모은 근거로 답한다.
// 근거 id 는 도구가 실제로 돌려준 것만 받는다. 조사 근거도 단일 경로와 같은 묶기·답변 검사·계약·정제를 지난다.
// 루프나 모델이 실패해도 던지지 않고, 단일 경로가 이미 만든 첫 답과 근거를 그대로 쓴다.
import type { PolicyEvidence } from '../generation/types.js';
import type {
  PolicyRetrievalCandidate,
  RetrievalOptions,
} from '../retrieval/types.js';
import type {
  CodeSymbolLookup,
  CodeTopologySource,
  CurrentSymbolRecord,
  EntityRelationGraphSource,
  FieldWriterIndexSource,
  TemporalCodeIndex,
} from './code-knowledge.js';

// ── 도구 이름 ──

/**
 * 조사 모델에게 넘기는 읽기 전용 도구 이름
 * - searchPolicy: claim 하이브리드 검색
 * - searchPolicyKeyword: 정확한 이름·숫자를 BM25 로만 찾기
 * - searchCode: 현재 코드 심볼 검색. 이름이 정확히 맞는 심볼을 앞에 둔다
 * - readSymbol: 심볼 하나의 원문(비밀값 가림). 잘린 뒤쪽의 분기 줄과 참조 심볼을 덧붙인다
 * - findCallers·findCallees: 호출 관계 한 단계
 * - findClientCalls: 클라이언트 함수와 서버 처리기의 연결
 * - findFieldWriters: 필드에 값을 넣는 심볼
 * - findEntityRelations: 엔티티 테이블의 컬럼과 다른 테이블과의 관계
 */
export const RESEARCH_TOOL_NAMES = Object.freeze([
  'searchPolicy',
  'searchPolicyKeyword',
  'searchCode',
  'readSymbol',
  'findCallers',
  'findCallees',
  'findClientCalls',
  'findFieldWriters',
  'findEntityRelations',
] as const);

export type ResearchToolName = (typeof RESEARCH_TOOL_NAMES)[number];

/** 조사를 끝낼 때 모델이 부르는 도구 이름. 결론과 근거 id 를 함께 받는다 */
export const RESEARCH_FINISH_TOOL_NAME = 'finish';

// ── 예산 ──

/** 조사 루프 예산. 어느 하나라도 다 쓰면 루프를 멈추고 모은 근거로 답한다 */
export interface ResearchBudget {
  /** 모델 턴 수 */
  maxTurns: number;
  /** 한 턴에 실행하는 도구 호출 수. 넘친 호출은 실행하지 않고 기록만 한다 */
  maxToolCallsPerTurn: number;
  /** 루프 전체의 도구 호출 수 */
  maxToolCalls: number;
  /** 루프 전체 시간 */
  timeoutMs: number;
  /** 답변 단계로 넘기는 조사 근거 수 */
  maxEvidenceItems: number;
  /** 도구 결과 요약 하나의 길이. 넘치면 자르고 잘렸다고 표시한다 */
  maxToolResultChars: number;
}

/** 조사 루프 예산 기본값. 쉬운 질문의 속도와 비용을 지키도록 작게 잡은 엔진 조율값이다 */
export const DEFAULT_RESEARCH_BUDGET: Readonly<ResearchBudget> = Object.freeze({
  maxTurns: 6,
  maxToolCallsPerTurn: 4,
  maxToolCalls: 16,
  timeoutMs: 60_000,
  maxEvidenceItems: 12,
  maxToolResultChars: 4_000,
});

/** 조사 근거를 묶는 한도. 원인 설명에는 노출 조건과 상태를 바꾸는 코드가 함께 필요해 단일 경로보다 넓다 */
export interface ResearchPackingLimits {
  maxItems: number;
  maxTotalChars: number;
  maxItemChars: number;
  /** 조사 근거를 앞에 둘 때도 단일 경로의 앞 근거(기준 정책 근거)에 남겨 두는 자리 */
  reservedLeadingItems: number;
}

/** 조사 근거 묶기 한도 기본값 */
export const DEFAULT_RESEARCH_PACKING: Readonly<ResearchPackingLimits> =
  Object.freeze({
    maxItems: 8,
    maxTotalChars: 9_000,
    maxItemChars: 3_200,
    reservedLeadingItems: 2,
  });

// ── 도구 인자 ──

export interface SearchPolicyArgs {
  query: string;
  limit?: number;
}

export interface SearchCodeArgs {
  query: string;
  repository?: string;
  limit?: number;
}

export interface ReadSymbolArgs {
  /** 다른 도구가 돌려준 id, 그래프 노드 id, 또는 `Type.member` 꼴의 심볼 이름 */
  symbol: string;
  repository?: string;
  /** 원문이 길 때 이 낱말이 처음 보이는 자리부터 읽는다 */
  focus?: string;
}

export interface FindCallsArgs {
  symbol: string;
  repository?: string;
  limit?: number;
}

export interface FindClientCallsArgs {
  /** 클라이언트 함수, 서버 처리기, 요청 작업 이름 가운데 하나 */
  target: string;
  limit?: number;
}

export interface FindFieldWritersArgs {
  field: string;
  repository?: string;
  /** 이 값을 넣는 쓰기로 좁힌다. 변수나 식을 넣는 쓰기는 값을 몰라 버리지 않는다 */
  value?: string;
  /** 심볼 이름이나 경로가 이 낱말을 담은 쓰기부터 보인다 */
  query?: string;
  limit?: number;
}

export interface FindEntityRelationsArgs {
  entity: string;
  limit?: number;
}

/** 조사 끝 선언의 인자. evidenceIds 는 중요한 것부터 쓴다 */
export interface FinishResearchArgs {
  conclusion: string;
  evidenceIds: string[];
}

/** 도구 이름마다 받는 인자 */
export interface ResearchToolArgumentMap {
  searchPolicy: SearchPolicyArgs;
  searchPolicyKeyword: SearchPolicyArgs;
  searchCode: SearchCodeArgs;
  readSymbol: ReadSymbolArgs;
  findCallers: FindCallsArgs;
  findCallees: FindCallsArgs;
  findClientCalls: FindClientCallsArgs;
  findFieldWriters: FindFieldWritersArgs;
  findEntityRelations: FindEntityRelationsArgs;
}

/** 모델에게 넘기는 도구 설명. parameters 는 JSON Schema 다 */
export interface ResearchToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ── 도구 결과 ──

/**
 * 도구가 돌려준 근거 후보의 종류
 * - policy: claim
 * - code: 현재 코드 심볼(검색 결과나 원문)
 * - code-link: 호출 관계 한 단계
 * - client-call: 클라이언트 함수와 서버 처리기의 연결
 * - field-writer: 필드에 값을 넣는 코드 자리
 * - entity: 엔티티 테이블과 관계
 * 모델이 끝을 선언하지 않고 멈추면 원문을 읽은 코드 → 상태를 바꾸는 코드 → claim → 호출 연결 순으로 근거를 고른다
 */
export type ResearchItemKind =
  'policy' | 'code' | 'code-link' | 'client-call' | 'field-writer' | 'entity';

/** 근거 후보가 있는 코드 자리. 다음 도구 인자를 고르는 재료일 뿐 공개 답에 싣지 않는다 */
export interface ResearchItemLocation {
  repository?: string;
  filePath?: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
}

/**
 * 근거 후보 하나. 모델이 조사를 끝낼 때 이 id 로 근거를 가리킨다
 * title·text·location 은 조사 안에서만 쓴다. 답의 재료가 되려면 v0 근거 모양으로 바뀐 뒤 정제를 지나야 한다
 */
export interface ResearchItem {
  id: string;
  kind: ResearchItemKind;
  /** 도구 결과 목록에 찍히는 짧은 제목 */
  title: string;
  /** 후보의 내용. 코드 조각이나 관계를 풀어 쓴 문장 */
  text: string;
  location: ResearchItemLocation;
  /** claim 후보면 검색이 준 근거 그대로. v0 근거로 바꿀 때 손대지 않는다 */
  policyEvidence?: PolicyEvidence;
  /** 코드 후보면 그 심볼의 현재 레코드 */
  codeRecord?: CurrentSymbolRecord;
  /** readSymbol 로 읽은 본문. 비밀값 모양은 이미 가려져 있다 */
  source?: string;
  policyGroup?: string;
}

/** 도구 호출 결과. summary 는 모델이 읽는 글이고, items 는 루프가 근거 후보로 쌓는다 */
export interface ResearchToolResult {
  /** 요청받은 도구 이름. 목록에 없는 이름이어도 받은 그대로 적는다 */
  tool: string;
  summary: string;
  items: ResearchItem[];
  truncated: boolean;
}

/** 조사 도구의 claim 검색. 하이브리드 검색과 BM25 만 쓰는 키워드 검색 */
export interface ResearchPolicySearch {
  retrieve(
    query: string,
    options: RetrievalOptions,
  ): Promise<PolicyRetrievalCandidate[]>;
  retrieveLexical(
    query: string,
    limit: number,
  ): Promise<PolicyRetrievalCandidate[]>;
}

/** 조사 도구가 읽는 지식. 비어 있는 항목에 기대는 도구는 실패 대신 "이 환경에서 못 씀" 요약과 빈 목록을 낸다 */
export interface ResearchToolSources {
  policySearch?: ResearchPolicySearch;
  codeIndex?: Pick<TemporalCodeIndex, 'searchCurrent'>;
  codeSymbols?: CodeSymbolLookup;
  topology?: CodeTopologySource;
  fieldWriters?: FieldWriterIndexSource;
  entityRelations?: EntityRelationGraphSource;
}

/** 읽기 전용 조사 도구 묶음. 이름이 틀리거나 필수 인자가 비면 예외 대신 까닭을 summary 에 적은 빈 결과를 낸다 */
export interface ResearchToolbox {
  readonly schemas: readonly ResearchToolSchema[];
  run(name: string, args: Record<string, unknown>): Promise<ResearchToolResult>;
}

// ── 조사 에이전트 ──

/**
 * 조사 모드로 넘긴 까닭
 * - explicit_request: 질문이 더 깊이 찾아 달라고 했다
 * - no_evidence: 단일 경로에서 묶인 근거가 0 개다
 * - insufficient_answer: 첫 답이 검사에서 근거 부족으로 나왔다
 * - state_change·cause_diagnosis: 되살아난 상태나 원인을 묻는 질문을 먼저 넘긴다. 기본은 끄고, 재 본 이득이 시간·비용보다 클 때 켠다
 */
export type ResearchRouteReason =
  | 'explicit_request'
  | 'no_evidence'
  | 'insufficient_answer'
  | 'state_change'
  | 'cause_diagnosis';

/** 라우팅을 판정하는 때. 첫 답을 만들기 전, 또는 첫 답을 검사한 뒤 */
export type ResearchRouteStage = 'before_answer' | 'after_answer';

/** 라우팅 판정. 결정적 규칙으로만 정하고, 판정에 모델을 쓰지 않는다 */
export interface ResearchRouteDecision {
  route: 'single' | 'research';
  stage: ResearchRouteStage;
  reason?: ResearchRouteReason;
  /** 조건은 맞았으나 꺼져 있어 넘기지 않은 까닭. 켤지 정하려고 빈도를 센다 */
  dormantReasons: ResearchRouteReason[];
}

/** 모델이 요청한 도구 실행 한 건. 결과 메시지는 같은 id 로 짝을 맞춘다 */
export interface ResearchToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 한 턴에서 모델이 낸 도구 요청들 */
export interface ResearchAssistantMessage {
  role: 'assistant';
  toolCalls: ResearchToolCall[];
}

/** 모델에게 돌려주는 도구 결과 글. 후보 항목 자체는 루프 쪽에 남는다 */
export interface ResearchToolMessage {
  role: 'tool';
  callId: string;
  content: string;
}

/** 조사 대화의 한 메시지. 특정 모델 API 의 형식에 묶이지 않는다 */
export type ResearchMessage = ResearchAssistantMessage | ResearchToolMessage;

/**
 * 조사 첫머리에 건네는 재료. 이것을 프롬프트 글로 옮기는 일은 에이전트 구현 몫이다
 * initialEvidence 는 단일 경로 근거를 맛보기로 보여 줄 뿐, 도구가 준 후보가 아니라 근거 id 로 댈 수 없다
 */
export interface ResearchBrief {
  question: string;
  previousQuestions?: string[];
  routeReason: ResearchRouteReason;
  plan?: {
    intent: string;
    target: string;
    searchTerms: string[];
    criteria: string[];
  };
  initialEvidence: Array<{ section: string; preview: string }>;
  /** 첫 답을 검사한 뒤 넘어왔다면 그 답 */
  firstAnswer?: string;
}

/** 턴 하나의 입력 */
export interface ResearchTurnInput {
  brief: ResearchBrief;
  history: ResearchMessage[];
  tools: readonly ResearchToolSchema[];
  turn: number;
  maxTurns: number;
  remainingToolCalls: number;
  signal: AbortSignal;
}

/**
 * 턴 하나의 응답
 * - ok: 모델이 요청한 도구들. 조사 끝 선언도 여기 온다. 빈 배열은 모델이 아무것도 요청하지 않았다는 뜻이다
 * - unsupported: 이 모델로는 도구 호출을 할 수 없다. 루프를 접고 단일 경로 답으로 돌아간다
 */
export interface ResearchTurnOutput {
  status: 'ok' | 'unsupported';
  toolCalls: ResearchToolCall[];
}

/** 턴 단위 조사 에이전트. 모델을 불러 다음에 부를 도구만 고른다. 도구를 직접 실행하지 않는다 */
export interface ResearchAgent {
  nextTurn(input: ResearchTurnInput): Promise<ResearchTurnOutput>;
}

// ── 조사 결과 ──

/**
 * 루프를 마친 까닭
 * - finish: 모델이 결론과 근거 id 를 냈다
 * - turn_budget·tool_call_budget·timeout: 예산이 바닥났다. 그때까지 쌓인 후보로 간다
 * - no_tool_calls: 한 턴에서 모델이 아무 요청도 하지 않았다
 * - unsupported·error: 모델 쪽이 도구 호출을 못 하거나 실패했다. 첫 답을 그대로 둔다
 */
export type ResearchStopReason =
  | 'finish'
  | 'turn_budget'
  | 'tool_call_budget'
  | 'timeout'
  | 'no_tool_calls'
  | 'unsupported'
  | 'error';

/** 도구 호출 기록 한 줄. 인자는 앞부분만, 결과는 항목 수만 적는다 */
export interface ResearchToolCallLog {
  turn: number;
  name: string;
  args: string;
  itemCount: number;
  /** cached: 앞서 똑같이 부른 결과를 경고와 함께 되돌려 줌. budget: 한도를 넘어 건너뜀 */
  note?: 'cached' | 'budget';
}

/** 조사 루프 한 번의 결과 */
export interface ResearchOutcome {
  status: ResearchStopReason;
  /** 답변 단계에 넘길 후보. 모델이 근거 id 를 댔다면 그 순서를 따른다 */
  items: ResearchItem[];
  /** 모델이 댄 id 가운데 도구가 실제로 준 것 */
  evidenceIds: string[];
  /** 모델이 댔지만 어느 도구도 준 적 없는 id. 받지 않고 기록만 한다 */
  droppedIds: string[];
  /** 모델이 적은 결론. 근거로 세지 않고 답을 쓸 때 참고만 한다 */
  conclusion?: string;
  turns: number;
  toolCalls: ResearchToolCallLog[];
  collectedCount: number;
  elapsedMs: number;
  error?: string;
}
