import {
  CODE_SYMBOL_HEADINGS,
  EVIDENCE_ONLY_HEADINGS,
  SEARCH_ONLY_HEADINGS,
  SHARED_HEADINGS,
  TECHNICAL_HEADINGS,
} from './constants.js';
import { PolicyChunk } from './policy-chunk.js';
import type { Policy } from './policy.js';
import type {
  ParsedPolicySection,
  PolicyChunkProjection,
  PolicyContextKind,
} from './types.js';

/** 하나의 정책을 답변 근거와 검색 보조 문구가 분리된 검색 조각으로 투영한다 */
export function projectPolicyChunks(policy: Policy): PolicyChunk[] {
  return projectKnowledgeText(
    policy.toKnowledgeText(),
    policy.name,
    policy.section,
  ).map((projection) => PolicyChunk.fromPolicy(policy, projection));
}

/** context_text 섹션을 정책 답변용과 기술 구현용 검색 문서로 손실 없이 나눈다 */
export function projectKnowledgeText(
  contextText: string,
  featureName: string,
  domain: string,
): PolicyChunkProjection[] {
  const normalized = contextText.trim();
  if (!normalized) {
    return [];
  }

  const sections = parseSections(normalized);
  if (sections.every((section) => section.heading === undefined)) {
    return [
      {
        contextKind: 'policy',
        text: normalized,
        searchText: contextualSearchText(domain, 'policy', normalized, []),
      },
    ];
  }

  if (
    sections.some(
      (section) => section.heading && CODE_SYMBOL_HEADINGS.has(section.heading),
    )
  ) {
    const text = sectionText(
      sections.filter(
        (section) =>
          section.heading === undefined ||
          (section.heading && CODE_SYMBOL_HEADINGS.has(section.heading)),
      ),
    );
    return [
      {
        contextKind: 'technical',
        text,
        searchText: contextualSearchText(domain, 'technical', text, []),
      },
    ];
  }

  const sharedSections = sections.filter(
    (section) => section.heading && SHARED_HEADINGS.has(section.heading),
  );
  const searchOnlySections = sections.filter(
    (section) => section.heading && SEARCH_ONLY_HEADINGS.has(section.heading),
  );
  const policySections = sections.filter(
    (section) =>
      section.heading === undefined ||
      (!SHARED_HEADINGS.has(section.heading) &&
        !SEARCH_ONLY_HEADINGS.has(section.heading) &&
        !TECHNICAL_HEADINGS.has(section.heading)),
  );
  const technicalSections = sections.filter(
    (section) => section.heading && TECHNICAL_HEADINGS.has(section.heading),
  );

  return [
    buildProjection(
      'policy',
      sharedSections,
      policySections,
      searchOnlySections,
      featureName,
      domain,
    ),
    buildProjection(
      'technical',
      sharedSections,
      technicalSections,
      searchOnlySections,
      featureName,
      domain,
    ),
  ].filter((chunk): chunk is PolicyChunkProjection => Boolean(chunk));
}

function parseSections(contextText: string): ParsedPolicySection[] {
  const headerPattern = /^\[([^\]\r\n]+)\][ \t]*$/gm;
  const matches = [...contextText.matchAll(headerPattern)];
  if (matches.length === 0) {
    return [{ text: contextText }];
  }

  const sections: ParsedPolicySection[] = [];
  const leadingText = contextText.slice(0, matches[0].index).trim();
  if (leadingText) {
    sections.push({ text: leadingText });
  }

  for (const [index, match] of matches.entries()) {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? contextText.length;
    sections.push({
      heading: match[1].trim(),
      text: contextText.slice(start, end).trim(),
    });
  }

  return sections;
}

function buildProjection(
  contextKind: PolicyContextKind,
  sharedSections: ParsedPolicySection[],
  evidenceSections: ParsedPolicySection[],
  searchOnlySections: ParsedPolicySection[],
  featureName: string,
  domain: string,
): PolicyChunkProjection | undefined {
  if (evidenceSections.length === 0 && sharedSections.length === 0) {
    return undefined;
  }
  if (contextKind === 'technical' && evidenceSections.length === 0) {
    return undefined;
  }

  const contextualHeader = sharedSections.length
    ? sharedSections
    : [{ heading: '기능', text: `[기능]\n${featureName.trim()}` }];
  const text = sectionText([...contextualHeader, ...evidenceSections]);
  const searchEvidenceText = sectionText([
    ...contextualHeader,
    ...evidenceSections.filter(
      (section) =>
        !section.heading || !EVIDENCE_ONLY_HEADINGS.has(section.heading),
    ),
  ]);

  return {
    contextKind,
    text,
    searchText: contextualSearchText(
      domain,
      contextKind,
      searchEvidenceText,
      searchOnlySections,
    ),
  };
}

function contextualSearchText(
  domain: string,
  contextKind: PolicyContextKind,
  evidenceText: string,
  searchOnlySections: ParsedPolicySection[],
): string {
  return [
    `도메인: ${domain.trim() || 'policy'}`,
    `컨텍스트 유형: ${contextKind === 'technical' ? '기술 구현' : '정책'}`,
    evidenceText,
    sectionText(searchOnlySections),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function sectionText(sections: ParsedPolicySection[]): string {
  return sections
    .map((section) => section.text)
    .filter(Boolean)
    .join('\n\n');
}
