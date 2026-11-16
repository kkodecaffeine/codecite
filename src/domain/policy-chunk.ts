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
    const codeMetadata = extractCodeMetadata(projection?.text ?? '');
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
      ...codeMetadata,
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

  get symbol(): string | undefined {
    return this.props.symbol;
  }

  get sourceFile(): string | undefined {
    return this.props.sourceFile;
  }

  get lineStart(): number | undefined {
    return this.props.lineStart;
  }

  get relationTargets(): string[] {
    return this.props.relationTargets ?? [];
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

/** `[심볼]` 섹션이 있는 코드 심볼 문서에서 심볼·위치·관계 대상을 읽는다 */
function extractCodeMetadata(text: string): Partial<PolicyChunkProps> {
  if (!text.includes('[심볼]')) {
    return {};
  }
  const symbol = sectionValue(text, '심볼');
  const location = text.match(/^- 위치:\s+(.+?):(\d+)(?:-\d+)?$/m);
  const relationTargets = [...text.matchAll(/^- [A-Z_]+:\s+(.+)$/gm)].map(
    (match) => match[1].trim(),
  );
  return {
    symbol: symbol || undefined,
    sourceFile: location?.[1],
    lineStart: location ? Number(location[2]) : undefined,
    relationTargets: [...new Set(relationTargets)],
  };
}

function sectionValue(text: string, heading: string): string {
  const match = text.match(
    new RegExp(`^\\[${heading}\\]\\s*\\n([^\\n]+)`, 'm'),
  );
  return match?.[1]?.trim() ?? '';
}
