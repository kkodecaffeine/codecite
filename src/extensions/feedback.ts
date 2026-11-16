// 피드백 계약. 틀린 답은 가장 값싼 평가 데이터지만, 어느 답에 대한 평가인지 묶여 있지 않으면 무엇이 틀렸는지 알 수 없다.
// 그래서 답마다 기록을 먼저 남기고, 👍·👎 와 이유를 그 기록에 붙인다. 기록에는 회원 식별자와 연락처를 남기지 않는다.
// 피드백과 경험 사례는 원인 단계를 찾고 회귀 세트·골든 제안을 늘리는 재료다. 근거를 만들거나 판정을 뒤집지 않는다.
// 피드백으로 검색 순위를 보정할 때는 작게, shadow 로 먼저 견준 뒤에 켠다. 많이 누른 쪽이 정책이 되면 안 된다.
import type { RunOutcome, RunSignal } from './observability.js';

/** 기록 종류. 답하지 못한 경우(근거 부족, 오류)도 빠짐없이 한 건으로 남겨 분모를 지킨다 */
export type AnswerRecordKind = 'answer' | 'abstention' | 'error';

/** 👍 은 helpful, 👎 은 unhelpful */
export type FeedbackRating = 'helpful' | 'unhelpful';

/**
 * 👎 를 누른 이유
 * - incorrect_evidence: 근거가 틀렸거나 다른 정책의 근거다
 * - incomplete_answer: 조건·예외·숫자가 빠졌다
 * - unclear_answer: 무슨 말인지 알기 어렵다
 */
export type FeedbackReason =
  'incorrect_evidence' | 'incomplete_answer' | 'unclear_answer';

/** 질문 하나에 대한 응답 기록. 몇 번 물었고 얼마나 맞았는지를 이 단위로 센다 */
export interface AnswerRecord {
  /** 응답이 실린 메시지를 가리키는 키. 나중에 온 평가를 이 키로 기록에 잇는다 */
  answerKey: string;
  kind: AnswerRecordKind;
  question?: string;
  answer?: string;
  /** 답에 묶인 근거의 claim id. 기록이 바깥 도구로 나가면 비워 둘 수 있다 */
  evidenceIds?: string[];
  /** 모델이 쓴 답인지 결정적 답변인지 */
  generation?: 'llm' | 'deterministic';
  answeredAt: string;
}

/** 답 기록에 붙는 평가 한 건 */
export interface AnswerFeedback {
  rating: FeedbackRating;
  /** 누른 사람의 표시 이름. 붙이는 쪽이 공개해도 된다고 정한 값만 쓴다 */
  reviewerName?: string;
  reportedAt: string;
}

/**
 * 답 기록과 평가를 남기는 곳. reportId 는 이 저장소가 기록마다 매긴 id 다
 * 같은 기록에 평가가 여러 번 오면 마지막 평가로 고친다
 */
export interface FeedbackReport {
  /** 기록을 만들고 그 reportId 를 준다. 만들지 못하면 undefined */
  recordAnswer(record: AnswerRecord): Promise<string | undefined>;
  /** 손에 reportId 가 없을 때(재시작 등) answerKey 로 이미 남긴 기록의 id 를 얻는다 */
  findAnswer(answerKey: string): Promise<string | undefined>;
  recordFeedback(reportId: string, feedback: AnswerFeedback): Promise<void>;
  updateReason(
    reportId: string,
    reason: FeedbackReason,
    comment?: string,
  ): Promise<void>;
}

/** 경험 사례의 검토 상태. 사람이 확인하기 전까지 candidate 다 */
export type ExperienceCaseStatus = 'candidate' | 'verified' | 'rejected';

/** 경험 사례가 어디서 왔는지. runtime_signal 은 실행 신호에서, user_feedback 은 👎 에서 */
export type ExperienceCaseSource = 'runtime_signal' | 'user_feedback';

/** 되풀이되는 실패 하나. 같은 질문 해시의 같은 신호는 한 사례로 모아 횟수를 센다 */
export interface ExperienceCase {
  schemaVersion: 1;
  caseId: string;
  queryHash: string;
  /** 사람이 검토하려고 남긴 질문. 개인정보는 가린다 */
  queryText?: string;
  outcome: RunOutcome;
  signals: RunSignal[];
  source: ExperienceCaseSource;
  status: ExperienceCaseStatus;
  occurrenceCount: number;
  answerHash?: string;
  answerLength?: number;
  citationCount?: number;
  errorType?: string;
}

/** 경험 사례 저장소. 비슷한 앞 사례는 검토와 회귀 세트의 재료일 뿐 답의 근거가 아니다 */
export interface ExperienceCaseStore {
  record(experienceCase: ExperienceCase, query?: string): Promise<void> | void;
  searchSimilar(query: string, limit: number): Promise<ExperienceCase[]>;
  updateStatus(caseId: string, status: ExperienceCaseStatus): Promise<void>;
}
