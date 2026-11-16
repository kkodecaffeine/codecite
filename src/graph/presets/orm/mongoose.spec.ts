import { describe, expect, it, vi } from 'vitest';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  Detection,
  ExtractedSymbol,
  GraphConfig,
  PresetContext,
} from '../../types.js';
import { mongoosePreset } from './mongoose.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const config: GraphConfig = {
  cwd: '/work/dotori',
  output: '/work/dotori/.codecite/graph',
  cache: '/work/dotori/.codecite/cache',
  repositories: [{ name: 'shop-api', path: '../shop-api' }],
  defaultExcludes: [],
  presets: ['mongoose'],
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

function contextFor(symbols: ExtractedSymbol[]): PresetContext {
  return {
    repository: 'shop-api',
    config,
    logger,
    resolveConstant: () => undefined,
    symbols,
  };
}

function detectAll(symbols: ExtractedSymbol[]): Detection[] {
  const context = contextFor(symbols);
  return symbols.flatMap((symbol) => mongoosePreset.detect(symbol, context));
}

const FILES = {
  'src/review/review.schema.ts': `import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

@Schema({ collection: 'reviews', timestamps: true })
export class Review {
  @Prop({ required: true })
  body: string;

  @Prop({ type: Types.ObjectId, ref: 'Member' })
  memberId: Types.ObjectId;

  @Prop({ type: String, enum: ReviewGrade })
  grade: ReviewGrade;

  @Prop([{ type: Types.ObjectId, ref: Coupon.name }])
  couponIds: Types.ObjectId[];
}

export const ReviewSchema = SchemaFactory.createForClass(Review);
`,
  'src/point/point.model.ts': `import mongoose, { Schema, model } from 'mongoose';

export const PointHistorySchema = new Schema(
  {
    memberId: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
    amount: Number,
    reason: { type: String, enum: PointReason },
    detail: { orderId: String, note: String },
    tags: [String],
  },
  { collection: 'point_histories' },
);

export const PointHistory = model('PointHistory', PointHistorySchema);

export const Wishlist = mongoose.model('Wishlist', new Schema({ productIds: [String] }));
`,
  'src/point/point.service.ts': `import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PointHistory } from './point.model';
import { Review } from '../review/review.schema';

export class PointService {
  constructor(
    @InjectModel(Review.name) private readonly reviews: Model<ReviewDocument>,
    private readonly wishlists: Model<Wishlist>,
  ) {}

  async earn(memberId: string, amount: number) {
    await PointHistory.create({ memberId, amount, reason: PointReason.Review });
    await PointHistory.updateOne(
      { memberId },
      { $inc: { amount }, $set: { 'detail.note': 'bonus' }, reason: PointReason.Event },
    );
    const found = await this.reviews.findOne({ memberId });
    await this.reviews.findByIdAndUpdate(found.id, { $set: { grade: ReviewGrade.Best } });
    await this.wishlists.deleteMany({ memberId });
    const cache = new Map<string, number>();
    cache.delete('PointHistory');
    // await PointHistory.deleteMany({});
    return found;
  }
}
`,
};

describe('mongoosePreset declarations', () => {
  it('reads NestJS schema classes with Prop members as document collections', async () => {
    const symbols = await extract(FILES);
    const review = detectAll(symbols).find(
      (item) => item.kind === 'entity-declaration' && item.symbol === 'Review',
    );
    expect(review).toMatchObject({
      table: 'reviews',
      className: 'Review',
      store: 'document',
      columns: [
        { name: 'body', dataType: 'string' },
        { name: 'memberId', dataType: 'Types.ObjectId' },
        { name: 'grade', dataType: 'String', enumName: 'ReviewGrade' },
        { name: 'couponIds', dataType: '[Types.ObjectId]' },
      ],
      relations: [
        {
          targetClass: 'Member',
          kind: 'many-to-one',
          property: 'memberId',
          column: 'memberId',
        },
        {
          targetClass: 'Coupon',
          kind: 'one-to-many',
          property: 'couponIds',
          column: 'couponIds',
        },
      ],
    });
  });

  it('names schemas by the model they are registered as and flattens subdocuments', async () => {
    const symbols = await extract(FILES);
    const declarations = detectAll(symbols).filter(
      (item) =>
        item.kind === 'entity-declaration' &&
        item.filePath === 'src/point/point.model.ts',
    );
    expect(declarations).toEqual([
      expect.objectContaining({
        symbol: 'PointHistorySchema',
        table: 'point_histories',
        className: 'PointHistory',
        store: 'document',
        columns: [
          { name: 'memberId', dataType: 'Schema.Types.ObjectId' },
          { name: 'amount', dataType: 'Number' },
          { name: 'reason', dataType: 'String', enumName: 'PointReason' },
          { name: 'detail.orderId', dataType: 'String' },
          { name: 'detail.note', dataType: 'String' },
          { name: 'tags', dataType: '[String]' },
        ],
        relations: [
          {
            targetClass: 'Member',
            kind: 'many-to-one',
            property: 'memberId',
            column: 'memberId',
          },
        ],
      }),
      expect.objectContaining({
        symbol: 'Wishlist',
        table: 'Wishlist',
        className: 'Wishlist',
        columns: [{ name: 'productIds', dataType: '[String]' }],
      }),
    ]);
  });
});

describe('mongoosePreset access', () => {
  it('binds model constants and injected models and records update operators as document field writes', async () => {
    const symbols = await extract(FILES);
    const found = detectAll(symbols).filter(
      (item) => item.symbol === 'PointService.earn',
    );
    expect(
      found.map((item) => {
        if (item.kind === 'field-write') {
          return [item.entity, item.field, item.writeKind, item.valueSummary];
        }
        return 'target' in item ? [item.kind, item.target] : [item.kind];
      }),
    ).toEqual([
      ['entity-write', 'PointHistory'],
      ['entity-read', 'Review'],
      ['entity-write', 'Review'],
      ['entity-write', 'Wishlist'],
      ['PointHistory', 'memberId', 'document-set', 'memberId'],
      ['PointHistory', 'amount', 'document-set', 'amount'],
      ['PointHistory', 'reason', 'document-set', 'PointReason.Review'],
      ['PointHistory', 'reason', 'document-set', 'PointReason.Event'],
      ['PointHistory', 'amount', 'document-set', '$inc amount'],
      ['PointHistory', 'detail.note', 'document-set', '$set <literal>'],
      ['Review', 'grade', 'document-set', '$set ReviewGrade.Best'],
    ]);
  });
});
