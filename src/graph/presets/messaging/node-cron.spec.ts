import { describe, expect, it, vi } from 'vitest';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  ExtractedSymbol,
  GraphConfig,
  PresetContext,
  ScheduleDetection,
} from '../../types.js';
import { nodeCronPreset } from './node-cron.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const config: GraphConfig = {
  cwd: '/work/dotori',
  output: '/work/dotori/.codecite/graph',
  cache: '/work/dotori/.codecite/cache',
  repositories: [{ name: 'shop-worker', path: '../shop-worker' }],
  defaultExcludes: [],
  presets: ['node-cron'],
  hints: {},
  detectors: [],
  entities: { foreignKeySuffixes: ['Id'] },
  groups: {},
  extractorModules: [],
  presetModules: [],
};

async function extract(
  files: Record<string, string>,
): Promise<ExtractedSymbol[]> {
  const result = await typescriptExtractor().extract(
    Object.entries(files).map(([filePath, content]) => ({
      repository: 'shop-worker',
      filePath,
      content,
    })),
    { repository: 'shop-worker', logger },
  );
  expect(result.failures).toEqual([]);
  return result.symbols;
}

function contextFor(
  symbols: ExtractedSymbol[],
  constants: Record<string, string> = {},
  withSymbols = true,
): PresetContext {
  return {
    repository: 'shop-worker',
    config,
    logger,
    resolveConstant: (identifier) => constants[identifier],
    ...(withSymbols ? { symbols } : {}),
  };
}

function schedules(symbols: ExtractedSymbol[], context: PresetContext) {
  return symbols
    .flatMap((symbol) => nodeCronPreset.detect(symbol, context))
    .map((item) => {
      const schedule = item as ScheduleDetection;
      return [schedule.filePath, schedule.symbol, schedule.expression];
    });
}

describe('nodeCronPreset', () => {
  it('attributes a registered function to the function and an inline callback to the registering symbol', async () => {
    const symbols = await extract({
      'src/jobs/index.ts': `import cron from 'node-cron';
import { schedule as every } from 'node-cron';
import { settlePoints } from '../points/points.job';

const EXPIRE_CRON = '30 4 * * *';

export function expireCoupons() {
  return 'coupons';
}

cron.schedule('0 3 * * *', expireCoupons);
cron.schedule('0 5 * * *', settlePoints, { timezone: 'Asia/Seoul' });
every(EXPIRE_CRON, () => expireCoupons());
cron.schedule(process.env.REFUND_CRON, () => expireCoupons());
// cron.schedule('* * * * *', expireCoupons);
const memo = "cron.schedule('* * * * *', expireCoupons)";
`,
      'src/points/points.job.ts': `export async function settlePoints() {
  return 'points';
}
`,
    });
    const found = schedules(
      symbols,
      contextFor(symbols, { EXPIRE_CRON: '30 4 * * *' }),
    );
    expect(found).toEqual([
      ['src/jobs/index.ts', 'expireCoupons', '0 3 * * *'],
      ['src/points/points.job.ts', 'settlePoints', '0 5 * * *'],
      ['src/jobs/index.ts', '<module>', '30 4 * * *'],
      ['src/jobs/index.ts', '<module>', 'runtime'],
    ]);
  });

  it('reads require bindings and ignores schedule calls from other modules', async () => {
    const symbols = await extract({
      'src/jobs/refund.js': `const cron = require('node-cron');
const timer = require('./timer');

function retryRefunds() {}

cron.schedule('*/10 * * * *', retryRefunds);
timer.schedule('*/5 * * * *', retryRefunds);
`,
      'src/jobs/local-cron.ts': `import cron from './cron-like';
cron.schedule('0 0 * * *', () => undefined);
`,
    });
    expect(schedules(symbols, contextFor(symbols))).toEqual([
      ['src/jobs/refund.js', 'retryRefunds', '*/10 * * * *'],
    ]);
  });

  it('keeps the registration on the registering symbol when other symbols are not visible', async () => {
    const symbols = await extract({
      'src/jobs/index.ts': `import cron from 'node-cron';
export function expireCoupons() {}
cron.schedule('0 3 * * *', expireCoupons);
`,
    });
    expect(schedules(symbols, contextFor(symbols, {}, false))).toEqual([
      ['src/jobs/index.ts', '<module>', '0 3 * * *'],
    ]);
  });
});
