import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../../ports.js';
import type { ExtractedSymbol, SourceFile } from '../types.js';
import { pythonExtractor } from './python.js';

/** python3 이 3.9 이상이면 [주 판, 부 판]. 없으면 undefined */
function pythonVersion(): [number, number] | undefined {
  const result = spawnSync(
    'python3',
    ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    return undefined;
  }
  const [major, minor] = result.stdout.trim().split(' ').map(Number);
  return major === 3 && minor >= 9 ? [major, minor] : undefined;
}

const version = pythonVersion();
/** python3 이 없으면 건너뛴 까닭을 시험 이름에 남긴다. CI 실행기에는 python3 이 있다 */
const PYTHON_SUITE = version
  ? 'pythonExtractor'
  : 'pythonExtractor (python3 3.9 이상이 없어 건너뜀)';
const canUseShell = process.platform !== 'win32';

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
const context = { repository: 'shop-worker', logger };

const file = (filePath: string, content: string): SourceFile => ({
  repository: 'shop-worker',
  filePath,
  content,
});

const bySymbol = (symbols: ExtractedSymbol[], symbol: string) => {
  const found = symbols.find((item) => item.symbol === symbol);
  if (!found) {
    throw new Error(`missing symbol ${symbol}`);
  }
  return found;
};

const targets = (item: ExtractedSymbol, type: string) =>
  item.relations
    .filter((relation) => relation.type === type)
    .map((relation) => relation.target.symbol);

const brief = (item: ExtractedSymbol): string[] =>
  (item.executionFacts ?? []).map(
    (fact) =>
      `${fact.line} ${fact.kind} ${fact.subject ?? '-'} = ${fact.value ?? '-'} | ${(fact.conditions ?? []).join(' ; ')}`,
  );

