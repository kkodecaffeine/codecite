import { describe, expect, it } from 'vitest';
import {
  completedAnswerItems,
  enforcePolicyAnswerContract,
  policyAnswerItemLimit,
  policyAnswerMode,
} from './answer-contract.js';

describe('policyAnswerMode', () => {
  it.each([
    ['배송비는 얼마예요?', 'default'],
    ['반품 절차를 자세히 설명해 주세요', 'detailed'],
    ['멤버십 혜택 아는 대로 다 말해줘', 'detailed'],
    ['쿠폰 종류를 목록으로 보여줘', 'list'],
    ['골드와 실버 등급 비교해 줘', 'list'],
  ] as const)('%s → %s', (question, mode) => {
    expect(policyAnswerMode(question)).toBe(mode);
  });

  it('모드마다 남기는 항목 수가 다르다', () => {
    expect(policyAnswerItemLimit('default')).toBe(3);
    expect(policyAnswerItemLimit('list')).toBe(4);
    expect(policyAnswerItemLimit('detailed')).toBe(12);
  });
});

describe('enforcePolicyAnswerContract', () => {
  it('기본 답변을 줄일 때 앞의 두 항목과 마지막 예외 항목을 남긴다', () => {
    const answer = [
      '가방은 무료로 교환됩니다.',
      '교환 신청은 주문 내역에서 합니다.',
      '회수 기사가 이틀 안에 방문합니다.',
      '새 상품은 회수 확인 뒤 보냅니다.',
      '교환 배송비는 도토리 마켓이 냅니다.',
      '단, 사용 흔적이 있으면 교환이 제외됩니다.',
    ].join(' ');

    const contracted = enforcePolicyAnswerContract(answer, 'default');

    expect(completedAnswerItems(contracted)).toHaveLength(3);
    expect(contracted).toContain('교환 신청은 주문 내역에서 합니다.');
    expect(contracted).not.toContain('회수 기사가');
    expect(contracted).toContain('단, 사용 흔적이 있으면');
  });

  it('항목이 둘 이상이면 목록 기호를 붙인다', () => {
    expect(
      enforcePolicyAnswerContract(
        '적립금은 결제 때 씁니다. 남은 적립금은 다음 주문에 씁니다.',
        'default',
      ),
    ).toBe('• 적립금은 결제 때 씁니다.\n• 남은 적립금은 다음 주문에 씁니다.');
  });

  it('항목이 하나면 기호 없이 그대로 둔다', () => {
    expect(
      enforcePolicyAnswerContract('리뷰 적립금은 바로 들어옵니다.', 'default'),
    ).toBe('리뷰 적립금은 바로 들어옵니다.');
  });

  it('prose 로 내면 항목 수는 지키고 이어진 문장으로 둔다', () => {
    expect(
      enforcePolicyAnswerContract(
        '- 쿠폰은 돌려드립니다.\n- 적립금 반환 시점은 확인하지 못했습니다.',
        'default',
        undefined,
        'prose',
      ),
    ).toBe('쿠폰은 돌려드립니다. 적립금 반환 시점은 확인하지 못했습니다.');
  });

  it('숫자 뒤 마침표는 문장 끝으로 보지 않는다', () => {
    expect(
      enforcePolicyAnswerContract(
        '2.5배로 쌓입니다. 골드 등급에만 해당합니다.',
        'default',
      ),
    ).toBe('• 2.5배로 쌓입니다.\n• 골드 등급에만 해당합니다.');
  });

  it('원래 있던 목록 기호를 하나로 맞춘다', () => {
    expect(
      enforcePolicyAnswerContract('* 택배 회수\n- 검수 뒤 환불', 'list'),
    ).toBe('• 택배 회수\n• 검수 뒤 환불');
  });

  it('기호 뒤에 공백이 없어도 목록 줄로 보고 기호를 겹쳐 남기지 않는다', () => {
    expect(
      enforcePolicyAnswerContract(
        '배송 방법은 세 가지입니다.\n-일반 택배: 이틀 걸림.\n•새벽 배송: 다음 날 아침.',
        'list',
      ),
    ).toBe(
      '• 배송 방법은 세 가지입니다.\n• 일반 택배: 이틀 걸림.\n• 새벽 배송: 다음 날 아침.',
    );
  });

  it('기호 바로 뒤에 숫자가 오면 음수·범위로 보고 목록 기호로 보지 않는다', () => {
    expect(completedAnswerItems('-15% 할인됩니다. 이번 주까지입니다.')).toEqual(
      [{ text: '-15% 할인됩니다.' }, { text: '이번 주까지입니다.' }],
    );
  });

  it('상세 답변은 열두 항목까지, 목록 답변은 네 항목까지 남긴다', () => {
    const bullets = Array.from(
      { length: 14 },
      (_, index) => `- 상품 분류 ${index + 1}`,
    ).join('\n');

    expect(
      completedAnswerItems(enforcePolicyAnswerContract(bullets, 'detailed')),
    ).toHaveLength(12);
    expect(
      completedAnswerItems(enforcePolicyAnswerContract(bullets, 'list')),
    ).toHaveLength(4);
  });

  it('줄일 때 끝맺지 않은 꼬리는 남기지 않는다', () => {
    const contracted = enforcePolicyAnswerContract(
      '하나. 둘. 셋. 넷. 다섯. 끝나지 않은',
      'default',
    );

    expect(contracted).not.toContain('끝나지 않은');
    expect(contracted.endsWith('.')).toBe(true);
  });

  it('항목이 한도보다 적어도 끝맺지 않은 꼬리는 지운다', () => {
    expect(
      enforcePolicyAnswerContract(
        '배송은 이틀 걸립니다. 그리고 주말에는',
        'default',
      ),
    ).toBe('배송은 이틀 걸립니다.');
  });

  it('구두점이 없는 줄도 한 항목으로 세어 한도를 지킨다', () => {
    const answer = Array.from(
      { length: 5 },
      (_, index) => `구두점 없는 안내 ${index + 1}`,
    ).join('\n');

    const contracted = enforcePolicyAnswerContract(answer, 'default');

    expect(completedAnswerItems(contracted)).toHaveLength(3);
    expect(contracted).not.toContain('안내 4');
  });
});
