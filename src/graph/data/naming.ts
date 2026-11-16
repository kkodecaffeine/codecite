// 이름 규칙 도우미. 연결 컬럼 이름(`orderId`, `order_id`)에서 상대 테이블 이름 후보를 만든다
import { IRREGULAR_PLURALS, UNCOUNTABLE_WORDS } from './constants.js';

/**
 * 영어 낱말 하나의 복수형. 작은 범용 규칙이다
 * 1. 셀 수 없는 낱말(`data`)은 그대로, 예외 낱말(`person` → `people`)은 표에서
 * 2. s·x·z·ch·sh 로 끝나면 es(`address` → `addresses`, `box` → `boxes`)
 * 3. 자음 + y 로 끝나면 ies(`category` → `categories`). 모음 + y 는 s(`day` → `days`)
 * 4. 나머지는 s(`order` → `orders`)
 * 대소문자는 소문자로 본다
 */
export function pluralize(word: string): string {
  const lower = word.toLowerCase();
  if (lower === '' || UNCOUNTABLE_WORDS.includes(lower)) {
    return lower;
  }
  const irregular = IRREGULAR_PLURALS[lower];
  if (irregular) {
    return irregular;
  }
  if (/(?:s|x|z|ch|sh)$/.test(lower)) {
    return `${lower}es`;
  }
  if (/[^aeiou]y$/.test(lower)) {
    return `${lower.slice(0, -1)}ies`;
  }
  return `${lower}s`;
}

/** 이름을 소문자 낱말로 나눈다(`orderItem`, `order_item`, `OrderItem`, `HTTPRequest`) */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * 테이블 이름을 맞춰 볼 열쇠. 스키마 앞머리(`shop.`)를 떼고, 소문자로 바꾸고, 글자·숫자 밖의 글자를 뺀다
 * 그래서 `order_items`, `orderItems`, `OrderItems` 가 같은 열쇠다
 */
export function tableMatchKey(table: string): string {
  return (table.split('.').at(-1) ?? table)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * 연결 컬럼 이름에서 상대 테이블 열쇠 후보를 만든다. 끝말(`Id`, `_id`)을 뗀 낱말들로 단수형·복수형 열쇠를 만들고,
 * 앞 낱말을 하나씩 뗀 짧은 꼴도 차례로 낸다(`buyerMemberId` → [buyermember, buyermembers], [member, members])
 * 끝말이 맞지 않거나 뗀 뒤 남는 이름이 없으면 빈 목록이다
 */
export function foreignKeyCandidates(
  column: string,
  suffixes: readonly string[],
): string[][] {
  const field = column.split('.').at(-1) ?? column;
  const bases = new Set<string>();
  for (const suffix of suffixes) {
    if (suffix && field.length > suffix.length && field.endsWith(suffix)) {
      bases.add(field.slice(0, -suffix.length));
    }
  }
  const tiers = new Map<number, Set<string>>();
  for (const base of bases) {
    const words = nameWords(base);
    for (let start = 0; start < words.length; start += 1) {
      const tail = words.slice(start);
      const head = tail.slice(0, -1).join('');
      const last = tail.at(-1) ?? '';
      const tier = tiers.get(tail.length) ?? new Set<string>();
      tier.add(`${head}${last}`);
      tier.add(`${head}${pluralize(last)}`);
      tiers.set(tail.length, tier);
    }
  }
  // 낱말이 많은(더 구체적인) 꼴부터 본다
  return [...tiers.entries()]
    .sort(([left], [right]) => right - left)
    .map(([, keys]) => [...keys]);
}
