import type { PolicyContextKind } from './types.js';

/** 예전에 저장한 조각을 포함해 알 수 없는 값은 일반 정책 컨텍스트로 해석한다 */
export function normalizePolicyContextKind(value: unknown): PolicyContextKind {
  return value === 'technical' ? 'technical' : 'policy';
}
