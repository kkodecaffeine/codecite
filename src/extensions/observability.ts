// 관측·런타임 계약. 근거 부족이나 틀린 답의 원인은 여러 단계 어디에나 있을 수 있어, 답 하나가 단계마다 무엇을 남겼는지 끝까지 따라갈 수 있어야 한다.
// 관측 기록에는 질문 본문 대신 해시·길이·결과 종류·단계별 시간만 남긴다. 기록은 오래 남고 여러 사람이 보기 때문이다.
// 런타임 캐시는 같은 질문의 계획과 임베딩을 다시 만들지 않게 할 뿐, 근거나 판정을 바꾸지 않는다. 캐시 쓰기가 답을 기다리게 하지 않는다.
// 백업은 재시작해도 캐시와 기록을 잃지 않게 한다. 관측·캐시·백업 어느 것이 실패해도 답변 경로를 막지 않는다.

/** 실행 한 번의 결과 종류 */
export type RunOutcome = 'answered' | 'abstained' | 'error';

/** 실행에서 눈여겨볼 신호. 같은 신호가 되풀이되면 경험 사례 후보가 된다 */
export type RunSignal = 'empty_answer' | 'abstention' | 'execution_error';

/** 실행 한 번의 관측 기록. 질문과 답은 해시와 길이로만 남긴다 */
export interface RunObservation {
  schemaVersion: 1;
  requestId: string;
  queryHash: string;
  outcome: RunOutcome;
  signals: RunSignal[];
  elapsedMs: number;
  /** 단계 이름별 걸린 시간(ms). 느린 답을 가장 큰 단계부터 볼 수 있게 한다 */
  stageMs?: Readonly<Record<string, number>>;
  answerHash?: string;
  answerLength?: number;
  citationCount?: number;
  /** 오류의 종류 이름. 오류 메시지 원문은 남기지 않는다 */
  errorType?: string;
}

/** 관측 기록을 받는 곳. 실패해도 던지지 않는다 */
export interface RunObserver {
  record(observation: RunObservation): Promise<void> | void;
}

/** 캐시에서 꺼낸 값과 만료 시각(ms 단위 유닉스 시각) */
export interface RuntimeCacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** 이름 공간으로 나눈 런타임 캐시. 만료된 항목은 없는 것으로 본다 */
export interface RuntimeCache {
  get<T>(
    namespace: string,
    key: string,
  ): Promise<RuntimeCacheEntry<T> | undefined>;
  set(
    namespace: string,
    key: string,
    value: unknown,
    expiresAt: number,
  ): Promise<void>;
}

/** 런타임 상태(캐시, 기록)를 오래 가는 저장소로 옮겨 두라고 요청한다. 종료 직전에도 부른다 */
export interface RuntimeBackup {
  requestBackup(): Promise<void>;
}
