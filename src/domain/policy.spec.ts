import { describe, expect, it } from 'vitest';
import { normalizePolicyContextKind } from './context-kind.js';
import { PolicyCode } from './policy-code.js';
import { PolicyStatus } from './policy-status.js';
import { Policy } from './policy.js';

function refundPolicy(overrides: Partial<Parameters<typeof Policy.create>[0]>) {
  return Policy.create({
    name: '환불 기간',
    decision: '환불은 결제 수단으로 3 영업일 안에 돌아간다.',
    status: PolicyStatus.of('Active'),
    section: 'refund',
    code: PolicyCode.of('REFUND-001'),
    source: 'policies.csv#row-2',
    ...overrides,
  });
}

describe('Policy', () => {
  it('이름이나 결정 문장이 비면 만들지 않는다', () => {
    expect(() => refundPolicy({ name: ' ' })).toThrow(
      'Policy name is required.',
    );
    expect(() => refundPolicy({ decision: '' })).toThrow(
      'Policy decision is required: 환불 기간',
    );
  });

  it('knowledgeText 가 있으면 그대로, 없으면 정책 필드로 근거 글을 만든다', () => {
    expect(
      refundPolicy({ knowledgeText: '[정책]\n- 환불' }).toKnowledgeText(),
    ).toBe('[정책]\n- 환불');
    expect(refundPolicy({ knowledgeText: '  ' }).toKnowledgeText()).toBe(
      [
        '정책명: 환불 기간',
        '정책 코드: REFUND-001',
        '섹션: refund',
        '상태: Active',
        '결정: 환불은 결제 수단으로 3 영업일 안에 돌아간다.',
        '출처: policies.csv#row-2',
      ].join('\n'),
    );
  });

  it('상태가 active 일 때만 활성으로 본다', () => {
    expect(refundPolicy({}).isActive()).toBe(true);
    expect(refundPolicy({ status: PolicyStatus.of('ACTIVE') }).isActive()).toBe(
      true,
    );
    expect(
      refundPolicy({ status: PolicyStatus.of('Inactive') }).isActive(),
    ).toBe(false);
    expect(PolicyStatus.of(' ').toString()).toBe('Draft');
  });

  it('정책 코드는 앞뒤 공백을 걷어 내고 빈 값을 거부한다', () => {
    expect(PolicyCode.of(' POINTS-001 ').toString()).toBe('POINTS-001');
    expect(() => PolicyCode.of('  ')).toThrow('Policy code is required.');
  });

  it('알 수 없는 조각 종류는 정책으로 해석한다', () => {
    expect(normalizePolicyContextKind('technical')).toBe('technical');
    expect(normalizePolicyContextKind('policy')).toBe('policy');
    expect(normalizePolicyContextKind(undefined)).toBe('policy');
    expect(normalizePolicyContextKind('code')).toBe('policy');
  });
});
