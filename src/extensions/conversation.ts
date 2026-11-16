// 다중 턴 대화 계약. "그건요?" 같은 짧은 후속 질문은 앞 턴이 없으면 무엇을 묻는지 알 수 없다.
// 앞 질문과 앞 답은 지금 질문의 대상을 되살리는 문맥으로만 쓰고 정책 근거로 올리지 않는다. 한 번 틀린 답이 다음 답의 근거가 되어 굳지 않게 하기 위해서다.
// 주제를 스스로 밝힌 새 질문은 앞 턴과 잇지 않는다. 후속 질문이 새 대상을 꺼내면 지금 질문만으로 한 검색을 앞에 둔다.
// 비교 질문은 대상마다 따로 찾고 대상마다 근거 자리를 보장한다. 강하게 걸린 한쪽이 자리를 독차지하지 않게 한다.
// 대화 기억은 되물어야 했던 질문을 남겨, 비슷한 다음 질문에 되물을 말의 힌트로만 쓴다. 근거나 판정에 섞지 않는다.

/** 대화 한 턴. assistant 의 content 는 공개 정제를 지난 답이다 */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** 저장된 스레드 문맥. expiresAt 이 지나면 없는 것으로 본다 */
export interface ThreadContextSnapshot {
  turns: ConversationTurn[];
  /** 밀리초 단위 유닉스 시각 */
  expiresAt: number;
}

/**
 * 스레드 하나의 앞 턴을 읽고 쓴다. threadKey 는 붙이는 쪽이 정하는 불투명한 키다
 * 문맥이 없거나 만료됐으면 undefined 를 돌려주고, 부르는 쪽은 첫 질문처럼 다룬다
 */
export interface ThreadContext {
  load(threadKey: string): Promise<ThreadContextSnapshot | undefined>;
  save(threadKey: string, turns: ConversationTurn[]): Promise<void>;
}

/**
 * 대화 한 건이 끝난 상태
 * - clarifying: 대상을 몰라 되물었다
 * - answered: 근거로 답했다
 * - unverified: 답은 했지만 일부를 확인하지 못했다
 * - abstained: 근거 부족으로 답하지 않았다
 */
export type DialogueState =
  'clarifying' | 'answered' | 'unverified' | 'abstained';

/** 대화 기억에 남기는 한 건. 이번 턴의 답은 본문 대신 해시와 인용 수로만 남긴다 */
export interface DialogueMemoryRecord {
  schemaVersion: 1;
  caseId: string;
  questionText: string;
  /** 앞 턴으로 대상을 채워 다시 쓴 질문 */
  resolvedQuestionText: string;
  conversationTurns: ConversationTurn[];
  /** 되물은 말. 되묻지 않았으면 null */
  clarificationQuestion: string | null;
  state: DialogueState;
  answerHash: string;
  citationCount: number;
  recordedAt: string;
}

/** 비슷한 앞 사례에서 되물었던 말. 다음 답의 근거가 아니라 되물을지 정하는 참고다 */
export interface DialogueMemoryHint {
  question: string;
  clarificationQuestion: string;
}

/** 대화 기억. 되물었던 사례를 남기고, 비슷한 질문이 오면 그때 되물은 말을 찾아 준다 */
export interface DialogueMemory {
  record(record: DialogueMemoryRecord): Promise<void>;
  searchSimilar(question: string, limit: number): Promise<DialogueMemoryHint[]>;
}
