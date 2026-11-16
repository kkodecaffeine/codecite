import { describe, expect, it } from 'vitest';
import type { PolicyClaimProps } from '../domain/types.js';
import {
  completedAnswerItems,
  enforcePolicyAnswerContract,
  ensureRequiredEvidenceDetails,
  isPolicyAnswerAbstention,
  numericValues,
  policyAnswerItemLimit,
  policyAnswerMode,
} from './answer-contract.js';
import type { PolicyEvidence } from './types.js';

const claimEvidence = (
  claims: Array<Partial<PolicyClaimProps> & { statement: string }>,
): PolicyEvidence[] => [
  {
    chunkId: 'points',
    policyCode: 'DOTORI-POINTS',
    section: '적립금',
    internalSource: 'shop/policies.csv#points',
    sourceLabel: 'policies.csv',
    text: '',
    policyClaims: claims.map((claim, index) => ({
      claimId: `points-${index}`,
      facet: 'outcome',
      confidence: 'high',
      provenanceChunkIds: ['points'],
      ...claim,
    })),
  },
];

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

describe('isPolicyAnswerAbstention', () => {
  it('첫 항목에서 근거 부족을 말한 답만 미룬 답으로 본다', () => {
    expect(
      isPolicyAnswerAbstention('이 질문에 맞는 규정을 찾지 못했어요.'),
    ).toBe(true);
    expect(
      isPolicyAnswerAbstention(
        '새벽 배송은 서울에서만 됩니다. 다른 지역 확대 일정은 자료로 확인할 수 없어요.',
      ),
    ).toBe(false);
  });
});

describe('numericValues', () => {
  it('쉼표와 만·천 단위를 펴서 같은 값으로 본다', () => {
    expect(numericValues('3만 원')).toEqual(['30000']);
    expect(numericValues('30,000원')).toEqual(['30000']);
    expect(numericValues('2만 5천 원')).toEqual(['25000']);
    expect(numericValues('2.50% 와 07 일')).toEqual(['2.5', '7']);
  });

  it('영문 식별자에 붙은 숫자는 세지 않는다', () => {
    expect(numericValues('claim-3f2a 와 v2 를 본다')).toEqual([]);
  });
});

describe('ensureRequiredEvidenceDetails', () => {
  it('claim 이 정한 필수 상세가 빠지면 첫 항목 뒤에 넣는다', () => {
    const evidence = claimEvidence([
      {
        statement: '섬 지역은 일반 택배로만 보낸다.',
        requiredAnswerDetails: [
          { label: '새벽 배송이 안 되는 곳', items: ['울릉도', '백령도'] },
        ],
      },
    ]);

    const enriched = ensureRequiredEvidenceDetails({
      question: '섬에도 새벽 배송 돼요?',
      answer: '섬 지역은 일반 택배로 갑니다. 이틀쯤 더 걸립니다.',
      evidence,
    });

    expect(enriched).toBe(
      [
        '섬 지역은 일반 택배로 갑니다.',
        '새벽 배송이 안 되는 곳 울릉도, 백령도입니다.',
        '이틀쯤 더 걸립니다.',
      ].join('\n'),
    );
  });

  it.each([
    ['반품 조건 알려줘', false],
    ['반품 API 요청에 넣을 입력 데이터는?', true],
  ])('입력 데이터 상세는 기술 질문에만 붙인다: %s', (question, required) => {
    const evidence = claimEvidence([
      {
        statement: '반품 신청에는 주문 번호가 있어야 한다.',
        requiredAnswerDetails: [
          { label: '필수 입력 데이터', items: ['주문 번호', '반품 사유'] },
        ],
      },
    ]);

    const enriched = ensureRequiredEvidenceDetails({
      question,
      answer: '주문 번호로 반품을 신청합니다.',
      evidence,
    });

    expect(enriched.includes('필수 입력 데이터')).toBe(required);
  });

  it('비율 범위의 한쪽 끝만 남은 답은 근거의 범위로 되돌린다', () => {
    const evidence = claimEvidence([
      {
        statement: '실버 등급 할인율은 상품군에 따라 4%에서 9% 사이로 정한다.',
      },
    ]);

    expect(
      ensureRequiredEvidenceDetails({
        answer: '실버 등급 할인율은 9% 입니다.',
        evidence,
      }),
    ).toBe('실버 등급 할인율은 4%부터 9% 사이 입니다.');
  });

  it('숫자 조건을 뭉뚱그린 답에는 그 숫자가 든 claim 문장을 되살린다', () => {
    const evidence = claimEvidence([
      { statement: '구매 확정 금액의 3% 를 적립금으로 준다.' },
      {
        statement: '적립금은 적립일로부터 2 년 뒤 소멸한다.',
        facet: 'expiration',
      },
    ]);

    expect(
      ensureRequiredEvidenceDetails({
        answer: '적립금은 일정 기간이 지나면 소멸돼요.',
        evidence,
      }),
    ).toBe(
      '적립금은 일정 기간이 지나면 소멸돼요.\n적립금은 적립일로부터 2 년 뒤 소멸한다.',
    );
  });

  it('숫자를 이미 말했거나 뭉뚱그린 말이 없으면 답을 바꾸지 않는다', () => {
    const evidence = claimEvidence([
      { statement: '적립금은 적립일로부터 2 년 뒤 소멸한다.' },
    ]);

    for (const answer of [
      '적립금은 2 년이 지나면 소멸돼요.',
      '적립금은 쓰지 않으면 소멸돼요.',
      '쿠폰은 일정 금액 이상 주문에 써요.',
    ]) {
      expect(ensureRequiredEvidenceDetails({ answer, evidence })).toBe(answer);
    }
  });
});
