import {
  ANSWER_ITEM_LIMITS,
  ANSWER_SENTENCE_PATTERN,
  DETAILED_ANSWER_QUERY_PATTERN,
  FINAL_EXCEPTION_ITEM_PATTERN,
  LEADING_BULLET_PATTERN,
  LIST_ANSWER_QUERY_PATTERN,
} from './constants.js';
import type { AnswerItem, PolicyAnswerMode } from './types.js';

/** 질문 말투로 답변 길이 모드를 정한다. 상세 요청이 목록 요청보다 앞선다 */
export function policyAnswerMode(question: string): PolicyAnswerMode {
  if (DETAILED_ANSWER_QUERY_PATTERN.test(question)) {
    return 'detailed';
  }
  return LIST_ANSWER_QUERY_PATTERN.test(question) ? 'list' : 'default';
}

/** 고객 응대용 기본 답변은 짧게 두고, 명시적인 상세 요청만 더 허용한다 */
export function policyAnswerItemLimit(mode: PolicyAnswerMode): number {
  return ANSWER_ITEM_LIMITS[mode];
}

/**
 * 목록 줄은 한 항목, 일반 문장은 완결 문장 하나를 한 항목으로 세어 항목 수를 맞춘다
 * 기본 답변을 줄일 때는 마지막 예외·한계 항목을 따로 남겨 "단, …" 이 잘리지 않게 한다
 * 항목이 둘 이상이면 훑기 쉬운 목록으로, prose 면 이어진 문장으로 낸다
 */
export function enforcePolicyAnswerContract(
  answer: string,
  mode: PolicyAnswerMode,
  itemLimit?: number,
  style: 'bullets' | 'prose' = 'bullets',
): string {
  const limit = itemLimit ?? policyAnswerItemLimit(mode);
  const items = completedAnswerItems(answer);
  if (items.length <= limit) {
    return renderAnswerItems(items, style);
  }

  if (mode === 'default') {
    const finalException = [...items]
      .reverse()
      .find((item) => FINAL_EXCEPTION_ITEM_PATTERN.test(item.text));
    const retained = items.slice(0, finalException ? limit - 1 : limit);
    if (finalException && !retained.includes(finalException)) {
      retained.push(finalException);
    }
    return renderAnswerItems(retained, style);
  }

  return renderAnswerItems(items.slice(0, limit), style);
}

/**
 * 답변을 항목으로 나눈다. 목록 기호 줄은 줄 전체가 한 항목이다
 * 일반 줄은 완결 문장마다 한 항목이고, 완결 문장 뒤의 미완성 꼬리는 버린다. 구두점이 하나도 없는 줄은 마침표를 붙여 한 항목으로 센다
 */
export function completedAnswerItems(answer: string): AnswerItem[] {
  return answer.split('\n').flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }
    if (
      LEADING_BULLET_PATTERN.test(trimmed) &&
      /\S/.test(trimmed.replace(LEADING_BULLET_PATTERN, ''))
    ) {
      return [{ text: trimmed }];
    }
    const completed = trimmed
      .match(ANSWER_SENTENCE_PATTERN)
      ?.map((text) => ({ text: text.trim() }));
    return completed?.length
      ? completed
      : [{ text: `${trimmed.replace(/[.!?。]+$/, '')}.` }];
  });
}

function renderAnswerItems(
  items: readonly AnswerItem[],
  style: 'bullets' | 'prose',
): string {
  if (style === 'prose') {
    return items
      .map((item) => item.text.replace(LEADING_BULLET_PATTERN, ''))
      .join(' ');
  }
  if (items.length < 2) {
    return items.map((item) => item.text).join('\n');
  }
  return items
    .map((item) => `• ${item.text.replace(LEADING_BULLET_PATTERN, '')}`)
    .join('\n');
}
