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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  EntityRelationGraph,
  FieldWriterIndex,
} from '../../extensions/code-knowledge.js';
import { parseGraphConfig } from '../config.js';
import { buildCodeGraph } from '../pipeline.js';
import { validateGraphOutput } from './validate.js';

const git = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

async function createRemote(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const work = join(root, `${name}-work`);
  await mkdir(work, { recursive: true });
  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'user.email', 'dotori@example.com']);
  git(work, ['config', 'user.name', 'Dotori']);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'init']);
  const bare = join(root, `${name}.git`);
  git(root, ['clone', '-q', '--bare', work, bare]);
  return bare;
}

/** 도토리 마켓 shop-api: 쿠폰·주문 엔티티와 쿠폰을 쓰는 서비스 */
const SHOP_API = {
  'src/order/order.entity.ts': [
    "import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';",
    '',
    "@Entity('orders')",
    'export class Order {',
    '  @PrimaryGeneratedColumn()',
    '  id: number;',
    '',
    '  @Column()',
    '  status: string;',
    '',
    '  @Column()',
    '  couponId: number;',
    '',
    '  markPaid() {',
    "    this.status = 'paid';",
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/coupon/coupon.entity.ts': [
    "import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';",
    '',
    "@Entity('coupons')",
    'export class Coupon {',
    '  @PrimaryGeneratedColumn()',
    '  id: number;',
    '',
    '  @Column()',
    '  usedAt: Date;',
    '}',
    '',
  ].join('\n'),
  'src/coupon/coupon.service.ts': [
    "import { InjectRepository } from '@nestjs/typeorm';",
    "import { Repository } from 'typeorm';",
    "import { Coupon } from './coupon.entity';",
    '',
    'export class CouponService {',
    '  constructor(',
    '    @InjectRepository(Coupon) private readonly coupons: Repository<Coupon>,',
    '  ) {}',
    '',
    '  async use(id: number, when: Date) {',
    '    if (when) {',
    '      await this.coupons.update(id, { usedAt: when });',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'),
};

let root: string;

beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codecite-data-')));
  await mkdir(join(root, 'graph'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('buildCodeGraph 의 데이터 단계', { timeout: 60_000 }, () => {
  it('ORM 프리셋 결과로 엔티티 관계와 필드 쓰기 색인을 쓰고, 결과 폴더는 검사를 지나고 두 번 만들어도 같다', async () => {
    const api = await createRemote(root, 'shop-api', SHOP_API);
    const config = parseGraphConfig(
      {
        output: 'first',
        repositories: [{ name: 'shop-api', url: api }],
        presets: ['typeorm'],
      },
      join(root, 'graph'),
    );

    const result = await buildCodeGraph(config);

    expect(result.files).toEqual(
      expect.arrayContaining(['entities.json', 'field-writers.json']),
    );
    const entities = JSON.parse(
      await readFile(join(config.output, 'entities.json'), 'utf8'),
    ) as EntityRelationGraph;
    expect(entities.tables.map((table) => table.table)).toEqual([
      'coupons',
      'orders',
    ]);
    expect(
      entities.tables.find((table) => table.table === 'orders')?.relations,
    ).toEqual([
      {
        targetTable: 'coupons',
        kind: 'many-to-one',
        source: 'naming',
        column: 'couponId',
      },
    ]);
    const writers = JSON.parse(
      await readFile(join(config.output, 'field-writers.json'), 'utf8'),
    ) as FieldWriterIndex;
    expect(writers.writers['shop-api:usedAt']).toEqual([
      expect.objectContaining({
        symbol: 'CouponService.use',
        kind: 'update-call',
        entity: 'coupons',
      }),
    ]);
    expect(writers.writers['shop-api:status']).toEqual([
      expect.objectContaining({
        symbol: 'Order.markPaid',
        kind: 'assignment',
        entity: 'orders',
        valueSummary: '<literal>',
      }),
    ]);

    const checked = await validateGraphOutput(config.output, { config });
    expect(checked).toEqual({ ok: true, errors: [], warnings: [] });

    const again = parseGraphConfig(
      {
        output: 'second',
        repositories: [{ name: 'shop-api', url: api }],
        presets: ['typeorm'],
      },
      join(root, 'graph'),
    );
    await buildCodeGraph(again);
    for (const file of ['entities.json', 'field-writers.json']) {
      expect(await readFile(join(again.output, file), 'utf8')).toBe(
        await readFile(join(config.output, file), 'utf8'),
      );
    }
  });
});
