import { describe, expect, it, vi } from 'vitest';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  Detection,
  ExtractedSymbol,
  GraphConfig,
  PresetContext,
  SymbolExtractor,
} from '../../types.js';
import { prismaPreset } from './prisma.js';
import { prismaSchemaExtractor } from './prisma-schema.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const config: GraphConfig = {
  cwd: '/work/dotori',
  output: '/work/dotori/.codecite/graph',
  cache: '/work/dotori/.codecite/cache',
  repositories: [{ name: 'shop-api', path: '../shop-api' }],
  defaultExcludes: [],
  presets: ['prisma'],
  hints: {},
  detectors: [],
  entities: { foreignKeySuffixes: ['Id'] },
  groups: {},
  extractorModules: [],
  presetModules: [],
};

async function extract(
  extractor: SymbolExtractor,
  files: Record<string, string>,
): Promise<{
  symbols: ExtractedSymbol[];
  failures: Array<{ filePath: string; message: string }>;
}> {
  return extractor.extract(
    Object.entries(files).map(([filePath, content]) => ({
      repository: 'shop-api',
      filePath,
      content,
    })),
    { repository: 'shop-api', logger },
  );
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

function detectAll(
  symbols: ExtractedSymbol[],
  context: PresetContext,
): Detection[] {
  return symbols.flatMap((symbol) => prismaPreset.detect(symbol, context));
}

const SCHEMA = `// 도토리 마켓 스키마
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

/// 도토리 마켓 주문
model Order {
  id        Int          @id @default(autoincrement())
  /// 도토리 주문 경로
  channel   OrderChannel @default(Web)
  memberId  Int          @map("member_id")
  member    Member       @relation(fields: [memberId], references: [id])
  coupons   Coupon[]
  refund    Refund?
  memo      String?      @db.VarChar(200) // "// 주석 안의 따옴표"
  createdAt DateTime     @default(now()) @map("created_at")

  @@map("orders")
  @@index([memberId, createdAt])
}

model Member {
  id     Int     @id
  orders Order[]
}

model Coupon {
  id     Int     @id
  orders Order[]
}

model Refund {
  id      Int   @id
  orderId Int   @unique @map("order_id")
  order   Order @relation(
    fields: [orderId],
    references: [id]
  )
}

enum OrderChannel {
  Web
  App @map("app")
}
`;

const ORDER_REPOSITORY = `export class OrderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async pay(id: number) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    await this.prisma.order.update({ where: { id }, data: { channel: 'App', memo: \`paid \${id}\` } });
    await this.prisma.$transaction(async (tx) => {
      await tx.refund.upsert({ where: { orderId: id }, create: { orderId: id }, update: { orderId: id } });
    });
    await this.prisma.coupon.createMany({ data: [{ id: 1 }, { id: 2 }] });
    // await this.prisma.member.delete({ where: { id } });
    const cache = new Map<string, number>();
    cache.delete('this.prisma.member.delete');
    return order;
  }
}
`;

describe('prismaSchemaExtractor', () => {
  it('turns models, views, enums and types into symbols and skips datasource and generator blocks', async () => {
    const { symbols, failures } = await extract(prismaSchemaExtractor(), {
      'prisma/schema.prisma': SCHEMA,
      'src/ignored.ts': 'export const a = 1;',
    });
    expect(failures).toEqual([]);
    expect(
      symbols.map((symbol) => [
        symbol.symbol,
        symbol.kind,
        symbol.language,
        symbol.lineStart,
        symbol.lineEnd,
      ]),
    ).toEqual([
      ['Order', 'entity', 'prisma', 12, 25],
      ['Member', 'entity', 'prisma', 27, 30],
      ['Coupon', 'entity', 'prisma', 32, 35],
      ['Refund', 'entity', 'prisma', 37, 44],
      ['OrderChannel', 'enum', 'prisma', 46, 49],
    ]);
    expect(symbols[0].description).toBe('도토리 마켓 주문');
    expect(symbols[0].content.startsWith('model Order {')).toBe(true);
  });

  it('reports a file whose block is not closed', async () => {
    const { symbols, failures } = await extract(prismaSchemaExtractor(), {
      'prisma/broken.prisma': 'model Order {\n  id Int @id\n',
    });
    expect(symbols).toEqual([]);
    expect(failures).toEqual([
      {
        filePath: 'prisma/broken.prisma',
        message: 'line 1: block is not closed',
      },
    ]);
  });
});

describe('prismaPreset', () => {
  it('declares models with mapped tables, columns, enum columns and relations', async () => {
    const { symbols } = await extract(prismaSchemaExtractor(), {
      'prisma/schema.prisma': SCHEMA,
    });
    const declarations = detectAll(symbols, contextFor(symbols)).filter(
      (item) => item.kind === 'entity-declaration',
    );
    const order = declarations.find((item) => item.symbol === 'Order');
    expect(order).toMatchObject({
      table: 'orders',
      className: 'Order',
      columns: [
        { name: 'id', dataType: 'Int' },
        {
          name: 'channel',
          dataType: 'OrderChannel',
          comment: '도토리 주문 경로',
          enumName: 'OrderChannel',
        },
        { name: 'member_id', dataType: 'Int' },
        { name: 'memo', dataType: 'String' },
        { name: 'created_at', dataType: 'DateTime' },
      ],
      relations: [
        {
          targetClass: 'Member',
          kind: 'many-to-one',
          property: 'member',
          column: 'member_id',
        },
        { targetClass: 'Coupon', kind: 'many-to-many', property: 'coupons' },
        { targetClass: 'Refund', kind: 'one-to-one', property: 'refund' },
      ],
    });
    expect(declarations.find((item) => item.symbol === 'Refund')).toMatchObject(
      {
        table: 'Refund',
        relations: [
          {
            targetClass: 'Order',
            kind: 'one-to-one',
            property: 'order',
            column: 'order_id',
          },
        ],
      },
    );
    expect(declarations.map((item) => item.symbol)).not.toContain(
      'OrderChannel',
    );
  });

  it('maps client accessors to models and records data fields as field writes', async () => {
    const schema = await extract(prismaSchemaExtractor(), {
      'prisma/schema.prisma': SCHEMA,
    });
    const code = await extract(typescriptExtractor(), {
      'src/order/order.repository.ts': ORDER_REPOSITORY,
    });
    expect(code.failures).toEqual([]);
    const symbols = [...schema.symbols, ...code.symbols];
    const found = code.symbols.flatMap((symbol) =>
      prismaPreset.detect(symbol, contextFor(symbols)),
    );
    expect(
      found.map((item) => {
        if (item.kind === 'field-write') {
          return [
            item.kind,
            item.entity,
            item.field,
            item.writeKind,
            item.valueSummary,
          ];
        }
        return 'target' in item
          ? [item.kind, item.target, item.confidence]
          : [item.kind];
      }),
    ).toEqual([
      ['entity-read', 'Order', 0.9],
      ['entity-write', 'Order', 0.9],
      ['entity-write', 'Refund', 0.9],
      ['entity-write', 'Coupon', 0.9],
      ['field-write', 'Order', 'channel', 'update-call', '<literal>'],
      ['field-write', 'Order', 'memo', 'update-call', '<literal>'],
      ['field-write', 'Refund', 'orderId', 'update-call', 'id'],
      ['field-write', 'Refund', 'orderId', 'update-call', 'id'],
      ['field-write', 'Coupon', 'id', 'update-call', '1'],
      ['field-write', 'Coupon', 'id', 'update-call', '2'],
    ]);
  });

  it('falls back to the client name when the repository has no schema', async () => {
    const { symbols } = await extract(typescriptExtractor(), {
      'src/refund.ts': `export async function listRefunds(db: Db) {
  await prisma.refund.findMany();
  await db.refund.findMany();
}
`,
    });
    const found = detectAll(symbols, contextFor(symbols));
    expect(found).toMatchObject([
      { kind: 'entity-read', target: 'Refund', confidence: 0.75 },
    ]);
  });
});
