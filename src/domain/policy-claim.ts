import { createHash } from 'node:crypto';
import type {
  KnowledgeClaim,
  KnowledgeClaimProvenance,
  KnowledgeClaimSourceKind,
  KnowledgeKind,
  PolicyClaimConfidence,
  PolicyClaimFacet,
  RequiredAnswerDetail,
} from './types.js';

const FACETS: ReadonlySet<string> = new Set([
  'outcome',
  'eligibility',
  'amount',
  'duration',
  'schedule',
  'expiration',
  'exception',
  'reversal',
  'procedure',
]);

/** 정책 묶음 이름을 소문자와 하이픈만 남긴 비교용 값으로 바꾼다 */
export function normalizePolicyGroup(value: string): string {
  return value
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
}

/** 알 수 없는 claim 종류는 outcome 으로 본다 */
export function normalizePolicyClaimFacet(value: string): PolicyClaimFacet {
  const normalized = value.trim().toLowerCase();
  return FACETS.has(normalized) ? (normalized as PolicyClaimFacet) : 'outcome';
}

/** high 가 아니면 모두 low 로 본다 */
export function normalizePolicyClaimConfidence(
  value: string,
): PolicyClaimConfidence {
  return value.trim().toLowerCase() === 'high' ? 'high' : 'low';
}

/** 묶음·종류·문장으로 만든 claim id. 행 순서가 바뀌어도 같은 claim 은 같은 id 를 갖는다 */
export function stablePolicyClaimId(input: {
  policyGroup?: string;
  facet: string;
  statement: string;
}): string {
  const fingerprint = [
    input.policyGroup ?? '',
    normalizePolicyClaimFacet(input.facet),
    input.statement.normalize('NFC').trim(),
  ].join('\n');
  return `claim-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`;
}

/** 필수 글자 값과 출처를 검사하고, 목록은 중복을 걷어 낸 구조화 claim 을 만든다 */
export function createKnowledgeClaim(
  input: Omit<
    KnowledgeClaim,
    'schemaVersion' | 'claimId' | 'provenanceVersionId' | 'knowledgeKind'
  > & {
    claimId?: string;
    provenanceVersionId?: string;
    knowledgeKind?: KnowledgeKind;
  },
): KnowledgeClaim {
  const provenance = validateProvenance(input.provenance);
  const normalized = {
    ...input,
    knowledgeKind:
      input.knowledgeKind ?? defaultKnowledgeKind(input.sourceKind),
    subject: requiredClaimText(input.subject, 'subject'),
    predicate: requiredClaimText(input.predicate, 'predicate'),
    value: requiredClaimText(input.value, 'value'),
    statement: requiredClaimText(input.statement, 'statement'),
    conditions: normalizeClaimTexts(input.conditions),
    exceptions: normalizeClaimTexts(input.exceptions),
    ...(input.searchAliases
      ? { searchAliases: normalizeClaimTexts(input.searchAliases) }
      : {}),
    ...(input.userQuestionExamples
      ? {
          userQuestionExamples: normalizeClaimTexts(input.userQuestionExamples),
        }
      : {}),
    ...(input.requiredAnswerDetails
      ? {
          requiredAnswerDetails: normalizeRequiredAnswerDetails(
            input.requiredAnswerDetails,
          ),
        }
      : {}),
    provenance,
    relations: input.relations.map((relation) => ({ ...relation })),
  };
  const claimId = input.claimId?.trim() || stableKnowledgeClaimId(normalized);
  const provenanceVersionId = stableKnowledgeClaimProvenanceVersion(provenance);
  return { ...normalized, schemaVersion: 2, claimId, provenanceVersionId };
}

function defaultKnowledgeKind(
  sourceKind: KnowledgeClaimSourceKind,
): KnowledgeKind {
  return sourceKind === 'code' ? 'implementation-detail' : 'user-policy';
}

/** 주체·서술어·값·조건·예외로 만든 id. 조건과 예외의 순서는 따지지 않는다 */
export function stableKnowledgeClaimId(
  claim: Pick<
    KnowledgeClaim,
    'subject' | 'predicate' | 'value' | 'conditions' | 'exceptions'
  >,
): string {
  return `knowledge-claim-${createHash('sha256').update(knowledgeClaimFingerprint(claim)).digest('hex').slice(0, 20)}`;
}

/** 출처 id·내용 해시·커밋으로 만든 출처 버전. 출처가 바뀌면 함께 바뀐다 */
export function stableKnowledgeClaimProvenanceVersion(
  provenance: KnowledgeClaimProvenance[],
): string {
  const fingerprint = [...provenance]
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId))
    .map((source) =>
      [source.sourceId, source.contentHash ?? '', source.commitSha ?? ''].join(
        ':',
      ),
    )
    .join('\n');
  return `knowledge-provenance-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 20)}`;
}

