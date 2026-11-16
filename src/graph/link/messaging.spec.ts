import { describe, expect, it } from 'vitest';
import { normalizeMessageName } from '../topology.js';
import { isGenericMessageName } from './messaging.js';

describe('isGenericMessageName', () => {
  it('정규화한 이름이 일반 낱말 하나뿐일 때만 일반 이름으로 본다', () => {
    expect(
      ['QUEUE', 'events', 'Jobs', 'default'].map((name) =>
        isGenericMessageName(normalizeMessageName(name)),
      ),
    ).toEqual([true, true, true, true]);
    expect(
      ['refund-queue', 'couponIssued', 'jobs.daily'].map((name) =>
        isGenericMessageName(normalizeMessageName(name)),
      ),
    ).toEqual([false, false, false]);
  });
});
