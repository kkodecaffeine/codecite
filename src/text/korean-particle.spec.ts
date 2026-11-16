import { describe, expect, it } from 'vitest';
import {
  fixTemplateQuestionParticle,
  withKoreanParticle,
} from './korean-particle.js';
import type { KoreanParticle } from './types.js';

describe('korean particle', () => {
  it.each<[string, KoreanParticle, string]>([
    ['장바구니', '은', '장바구니는'],
    ['교환 정책', '은', '교환 정책은'],
    ['새벽 배송', '이', '새벽 배송이'],
    ['포장 상자', '이', '포장 상자가'],
    ['멤버십 등급', '을', '멤버십 등급을'],
    ['배송비', '을', '배송비를'],
    ['쿠폰함', '으로', '쿠폰함으로'],
    ['적립금 사용', '으로', '적립금 사용으로'],
    ['간편 결제', '으로', '간편 결제로'],
    ['주문 메일', '으로', '주문 메일로'],
    ['gold tier', '은', 'gold tier은'],
  ])('%s + %s → %s', (word, particle, expected) => {
    expect(withKoreanParticle(word, particle)).toBe(expected);
  });

  it('자동으로 만든 질문의 주제 조사만 받침에 맞게 고친다', () => {
    expect(fixTemplateQuestionParticle('반품 접수은 언제 마감돼요?')).toBe(
      '반품 접수는 언제 마감돼요?',
    );
    expect(
      fixTemplateQuestionParticle('묶음 배송이 얼마나 늦어질 수 있죠?'),
    ).toBe('묶음 배송이 얼마나 늦어질 수 있죠?');
    expect(
      fixTemplateQuestionParticle('주말 할인 쿠폰가 취소하거나 바뀌면요?'),
    ).toBe('주말 할인 쿠폰이 취소하거나 바뀌면요?');
    expect(
      fixTemplateQuestionParticle('VIP 포인트으로 얼마를 깎아 주나요?'),
    ).toBe('VIP 포인트로 얼마를 깎아 주나요?');
    expect(fixTemplateQuestionParticle('얼마나 걸리는지만 알려 줘요')).toBe(
      '얼마나 걸리는지만 알려 줘요',
    );
  });
});
