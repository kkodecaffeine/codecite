import { describe, expect, it, vi } from 'vitest';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  Detection,
  ExtractedSymbol,
  GraphConfig,
  PresetContext,
} from '../../types.js';
import { typeormPreset } from './typeorm.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const config: GraphConfig = {
  cwd: '/work/dotori',
  output: '/work/dotori/.codecite/graph',
  cache: '/work/dotori/.codecite/cache',
  repositories: [{ name: 'shop-api', path: '../shop-api' }],
  defaultExcludes: [],
  presets: ['typeorm'],
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
      repository: 'shop-api',
      filePath,
      content,
    })),
    { repository: 'shop-api', logger },
  );
  expect(result.failures).toEqual([]);
  return result.symbols;
}

function contextFor(
  symbols: ExtractedSymbol[],
  withSymbols = true,
): PresetContext {
  return {
    repository: 'shop-api',
    config,
    logger,
    resolveConstant: (identifier) =>
      (({ COUPON_TABLE: 'coupons' }) as Record<string, string>)[identifier],
    ...(withSymbols ? { symbols } : {}),
  };
}

function detectAll(
  symbols: ExtractedSymbol[],
  context: PresetContext,
): Detection[] {
  return symbols.flatMap((symbol) => typeormPreset.detect(symbol, context));
}

const COUPON_ENTITY = `import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { CouponStatus } from './coupon-status';

@Entity({ name: COUPON_TABLE })
export class Coupon {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('varchar', { length: 20, comment: '도토리 쿠폰 번호' })
  code: string;

  @Column({ type: 'enum', enum: CouponStatus, name: 'coupon_status' })
  status: CouponStatus;

  @ManyToOne(() => Member, (member) => member.coupons)
  @JoinColumn({ name: 'member_id' })
  member: Member;

  @OneToMany(() => Refund, (refund) => refund.coupon)
  refunds: Refund[];

  @Column()
  memberId: string;
}

@Entity()
export class PointLedger {
  @Column({ type: 'int' })
  balance: number;
}
`;

const COUPON_SERVICE = `import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Coupon, PointLedger } from './coupon.entity';

@Injectable()
export class CouponService {
  constructor(
    @InjectRepository(Coupon) private readonly coupons: Repository<Coupon>,
    private readonly ledgers: Repository<PointLedger>,
    private readonly manager: EntityManager,
    private readonly dataSource: DataSource,
  ) {}

  async use(code: string) {
    const coupon = await this.coupons.findOneBy({ code });
    if (coupon) {
      coupon.status = CouponStatus.Used;
    }
    await this.coupons.save(coupon);
    await this.coupons.update({ code }, { status: CouponStatus.Used, usedAt: new Date() });
    await this.ledgers.increment({ memberId: coupon.memberId }, 'balance', 100);
  }

  async expire() {
    await this.dataSource
      .createQueryBuilder()
      .update(Coupon)
      .set({ status: CouponStatus.Expired })
      .where('expires_at < :now', { now: new Date() })
      .execute();
    const repo = this.dataSource.getRepository(PointLedger);
    await repo.insert({ balance: 0 });
    await this.manager.update(Coupon, { code: 'acorn' }, { status: CouponStatus.Issued });
    const stale = await this.coupons.createQueryBuilder('c').where('c.code = :code', { code: 'acorn' }).getOne();
    stale.code = 'reissued';
  }

  async reconcile(items: string[]) {
    const seen = new Map<string, number>();
    seen.set('acorn', 1);
    items.push('acorn');
    // await this.coupons.update({}, { status: 'ghost' });
    return "this.coupons.delete({ status: 'fake' })";
  }
}
`;

const FILES = {
  'src/coupon/coupon.entity.ts': COUPON_ENTITY,
  'src/coupon/coupon.service.ts': COUPON_SERVICE,
};

