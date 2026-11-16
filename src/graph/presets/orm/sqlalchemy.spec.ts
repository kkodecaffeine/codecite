import { describe, expect, it, vi } from 'vitest';
import { createConstantResolver } from '../../constant-resolver.js';
import { pythonExtractor } from '../../extractors/python.js';
import type {
  Detection,
  ExtractedSymbol,
  GraphConfig,
  PresetContext,
} from '../../types.js';
import { sqlalchemyPreset } from './sqlalchemy.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const config: GraphConfig = {
  cwd: '/work/dotori',
  output: '/work/dotori/.codecite/graph',
  cache: '/work/dotori/.codecite/cache',
  repositories: [{ name: 'shop-worker', path: '../shop-worker' }],
  defaultExcludes: [],
  presets: ['sqlalchemy'],
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

async function contextFor(
  symbols: ExtractedSymbol[],
  withSymbols = true,
): Promise<PresetContext> {
  const resolver = await createConstantResolver(symbols, {
    repository: 'shop-worker',
    logger,
  });
  return {
    repository: 'shop-worker',
    config,
    logger,
    resolveConstant: (identifier) => resolver.resolve(identifier),
    ...(withSymbols ? { symbols } : {}),
  };
}

function detectAll(
  symbols: ExtractedSymbol[],
  context: PresetContext,
): Detection[] {
  return symbols.flatMap((symbol) => sqlalchemyPreset.detect(symbol, context));
}

const MODELS = `import enum

from sqlalchemy import Column, Enum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, declarative_base, mapped_column, relationship

Base = declarative_base()
COUPON_TABLE = 'coupons'


class CouponKind(enum.Enum):
    FIXED = 'fixed'
    RATE = 'rate'


class Order(Base):
    __tablename__ = 'orders'
    id = Column(Integer, primary_key=True)
    coupons = relationship('Coupon', back_populates='order')


class Coupon(Base):
    __tablename__ = COUPON_TABLE
    id = Column(Integer, primary_key=True)
    code = Column('coupon_code', String(20), comment='도토리 쿠폰 코드')
    kind = mapped_column(Enum(CouponKind))
    order_id = Column(Integer, ForeignKey('orders.id'))
    member_id = Column(Integer, ForeignKey('members.id'))
    order = relationship('Order', back_populates='coupons')


class Member(Base):
    __tablename__ = 'members'
    id: Mapped[int] = mapped_column(primary_key=True)
    profile = relationship('Profile', uselist=False)
    tags = relationship('Tag', secondary='member_tags')


class PlainSettings:
    retries = 3
`;

const REPOSITORY = `from sqlalchemy import select, update

from shop_worker.models import Coupon, CouponKind


def use_coupon(session, coupon_id):
    coupon = session.get(Coupon, coupon_id)
    if coupon is not None:
        coupon.kind = CouponKind.RATE
    session.query(Coupon).filter(Coupon.id == coupon_id).update({'code': 'used'})
    session.execute(update(Coupon).where(Coupon.id == coupon_id).values(kind=CouponKind.FIXED))
    rows = session.execute(select(Coupon)).scalars()
    fresh = Coupon(code='welcome', kind=CouponKind.FIXED)
    session.add(fresh)
    settings = {'code': 'acorn'}
    settings.update({'code': 'acorn-2'})
    # session.query(Coupon).delete()
    return "session.query(Coupon).delete()", rows


def latest_coupon(session):
    found = session.query(Coupon).order_by(Coupon.id.desc()).first()
    found.code = 'renewed'
    return found
`;

describe('sqlalchemyPreset declarations', () => {
  it('reads tables, columns, enum columns, foreign keys and relationships', async () => {
    const symbols = await extract({ 'shop_worker/models.py': MODELS });
    const declarations = detectAll(symbols, await contextFor(symbols)).filter(
      (item) => item.kind === 'entity-declaration',
    );
    expect(declarations.map((item) => item.symbol)).toEqual([
      'Order',
      'Coupon',
      'Member',
    ]);
    expect(declarations[1]).toMatchObject({
      table: 'coupons',
      className: 'Coupon',
      columns: [
        { name: 'id', dataType: 'Integer' },
        {
          name: 'coupon_code',
          dataType: 'String(20)',
          comment: '도토리 쿠폰 코드',
        },
        { name: 'kind', dataType: 'Enum(CouponKind)', enumName: 'CouponKind' },
        { name: 'order_id', dataType: 'Integer' },
        { name: 'member_id', dataType: 'Integer' },
      ],
      relations: [
        {
          targetClass: 'Order',
          kind: 'many-to-one',
          property: 'order',
          column: 'order_id',
        },
        { targetClass: 'Member', kind: 'many-to-one', column: 'member_id' },
      ],
    });
    expect(declarations[0]).toMatchObject({
      table: 'orders',
      relations: [
        { targetClass: 'Coupon', kind: 'one-to-many', property: 'coupons' },
      ],
    });
    expect(declarations[2]).toMatchObject({
      table: 'members',
      columns: [{ name: 'id' }],
      relations: [
        { targetClass: 'Profile', kind: 'one-to-one', property: 'profile' },
        { targetClass: 'Tag', kind: 'many-to-many', property: 'tags' },
      ],
    });
  });

  it('declares nothing when the class attributes are not visible', async () => {
    const symbols = await extract({ 'shop_worker/models.py': MODELS });
    const found = detectAll(symbols, await contextFor(symbols, false));
    expect(found.filter((item) => item.kind === 'entity-declaration')).toEqual(
      [],
    );
  });
});

describe('sqlalchemyPreset access', () => {
  it('finds session, query and statement reads and writes with entity-qualified field writes', async () => {
    const symbols = await extract({
      'shop_worker/models.py': MODELS,
      'shop_worker/coupons_repo.py': REPOSITORY,
    });
    const found = detectAll(symbols, await contextFor(symbols)).filter(
      (item) => item.kind !== 'entity-declaration',
    );
    expect(
      found.map((item) => {
        if (item.kind === 'field-write') {
          return [
            item.symbol,
            item.entity,
            item.field,
            item.writeKind,
            item.valueSummary,
            item.conditions,
          ];
        }
        return 'target' in item
          ? [item.symbol, item.kind, item.target]
          : [item.symbol, item.kind];
      }),
    ).toEqual([
      ['use_coupon', 'entity-read', 'Coupon'],
      ['use_coupon', 'entity-write', 'Coupon'],
      [
        'use_coupon',
        'Coupon',
        'code',
        'update-builder',
        '<literal>',
        undefined,
      ],
      [
        'use_coupon',
        'Coupon',
        'kind',
        'update-builder',
        'CouponKind.FIXED',
        undefined,
      ],
      ['use_coupon', 'Coupon', 'code', 'update-call', '<literal>', undefined],
      [
        'use_coupon',
        'Coupon',
        'kind',
        'update-call',
        'CouponKind.FIXED',
        undefined,
      ],
      [
        'use_coupon',
        'Coupon',
        'kind',
        'assignment',
        'CouponKind.RATE',
        ['coupon is not None'],
      ],
      ['latest_coupon', 'entity-read', 'Coupon'],
      ['latest_coupon', 'Coupon', 'code', 'assignment', '<literal>', undefined],
    ]);
    expect(found[1].evidence).toContain('(+2)');
  });
});
