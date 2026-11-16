// 큐·이벤트·예약 작업·ORM 프리셋과 설정 규칙을 실제 파이프라인(스냅샷 → 추출 → 탐지 → 토폴로지)에 넣어 본다
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  SystemTopologyGraph,
  TopologyNode,
} from '../../../extensions/code-knowledge.js';
import { parseGraphConfig } from '../../config.js';
import { defaultSymbolExtractors } from '../../extractors/index.js';
import { buildCodeGraph } from '../../pipeline.js';
import type { DetectionsArtifact } from '../../types.js';
import { MESSAGING_PRESETS, rulesPreset } from '../messaging/index.js';
import { ORM_PRESETS, prismaSchemaExtractor } from './index.js';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Dotori Dev',
  GIT_AUTHOR_EMAIL: 'dev@dotori.test',
  GIT_COMMITTER_NAME: 'Dotori Dev',
  GIT_COMMITTER_EMAIL: 'dev@dotori.test',
  GIT_AUTHOR_DATE: '2026-11-02T09:00:00Z',
  GIT_COMMITTER_DATE: '2026-11-02T09:00:00Z',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...IDENTITY },
  }).trim();
}

/** 파일을 커밋한 작업 저장소와 그 bare 복제본. 그래프는 bare 주소로 읽는다 */
async function createRemote(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const work = join(root, `${name}-work`);
  git(root, ['init', '-q', '-b', 'main', work]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'shop']);
  const bare = join(root, `${name}.git`);
  git(root, ['clone', '-q', '--bare', work, bare]);
  return bare;
}

const SHOP_API = {
  'src/order/order-step.ts': `export enum OrderStep {
  Cart = 'cart',
  Checkout = 'checkout',
}
`,
  'src/order/order.entity.ts': `import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { OrderStep } from './order-step';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'enum', enum: OrderStep })
  step: OrderStep;
}
`,
  'src/order/order.service.ts': `import { Injectable } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bull';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';
import { acornBus } from '../shared/acorn-bus';
import { Order } from './order.entity';
import { OrderStep } from './order-step';

@Injectable()
export class OrderService {
  constructor(
    @InjectRepository(Order) private readonly orders: Repository<Order>,
    @InjectQueue('refunds') private readonly refundQueue: Queue,
    private readonly events: EventEmitter2,
  ) {}

  async checkout(id: number) {
    await this.orders.update({ id }, { step: OrderStep.Checkout });
    this.events.emit('order.checkedOut', { id });
    acornBus.publish('coupon-issued', { id });
  }

  async refund(id: number) {
    const pending = new Set<number>();
    pending.add(id);
    await this.refundQueue.add('refund-order', { id });
  }

  @OnEvent('order.checkedOut')
  async onCheckedOut(payload: { id: number }) {
    return this.orders.findOneBy({ id: payload.id });
  }

  @Cron('0 0 3 * * *')
  async closeCarts() {
    await this.orders.delete({ step: OrderStep.Cart });
  }
}
`,
  'src/refund/refund.processor.ts': `import { Process, Processor } from '@nestjs/bull';

@Processor('refunds')
export class RefundProcessor {
  @Process('refund-order')
  async handle(job: { data: { id: number } }) {
    return job.data.id;
  }
}
`,
  'src/coupon/coupon.repository.ts': `export async function useCoupon(prisma: PrismaClient, id: number) {
  await prisma.coupon.update({ where: { id }, data: { code: 'used' } });
}
`,
  'prisma/schema.prisma': `model Coupon {
  id   Int    @id
  code String

  @@map("coupons")
}
`,
};

const SHOP_WORKER = {
  'shop_worker/celery_app.py': `from celery import Celery
from celery.schedules import crontab

app = Celery('shop_worker')
app.conf.beat_schedule = {
    'expire-points': {'task': 'points.expire', 'schedule': crontab(minute=0, hour=4)},
}
`,
  'shop_worker/points.py': `from sqlalchemy import Column, Integer
from sqlalchemy.orm import declarative_base

from shop_worker.celery_app import app

Base = declarative_base()


class PointLedger(Base):
    __tablename__ = 'point_ledgers'
    id = Column(Integer, primary_key=True)
    balance = Column(Integer)


@app.task(name='points.expire')
def expire_points(session):
    session.query(PointLedger).update({'balance': 0})
`,
};

