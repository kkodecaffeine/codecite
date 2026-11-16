import { normalizePolicyContextKind } from './context-kind.js';
import type { Policy } from './policy.js';
import type {
  PolicyChunkProjection,
  PolicyChunkProps,
  PolicyClaimProps,
  PolicyContextKind,
} from './types.js';

/** 검색과 답변 근거의 단위. 정책 하나가 정책 조각과 기술 조각으로 나뉠 수 있다 */
export class PolicyChunk {
  private constructor(private readonly props: PolicyChunkProps) {}

  static fromPolicy(
    policy: Policy,
    projection?: PolicyChunkProjection,
  ): PolicyChunk {
    const policyCode = policy.code.toString();
    const contextKind = projection?.contextKind ?? 'policy';
    return new PolicyChunk({
      id: [
        policy.source,
        policyCode,
        contextKind === 'technical' ? contextKind : '',
      ]
        .filter(Boolean)
        .join('#'),
      policyCode,
      section: policy.section,
      text: projection?.text ?? policy.toKnowledgeText(),
      source: policy.source,
      contextKind,
      searchText: projection?.searchText ?? policy.toKnowledgeText(),
      policyGroup: policy.policyGroup,
      policyClaims:
        contextKind === 'policy'
          ? policy.policyClaims.map((claim) => ({
              ...claim,
              provenanceChunkIds:
                claim.provenanceChunkIds.length > 0
                  ? claim.provenanceChunkIds
                  : [[policy.source, policyCode].filter(Boolean).join('#')],
            }))
          : [],
    });
  }

  static rehydrate(props: PolicyChunkProps): PolicyChunk {
    return new PolicyChunk(props);
  }

  get id(): string {
    return this.props.id;
  }

  get policyCode(): string {
    return this.props.policyCode;
  }

  get section(): string {
    return this.props.section;
  }

  get text(): string {
    return this.props.text;
  }

  get source(): string {
    return this.props.source;
  }

  get contextKind(): PolicyContextKind {
    return normalizePolicyContextKind(this.props.contextKind);
  }

  get hasContextKindMetadata(): boolean {
    return (
      this.props.contextKind === 'policy' ||
      this.props.contextKind === 'technical'
    );
  }

  get searchText(): string {
    return this.props.searchText?.trim() || this.props.text;
  }

  get policyGroup(): string | undefined {
    return this.props.policyGroup;
  }

  get policyClaims(): PolicyClaimProps[] {
    return this.props.policyClaims ?? [];
  }

  toJSON(): PolicyChunkProps {
    return {
      ...this.props,
      contextKind: this.contextKind,
      searchText: this.searchText,
    };
  }
}
