import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { PolicySource } from '../ports.js';
import type { Codecite, CodeciteAnswer } from '../types.js';
import {
  GOLDEN_BASELINE_FILE,
  GOLDEN_BASELINE_SCHEMA_VERSION,
  GOLDEN_CHECK_LABELS,
  GOLDEN_CHECKS,
  GOLDEN_EXPECTED_STATUSES,
  GOLDEN_QUESTIONS_FILE,
} from './constants.js';
import type {
  GoldenBaseline,
  GoldenChange,
  GoldenComparison,
  GoldenQuestion,
  GoldenQuestionResult,
  GoldenUnknownClaims,
} from './types.js';

/**
 * 골든 질문 파일을 읽고 모양을 확인한다. 이 파일은 사람만 고치므로 어떤 함수도 쓰지 않는다
 * 오류 문장에는 질문 본문 대신 질문 id 를 적는다
 */
export async function readGoldenQuestions(
  path: string,
): Promise<GoldenQuestion[]> {
  const value = await readJson(path);
  if (value === undefined) {
    throw new Error(
      `${basename(path)} was not found in ${resolve(dirname(path))}.`,
    );
  }
  return parseGoldenQuestions(value, basename(path));
}

/** 골든 질문 배열을 확인한다. id 가 겹치거나, 잴 항목(기대 claim·기대 status)이 하나도 없으면 throw 한다 */
export function parseGoldenQuestions(
  value: unknown,
  label: string = GOLDEN_QUESTIONS_FILE,
): GoldenQuestion[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: must be an array of questions.`);
  }
  const seen = new Set<string>();
  return value.map((item: unknown, index): GoldenQuestion => {
    if (!isRecord(item)) {
      throw new Error(`${label}: entry ${index + 1} must be an object.`);
    }
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) {
      throw new Error(
        `${label}: entry ${index + 1} needs an id (a non-empty string).`,
      );
    }
    const fail = (detail: string) => new Error(`${label}: ${id}: ${detail}`);
    if (seen.has(id)) {
      throw fail('id is used by another question.');
    }
    seen.add(id);
    if (typeof item.question !== 'string' || !item.question.trim()) {
      throw fail('question must be a non-empty string.');
    }
    const expected = item.expectedClaimIds;
    if (
      !Array.isArray(expected) ||
      expected.some((claimId) => typeof claimId !== 'string' || !claimId)
    ) {
      throw fail('expectedClaimIds must be an array of claim ids.');
    }
    const expectStatus = item.expectStatus;
    if (expectStatus !== undefined && !isAnswerStatus(expectStatus)) {
      throw fail(
        `expectStatus must be one of ${GOLDEN_EXPECTED_STATUSES.map((status) => `"${status}"`).join(', ')}.`,
      );
    }
    if (expected.length === 0 && expectStatus === undefined) {
      throw fail('needs expectedClaimIds or expectStatus to check.');
    }
    return {
      id,
      question: item.question,
      expectedClaimIds: [...(expected as string[])],
      ...(expectStatus ? { expectStatus } : {}),
    };
  });
}

/** 정책 소스의 활성 claim id. 골든 질문이 데이터에 없는 claim 을 기대하는지 볼 때 쓴다 */
export async function collectClaimIds(
  source: PolicySource,
): Promise<Set<string>> {
  const policies = await source.loadPolicies();
  return new Set(
    policies
      .filter((policy) => policy.isActive())
      .flatMap((policy) => policy.policyClaims.map((claim) => claim.claimId)),
  );
}

/** 데이터에 없는 claim id 를 기대하는 질문. 이런 질문은 어떤 검색으로도 맞힐 수 없다 */
export function findUnknownClaimIds(
  questions: readonly GoldenQuestion[],
  knownClaimIds: ReadonlySet<string>,
): GoldenUnknownClaims[] {
  return questions
    .map((question) => ({
      id: question.id,
      claimIds: question.expectedClaimIds.filter(
        (claimId) => !knownClaimIds.has(claimId),
      ),
    }))
    .filter((entry) => entry.claimIds.length > 0);
}

/**
 * 답 하나를 잰다. 인용은 답변 모델에 넘긴 근거의 claim 이다
 * 기대 claim 이 없으면 hitAny·hitAll 을, expectStatus 가 없으면 status 를 재지 않고 null 로 둔다
 */
export function scoreGoldenAnswer(
  question: GoldenQuestion,
  answer: Pick<CodeciteAnswer, 'status' | 'citations'>,
): GoldenQuestionResult {
  const cited = new Set(answer.citations.map((citation) => citation.claimId));
  const expected = question.expectedClaimIds;
  const hitAny =
    expected.length > 0 ? expected.some((claimId) => cited.has(claimId)) : null;
  const hitAll =
    expected.length > 0
      ? expected.every((claimId) => cited.has(claimId))
      : null;
  const statusMatch =
    question.expectStatus === undefined
      ? null
      : answer.status === question.expectStatus;
  return {
    id: question.id,
    passed: [hitAny, hitAll, statusMatch].every((check) => check !== false),
    hitAny,
    hitAll,
    status: answer.status,
    statusMatch,
  };
}

/** 골든 질문을 순서대로 하나씩 묻고 잰다. 모델 없는 엔진을 넘기면 결정적이다 */
export async function runGoldenQuestions(
  codecite: Pick<Codecite, 'ask'>,
  questions: readonly GoldenQuestion[],
): Promise<GoldenQuestionResult[]> {
  const results: GoldenQuestionResult[] = [];
  for (const question of questions) {
    results.push(
      scoreGoldenAnswer(question, await codecite.ask(question.question)),
    );
  }
  return results;
}

/** 결과로 기준선을 만든다 */
export function createGoldenBaseline(
  results: readonly GoldenQuestionResult[],
): GoldenBaseline {
  return {
    schemaVersion: GOLDEN_BASELINE_SCHEMA_VERSION,
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    questions: results.map((result) => ({ ...result })),
  };
}

/** 기준선 파일을 읽는다. 파일이 없으면 undefined */
export async function readGoldenBaseline(
  path: string,
): Promise<GoldenBaseline | undefined> {
  const value = await readJson(path);
  return value === undefined
    ? undefined
    : parseGoldenBaseline(value, basename(path));
}

/** 기준선 모양을 확인한다. total·passed 는 사람이 읽는 값이라 질문 결과로 다시 센다 */
export function parseGoldenBaseline(
  value: unknown,
  label: string = GOLDEN_BASELINE_FILE,
): GoldenBaseline {
  if (!isRecord(value) || !Array.isArray(value.questions)) {
    throw new Error(`${label}: must be an object with a questions array.`);
  }
  if (value.schemaVersion !== GOLDEN_BASELINE_SCHEMA_VERSION) {
    throw new Error(
      `${label}: schemaVersion must be ${GOLDEN_BASELINE_SCHEMA_VERSION}.`,
    );
  }
  const seen = new Set<string>();
  const questions = value.questions.map(
    (item: unknown, index): GoldenQuestionResult => {
      const id = isRecord(item) && typeof item.id === 'string' ? item.id : '';
      const where = `${label}: ${id || `entry ${index + 1}`}`;
      if (!isRecord(item) || !id || seen.has(id)) {
        throw new Error(`${where} needs a unique id.`);
      }
      seen.add(id);
      for (const check of GOLDEN_CHECKS) {
        if (item[check] !== null && typeof item[check] !== 'boolean') {
          throw new Error(`${where}: ${check} must be true, false or null.`);
        }
      }
      if (typeof item.passed !== 'boolean' || !isAnswerStatus(item.status)) {
        throw new Error(`${where}: passed or status is missing.`);
      }
      return {
        id,
        passed: item.passed,
        hitAny: item.hitAny as boolean | null,
        hitAll: item.hitAll as boolean | null,
        status: item.status,
        statusMatch: item.statusMatch as boolean | null,
      };
    },
  );
  return createGoldenBaseline(questions);
}

/** 기준선을 JSON 으로 쓴다. 이 파일은 사람이 PR 로 검토해 들인다 */
export async function writeGoldenBaseline(
  path: string,
  baseline: GoldenBaseline,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
}

/**
 * 기준선과 질문별로 비교한다. 평균을 보지 않아 한 질문의 회귀를 다른 질문의 개선이 가리지 못한다
 * - 기준선에서 맞던(true) 항목이 지금 맞지 않으면(false·null) 회귀다
 * - 기준선의 질문이 결과에 없으면 회귀다
 * - 기준선에서 맞지 않던 항목이 지금 맞으면 개선이다. 개선은 실패로 치지 않는다
 */
export function compareWithBaseline(
  results: readonly GoldenQuestionResult[],
  baseline: GoldenBaseline,
): GoldenComparison {
  const current = new Map(results.map((result) => [result.id, result]));
  const baselineIds = new Set(baseline.questions.map((entry) => entry.id));
  const regressions: GoldenChange[] = [];
  const improvements: GoldenChange[] = [];
  for (const before of baseline.questions) {
    const now = current.get(before.id);
    if (!now) {
      regressions.push({ id: before.id, check: 'missing' });
      continue;
    }
    for (const check of GOLDEN_CHECKS) {
      if (before[check] === true && now[check] !== true) {
        regressions.push({ id: before.id, check });
      } else if (before[check] !== true && now[check] === true) {
        improvements.push({ id: before.id, check });
      }
    }
  }
  return {
    regressions,
    improvements,
    added: results
      .filter((result) => !baselineIds.has(result.id))
      .map((result) => result.id),
  };
}

/** 사람이 읽는 짧은 보고서. 합계 표, 회귀, 개선, 틀린 질문 id 를 보인다. 질문 본문은 넣지 않는다 */
export function formatGoldenReport(input: {
  results: readonly GoldenQuestionResult[];
  baseline?: GoldenBaseline;
  comparison?: GoldenComparison;
  unknown?: readonly GoldenUnknownClaims[];
}): string {
  const { results, baseline, comparison, unknown = [] } = input;
  const rows: string[][] = [
    ['', 'now', ...(baseline ? ['baseline'] : [])],
    [
      'passed',
      ratio(results, (result) => result.passed),
      ...(baseline ? [ratio(baseline.questions, (entry) => entry.passed)] : []),
    ],
    ...GOLDEN_CHECKS.map((check) => [
      GOLDEN_CHECK_LABELS[check],
      ratio(results, (result) => result[check]),
      ...(baseline ? [ratio(baseline.questions, (entry) => entry[check])] : []),
    ]),
  ];
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  const lines = [
    `Golden questions: ${results.length}`,
    '',
    ...rows.map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join('  ')
        .trimEnd(),
    ),
    '',
  ];
  if (comparison) {
    lines.push(
      `Regressions: ${comparison.regressions.length}`,
      ...changeLines(comparison.regressions, baseline, results),
      `Improvements: ${comparison.improvements.length}`,
      ...changeLines(comparison.improvements, baseline, results),
    );
    if (comparison.added.length > 0) {
      lines.push(
        `New questions (not in the baseline): ${comparison.added.join(', ')}`,
      );
    }
  }
  const misses = results.filter((result) => !result.passed);
  lines.push(
    `Misses: ${misses.length > 0 ? misses.map((result) => result.id).join(', ') : 'none'}`,
  );
  if (unknown.length > 0) {
    lines.push(
      'Claim ids not in the policy data:',
      ...unknown.map((entry) => `  ${entry.id}: ${entry.claimIds.join(', ')}`),
    );
  }
  return `${lines.join('\n')}\n`;
}

function changeLines(
  changes: readonly GoldenChange[],
  baseline: GoldenBaseline | undefined,
  results: readonly GoldenQuestionResult[],
): string[] {
  const width = Math.max(0, ...changes.map((change) => change.id.length));
  const before = new Map(baseline?.questions.map((entry) => [entry.id, entry]));
  const now = new Map(results.map((result) => [result.id, result]));
  return changes.map((change) => {
    const id = change.id.padEnd(width);
    if (change.check === 'missing') {
      return `  ${id}  missing from the results`;
    }
    const from = outcome(before.get(change.id)?.[change.check]);
    const to = outcome(now.get(change.id)?.[change.check]);
    return `  ${id}  ${GOLDEN_CHECK_LABELS[change.check]}: ${from} -> ${to}`;
  });
}

function outcome(value: boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return 'not checked';
  }
  return value ? 'pass' : 'fail';
}

/** 잰 항목 중 맞은 수. 재지 않은(null) 질문은 분모에서 뺀다 */
function ratio<T>(
  items: readonly T[],
  pick: (item: T) => boolean | null,
): string {
  const checked = items.map(pick).filter((value) => value !== null);
  return `${checked.filter(Boolean).length}/${checked.length}`;
}

async function readJson(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(
      `${basename(path)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function isAnswerStatus(value: unknown): value is CodeciteAnswer['status'] {
  return (GOLDEN_EXPECTED_STATUSES as readonly unknown[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
