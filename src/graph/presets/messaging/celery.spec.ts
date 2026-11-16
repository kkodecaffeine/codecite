import { describe, expect, it, vi } from 'vitest';
import { pythonExtractor } from '../../extractors/python.js';
import type {
  Detection,
  ExtractedSymbol,
  GraphConfig,
  PresetContext,
} from '../../types.js';
import { celeryPreset } from './celery.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const config: GraphConfig = {
  cwd: '/work/dotori',
  output: '/work/dotori/.codecite/graph',
  cache: '/work/dotori/.codecite/cache',
  repositories: [{ name: 'shop-worker', path: '../shop-worker' }],
  defaultExcludes: [],
  presets: ['celery'],
  hints: {},
  detectors: [],
  entities: { foreignKeySuffixes: ['_id'] },
  groups: {},
  extractorModules: [],
  presetModules: [],
};

async function extract(
  files: Record<string, string>,
): Promise<ExtractedSymbol[]> {
  const result = await pythonExtractor().extract(
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
  withSymbols = true,
): PresetContext {
  const constants = new Map<string, string>();
  for (const symbol of symbols) {
    for (const site of symbol.sites ?? []) {
      if (site.kind === 'assign' && site.args[0]?.literal !== undefined) {
        constants.set(site.name, site.args[0].literal);
      }
    }
  }
  return {
    repository: 'shop-worker',
    config,
    logger,
    resolveConstant: (identifier) => constants.get(identifier),
    ...(withSymbols ? { symbols } : {}),
  };
}

function detectAll(
  symbols: ExtractedSymbol[],
  context: PresetContext,
): Detection[] {
  return symbols.flatMap((symbol) => celeryPreset.detect(symbol, context));
}

const WORKER = {
  'shop_worker/celery_app.py': `from celery import Celery
from celery.schedules import crontab

app = Celery('shop_worker')
app.conf.beat_schedule = {
    'expire-coupons': {
        'task': 'coupons.expire',
        'schedule': crontab(minute='*/15', hour=3),
    },
    'settle-points': {
        'task': 'shop_worker.points.settle_points',
        'schedule': 300.0,
    },
}
`,
  'shop_worker/coupons.py': `from shop_worker.celery_app import app

COUPON_QUEUE = 'coupon-jobs'


@app.task(name='coupons.expire', queue=COUPON_QUEUE)
def expire_coupons():
    return 'expired'


@app.task
def restore_coupon(coupon_id):
    return coupon_id
`,
  'shop_worker/points.py': `from celery import shared_task


@shared_task
def settle_points():
    return 'settled'


def cleanup():
    return None
`,
  'shop_worker/orders.py': `from shop_worker import points
from shop_worker.celery_app import app
from shop_worker.coupons import restore_coupon
from shop_worker.points import cleanup
from shared_tasks.refunds import refund_order


def cancel_order(order_id):
    restore_coupon.delay(order_id)
    points.settle_points.apply_async(queue='slow')
    cleanup.delay()
    refund_order.delay(order_id)
    app.send_task('refunds.notify', args=[order_id])
    # restore_coupon.delay('ghost')
    note = "restore_coupon.delay(order_id)"
    return note
`,
  'shop_worker/periodic.py': `from celery.schedules import crontab
from shop_worker.celery_app import app
from shop_worker.coupons import restore_coupon


@app.on_after_configure.connect
def setup_periodic_tasks(sender, **kwargs):
    sender.add_periodic_task(crontab(hour=4, minute=0), restore_coupon.s(1), name='restore')
`,
};

const describeDetection = (item: Detection) => {
  if (item.kind === 'schedule') {
    return [item.symbol, item.kind, item.expression];
  }
  if (item.kind === 'queue-consume' || item.kind === 'queue-publish') {
    return [item.symbol, item.kind, item.name, item.confidence];
  }
  return [item.symbol, item.kind];
};

describe('celeryPreset', () => {
  it('names consumers by task name and keeps the queue in the evidence', async () => {
    const symbols = await extract(WORKER);
    const consumers = detectAll(symbols, contextFor(symbols)).filter(
      (item) => item.kind === 'queue-consume',
    );
    expect(consumers.map(describeDetection)).toEqual([
      ['expire_coupons', 'queue-consume', 'coupons.expire', 0.9],
      [
        'restore_coupon',
        'queue-consume',
        'shop_worker.coupons.restore_coupon',
        0.9,
      ],
      [
        'settle_points',
        'queue-consume',
        'shop_worker.points.settle_points',
        0.9,
      ],
    ]);
    expect(consumers[0].evidence).toContain('queue=coupon-jobs');
    expect(consumers[1].evidence).toContain('default name');
  });

  it('resolves delay, apply_async and send_task to task names', async () => {
    const symbols = await extract(WORKER);
    const published = detectAll(symbols, contextFor(symbols)).filter(
      (item) => item.kind === 'queue-publish' && item.symbol === 'cancel_order',
    );
    expect(published.map(describeDetection)).toEqual([
      [
        'cancel_order',
        'queue-publish',
        'shop_worker.coupons.restore_coupon',
        0.9,
      ],
      [
        'cancel_order',
        'queue-publish',
        'shop_worker.points.settle_points',
        0.9,
      ],
      [
        'cancel_order',
        'queue-publish',
        'shared_tasks.refunds.refund_order',
        0.75,
      ],
      ['cancel_order', 'queue-publish', 'refunds.notify', 0.9],
    ]);
    expect(published[1].evidence).toContain('queue=slow');
    expect(published.map((item) => item.evidence).join(' ')).not.toContain(
      'ghost',
    );
  });

  it('turns beat schedule entries and periodic tasks into schedules that publish the task', async () => {
    const symbols = await extract(WORKER);
    const beat = detectAll(symbols, contextFor(symbols)).filter(
      (item) =>
        item.symbol === '<module>' || item.symbol === 'setup_periodic_tasks',
    );
    expect(beat.map(describeDetection)).toEqual([
      ['<module>', 'schedule', 'crontab(minute=*/15, hour=3)'],
      ['<module>', 'queue-publish', 'coupons.expire', 0.9],
      ['<module>', 'schedule', 'every 300.0s'],
      ['<module>', 'queue-publish', 'shop_worker.points.settle_points', 0.9],
      ['setup_periodic_tasks', 'schedule', 'crontab(hour=4, minute=0)'],
      [
        'setup_periodic_tasks',
        'queue-publish',
        'shop_worker.coupons.restore_coupon',
        0.9,
      ],
    ]);
    expect(beat[0]).toMatchObject({
      filePath: 'shop_worker/celery_app.py',
      line: 5,
      evidence: 'beat_schedule[expire-coupons] → coupons.expire',
    });
  });

  it('reads beat schedules passed through conf.update', async () => {
    const symbols = await extract({
      'shop_worker/beat.py': `from celery import Celery
from celery.schedules import crontab

app = Celery('shop_worker')
app.conf.update(
    timezone='Asia/Seoul',
    beat_schedule={
        'retry-refunds': {'task': 'refunds.retry', 'schedule': crontab(minute=0)},
    },
)
`,
    });
    expect(
      detectAll(symbols, contextFor(symbols)).map(describeDetection),
    ).toEqual([
      ['<module>', 'schedule', 'crontab(minute=0)'],
      ['<module>', 'queue-publish', 'refunds.retry', 0.9],
    ]);
  });

  it('lowers confidence when the app and the published task cannot be checked', async () => {
    const symbols = await extract(WORKER);
    const context = contextFor(symbols, false);
    const restore = detectAll(symbols, context).filter((item) =>
      item.kind === 'queue-consume' || item.kind === 'queue-publish'
        ? item.name.endsWith('restore_coupon')
        : false,
    );
    expect(restore.map(describeDetection)).toEqual([
      [
        'restore_coupon',
        'queue-consume',
        'shop_worker.coupons.restore_coupon',
        0.7,
      ],
      [
        'cancel_order',
        'queue-publish',
        'shop_worker.coupons.restore_coupon',
        0.75,
      ],
      [
        'setup_periodic_tasks',
        'queue-publish',
        'shop_worker.coupons.restore_coupon',
        0.75,
      ],
    ]);
  });
});
