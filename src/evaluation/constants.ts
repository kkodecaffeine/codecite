import type { GoldenCheck } from './types.js';

/** `codecite eval` 이 `--cwd` 에서 읽는 파일 */
export const GOLDEN_QUESTIONS_FILE = 'golden-questions.json';
export const GOLDEN_BASELINE_FILE = 'baseline.json';

/** 기준선 파일 형식 버전 */
export const GOLDEN_BASELINE_SCHEMA_VERSION = 1;

/** 질문별로 비교하는 항목과 보고서에 쓰는 이름 */
export const GOLDEN_CHECKS: readonly GoldenCheck[] = Object.freeze([
  'hitAny',
  'hitAll',
  'statusMatch',
]);
export const GOLDEN_CHECK_LABELS: Readonly<Record<GoldenCheck, string>> =
  Object.freeze({ hitAny: 'hitAny', hitAll: 'hitAll', statusMatch: 'status' });

/** golden-questions.json 의 expectStatus 로 받는 값 */
export const GOLDEN_EXPECTED_STATUSES = Object.freeze([
  'answered',
  'insufficient_evidence',
] as const);
