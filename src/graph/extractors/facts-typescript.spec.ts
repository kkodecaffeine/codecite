import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { ExecutionFact } from '../../extensions/code-knowledge.js';
import { createTypeScriptFactProjector } from './facts-typescript.js';

const projector = createTypeScriptFactProjector(ts);

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile(
    '/shop-api/src/sample.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/** 첫 함수 선언(없으면 첫 화살표 함수 상수)의 실행 사실 */
function factsOf(source: string): ExecutionFact[] {
  const sourceFile = parse(source);
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body) {
      return projector.bodyFacts(sourceFile, statement.body);
    }
    if (ts.isVariableStatement(statement)) {
      const initializer = statement.declarationList.declarations[0].initializer;
      if (initializer && ts.isArrowFunction(initializer)) {
        return projector.bodyFacts(sourceFile, initializer.body);
      }
    }
  }
  throw new Error('no function in sample');
}

const brief = (facts: ExecutionFact[]): string[] =>
  facts.map(
    (fact) =>
      `${fact.line} ${fact.kind} ${fact.subject ?? '-'} = ${fact.value ?? '-'} | ${(fact.conditions ?? []).join(' ; ')}`,
  );

describe('createTypeScriptFactProjector().bodyFacts', () => {
  it('else 와 else if 는 앞 조건의 부정을 쌓는다', () => {
    const facts = factsOf(`function membershipGrade(total: number) {
  if (total >= 300000) {
    return Grade.Gold;
  } else if (total >= 100000) {
    return Grade.Silver;
  } else {
    return Grade.Basic;
  }
}`);

    expect(facts.filter((fact) => fact.kind === 'returns')).toEqual([
      {
        line: 3,
        kind: 'returns',
        value: 'Grade.Gold',
        conditions: ['total >= 300000'],
      },
      {
        line: 5,
        kind: 'returns',
        value: 'Grade.Silver',
        conditions: ['NOT (total >= 300000)', 'total >= 100000'],
      },
      {
        line: 7,
        kind: 'returns',
        value: 'Grade.Basic',
        conditions: ['NOT (total >= 300000)', 'NOT (total >= 100000)'],
      },
    ]);
    expect(facts.filter((fact) => fact.kind === 'condition')).toEqual([
      { line: 2, kind: 'condition', value: 'total >= 300000' },
      {
        line: 4,
        kind: 'condition',
        value: 'total >= 100000',
        conditions: ['NOT (total >= 300000)'],
      },
    ]);
  });

  it('return·throw 로 먼저 빠지는 if 뒤의 문장은 그 조건의 부정 아래에 둔다', () => {
    const facts =
      factsOf(`function applyCoupon(coupon: Coupon | undefined, cart: Cart) {
  if (!coupon) {
    throw new CouponMissingError();
  }
  if (cart.total < coupon.minimumSpend) return cart.total;
  cart.discount = coupon.amount;
  return cart.total - cart.discount;
}`);

    expect(brief(facts)).toEqual([
      '2 condition - = !coupon | ',
      '3 throws - = new CouponMissingError() | !coupon',
      '5 condition - = cart.total < coupon.minimumSpend | coupon',
      '5 returns - = cart.total | coupon ; cart.total < coupon.minimumSpend',
      '6 assigns cart.discount = coupon.amount | coupon ; NOT (cart.total < coupon.minimumSpend)',
      '7 returns - = cart.total - cart.discount | coupon ; NOT (cart.total < coupon.minimumSpend)',
    ]);
  });

  it('switch 는 case 마다 조건이 되고, 이어지는 case 는 묶고, default 는 나머지의 부정이다', () => {
    const facts = factsOf(`function shippingFee(region: Region) {
  switch (region) {
    case Region.Island:
    case Region.Mountain:
      return 5000;
    case Region.City:
      return 0;
    default:
      return 2500;
  }
}`);

    expect(brief(facts)).toEqual([
      '3 condition - = region === Region.Island || region === Region.Mountain | ',
      '5 returns - = 5000 | region === Region.Island || region === Region.Mountain',
      '6 condition - = region === Region.City | ',
      '7 returns - = 0 | region === Region.City',
      '8 condition - = NOT (region === Region.Island || region === Region.Mountain || region === Region.City) | ',
      '9 returns - = 2500 | NOT (region === Region.Island || region === Region.Mountain || region === Region.City)',
    ]);
  });

  it('반복문은 조건이 되고 try 의 catch·finally 는 이름으로 쌓는다', () => {
    const facts = factsOf(`async function settlePoints(orders: Order[]) {
  for (const order of await ledger.pendingOrders()) {
    while (order.pending > 0) {
      order.pending -= 1;
    }
  }
  try {
    await ledger.flush();
  } catch (error) {
    reporter.warn(error);
  } finally {
    ledger.close();
  }
}`);

    expect(brief(facts)).toEqual([
      '2 condition - = order of await ledger.pendingOrders() | ',
      '2 calls ledger.pendingOrders = - | ',
      '3 condition - = order.pending > 0 | order of await ledger.pendingOrders()',
      '4 assigns order.pending = -= 1 | order of await ledger.pendingOrders() ; order.pending > 0',
      '8 calls ledger.flush = - | ',
      '10 calls reporter.warn = error | catch',
      '12 calls ledger.close = - | finally',
    ]);
  });

  it('삼항식 대입과 반환은 갈래마다 조건과 그 부정으로 나눈다', () => {
    const facts = factsOf(`function refundRoute(order: Order) {
  const method = order.paidWithPoints ? RefundMethod.Points : RefundMethod.Card;
  return order.total > 50000 ? Route.Review : order.isMember ? Route.Instant : Route.Queue;
}`);

    expect(brief(facts)).toEqual([
      '2 assigns method = RefundMethod.Points | order.paidWithPoints',
      '2 assigns method = RefundMethod.Card | NOT (order.paidWithPoints)',
      '3 returns - = Route.Review | order.total > 50000',
      '3 returns - = Route.Instant | NOT (order.total > 50000) ; order.isMember',
      '3 returns - = Route.Queue | NOT (order.total > 50000) ; NOT (order.isMember)',
    ]);
  });

  it('콜백 안의 호출은 바깥 조건 아래에 적고, 콜백의 return 은 반환으로 적지 않는다', () => {
    const facts =
      factsOf(`function expireCoupons(coupons: Coupon[], today: Date) {
  if (coupons.length > 0) {
    coupons
      .filter((coupon) => coupon.expiresAt < today)
      .forEach((coupon) => {
        if (coupon.used) return;
        couponStore.expire(coupon.id);
      });
  }
}`);

    expect(brief(facts)).toEqual([
      '2 condition - = coupons.length > 0 | ',
      '4 calls coupons.filter = (coupon) => … | coupons.length > 0',
      '5 calls coupons.filter().forEach = (coupon) => … | coupons.length > 0',
      '6 condition - = coupon.used | coupons.length > 0',
      '7 calls couponStore.expire = coupon.id | coupons.length > 0 ; NOT (coupon.used)',
    ]);
    expect(facts.some((fact) => fact.kind === 'returns')).toBe(false);
  });

  it('&& · || · ?? 의 오른쪽 호출은 왼쪽 조건 아래에서 불린다', () => {
    const facts = factsOf(`function rewardMember(member: Member, cache: Cache) {
  member.isVip && grantBonus(member);
  member.hasCoupon || issueWelcomeCoupon(member);
  const profile = cache.get(member.id) ?? loadProfile(member.id);
}`);

    expect(brief(facts)).toEqual([
      '2 calls grantBonus = member | member.isVip',
      '3 calls issueWelcomeCoupon = member | NOT (member.hasCoupon)',
      '4 assigns profile = cache.get(member.id) ?? loadProfile(member.id) | ',
      '4 calls cache.get = member.id | ',
      '4 calls loadProfile = member.id | cache.get(member.id) == null',
    ]);
  });

  it('문자열·템플릿은 <literal>, 환경 변수 읽기는 <env> 로 바꾸고 주석과 공백을 걷어 낸다', () => {
    const facts = factsOf(`function shippingLabel(order: Order) {
  const carrier = process.env.SHIP_CARRIER ?? 'acorn-express';
  const key = process.env['LABEL_KEY'];
  const base = import.meta.env.VITE_LABEL_BASE;
  const title = \`\${order.id}-label\`;
  const weight = order.items.reduce(
    (sum, item) => sum + item.weight, // 무게를 더한다
    0,
  );
  return title;
}`);

    expect(
      facts
        .filter((fact) => fact.kind === 'assigns')
        .map((fact) => [fact.subject, fact.value]),
    ).toEqual([
      ['carrier', '<env> ?? <literal>'],
      ['key', '<env>'],
      ['base', '<env>'],
      ['title', '<literal>'],
      ['weight', 'order.items.reduce( (sum, item) => sum + item.weight, 0, )'],
    ]);
  });

  it('긴 글은 자르고 끝에 표시를 붙인다', () => {
    const terms = Array.from({ length: 80 }, (_, index) => `fee${index}`);
    const [fact] = factsOf(`function totalFee() {
  return ${terms.join(' + ')};
}`);

    expect(fact.value).toHaveLength(300);
    expect(fact.value?.endsWith('…')).toBe(true);
  });

  it('같은 줄에서 같은 조건으로 되풀이된 사실은 하나로 합친다', () => {
    const facts = factsOf(`function earnTwice(points: Points) {
  points.add(1); points.add(1);
  points.add(1);
}`);

    expect(brief(facts)).toEqual([
      '2 calls points.add = 1 | ',
      '3 calls points.add = 1 | ',
    ]);
  });

  it('복합 대입과 증감은 연산을 값에 남긴다', () => {
    const facts = factsOf(`function earn(member: Member, earned: number) {
  member.points += earned;
  member.visits++;
  --member.couponSlots;
}`);

    expect(brief(facts)).toEqual([
      '2 assigns member.points = += earned | ',
      '3 assigns member.visits = += 1 | ',
      '4 assigns member.couponSlots = -= 1 | ',
    ]);
  });

  it('식 본문 화살표 함수는 그 식을 반환으로 적는다', () => {
    const facts = factsOf(
      `const deliveryBadge = (days: number) => (days <= 1 ? Badge.Fast : Badge.Normal);`,
    );

    expect(brief(facts)).toEqual([
      '1 returns - = Badge.Fast | days <= 1',
      '1 returns - = Badge.Normal | NOT (days <= 1)',
    ]);
  });

  it('여러 줄 연쇄 호출은 그 호출 이름이 있는 줄에 적는다', () => {
    const facts =
      factsOf(`async function markShipped(orderRepository: Repo, ids: string[]) {
  await orderRepository
    .createQueryBuilder()
    .update(Order)
    .execute();
}`);

    expect(brief(facts)).toEqual([
      '3 calls orderRepository.createQueryBuilder = - | ',
      '4 calls orderRepository.createQueryBuilder().update = Order | ',
      '5 calls orderRepository.createQueryBuilder().update().execute = - | ',
    ]);
  });
});

