import type { PolicyCode } from './policy-code.js';
import type { PolicyStatus } from './policy-status.js';
import type { PolicyClaimProps, PolicyProps } from './types.js';

/** 정책 소스의 한 행. 이름과 결정 문장이 없으면 만들지 않는다 */
export class Policy {
  private constructor(private readonly props: PolicyProps) {}

  static create(props: PolicyProps): Policy {
    if (!props.name.trim()) {
      throw new Error('Policy name is required.');
    }
    if (!props.decision.trim()) {
      throw new Error(`Policy decision is required: ${props.name}`);
    }
    return new Policy(props);
  }

  get name(): string {
    return this.props.name;
  }

  get decision(): string {
    return this.props.decision;
  }

  get status(): PolicyStatus {
    return this.props.status;
  }

  get section(): string {
    return this.props.section;
  }

  get code(): PolicyCode {
    return this.props.code;
  }

  get source(): string {
    return this.props.source;
  }

  get policyGroup(): string | undefined {
    return this.props.policyGroup;
  }

  get policyClaims(): PolicyClaimProps[] {
    return this.props.policyClaims ?? [];
  }

  isActive(): boolean {
    return this.props.status.isActive();
  }

  toKnowledgeText(): string {
    if (this.props.knowledgeText?.trim()) {
      return this.props.knowledgeText;
    }

    return [
      `정책명: ${this.name}`,
      `정책 코드: ${this.code.toString()}`,
      `섹션: ${this.section}`,
      `상태: ${this.status.toString()}`,
      `결정: ${this.decision}`,
      `출처: ${this.source}`,
    ].join('\n');
  }
}
