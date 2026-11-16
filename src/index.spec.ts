import { describe, expect, it } from 'vitest';
import { version } from './index.js';

describe('codecite', () => {
  it('패키지 버전을 내보낸다', () => {
    expect(version).toBe('0.0.0');
  });
});
