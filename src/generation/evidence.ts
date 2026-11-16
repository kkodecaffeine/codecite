import { basename } from 'node:path';
import type { PolicyChunk } from '../domain/policy-chunk.js';
import type {
  PolicyClaimProps,
  RequiredAnswerDetail,
} from '../domain/types.js';
import { policyRetrievalScopeForQuery } from '../retrieval/query-intent.js';
import { neutralizeEmbeddedInstructions } from '../safety/prompt-boundary.js';
import { PUBLIC_HEADING_LABELS, PUBLIC_HIDDEN_HEADINGS } from './constants.js';
import type { PolicyEvidence } from './types.js';

/** 내부 출처는 보존하고, 공개해도 되는 문서 이름만 따로 만든다 */
export function policyEvidenceFromChunk(chunk: PolicyChunk): PolicyEvidence {
  return {
    chunkId: chunk.id,
    policyCode: chunk.policyCode || '미분류 정책',
    section: chunk.section || '정책',
    internalSource: chunk.source,
    sourceLabel: publicSourceLabel(chunk.source),
    text: chunk.text,
    ...(chunk.contextKind === 'policy'
      ? { publicText: publicPolicyEvidenceText(chunk.text) }
      : {}),
    contextKind: chunk.contextKind,
    policyGroup: chunk.policyGroup,
    policyClaims: chunk.policyClaims,
  };
}

/** 근거 글에서 색인 메타데이터 섹션을 빼고 섹션 이름을 사용자용으로 바꾼다 */
export function publicPolicyEvidenceText(value: string): string {
  const normalized = value.trim();
  const headerPattern = /^\[([^\]\r\n]+)\][ \t]*$/gm;
  const matches = [...normalized.matchAll(headerPattern)];
  if (matches.length === 0) {
    return normalized;
  }

  const parts: string[] = [];
  const leading = normalized.slice(0, matches[0].index).trim();
  if (leading) {
    parts.push(leading);
  }
  for (const [index, match] of matches.entries()) {
    const heading = match[1].trim();
    if (PUBLIC_HIDDEN_HEADINGS.has(heading)) {
      continue;
    }
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? normalized.length;
    const body = normalized.slice(start, end).trim();
    if (!body) {
      continue;
    }
    const label = PUBLIC_HEADING_LABELS[heading] ?? heading;
    parts.push(label ? `${label}\n${body}` : body);
  }
  return parts.join('\n\n').trim();
}

/** 출처 경로에서 `#` 뒤 행 표시와 폴더를 떼고 파일 이름만 남긴다. 제어 문자는 지운다 */
export function publicSourceLabel(source: string): string {
  const withoutFragment = source.split('#', 1)[0].replace(/\\/g, '/');
  const label = Array.from(basename(withoutFragment))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join('')
    .trim();
  return label || '정책 문서';
}

/**
 * 답변 모델 프롬프트에 넣을 때 구조화 필드를 분명한 경계로 직렬화한다
 * 본문의 지시문 꼴 줄은 자리 표시로 바꾸고, 꺾쇠와 `&` 는 이스케이프해 프롬프트 태그로 읽히지 않게 한다
 */
export function serializePolicyEvidence(
  evidence: PolicyEvidence,
  question?: string,
): string {
  const highConfidenceClaims = (evidence.policyClaims ?? []).filter(
    (claim) => claim.confidence === 'high',
  );
  return JSON.stringify({
    policyCode: evidence.policyCode,
    section: evidence.section,
    ...(evidence.contextKind === 'technical'
      ? { contextKind: 'technical' }
      : {}),
    source: evidence.sourceLabel,
    text: neutralizeEmbeddedInstructions(evidence.text),
    ...(highConfidenceClaims.length > 0
      ? {
          claims: highConfidenceClaims.map((claim) =>
            claim.schemaVersion === 2
              ? serializedKnowledgeClaim(claim, question)
              : claim.statement,
          ),
        }
      : {}),
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function serializedKnowledgeClaim(claim: PolicyClaimProps, question?: string) {
  if (
    claim.schemaVersion !== 2 ||
    !claim.subject ||
    !claim.predicate ||
    !claim.value
  ) {
    return claim.statement;
  }
  const duplicateValue =
    normalizedClaimText(claim.value) === normalizedClaimText(claim.statement);
  const requiredAnswerDetails = policyAnswerRequiredDetails(claim, question);
  return {
    claimId: claim.claimId,
    subject: claim.subject,
    predicate: claim.predicate,
    ...(!duplicateValue ? { value: claim.value } : {}),
    conditions: claim.conditions ?? [],
    exceptions: claim.exceptions ?? [],
    statement: claim.statement,
    ...(requiredAnswerDetails.length ? { requiredAnswerDetails } : {}),
  };
}

/**
 * 답변이 빠뜨리면 안 되는 항목 중 실제 정책 상세만 남긴다
 * 평가용 항목 목록은 답변 요구사항이 아니고, 입력 데이터 목록은 기술 질문에서만 요구한다
 */
export function policyAnswerRequiredDetails(
  claim: PolicyClaimProps,
  question?: string,
): RequiredAnswerDetail[] {
  const technical =
    !question || policyRetrievalScopeForQuery(question).intent === 'technical';
  return (claim.requiredAnswerDetails ?? []).filter(
    (detail) =>
      !/답변에\s*포함할.*정책\s*항목/.test(detail.label.normalize('NFC')) &&
      (technical ||
        !/^(?:필수|선택)\s*입력\s*데이터$/.test(detail.label.trim())),
  );
}

function normalizedClaimText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim();
}
