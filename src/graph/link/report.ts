// report.json 을 읽고 사람이 읽는 글로 바꾼다. CLI 의 보고서 명령과 에이전트 스킬이 같은 글을 본다
// 못 이은 항목은 까닭별로 묶고, 까닭마다 다음에 할 일을 함께 보인다
import { GRAPH_REPORT_FILE, UNRESOLVED_REASONS } from '../data/constants.js';
import { readGraphArtifact } from '../output.js';
import type {
  GraphReport,
  UnresolvedItem,
  UnresolvedReason,
} from '../types.js';
import {
  REPORT_DEFAULT_ITEMS_PER_REASON,
  REPORT_REASON_GUIDE,
} from './constants.js';
import type { FormatGraphReportOptions } from './types.js';

/** 결과 폴더의 report.json. 없으면 undefined, 모양이 보고서가 아니면 throw 한다 */
export async function readGraphReport(
  output: string,
): Promise<GraphReport | undefined> {
  const value = await readGraphArtifact(output, GRAPH_REPORT_FILE);
  if (value === undefined) {
    return undefined;
  }
  const report = value as Partial<GraphReport> | null;
  if (
    typeof report !== 'object' ||
    report === null ||
    report.schemaVersion !== 1 ||
    typeof report.coverage !== 'object' ||
    !Array.isArray(report.unresolved) ||
    !Array.isArray(report.extractionFailures)
  ) {
    throw new Error(`${GRAPH_REPORT_FILE}: not a graph report`);
  }
  return report as GraphReport;
}

/**
 * 보고서를 사람이 읽는 글로 바꾼다(영어, 끝 줄바꿈 포함)
 * coverage 요약 → 관계별 간선 수 → 까닭별 못 이은 항목(다음 할 일과 함께, 까닭마다 itemsPerReason 개까지) → 추출 실패 → 탐지기별 수
 */
export function formatGraphReport(
  report: GraphReport,
  options: FormatGraphReportOptions = {},
): string {
  const limit = options.itemsPerReason ?? REPORT_DEFAULT_ITEMS_PER_REASON;
  const coverage = report.coverage;
  const lines: string[] = [];
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  lines.push(
    `Coverage: ${coverage.status} - ${coverage.linkedProviderContracts} of ${coverage.providerContracts} provider contracts linked, ` +
      `${coverage.unresolvedProviderContracts} unresolved (${percent(report.unresolvedRatio)})`,
  );
  const missing = coverage.expectedRepositories.filter(
    (repository) => !coverage.auditedRepositories.includes(repository),
  );
  lines.push(
    `Repositories: ${coverage.auditedRepositories.join(', ') || '(none)'}` +
      (missing.length > 0 ? `; no symbols in ${missing.join(', ')}` : ''),
  );
  const relations = Object.entries(report.relations);
  lines.push(
    `Links: ${
      relations.length > 0
        ? relations
            .map(([relation, count]) => `${relation} ${count}`)
            .join(', ')
        : 'none'
    }`,
  );
  const reasons = Object.entries(report.reasons);
  lines.push(
    `Unresolved: ${report.unresolved.length}` +
      (reasons.length > 0
        ? ` (${reasons.map(([reason, count]) => `${reason} ${count}`).join(', ')})`
        : ''),
  );

  for (const reason of UNRESOLVED_REASONS) {
    const items = report.unresolved.filter((item) => item.reason === reason);
    if (items.length === 0) {
      continue;
    }
    lines.push('', reasonHeading(reason, items.length));
    for (const item of items.slice(0, limit)) {
      lines.push(`  ${itemLine(item)}`);
      if (item.candidates && item.candidates.length > 0) {
        lines.push(`    candidates: ${item.candidates.join(', ')}`);
      }
    }
    if (items.length > limit) {
      lines.push(`  ... and ${items.length - limit} more`);
    }
  }

  if (report.extractionFailures.length > 0) {
    lines.push('', `Skipped files: ${report.extractionFailures.length}`);
    for (const failure of report.extractionFailures.slice(0, limit)) {
      lines.push(
        `  ${failure.repository} ${failure.filePath}: ${failure.message}`,
      );
    }
    if (report.extractionFailures.length > limit) {
      lines.push(`  ... and ${report.extractionFailures.length - limit} more`);
    }
  }

  const detectors = Object.entries(report.detectors);
  if (detectors.length > 0) {
    lines.push('', 'Detections by detector:');
    for (const [detector, kinds] of detectors) {
      lines.push(
        `  ${detector}: ${Object.entries(kinds)
          .map(([kind, count]) => `${kind} ${count}`)
          .join(', ')}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

function reasonHeading(reason: UnresolvedReason, count: number): string {
  const guide = REPORT_REASON_GUIDE[reason];
  return `${reason} (${count}): ${guide.meaning}. Next: ${guide.next}`;
}

function itemLine(item: UnresolvedItem): string {
  const place = `${item.repository} ${item.filePath}${item.line !== undefined ? `:${item.line}` : ''}`;
  return `${place} ${item.symbol} ${item.relation} ${item.value}`;
}
