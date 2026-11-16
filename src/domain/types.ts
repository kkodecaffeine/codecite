import type { PolicyCode } from './policy-code.js';
import type { PolicyStatus } from './policy-status.js';

/** 정책 답변 근거와 기술 구현 근거를 가르는 조각 종류 */
export type PolicyContextKind = 'policy' | 'technical';

export type PolicyStatusValue = 'Active' | 'Inactive' | 'Draft' | string;

export type PolicyClaimConfidence = 'high' | 'low';
export type KnowledgeClaimSourceKind = 'policy' | 'code' | 'history' | 'mixed';
export type KnowledgeKind =
  | 'product-capability'
  | 'user-policy'
  | 'partner-operation'
  | 'internal-operation'
  | 'implementation-detail';
export type KnowledgeClaimProvenanceSourceKind = Exclude<
  KnowledgeClaimSourceKind,
  'mixed'
>;
export type KnowledgeClaimStatus = 'active' | 'inactive' | 'superseded';
export type KnowledgeClaimRelationKind =
  'supports' | 'contradicts' | 'supersedes' | 'dependsOn';
export type PolicyClaimFacet =
  | 'outcome'
  | 'eligibility'
  | 'amount'
  | 'duration'
  | 'schedule'
  | 'expiration'
  | 'exception'
  | 'reversal'
  | 'procedure';

export interface KnowledgeClaimProvenance {
  sourceId: string;
  sourceKind: KnowledgeClaimProvenanceSourceKind;
  sourceLabel: string;
  repository?: string;
  filePath?: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
  commitSha?: string;
  contentHash?: string;
  publicAnswerSafe: boolean;
}

export interface KnowledgeClaimRelation {
  kind: KnowledgeClaimRelationKind;
  targetClaimId: string;
}

/** 답변이 빠뜨리면 안 되는 항목 묶음(예: 필수 입력 데이터) */
export interface RequiredAnswerDetail {
  label: string;
  items: string[];
}

export interface PolicyClaimProps {
  schemaVersion?: 1 | 2;
  claimId: string;
  policyGroup?: string;
  facet: PolicyClaimFacet;
  statement: string;
  confidence: PolicyClaimConfidence;
  provenanceChunkIds: string[];
  sourceKind?: KnowledgeClaimSourceKind;
  knowledgeKind?: KnowledgeKind;
  subject?: string;
  predicate?: string;
  value?: string;
  conditions?: string[];
  exceptions?: string[];
  status?: KnowledgeClaimStatus;
  provenance?: KnowledgeClaimProvenance[];
  relations?: KnowledgeClaimRelation[];
  provenanceVersionId?: string;
  searchAliases?: string[];
  userQuestionExamples?: string[];
  requiredAnswerDetails?: RequiredAnswerDetail[];
}

/** 주체·서술어·값·조건·출처를 모두 갖춘 구조화 claim */
export type KnowledgeClaim = PolicyClaimProps & {
  schemaVersion: 2;
  sourceKind: KnowledgeClaimSourceKind;
  knowledgeKind: KnowledgeKind;
  subject: string;
  predicate: string;
  value: string;
  conditions: string[];
  exceptions: string[];
  status: KnowledgeClaimStatus;
  provenance: KnowledgeClaimProvenance[];
  relations: KnowledgeClaimRelation[];
  provenanceVersionId: string;
};

export interface PolicyProps {
  name: string;
  decision: string;
  status: PolicyStatus;
  section: string;
  code: PolicyCode;
  source: string;
  knowledgeText?: string;
  policyGroup?: string;
  policyClaims?: PolicyClaimProps[];
}

export interface PolicyChunkProps {
  id: string;
  policyCode: string;
  section: string;
  text: string;
  source: string;
  contextKind?: PolicyContextKind;
  searchText?: string;
  symbol?: string;
  sourceFile?: string;
  lineStart?: number;
  relationTargets?: string[];
  policyGroup?: string;
  policyClaims?: PolicyClaimProps[];
}

/** 정책 하나를 조각으로 나눈 결과. text 는 답변 근거, searchText 는 검색에 쓴다 */
export interface PolicyChunkProjection {
  contextKind: PolicyContextKind;
  text: string;
  searchText: string;
}

/** context_text 의 `[머리말]` 단위 섹션. 머리말 앞의 글은 heading 이 없다 */
export interface ParsedPolicySection {
  heading?: string;
  text: string;
}