describe('createTypeScriptFactProjector().constantFacts·enumFacts', () => {
  it('상수 객체는 속성마다 대입 사실을 만든다', () => {
    const sourceFile = parse(
      `export const REFUND_RULES = { maxDays: 7, fee: { rate: 0.1 }, label: 'refund', channel } as const;`,
    );
    const statement = sourceFile.statements[0] as ts.VariableStatement;
    const initializer = statement.declarationList.declarations[0].initializer;
    if (!initializer) {
      throw new Error('no initializer');
    }

    expect(
      brief(projector.constantFacts(sourceFile, 'REFUND_RULES', initializer)),
    ).toEqual([
      '1 assigns REFUND_RULES.maxDays = 7 | ',
      '1 assigns REFUND_RULES.fee.rate = 0.1 | ',
      '1 assigns REFUND_RULES.label = <literal> | ',
      '1 assigns REFUND_RULES.channel = channel | ',
    ]);
  });

  it('열거형은 멤버마다 값을 적고, 값이 없는 숫자 멤버는 앞 값에 1 을 더한다', () => {
    const sourceFile = parse(`enum CouponKind {
  Fixed,
  Rate = 10,
  Shipping,
  Code = 'code',
  Other,
}`);
    const declaration = sourceFile.statements[0] as ts.EnumDeclaration;

    expect(brief(projector.enumFacts(sourceFile, declaration))).toEqual([
      '2 assigns CouponKind.Fixed = 0 | ',
      '3 assigns CouponKind.Rate = 10 | ',
      '4 assigns CouponKind.Shipping = 11 | ',
      '5 assigns CouponKind.Code = <literal> | ',
      '6 assigns CouponKind.Other = - | ',
    ]);
  });
});