let root: string;
let topology: SystemTopologyGraph;
let detections: DetectionsArtifact;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codecite-presets-')));
  const api = await createRemote(root, 'shop-api', SHOP_API);
  const worker = await createRemote(root, 'shop-worker', SHOP_WORKER);
  await mkdir(join(root, 'graph'));
  const config = parseGraphConfig(
    {
      repositories: [
        { name: 'shop-api', url: api },
        { name: 'shop-worker', url: worker },
      ],
      presets: ['nestjs', 'typeorm', 'prisma', 'celery', 'sqlalchemy'],
      detectors: [
        { kind: 'queue-publisher', call: 'acornBus.publish', nameArgument: 0 },
      ],
    },
    join(root, 'graph'),
  );
  const result = await buildCodeGraph(config, {
    presets: [...MESSAGING_PRESETS, ...ORM_PRESETS],
    rulesPreset,
    extractors: [...defaultSymbolExtractors(), prismaSchemaExtractor()],
  });
  topology = JSON.parse(
    await readFile(join(result.output, 'topology.json'), 'utf8'),
  );
  detections = JSON.parse(
    await readFile(join(result.output, 'detections.json'), 'utf8'),
  );
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const RESOURCE_TYPES = ['Queue', 'Event', 'Scheduler', 'DatabaseTable'];

function resources(repository: string): string[] {
  return topology.nodes
    .filter(
      (node) =>
        node.repository === repository && RESOURCE_TYPES.includes(node.type),
    )
    .map((node) => `${node.type} ${node.name}`)
    .sort();
}

function edgesTo(node: TopologyNode | undefined): string[] {
  const byId = new Map(topology.nodes.map((item) => [item.id, item]));
  return topology.edges
    .filter((edge) => edge.to === node?.id || edge.from === node?.id)
    .map(
      (edge) =>
        `${byId.get(edge.from)?.name} -${edge.type}-> ${byId.get(edge.to)?.name}`,
    )
    .sort();
}

const nodeNamed = (repository: string, type: string, name: string) =>
  topology.nodes.find(
    (node) =>
      node.repository === repository &&
      node.type === type &&
      node.name === name,
  );

describe('presets in buildCodeGraph', { timeout: 60_000 }, () => {
  it('turns detections into queue, event, scheduler and table nodes per repository', () => {
    expect(resources('shop-api')).toEqual([
      'DatabaseTable coupons',
      'DatabaseTable orders',
      'Event order-checked-out',
      'Queue coupon-issued',
      'Queue refunds',
      'Scheduler 0 0 3 * * *',
    ]);
    expect(resources('shop-worker')).toEqual([
      'DatabaseTable point_ledgers',
      'Queue points-expire',
      'Scheduler crontab(minute=0, hour=4)',
    ]);
  });

  it('links publishers and consumers, handlers, schedules and table access inside each repository', () => {
    expect(edgesTo(nodeNamed('shop-api', 'Queue', 'refunds'))).toEqual([
      'OrderService.refund -PUBLISHES-> refunds',
      'RefundProcessor.handle -CONSUMES-> refunds',
      'refunds -TRIGGERS-> RefundProcessor.handle',
    ]);
    expect(
      edgesTo(nodeNamed('shop-api', 'Event', 'order-checked-out')),
    ).toEqual([
      'OrderService.checkout -PRODUCES_EVENT-> order-checked-out',
      'OrderService.onCheckedOut -HANDLES_EVENT-> order-checked-out',
      'order-checked-out -TRIGGERS-> OrderService.onCheckedOut',
    ]);
    expect(edgesTo(nodeNamed('shop-api', 'DatabaseTable', 'orders'))).toEqual([
      'OrderService.checkout -WRITES-> orders',
      'OrderService.closeCarts -WRITES-> orders',
      'OrderService.onCheckedOut -READS-> orders',
      'OrderStep -TYPES_COLUMN-> orders',
    ]);
    expect(edgesTo(nodeNamed('shop-api', 'DatabaseTable', 'coupons'))).toEqual([
      'useCoupon -WRITES-> coupons',
    ]);
    expect(edgesTo(nodeNamed('shop-worker', 'Queue', 'points-expire'))).toEqual(
      [
        'expire_points -CONSUMES-> points-expire',
        'points-expire -TRIGGERS-> expire_points',
        // 주기 실행 표는 파일 최상위 문장이라 파일 노드가 발행한다
        'shop_worker/celery_app.py -PUBLISHES-> points-expire',
      ],
    );
    expect(
      edgesTo(nodeNamed('shop-worker', 'DatabaseTable', 'point_ledgers')),
    ).toEqual(['expire_points -WRITES-> point_ledgers']);
  });

  it('records field writes with their entity and the config rule detector', () => {
    const api = detections.repositories['shop-api'].detections;
    expect(
      api
        .filter((item) => item.kind === 'field-write')
        .map(
          (item) =>
            item.kind === 'field-write' &&
            `${item.symbol} ${item.entity}.${item.field}`,
        ),
    ).toEqual(['useCoupon Coupon.code', 'OrderService.checkout Order.step']);
    expect(api.find((item) => item.detector === 'rule:0')).toMatchObject({
      kind: 'queue-publish',
      name: 'coupon-issued',
      symbol: 'OrderService.checkout',
    });
    // 배열·집합의 add 는 큐 발행이 아니다
    expect(
      api.filter(
        (item) =>
          item.kind === 'queue-publish' &&
          item.symbol === 'OrderService.refund',
      ),
    ).toHaveLength(1);
  });
});
