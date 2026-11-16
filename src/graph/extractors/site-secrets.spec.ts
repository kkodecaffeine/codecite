import { describe, expect, it } from 'vitest';
import type { CodeSite } from '../types.js';
import {
  isSecretKeyName,
  redactSecretValue,
  redactSiteSecrets,
} from './site-secrets.js';

// 비밀값 모양 시험 값. 저장소의 비밀값 검사에 걸리지 않도록 조각을 실행 중에 잇는다
const fakeLiveKey = ['sk', 'live', 'Dotori1Acorn2Market3Shop4'].join('_');
const fakeRepoToken = ['ghp', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2'].join('_');
const fakeJwt = [
  'eyJ' + 'hbGciOiJIUzI1NiJ9',
  'eyJ' + 'zdWIiOiJkb3RvcmkifQ',
  'c2lnbmF0dXJlLXBhcnQ',
].join('.');
const fakeHex = '0123456789abcdef'.repeat(3);
const fakeRandom = [
  'aB3d',
  'E5gH',
  '7jK9',
  'mN1p',
  'Q3sT',
  '5vW7',
  'xY9z',
].join('');

describe('redactSecretValue', () => {
  it('알려진 토큰 머리말, JWT, 긴 16 진수, 무작위처럼 보이는 묶음을 가린다', () => {
    expect(redactSecretValue(fakeLiveKey)).toBe('<redacted>');
    expect(redactSecretValue(`token ${fakeRepoToken} used`)).toBe(
      'token <redacted> used',
    );
    expect(redactSecretValue(fakeJwt)).toBe('<redacted>');
    expect(redactSecretValue(`sha=${fakeHex}`)).toBe('sha=<redacted>');
    expect(redactSecretValue(`trace/${fakeRandom}`)).toBe('<redacted>');
    expect(redactSecretValue(['Bearer', fakeRandom].join(' '))).toBe(
      '<redacted>',
    );
  });

  it('주소의 사용자 정보만 가리고 호스트와 경로는 남긴다', () => {
    const url = ['https://acorn', 'hunter2@pay.example.com/v1/charge'].join(
      ':',
    );

    expect(redactSecretValue(url)).toBe(
      'https://<redacted>@pay.example.com/v1/charge',
    );
  });

  it('경로·큐 이름·긴 낙타 표기 이름은 그대로 둔다', () => {
    for (const value of [
      '/api/v1/members/{member_id}/coupons/2026',
      'order-cancelled-refund-queue-v2',
      'COUPON_ISSUED_RETRY_QUEUE_V3_DEAD_LETTER',
      'membershipGradeRecalculationScheduledJobV3',
      'points.expire',
    ]) {
      expect(redactSecretValue(value)).toBe(value);
    }
  });
});

describe('isSecretKeyName', () => {
  it('대소문자와 구분자를 무시하고 비밀값을 담는 키 이름을 알아본다', () => {
    for (const name of [
      'apiKey',
      'api_key',
      'client-secret',
      'Authorization',
      'refreshToken',
      'PASSWORD',
    ]) {
      expect(isSecretKeyName(name)).toBe(true);
    }
    // 마지막 낱말만 본다: 비밀값을 설명하는 이름의 값(안내 문구, 종류)은 남긴다
    for (const name of [
      'memberId',
      'method',
      'queue',
      'author',
      'passwordHint',
      'tokenType',
    ]) {
      expect(isSecretKeyName(name)).toBe(false);
    }
  });
});

describe('redactSiteSecrets', () => {
  it('키·솔트 이름 아래의 값은 무작위처럼 보일 때만 가린다', () => {
    const fakeSalt = '0123456789abcdef'.slice(0, 16);
    const [site] = redactSiteSecrets([
      {
        kind: 'call',
        name: 'pointCache.set',
        line: 1,
        args: [
          {
            text: '{ key: <literal>, cacheKey: <literal>, salt: <literal> }',
            properties: {
              key: { text: '<literal>', literal: 'coupon-list' },
              cacheKey: { text: '<literal>', literal: 'points:daily' },
              salt: { text: '<literal>', literal: fakeSalt },
            },
          },
        ],
      },
    ]);

    expect(site.args[0].properties).toEqual({
      key: { text: '<literal>', literal: 'coupon-list' },
      cacheKey: { text: '<literal>', literal: 'points:daily' },
      salt: { text: '<literal>', literal: '<redacted>' },
    });
  });

  it('비밀값 키 아래의 값은 모양과 상관없이 가리고, 이름과 가린 원문은 그대로 둔다', () => {
    const sites: CodeSite[] = [
      {
        kind: 'call',
        name: 'couponGateway.issue',
        line: 3,
        args: [
          { text: '<literal>', literal: '/coupons/issue' },
          {
            text: '{ headers: { authorization: <literal> }, memberId }',
            properties: {
              headers: {
                text: '{ authorization: <literal> }',
                properties: {
                  authorization: {
                    text: '<literal>',
                    template: ['Basic ', ''],
                    substitutions: [{ text: 'pair', identifier: 'pair' }],
                  },
                },
              },
              memberId: { text: 'memberId', identifier: 'memberId' },
              note: { text: '<literal>', literal: `key ${fakeLiveKey}` },
              tags: {
                text: '[<literal>]',
                elements: [{ text: '<literal>', literal: 'points' }],
              },
            },
          },
        ],
      },
    ];

    expect(redactSiteSecrets(sites)).toEqual([
      {
        kind: 'call',
        name: 'couponGateway.issue',
        line: 3,
        args: [
          { text: '<literal>', literal: '/coupons/issue' },
          {
            text: '{ headers: { authorization: <literal> }, memberId }',
            properties: {
              headers: {
                text: '{ authorization: <literal> }',
                properties: {
                  authorization: {
                    text: '<literal>',
                    template: ['<redacted>', ''],
                    substitutions: [{ text: 'pair', identifier: 'pair' }],
                  },
                },
              },
              memberId: { text: 'memberId', identifier: 'memberId' },
              note: { text: '<literal>', literal: 'key <redacted>' },
              tags: {
                text: '[<literal>]',
                elements: [{ text: '<literal>', literal: 'points' }],
              },
            },
          },
        ],
      },
    ]);
  });
});
