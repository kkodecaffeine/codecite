import type { PolicyClaimFacet } from '../domain/types.js';
import { POLICY_GROUP_SUMMARY_CLAIM_ID_PREFIX } from '../retrieval/constants.js';
import { preferredPolicyClaimFacets } from '../retrieval/query-intent.js';
import { inferPolicyFacet } from '../text/facet-inference.js';
import {
  completedAnswerItems,
  enforcePolicyAnswerContract,
  policyAnswerItemLimit,
} from './answer-contract.js';
import {
  INTERNAL_FALLBACK_STATEMENT_PATTERNS,
  NO_EVIDENCE_ANSWER,
  STATEMENT_ENDING_PATTERN,
  UNANSWERED_EVIDENCE_ANSWER,
} from './constants.js';
import type { DeterministicFallbackInput, PolicyEvidence } from './types.js';

/**
 * 모델 없이 묶인 근거만으로 답을 만든다. 모델 실패·시간 초과, 답변 검사 탈락, API 키 없는 모드가 모두 이 답을 쓴다
 * high claim 문장을 질문이 원하는 종류 순서로 고르고, claim 이 없으면 근거 글의 완결 문장을 쓴다
 * 재검색이나 다른 모델 호출은 하지 않는다. 모델 장애로 물러난 경로에서 다시 모델을 부르면 같은 장애를 또 만난다
 */
export function deterministicPolicyFallback(
  input: DeterministicFallbackInput,
): string {
  const evidence = input.evidence;
  if (evidence.length === 0) {
    return NO_EVIDENCE_ANSWER;
  }

  const mode = input.answerMode ?? 'default';
  const claims = claimStatements(input.question, evidence);
  const statements = (
    claims.length > 0
      ? claims
      : evidence.flatMap(evidenceStatements).filter(isPublicFallbackStatement)
  )
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, policyAnswerItemLimit(mode));
  const answer =
    statements.length > 0 ? statements.join('\n') : UNANSWERED_EVIDENCE_ANSWER;
  return enforcePolicyAnswerContract(answer, mode);
}

/**
 * 고객에게 보여도 되는 high claim 문장을 질문이 먼저 원하는 종류부터 늘어놓는다. 같은 순위는 근거 순서를 지킨다
 * 묶음 요약 claim 은 여러 사실을 한 문장 묶음에 담으므로 완결 문장으로 나누고 문장마다 종류를 다시 추론해 함께 줄 세운다
 */
function claimStatements(
  question: string,
  evidence: readonly PolicyEvidence[],
): string[] {
  const preferences = preferredPolicyClaimFacets(question);
  const priority = (facet: PolicyClaimFacet): number => {
    if (preferences.primary.includes(facet)) {
      return 2;
    }
    return preferences.secondary.includes(facet) ? 1 : 0;
  };
  return evidence
    .flatMap((item) => item.policyClaims ?? [])
    .filter(
      (claim) =>
        claim.confidence === 'high' &&
        claim.knowledgeKind !== 'implementation-detail',
    )
    .flatMap((claim) =>
      claim.claimId.startsWith(POLICY_GROUP_SUMMARY_CLAIM_ID_PREFIX)
        ? completedAnswerItems(claim.statement).map(({ text }) => ({
            statement: text,
            facet: inferPolicyFacet(text),
          }))
        : [{ statement: claim.statement, facet: claim.facet }],
    )
    .filter(({ statement }) => isPublicFallbackStatement(statement))
    .sort((left, right) => priority(right.facet) - priority(left.facet))
    .map(({ statement }) => statement);
}

/** 색인 메타데이터나 내부 구현 요약은 모델이 실패했다고 고객 답으로 올리지 않는다 */
function isPublicFallbackStatement(statement: string): boolean {
  return !INTERNAL_FALLBACK_STATEMENT_PATTERNS.some((pattern) =>
    pattern.test(statement),
  );
}

/** 근거 글에서 완결된 줄만 골라 존댓말로 끝맺는다. `결정:` 머리는 떼고 목록 기호는 지운다 */
function evidenceStatements(evidence: PolicyEvidence): string[] {
  return evidence.text
    .split('\n')
    .map((line) => line.trim().replace(/^[-*•]\s+/, ''))
    .filter(
      (line) => STATEMENT_ENDING_PATTERN.test(line) || /^결정:\s*\S/.test(line),
    )
    .map((line) =>
      line
        .replace(/^결정:\s*/, '')
        .replace(/한다[.]?$/, '합니다.')
        .replace(/된다[.]?$/, '됩니다.')
        .replace(/([^.!?。])$/, '$1.'),
    );
}