const scratch = mkdtempSync(join(tmpdir(), 'codecite-python-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** 셸 스크립트로 가짜 python 실행 파일을 만든다 */
function fakeCommand(name: string, body: string): string {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const COUPON_WORKER = `"""쿠폰 작업자"""
import os
import shop.ledger
from decimal import Decimal as D
from .rules import EARN_RATE, unused_rule
from typing import overload

MAX_COUPONS = int(os.getenv("MAX_COUPONS", "20"))
to_won = lambda points: points * 10


class CouponKind(str, Enum):
    FIXED = "fixed"
    RATE = "rate"


@dataclass
class CouponService(BaseService, Generic[T]):
    """쿠폰을 발급하고 거둔다"""

    retry: int = 3

    def __init__(self, store: "CouponStore", clock: Clock):
        self.store = store

    @property
    def issued(self):
        return self.store.count()

    @issued.setter
    def issued(self, value):
        self.store.reset(value)

    @overload
    def issue(self, member: str) -> None: ...

    @transactional
    async def issue(self, member, kind=CouponKind.FIXED):
        """회원에게 쿠폰을 발급한다"""
        from .audit import record
        await self.store.add(member, D(kind.value) * EARN_RATE)
        record(member)
`;

describe.skipIf(!version)(PYTHON_SUITE, () => {
  it('클래스·메서드·함수·모듈 상수와 독스트링을 읽는다', async () => {
    const { symbols, failures } = await pythonExtractor().extract(
      [file('worker/coupons.py', COUPON_WORKER)],
      context,
    );

    expect(failures).toEqual([]);
    expect(
      symbols.map((item) => [
        item.symbol,
        item.kind,
        item.lineStart,
        item.lineEnd,
      ]),
    ).toEqual([
      ['MAX_COUPONS', 'constant', 8, 8],
      ['to_won', 'function', 9, 9],
      ['CouponKind', 'enum', 12, 14],
      ['CouponService', 'class', 17, 42],
      ['CouponService.retry', 'constant', 21, 21],
      ['CouponService.__init__', 'method', 23, 24],
      ['CouponService.issued:get', 'method', 26, 28],
      ['CouponService.issued:set', 'method', 30, 32],
      ['CouponService.issue', 'method', 37, 42],
    ]);
    expect(symbols.every((item) => item.language === 'python')).toBe(true);
    expect(bySymbol(symbols, 'CouponService').description).toBe(
      '쿠폰을 발급하고 거둔다',
    );
    expect(bySymbol(symbols, 'CouponService.issue').description).toBe(
      '회원에게 쿠폰을 발급한다',
    );
    expect(bySymbol(symbols, 'CouponService.issue').content).toMatch(
      /^@transactional\n {4}async def issue/,
    );
    expect(
      bySymbol(symbols, 'CouponKind').executionFacts?.map(
        (fact) => `${fact.subject}=${fact.value}`,
      ),
    ).toEqual(['CouponKind.FIXED=<literal>', 'CouponKind.RATE=<literal>']);
    expect(bySymbol(symbols, 'MAX_COUPONS').executionFacts).toEqual([
      { line: 8, kind: 'assigns', subject: 'MAX_COUPONS', value: 'int(<env>)' },
    ]);
  });

  it('관계를 TypeScript 와 같은 꼴의 원문으로 남긴다', async () => {
    const { symbols } = await pythonExtractor().extract(
      [file('worker/coupons.py', COUPON_WORKER)],
      context,
    );

    const service = bySymbol(symbols, 'CouponService');
    expect(targets(service, 'IMPORTS')).toEqual([
      'Decimal as D from decimal',
      'EARN_RATE from .rules',
      'overload from typing',
      'record from .audit',
    ]);
    expect(targets(service, 'EXTENDS')).toEqual(['BaseService', 'Generic']);
    expect(targets(service, 'DECORATED_BY')).toEqual(['dataclass']);
    expect(targets(service, 'INJECTS')).toEqual(['Clock', 'CouponStore']);
    expect(targets(service, 'CALLS')).toEqual([]);

    const issue = bySymbol(symbols, 'CouponService.issue');
    expect(targets(issue, 'DECORATED_BY')).toEqual(['transactional']);
    expect(targets(issue, 'CALLS')).toEqual(['D', 'record', 'self.store.add']);
    expect(
      issue.relations.every(
        (relation) =>
          relation.target.repository === 'shop-worker' &&
          relation.target.filePath === undefined,
      ),
    ).toBe(true);
    expect(targets(bySymbol(symbols, 'MAX_COUPONS'), 'IMPORTS')).toEqual([
      '* from os',
    ]);
    expect(targets(bySymbol(symbols, 'CouponKind'), 'EXTENDS')).toEqual([
      'Enum',
      'str',
    ]);
  });

  it('분기·반복·예외·with·삼항식·내포·단락 평가를 실행 사실로 펼친다', async () => {
    const { symbols } = await pythonExtractor().extract(
      [
        file(
          'worker/refund.py',
          `def settle_refund(order, ledger):
    if not order:
        raise ValueError(f"missing {order}")
    fee = 0 if order.member.is_vip else order.total * 0.05
    for item in order.items:
        if item.refunded:
            continue
        ledger.reverse(item.id)
    else:
        ledger.mark_done(order.id)
    try:
        ledger.commit()
    except (TimeoutError, KeyError):
        ledger.rollback()
    else:
        ledger.flush()
    finally:
        ledger.close()
    with ledger.lock(order.id):
        order.refund_total += fee
    assert fee >= 0
    token = os.environ["REFUND_TOKEN"]
    codes = [reissue(c) for c in order.coupons if c.reusable]
    order.member.is_vip and send_apology(order.member)
    def later():
        return archive(order)
    return fee if fee > 0 else None
`,
        ),
      ],
      context,
    );

    expect(brief(bySymbol(symbols, 'settle_refund'))).toEqual([
      '2 condition - = not order | ',
      '3 throws - = ValueError(<literal>) | not order',
      '3 calls ValueError = <literal> | not order',
      '4 assigns fee = 0 | order ; order.member.is_vip',
      '4 assigns fee = order.total * 0.05 | order ; NOT (order.member.is_vip)',
      '5 condition - = item in order.items | order',
      '6 condition - = item.refunded | order ; item in order.items',
      '8 calls ledger.reverse = item.id | order ; item in order.items ; NOT (item.refunded)',
      '10 calls ledger.mark_done = order.id | order ; no break (item in order.items)',
      '12 calls ledger.commit = - | order',
      '14 calls ledger.rollback = - | order ; catch (TimeoutError, KeyError)',
      '16 calls ledger.flush = - | order ; no exception',
      '18 calls ledger.close = - | order ; finally',
      '19 calls ledger.lock = order.id | order',
      '20 assigns order.refund_total = += fee | order ; with ledger.lock(order.id)',
      '21 throws - = AssertionError | order ; NOT (fee >= 0)',
      '22 assigns token = <env> | order ; fee >= 0',
      '23 assigns codes = [reissue(c) for c in order.coupons if c.reusable] | order ; fee >= 0',
      '23 calls reissue = c | order ; fee >= 0 ; c in order.coupons ; c.reusable',
      '24 calls send_apology = order.member | order ; fee >= 0 ; order.member.is_vip',
      '26 calls archive = order | order ; fee >= 0',
      '27 returns - = fee | order ; fee >= 0 ; fee > 0',
      '27 returns - = None | order ; fee >= 0 ; NOT (fee > 0)',
    ]);
  });

  it.skipIf(!version || version[1] < 10)(
    'match 의 case 마다 조건을 만든다',
    async () => {
      const { symbols } = await pythonExtractor().extract(
        [
          file(
            'worker/shipping.py',
            `def shipping_fee(region, express):
    match region:
        case Region.ISLAND | Region.MOUNTAIN:
            return 5000
        case Region.CITY if express:
            return 0
        case _:
            return 2500
`,
          ),
        ],
        context,
      );

      expect(brief(bySymbol(symbols, 'shipping_fee'))).toEqual([
        '3 condition - = region matches Region.ISLAND | Region.MOUNTAIN | ',
        '4 returns - = 5000 | region matches Region.ISLAND | Region.MOUNTAIN',
        '5 condition - = region matches Region.CITY if express | ',
        '6 returns - = 0 | region matches Region.CITY if express',
        '7 condition - = region matches _ | ',
        '8 returns - = 2500 | region matches _',
      ]);
    },
  );

  it('구문 오류가 있는 파일은 실패로 남기고 나머지 파일은 계속 읽는다', async () => {
    const { symbols, failures } = await pythonExtractor().extract(
      [
        file('worker/broken.py', 'def add_points(:\n    pass\n'),
        file('worker/points.py', '\uFEFFDAILY_CAP = 1000\n'),
        file('worker/notes.txt', 'not python'),
      ],
      context,
    );

    expect(symbols.map((item) => [item.filePath, item.symbol])).toEqual([
      ['worker/points.py', 'DAILY_CAP'],
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0].filePath).toBe('worker/broken.py');
    expect(failures[0].message).toMatch(/^line 1: /);
  });

  it('같은 입력이면 파일 순서와 상관없이 같은 결과를 낸다', async () => {
    const files = [
      file('worker/b.py', 'def ship():\n    return pack()\n'),
      file('worker/a.py', COUPON_WORKER),
    ];
    const first = await pythonExtractor().extract(files, context);
    const second = await pythonExtractor().extract(
      [...files].reverse(),
      context,
    );

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('같은 파일에서 이름이 겹치는 심볼에는 꼬리를 붙인다', async () => {
    const { symbols } = await pythonExtractor().extract(
      [
        file(
          'worker/grade.py',
          'def grade_of(total):\n    return 1\n\n\ndef grade_of(total):\n    return 2\n',
        ),
      ],
      context,
    );

    expect(symbols.map((item) => item.symbol)).toEqual([
      'grade_of',
      'grade_of~2',
    ]);
  });

  it('맡을 파일이 없으면 python3 을 띄우지 않는다', async () => {
    const result = await pythonExtractor({
      command: join(scratch, 'never-started'),
    }).extract([file('web/src/cart.ts', 'export {}')], context);

    expect(result).toEqual({ symbols: [], failures: [] });
  });

  it.skipIf(!canUseShell)(
    '추출 한 번에 python3 을 한 번만 띄운다',
    async () => {
      const counter = join(scratch, 'spawned.txt');
      writeFileSync(counter, '');
      const command = fakeCommand(
        'counting-python',
        `echo spawned >> "${counter}"\nexec python3 "$@"`,
      );
      const { symbols } = await pythonExtractor({ command }).extract(
        [
          file('worker/a.py', 'A = 1\n'),
          file('worker/b.py', 'def b():\n    return 2\n'),
          file('worker/c.py', 'class C:\n    pass\n'),
        ],
        context,
      );

      expect(symbols).toHaveLength(3);
      expect(readFileSync(counter, 'utf8').trim().split('\n')).toEqual([
        'spawned',
      ]);
    },
  );
});

describe('pythonExtractor 실행 오류', () => {
  it('python3 이 없으면 저장소 이름과 설치 안내를 담은 오류를 던진다', async () => {
    const extractor = pythonExtractor({
      command: join(scratch, 'python3-not-installed'),
    });

    await expect(
      extractor.extract([file('worker/a.py', 'A = 1\n')], context),
    ).rejects.toThrow(/was not found.*"shop-worker".*Python 3\.9 or newer/);
  });

  it.skipIf(!canUseShell)('판이 낮으면 필요한 판을 알린다', async () => {
    const command = fakeCommand(
      'old-python',
      'cat > /dev/null\necho "python 3.7 is too old" >&2\nexit "$4"',
    );

    await expect(
      pythonExtractor({ command }).extract(
        [file('worker/a.py', 'A = 1\n')],
        context,
      ),
    ).rejects.toThrow(/older than Python 3\.9.*"shop-worker"/);
  });

  it.skipIf(!canUseShell)(
    '도우미가 엉뚱한 출력을 내면 그 사실을 알린다',
    async () => {
      const command = fakeCommand(
        'noisy-python',
        'cat > /dev/null\necho "not json"',
      );

      await expect(
        pythonExtractor({ command }).extract(
          [file('worker/a.py', 'A = 1\n')],
          context,
        ),
      ).rejects.toThrow(/invalid output for repository "shop-worker"/);
    },
  );
});
