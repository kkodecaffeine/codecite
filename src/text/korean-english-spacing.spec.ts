import { describe, expect, it } from 'vitest';
import { normalizeKoreanEnglishSpacing } from './korean-english-spacing.js';

describe('korean english spacing', () => {
  it('한글과 영어 사이를 한 칸 띄운다', () => {
    expect(normalizeKoreanEnglishSpacing('VIP등급은 Gold멤버십보다 높다')).toBe(
      'VIP 등급은 Gold 멤버십보다 높다',
    );
  });

  it('숫자와 이미 띄운 글은 건드리지 않는다', () => {
    expect(normalizeKoreanEnglishSpacing('적립금 3000원, API 응답')).toBe(
      '적립금 3000원, API 응답',
    );
  });
});
