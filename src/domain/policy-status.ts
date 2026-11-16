import type { PolicyStatusValue } from './types.js';

/** 정책 상태. 비어 있으면 Draft 로 보고, 대소문자와 무관하게 active 만 활성으로 친다 */
export class PolicyStatus {
  private constructor(private readonly value: PolicyStatusValue) {}

  static of(value: string): PolicyStatus {
    const normalized = value.trim() || 'Draft';
    return new PolicyStatus(normalized);
  }

  isActive(): boolean {
    return this.value.toLowerCase() === 'active';
  }

  toString(): string {
    return this.value;
  }
}
