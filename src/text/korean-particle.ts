import {
  HANGUL_RIEUL_FINAL,
  HANGUL_SYLLABLE_END,
  HANGUL_SYLLABLE_START,
  KOREAN_PARTICLE_BASE,
  KOREAN_PARTICLE_PAIRS,
  TEMPLATE_QUESTION_PARTICLE_PATTERN,
} from './constants.js';
import type { KoreanParticle } from './types.js';

/** 마지막 글자의 받침에 맞춰 조사를 붙인다. 한글로 끝나지 않으면 원래 형태를 유지한다 */
export function withKoreanParticle(
  word: string,
  particle: KoreanParticle,
): string {
  const last = word.trimEnd().codePointAt(word.trimEnd().length - 1);
  if (
    last === undefined ||
    last < HANGUL_SYLLABLE_START ||
    last > HANGUL_SYLLABLE_END
  ) {
    return `${word}${particle}`;
  }
  const final = (last - HANGUL_SYLLABLE_START) % 28;
  const [withFinal, withoutFinal] = KOREAN_PARTICLE_PAIRS[particle];
  if (particle === '으로') {
    return `${word}${final === 0 || final === HANGUL_RIEUL_FINAL ? withoutFinal : withFinal}`;
  }
  return `${word}${final === 0 ? withoutFinal : withFinal}`;
}

/** 자동으로 만든 질문 예시에서 주제 바로 뒤 조사만 받침에 맞게 고친다 */
export function fixTemplateQuestionParticle(question: string): string {
  const match = TEMPLATE_QUESTION_PARTICLE_PATTERN.exec(question);
  if (!match) {
    return question;
  }
  const [whole, topic, particle] = match;
  const base = KOREAN_PARTICLE_BASE[particle];
  if (!base) {
    return question;
  }
  return `${withKoreanParticle(topic, base)} ${question.slice(whole.length)}`;
}