/** 구조화 claim 을 특정 업무와 무관한 자연어 검색 문서로 펼친다 */
export function knowledgeClaimSearchText(claim: KnowledgeClaim): string {
  return [
    `topic: ${humanizeSearchText(claim.policyGroup ?? claim.subject)}`,
    `subject: ${claim.subject}`,
    `subject terms: ${humanizeSearchText(claim.subject)}`,
    `facet: ${claim.facet} ${FACET_SEARCH_TERMS[claim.facet]}`,
    `predicate: ${claim.predicate}`,
    `value: ${claim.value}`,
    ...claim.conditions.map((condition) => `condition: ${condition}`),
    ...claim.exceptions.map((exception) => `exception: ${exception}`),
    ...(claim.searchAliases ?? []).map((alias) => `search alias: ${alias}`),
    ...(claim.userQuestionExamples ?? []).map(
      (question) => `user question: ${question}`,
    ),
    ...(claim.requiredAnswerDetails ?? []).map(
      (detail) =>
        `required answer detail: ${detail.label} ${detail.items.join(', ')}`,
    ),
    `statement: ${claim.statement}`,
    `natural language: ${naturalLanguageSearchSummary(claim)}`,
  ].join('\n');
}

/** 검색 보조 표현을 정책 근거로 오인하지 않도록 답변용 사실만 남긴다 */
function normalizeRequiredAnswerDetails(
  details: RequiredAnswerDetail[],
): RequiredAnswerDetail[] {
  return details.flatMap((detail) => {
    const label = detail.label.normalize('NFC').trim();
    const items = normalizeClaimTexts(detail.items);
    return label && items.length ? [{ label, items }] : [];
  });
}

const FACET_SEARCH_TERMS: Readonly<Record<PolicyClaimFacet, string>> = {
  outcome: '처리 결과 반환 상태',
  eligibility: '대상 자격 가능 여부 적용 조건',
  amount: '금액 수량 비율 한도 최대 최소',
  duration: '기간 유지 시간',
  schedule: '시점 일정 주기 스케줄',
  expiration: '만료 소멸 유효 기간',
  exception: '실패 예외 제외 불가 원인',
  reversal: '취소 환불 회수 차감 되돌림',
  procedure: '방법 절차 처리 순서',
};

function naturalLanguageSearchSummary(claim: KnowledgeClaim): string {
  const topic = humanizeSearchText(claim.policyGroup ?? claim.subject);
  const subject = humanizeSearchText(claim.subject);
  const conditions = claim.conditions.length
    ? `적용 조건은 ${claim.conditions.map(humanizeSearchText).join(', ')}`
    : '별도 적용 조건은 명시되지 않음';
  const exceptions = claim.exceptions.length
    ? `예외는 ${claim.exceptions.map(humanizeSearchText).join(', ')}`
    : '';
  return [
    `${topic} 영역의 ${subject}에 관한 ${FACET_SEARCH_TERMS[claim.facet]} 정보`,
    conditions,
    exceptions,
    `처리 값 또는 결과는 ${humanizeSearchText(claim.value)}`,
  ]
    .filter(Boolean)
    .join('. ');
}

function humanizeSearchText(value: string): string {
  return value
    .replace(/([\p{Ll}\d])([\p{Lu}])/gu, '$1 $2')
    .replace(/[_./:#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function knowledgeClaimFingerprint(
  claim: Pick<
    KnowledgeClaim,
    'subject' | 'predicate' | 'value' | 'conditions' | 'exceptions'
  >,
): string {
  return [
    claim.subject,
    claim.predicate,
    claim.value,
    ...[...claim.conditions].sort(),
    '--exceptions--',
    ...[...claim.exceptions].sort(),
  ]
    .map((value) => value.normalize('NFC').trim())
    .join('\n');
}

function validateProvenance(
  values: KnowledgeClaimProvenance[],
): KnowledgeClaimProvenance[] {
  if (!values.length) {
    throw new Error('knowledge claim provenance is required');
  }
  return values.map((value) => ({
    ...value,
    sourceId: requiredClaimText(value.sourceId, 'provenance.sourceId'),
    sourceLabel: requiredClaimText(value.sourceLabel, 'provenance.sourceLabel'),
  }));
}

function requiredClaimText(value: string, field: string): string {
  const normalized = value.normalize('NFC').trim();
  if (!normalized) {
    throw new Error(`knowledge claim ${field} is required`);
  }
  return normalized;
}

function normalizeClaimTexts(values: string[]): string[] {
  return [
    ...new Set(
      values.map((value) => value.normalize('NFC').trim()).filter(Boolean),
    ),
  ];
}
