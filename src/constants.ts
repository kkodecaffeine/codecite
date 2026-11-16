import type { LogLevel } from './types.js';

/** 근거가 모자라 답변 모델을 부르지 않았을 때 돌려주는 안내 문장 */
export const INSUFFICIENT_EVIDENCE_ANSWER =
  '질문에 답할 정책 근거를 찾지 못했습니다. 궁금한 정책과 상황을 조금 더 구체적으로 적어 다시 물어봐 주세요.';

/**
 * 답변 모델을 기다리는 기본 시간(밀리초). 어댑터마다 자기 시간 한도가 있으므로 그중 가장 긴 값에 맞춰 둔다
 * 시간 한도가 없는 어댑터를 붙여도 답이 멈추지 않게 하는 마지막 울타리다
 */
export const DEFAULT_ANSWER_TIMEOUT_MS = 120_000;

/** 로그 수준의 높낮이 */
export const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> =
  Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
