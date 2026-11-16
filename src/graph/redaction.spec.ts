import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE } from './constants.js';
import { redactSecretLiterals, scrubMessage } from './redaction.js';

// 비밀값 모양은 소스에 글자 그대로 두지 않고 실행할 때 만든다(비밀값 검사 도구가 소스를 훑는다)
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const HEX = '0123456789abcdef';

/** 씨앗이 같으면 같은 수열을 내는 작은 난수 생성기(mulberry32) */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** 가짜 토큰. 대문자·소문자·숫자를 모두 담는다 */
function fakeToken(length: number, seed: number): string {
  const random = seeded(seed);
  const choose = (pool: string) => pool[Math.floor(random() * pool.length)];
  let token = choose(UPPER) + choose(LOWER) + choose(DIGITS);
  const all = UPPER + LOWER + DIGITS;
  while (token.length < length) {
    token += choose(all);
  }
  return token;
}

function fakeHex(length: number, seed: number): string {
  const random = seeded(seed);
  let text = '';
  while (text.length < length) {
    text += HEX[Math.floor(random() * HEX.length)];
  }
  return text;
}

const quoted = (value: string) => `'${value}'`;

describe('redactSecretLiterals', () => {
  it('개인 키 블록을 통째로 가린다', () => {
    const begin = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
    const end = ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
    const source = `const signer = \`${begin}\n${fakeToken(48, 1)}\n${end}\`;`;

    const result = redactSecretLiterals(source);

    expect(result).toBe('const signer = `[REDACTED PRIVATE KEY]`;');
  });

  it('비밀값 이름에 넣은 문자열은 따옴표를 남기고 안만 가린다', () => {
    const token = fakeToken(12, 2);
    const cases = [
      `const apiKey = ${quoted(token)};`,
      `const ORDER_API_KEY: string = ${quoted(token)};`,
      `{ "clientSecret": "${token}" }`,
      `headers: { 'x-api-key': ${quoted(token)} }`,
      `db_password="${token}"`,
      `const secretKey = ${quoted(token)};`,
      `const refundApiToken =\n  ${quoted(token)};`,
    ];
    for (const source of cases) {
      const result = redactSecretLiterals(source);
      expect(result).not.toContain(token);
      expect(result).toContain(REDACTED_VALUE);
    }
    expect(redactSecretLiterals(`const apiKey = ${quoted(token)};`)).toBe(
      `const apiKey = '${REDACTED_VALUE}';`,
    );
  });

  it('비밀값을 설명하는 이름과 사람이 읽는 안내 문구는 남긴다', () => {
    const kept = [
      "const passwordHint = '도토리 회원 비밀번호는 여덟 자 이상';",
      "const tokenType = 'access';",
      "const tokenizer = 'acorn';",
      "const password = '';",
      'const authorization = `Bearer ${session.token}`;',
      "const resetUrl = '/account/password/reset';",
    ];
    for (const source of kept) {
      expect(redactSecretLiterals(source)).toBe(source);
    }
  });

  it('키·솔트 이름은 값이 무작위 모양일 때만 가린다', () => {
    const hex = fakeHex(32, 3);
    const mixed = fakeToken(24, 4);
    expect(
      redactSecretLiterals(`const couponCipherKey = ${quoted(hex)};`),
    ).toBe(`const couponCipherKey = '${REDACTED_VALUE}';`);
    expect(redactSecretLiterals(`cipherSalt: ${quoted(mixed)},`)).toBe(
      `cipherSalt: '${REDACTED_VALUE}',`,
    );
    const plain = "const cacheKey = 'acorn-cart-summary';";
    expect(redactSecretLiterals(plain)).toBe(plain);
    const versioned = "const storageKey = 'reviewDraftVersion20261116';";
    expect(redactSecretLiterals(versioned)).toBe(versioned);
  });

  it('이름이 평범해도 길고 무작위인 문자열은 가린다', () => {
    const token = fakeToken(40, 5);
    expect(redactSecretLiterals(`const value = ${quoted(token)};`)).toBe(
      `const value = '${REDACTED_VALUE}';`,
    );
    const hash = fakeHex(64, 6);
    const checksum = `const expectedDigest = ${quoted(hash)};`;
    expect(redactSecretLiterals(checksum)).toBe(checksum);
    const label = "const title = 'AcornMarketMembershipGradeBadge2026';";
    expect(redactSecretLiterals(label)).toBe(label);
  });

  it('형식이 알려진 토큰과 인증 머리글 값은 어디에 있든 가린다', () => {
    const prefixed = ['gh', 'p_'].join('') + fakeToken(36, 7);
    const keyId = ['AK', 'IA'].join('') + fakeToken(16, 8).toUpperCase();
    const bearer = fakeToken(30, 9);
    const jwt = [
      ['ey', 'J'].join('') + fakeToken(20, 10),
      ['ey', 'J'].join('') + fakeToken(24, 11),
      fakeToken(22, 12),
    ].join('.');
    const source = [
      `// 배포 토큰 ${prefixed}`,
      `const id = process.env.KEY_ID ?? '${keyId}';`,
      `fetch(url, { headers: { Authorization: 'Bearer ${bearer}' } });`,
      `const session = '${jwt}';`,
    ].join('\n');

    const result = redactSecretLiterals(source);

    for (const secret of [prefixed, keyId, bearer, jwt]) {
      expect(result).not.toContain(secret);
    }
    expect(result).toContain('Bearer [REDACTED]');
  });

  it('주소 안의 계정 비밀번호를 가린다', () => {
    const secret = fakeToken(14, 13);
    const source = `const db = 'postgres://acorn:${secret}@db.dotori.test:5432/shop';`;
    expect(redactSecretLiterals(source)).toBe(
      `const db = 'postgres://acorn:${REDACTED_VALUE}@db.dotori.test:5432/shop';`,
    );
  });

  it('END 없는 BEGIN 줄이 많아도 앞에서부터 한 번만 훑는다', () => {
    const begin = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
    const source = `${begin}\n`.repeat(20_000);
    expect(redactSecretLiterals(source)).toBe(source);
  });

  it('평범한 코드는 그대로 둔다', () => {
    const source = [
      'export function earnPoints(order: Order): number {',
      "  if (order.status !== 'paid') {",
      '    return 0;',
      '  }',
      '  return Math.floor(order.amount * 0.01);',
      '}',
    ].join('\n');
    expect(redactSecretLiterals(source)).toBe(source);
  });
});

describe('scrubMessage', () => {
  it('이 컴퓨터의 경로를 지우고 비밀값을 가린 뒤 자른다', () => {
    const token = fakeToken(12, 14);
    const message = `Unexpected token in /tmp/codecite-graph-x1/shop-api/src/cart.ts (password='${token}')`;
    const result = scrubMessage(
      message,
      ['/tmp/codecite-graph-x1/shop-api'],
      200,
    );
    expect(result).toBe(
      `Unexpected token in src/cart.ts (password='${REDACTED_VALUE}')`,
    );
    expect(scrubMessage('x'.repeat(50), [], 10)).toHaveLength(10);
  });
});
