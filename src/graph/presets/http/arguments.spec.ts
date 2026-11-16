import { describe, expect, it } from 'vitest';
import type {
  CodeSite,
  CodeSiteArgument,
  GraphConfig,
  PresetContext,
} from '../../types.js';
import {
  keywordArguments,
  positionalArguments,
  readMethod,
  readUrl,
  staticTexts,
  withBaseUrl,
} from './arguments.js';

const constants: Record<string, string> = {
  ORDERS_PATH: '/orders',
  SHOP_API_ORIGIN: 'https://shop-api.example.com',
  'Paths.POINTS': '/points',
};
const context: PresetContext = {
  repository: 'shop-web',
  config: {} as GraphConfig,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  resolveConstant: (name) => constants[name],
};

const literal = (value: string): CodeSiteArgument => ({
  text: '<literal>',
  literal: value,
});
const name = (identifier: string): CodeSiteArgument => ({
  text: identifier,
  identifier,
});
const template = (
  pieces: string[],
  substitutions: CodeSiteArgument[],
): CodeSiteArgument => ({ text: '<literal>', template: pieces, substitutions });

describe('readUrl', () => {
  it('문자열 경로와 절대 주소를 읽는다', () => {
    expect(readUrl(literal('/orders/'), context)).toEqual({
      path: '/orders',
      baseIdentifiers: [],
      dynamic: false,
    });
    expect(
      readUrl(literal('https://Pay.Example.com/v1/charges?a=1'), context),
    ).toEqual({
      path: '/v1/charges',
      host: 'pay.example.com',
      baseIdentifiers: [],
      dynamic: false,
    });
  });

  it('맨 앞의 실행 중 값은 기준 주소 식별자로, 뒤쪽 값은 :param 과 dynamic 으로 둔다', () => {
    expect(
      readUrl(
        template(
          ['', '/orders/', '/items'],
          [name('process.env.SHOP_API_URL'), name('orderId')],
        ),
        context,
      ),
    ).toEqual({
      path: '/orders/:param/items',
      baseIdentifiers: ['process.env.SHOP_API_URL'],
      dynamic: true,
    });
    expect(
      readUrl(template(['', '/coupons'], [name('this.baseUrl')]), context),
    ).toEqual({
      path: '/coupons',
      baseIdentifiers: ['this.baseUrl'],
      dynamic: false,
    });
  });

  it('상수는 같은 저장소 값으로 풀고, 정적인 경로 글자가 없으면 path 를 비운다', () => {
    expect(
      readUrl(
        template(['', '/', ''], [name('ORDERS_PATH'), name('id')]),
        context,
      ),
    ).toEqual({ path: '/orders/:param', baseIdentifiers: [], dynamic: true });
    expect(readUrl(name('Paths.POINTS'), context)).toMatchObject({
      path: '/points',
      dynamic: false,
    });
    expect(
      readUrl(template(['', '/orders'], [name('SHOP_API_ORIGIN')]), context),
    ).toEqual({
      path: '/orders',
      host: 'shop-api.example.com',
      baseIdentifiers: [],
      dynamic: false,
    });
    expect(readUrl(name('endpoint'), context)).toEqual({
      baseIdentifiers: ['endpoint'],
      dynamic: true,
    });
    expect(readUrl(template(['/', ''], [name('section')]), context)).toEqual({
      baseIdentifiers: [],
      dynamic: true,
    });
    expect(readUrl({ text: 'buildUrl(<literal>)' }, context)).toEqual({
      baseIdentifiers: [],
      dynamic: true,
    });
  });

  it('공백이 섞인 글은 주소로 보지 않는다', () => {
    expect(readUrl(literal('order list'), context)).toBeUndefined();
  });
});

describe('withBaseUrl', () => {
  it('기준 주소의 경로를 앞에 붙이고 식별자·호스트를 넘긴다', () => {
    const base = readUrl(
      template(['', '/v2'], [name('process.env.SHOP_API_URL')]),
      context,
    );
    const call = readUrl(literal('/refunds'), context);
    expect(call && withBaseUrl(base, call)).toEqual({
      path: '/v2/refunds',
      baseIdentifiers: ['process.env.SHOP_API_URL'],
      dynamic: false,
    });
  });

  it('호출 주소에 호스트가 있으면 기준 주소를 쓰지 않는다', () => {
    const base = readUrl(literal('https://shop-api.example.com/v2'), context);
    const call = readUrl(literal('https://pay.example.com/charges'), context);
    expect(call && withBaseUrl(base, call)).toEqual(call);
  });
});

describe('readMethod', () => {
  it('문자열, 상수, 메서드 이름으로 끝나는 열거형 멤버를 대문자로 읽는다', () => {
    expect(readMethod(literal('post'), context)).toBe('POST');
    expect(readMethod(name('HttpMethod.Delete'), context)).toBe('DELETE');
    expect(readMethod(name('method'), context)).toBeUndefined();
    expect(readMethod(literal('FETCH'), context)).toBeUndefined();
  });
});

describe('Python 키워드 인자', () => {
  it('마지막 키워드 묶음과 위치 인자를 나누고, 위치 딕셔너리는 키워드로 보지 않는다', () => {
    const site: CodeSite = {
      kind: 'call',
      name: 'requests.post',
      line: 3,
      args: [
        literal('/orders'),
        { text: '{<literal>: 1}', properties: { page: { text: '1' } } },
        {
          text: 'json=payload, timeout=3',
          properties: { json: name('payload'), timeout: { text: '3' } },
        },
      ],
    };
    expect(positionalArguments(site)).toHaveLength(2);
    expect(Object.keys(keywordArguments(site))).toEqual(['json', 'timeout']);
  });

  it('배열 인자는 원소마다 글로 읽는다', () => {
    expect(
      staticTexts(
        { text: '[<literal>, <literal>]', elements: [literal('a'), name('x')] },
        context,
      ),
    ).toEqual(['a']);
  });
});