describe('createTypeScriptFactProjector().callee', () => {
  const calleeOf = (source: string): string | undefined => {
    // 모듈로 읽어야 맨 위 await 가 식별자가 아니라 await 식이 된다
    const sourceFile = parse(`export {};\n${source}`);
    const statement = sourceFile.statements.find(ts.isExpressionStatement);
    if (!statement) {
      throw new Error('no expression statement');
    }
    let expression = statement.expression;
    while (ts.isAwaitExpression(expression)) {
      expression = expression.expression;
    }
    if (!ts.isCallExpression(expression)) {
      throw new Error('not a call');
    }
    return projector.callee(expression.expression);
  };

  it('호출식의 부르는 쪽을 인자 없이 적는다', () => {
    expect(calleeOf('this.orderService.cancel(id);')).toBe(
      'this.orderService.cancel',
    );
    expect(calleeOf('await (await shopClient()).post(body);')).toBe(
      'shopClient().post',
    );
    expect(calleeOf('handlers[kind](order);')).toBe('handlers[...]');
    expect(calleeOf('order?.items?.at(0);')).toBe('order?.items?.at');
    expect(calleeOf('new Decimal(won).mul(rate);')).toBe('new Decimal().mul');
    expect(calleeOf('process.env.COUPON_CODES.split(sep);')).toBe(
      '<env>.split',
    );
    expect(calleeOf('(() => 1)();')).toBeUndefined();
  });
});
