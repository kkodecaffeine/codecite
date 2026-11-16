import { join } from 'node:path';
import {
  GOLDEN_BASELINE_FILE,
  GOLDEN_QUESTIONS_FILE,
} from '../evaluation/constants.js';
import {
  collectClaimIds,
  compareWithBaseline,
  createGoldenBaseline,
  findUnknownClaimIds,
  formatGoldenReport,
  readGoldenBaseline,
  readGoldenQuestions,
  runGoldenQuestions,
  writeGoldenBaseline,
} from '../evaluation/golden-eval.js';
import { EXIT_FAILURE, EXIT_OK } from './constants.js';
import { openEngine } from './engine.js';
import { CliUsageError } from './errors.js';
import type { CliLeafCommand } from './types.js';

/**
 * `codecite eval`: 골든 질문을 모델 없이 돌려 기준선과 질문별로 비교한다
 * 회귀가 하나라도 있으면 종료 코드 1 이다. `--write-baseline` 은 기준선만 쓰고, 골든 질문은 어떤 경우에도 쓰지 않는다
 */
export const evalCommand: CliLeafCommand = {
  name: 'eval',
  summary:
    'Run the golden questions offline and compare them with baseline.json',
  usage: '[--write-baseline]',
  description: [
    `Asks every question in ${GOLDEN_QUESTIONS_FILE} without calling any model (BM25 search and`,
    'deterministic answers, even when OPENAI_API_KEY is set) and checks per question whether the',
    'expected claims were packed for the answer (hitAny, hitAll) and whether the status matches',
    `expectStatus. Each question is compared with ${GOLDEN_BASELINE_FILE}: the exit code is 1 when a`,
    'check that passed in the baseline fails now or a baseline question is missing.',
    'Improvements are reported and never fail.',
    '',
    `${GOLDEN_BASELINE_FILE} changes only through a pull request that a person reviews.`,
    `No command writes ${GOLDEN_QUESTIONS_FILE}; people edit it by hand.`,
  ],
  options: {
    'write-baseline': {
      type: 'boolean',
      description: `Write ${GOLDEN_BASELINE_FILE} from the current results instead of comparing; refuses when a golden question expects a claim id the policy CSV does not have`,
    },
  },
  async run(context) {
    if (context.positionals.length > 0) {
      throw new CliUsageError(
        `unexpected argument "${context.positionals[0]}"`,
      );
    }
    const { codecite, source } = await openEngine(context, { offline: true });
    const questions = await readGoldenQuestions(
      join(context.cwd, GOLDEN_QUESTIONS_FILE),
    );
    const unknown = findUnknownClaimIds(
      questions,
      await collectClaimIds(source),
    );
    const baselinePath = join(context.cwd, GOLDEN_BASELINE_FILE);

    if (context.values['write-baseline'] === true) {
      // 데이터에 없는 claim 을 기대하는 질문으로 기준선을 만들면, 고칠 수 없는 실패가 기준이 된다
      if (unknown.length > 0) {
        throw new Error(
          [
            `${GOLDEN_QUESTIONS_FILE} expects claim ids that the policy CSV does not have; fix the questions before writing ${GOLDEN_BASELINE_FILE}:`,
            ...unknown.map(
              (entry) => `  ${entry.id}: ${entry.claimIds.join(', ')}`,
            ),
          ].join('\n'),
        );
      }
      const baseline = createGoldenBaseline(
        await runGoldenQuestions(codecite, questions),
      );
      await writeGoldenBaseline(baselinePath, baseline);
      context.io.stdout(
        `${formatGoldenReport({ results: baseline.questions })}Wrote ${GOLDEN_BASELINE_FILE} (${baseline.passed}/${baseline.total} passed). Commit it through a pull request so a person reviews the change.\n`,
      );
      return EXIT_OK;
    }

    const baseline = await readGoldenBaseline(baselinePath);
    if (!baseline) {
      throw new Error(
        `${GOLDEN_BASELINE_FILE} was not found in ${context.cwd}; run "codecite eval --write-baseline" and commit it through a pull request.`,
      );
    }
    const results = await runGoldenQuestions(codecite, questions);
    const comparison = compareWithBaseline(results, baseline);
    context.io.stdout(
      formatGoldenReport({ results, baseline, comparison, unknown }),
    );
    return comparison.regressions.length > 0 ? EXIT_FAILURE : EXIT_OK;
  },
};