describe('typeormPreset declarations', () => {
  it('reads table, columns, enum columns and relations from entity members', async () => {
    const symbols = await extract(FILES);
    const declarations = detectAll(symbols, contextFor(symbols)).filter(
      (item) => item.kind === 'entity-declaration',
    );
    expect(declarations).toEqual([
      expect.objectContaining({
        symbol: 'Coupon',
        table: 'coupons',
        className: 'Coupon',
        detector: 'typeorm',
        confidence: 0.95,
        columns: [
          { name: 'id', dataType: 'string' },
          { name: 'code', dataType: 'varchar', comment: '도토리 쿠폰 번호' },
          { name: 'coupon_status', dataType: 'enum', enumName: 'CouponStatus' },
          { name: 'memberId', dataType: 'string' },
        ],
        relations: [
          {
            targetClass: 'Member',
            kind: 'many-to-one',
            property: 'member',
            column: 'member_id',
          },
          { targetClass: 'Refund', kind: 'one-to-many', property: 'refunds' },
        ],
      }),
      expect.objectContaining({
        symbol: 'PointLedger',
        table: 'point_ledger',
        columns: [{ name: 'balance', dataType: 'int' }],
        relations: [],
      }),
    ]);
    expect(declarations[1].evidence).toContain('default table name');
  });
});

describe('typeormPreset access', () => {
  it('keys reads and writes by entity class through members, getRepository and managers', async () => {
    const symbols = await extract(FILES);
    const accesses = detectAll(symbols, contextFor(symbols))
      .filter(
        (item) => item.kind === 'entity-read' || item.kind === 'entity-write',
      )
      .map(
        (item) =>
          'target' in item && [
            item.symbol,
            item.kind,
            item.target,
            item.targetType,
          ],
      );
    expect(accesses).toEqual([
      ['CouponService.use', 'entity-read', 'Coupon', 'class'],
      ['CouponService.use', 'entity-write', 'Coupon', 'class'],
      ['CouponService.use', 'entity-write', 'PointLedger', 'class'],
      ['CouponService.expire', 'entity-write', 'Coupon', 'class'],
      ['CouponService.expire', 'entity-write', 'PointLedger', 'class'],
      ['CouponService.expire', 'entity-read', 'Coupon', 'class'],
    ]);
  });

  it('records field writes with their entity, write kind and conditions', async () => {
    const symbols = await extract(FILES);
    const writes = detectAll(symbols, contextFor(symbols))
      .filter((item) => item.kind === 'field-write')
      .map(
        (item) =>
          item.kind === 'field-write' && [
            item.symbol,
            item.entity,
            item.field,
            item.writeKind,
            item.valueSummary,
            item.conditions,
          ],
      );
    expect(writes).toEqual([
      [
        'CouponService.use',
        'Coupon',
        'status',
        'update-call',
        'CouponStatus.Used',
        undefined,
      ],
      [
        'CouponService.use',
        'Coupon',
        'usedAt',
        'update-call',
        'new Date()',
        undefined,
      ],
      [
        'CouponService.use',
        'PointLedger',
        'balance',
        'update-call',
        '+= 100',
        undefined,
      ],
      [
        'CouponService.use',
        'Coupon',
        'status',
        'assignment',
        'CouponStatus.Used',
        ['coupon'],
      ],
      [
        'CouponService.expire',
        'Coupon',
        'status',
        'update-builder',
        'CouponStatus.Expired',
        undefined,
      ],
      [
        'CouponService.expire',
        'PointLedger',
        'balance',
        'update-call',
        '0',
        undefined,
      ],
      [
        'CouponService.expire',
        'Coupon',
        'status',
        'update-call',
        'CouponStatus.Issued',
        undefined,
      ],
      [
        'CouponService.expire',
        'Coupon',
        'code',
        'assignment',
        '<literal>',
        undefined,
      ],
    ]);
  });

  it('ignores map and array calls, comments and strings', async () => {
    const symbols = await extract(FILES);
    const reconcile = detectAll(symbols, contextFor(symbols)).filter(
      (item) => item.symbol === 'CouponService.reconcile',
    );
    expect(reconcile).toEqual([]);
  });

  it('does not bind injected members without the other symbols', async () => {
    const symbols = await extract(FILES);
    const found = detectAll(symbols, contextFor(symbols, false));
    expect(
      found.filter((item) => item.kind === 'entity-declaration'),
    ).toHaveLength(2);
    // 코드에 엔티티를 적은 쿼리 빌더와 getRepository 지역 변수만 남고, 주입 멤버·매니저 멤버 호출은 잇지 않는다
    expect(
      found
        .filter((item) => item.kind !== 'entity-declaration')
        .map((item) => [
          item.kind,
          'target' in item
            ? item.target
            : item.kind === 'field-write' && item.entity,
        ]),
    ).toEqual([
      ['entity-write', 'Coupon'],
      ['entity-write', 'PointLedger'],
      ['field-write', 'Coupon'],
      ['field-write', 'PointLedger'],
    ]);
  });
});
