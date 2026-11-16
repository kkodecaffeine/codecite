import { describe, expect, it } from 'vitest';
import { createKnowledgeClaim } from '../domain/policy-claim.js';
import type { PolicyClaimProps } from '../domain/types.js';
import { POLICY_GROUP_SUMMARY_CLAIM_ID_PREFIX } from '../retrieval/constants.js';
import { POLICY_EVIDENCE_SEPARATOR } from './constants.js';
import {
  orderEvidenceSlots,
  packAnswerEvidence,
  packPolicyContext,
} from './context-packer.js';
import { serializePolicyEvidence } from './evidence.js';
import type { PolicyEvidence } from './types.js';

const evidence = (
  chunkId: string,
  text: string,
  overrides: Partial<PolicyEvidence> = {},
): PolicyEvidence => ({
  chunkId,
  policyCode: `DOTORI-${chunkId}`,
  section: '정책',
  internalSource: `shop/policies.csv#${chunkId}`,
  sourceLabel: 'policies.csv',
  text,
  ...overrides,
});

const claim = (
  claimId: string,
  statement: string,
  overrides: Partial<PolicyClaimProps> = {},
): PolicyClaimProps => ({
  claimId,
  facet: 'outcome',
  statement,
  confidence: 'high',
  provenanceChunkIds: [claimId],
  ...overrides,
});

const length = (value: string) => Array.from(value).length;

describe('packPolicyContext', () => {
  it('item 예산보다 큰 high claim 은 자르지 않고 근거째 뺀다', () => {
    const item = evidence('long-claim', '', {
      policyClaims: [claim('oversized', '배송 지역 목록 '.repeat(60))],
    });

    const packed = packPolicyContext('배송 지역', [item], {
      maxItemChars: 150,
      maxTotalChars: 600,
      maxItems: 3,
    });

    expect(packed.evidence).toEqual([]);
    expect(packed.oversizedClaimIds).toEqual(['oversized']);
    expect(packed.oversizedClaimCount).toBe(1);
    expect(packed.omittedHighConfidenceClaimIds).toEqual(['oversized']);
    expect(packed.omittedHighConfidenceClaimCount).toBe(1);
    expect(packed.omittedItemCount).toBe(1);
  });

  it('설명을 줄여야 하면 조건·예외 단위를 배경 설명보다 먼저 남긴다', () => {
    const lines = [
      '배경: 이 규정은 창고를 옮길 때 처음 만들었다.',
      '환불 조건: 상품을 받은 날부터 10 일 안에 신청해야 한다.',
      '예외로 각인을 새긴 맞춤 상품은 환불하지 않는다.',
    ];
    const item = evidence('refund-text', lines.join('\n'));
    const expected = { ...item, text: [lines[1], lines[2]].join('\n') };
    const budget = length(serializePolicyEvidence(expected));

    const packed = packPolicyContext('환불 가능한 기간', [item], {
      maxItemChars: budget,
      maxTotalChars: budget,
    });

    expect(packed.evidence[0].text).toBe(expected.text);
  });

  it('문장 안의 소수점은 문장 끝으로 보지 않는다', () => {
    const item = evidence(
      'rate',
      '골드 등급은 결제 금액의 2.5% 를 적립금으로 받는다. 실버 등급은 1% 를 받는다.',
    );

    const packed = packPolicyContext('골드 등급 적립', [item], {
      maxItemChars: 200,
      maxTotalChars: 200,
    });

    expect(packed.evidence[0].text).toContain(
      '골드 등급은 결제 금액의 2.5% 를 적립금으로 받는다.',
    );
  });

  it('번호 목록 줄은 번호만 남기지 않고 줄 전체를 한 단위로 둔다', () => {
    const item = evidence(
      'return-steps',
      ['[처리 순서]', '1. 반품 접수', '2. 택배 회수', '3. 검수 뒤 환불'].join(
        '\n',
      ),
    );

    const packed = packPolicyContext('반품 처리 순서', [item]);

    expect(packed.evidence[0].text).toBe(
      '[처리 순서]\n1. 반품 접수\n2. 택배 회수\n3. 검수 뒤 환불',
    );
  });

  it('기본 한도는 다섯 개, 전체 6500 자, 근거 하나 2200 자다', () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      evidence(`bulk-${index}`, `${'나'.repeat(1900)}.`),
    );

    const packed = packPolicyContext('정책', items);
    const serialized = packed.evidence.map((item) =>
      serializePolicyEvidence(item),
    );

    expect(packed.evidence).toHaveLength(3);
    expect(packed.omittedItemCount).toBe(5);
    expect(serialized.every((item) => length(item) <= 2200)).toBe(true);
    expect(
      serialized.reduce(
        (sum, item, index) =>
          sum +
          length(item) +
          (index > 0 ? length(POLICY_EVIDENCE_SEPARATOR) : 0),
        0,
      ),
    ).toBeLessThanOrEqual(6500);
  });

  it('같은 조각은 한 번만 묶고, 한 단위도 들어가지 않는 근거는 뺀다', () => {
    const tooLong = evidence(
      'same',
      '마침표 없이 길게 이어지는 설명 '.repeat(20),
    );
    const duplicate = evidence('same', '이 문장은 들어가면 안 된다.');

    const packed = packPolicyContext('설명', [tooLong, duplicate], {
      maxItemChars: 60,
      maxTotalChars: 60,
    });

    expect(packed.evidence).toEqual([]);
    expect(packed.omittedItemCount).toBe(1);
  });

  it('한도를 바꿀 수 있고 미완성 꼬리는 남기지 않는다', () => {
    const item = evidence(
      'coupon-text',
      '쿠폰은 주문 한 건에 한 장 쓴다. 다른 쿠폰과 겹쳐 쓸 수 없다. 끝맺지 않은 꼬리',
    );
    const expected = { ...item, text: '쿠폰은 주문 한 건에 한 장 쓴다.' };
    const budget = length(serializePolicyEvidence(expected));

    const packed = packPolicyContext('쿠폰 한 장', [item], {
      maxItemChars: budget,
      maxTotalChars: budget,
      maxItems: 1,
    });

    expect(packed.evidence[0].text).toBe(expected.text);
  });

  it('근거 글의 출처 줄은 묶지 않는다', () => {
    const item = evidence(
      'shipping-source',
      '결정: 오후 3 시 전에 결제하면 그날 출고한다.\n출처: /srv/shop/data/rules.csv#7',
    );

    const packed = packPolicyContext('출고', [item]);

    expect(packed.evidence[0].text).toContain('그날 출고한다.');
    expect(packed.evidence[0].text).not.toContain('/srv');
  });

  it('설명 글이 들어가지 않으면 claim 만 남긴다', () => {
    const item = evidence(
      'membership',
      '등급 산정 배경 설명이 길다. '.repeat(8),
      {
        policyClaims: [
          claim(
            'gold',
            '지난해 구매 금액이 50만 원 이상이면 골드 등급이 된다.',
            {
              facet: 'eligibility',
            },
          ),
        ],
      },
    );
    const claimOnly = { ...item, text: '' };
    const budget = length(serializePolicyEvidence(claimOnly)) + 5;

    const packed = packPolicyContext('골드 등급 조건', [item], {
      maxItemChars: budget,
      maxTotalChars: budget,
    });

    expect(packed.evidence[0].text).toBe('');
    expect(
      packed.evidence[0].policyClaims?.map((item) => item.claimId),
    ).toEqual(['gold']);
  });

  it('글자 수가 모자라면 claim 의 조건·예외·값은 지키고 설명을 줄인다', () => {
    const structured = createKnowledgeClaim({
      sourceKind: 'policy',
      subject: '단순 변심 환불',
      predicate: 'allows',
      value: '수령 후 10 일 이내',
      statement: '단순 변심 환불은 상품을 받고 10 일 안에 신청할 수 있다.',
      facet: 'duration',
      confidence: 'high',
      conditions: ['포장을 뜯지 않은 상품'],
      exceptions: ['각인을 새긴 맞춤 상품'],
      status: 'active',
      provenanceChunkIds: [],
      relations: [],
      provenance: [
        {
          sourceId: 'refund',
          sourceKind: 'policy',
          sourceLabel: '환불 규정',
          publicAnswerSafe: true,
        },
      ],
    });
    const background = `${'창고를 옮기던 해에 문의가 몰려 규칙을 다듬었다는 긴 사연 '.repeat(3).trim()}.`;
    const item = evidence(
      'refund-claim',
      [background, '반품 택배는 지정 택배사로만 보낸다.'].join('\n'),
      { policyClaims: [structured] },
    );
    const claimOnly = { ...item, text: '' };
    const budget =
      length(serializePolicyEvidence(claimOnly)) +
      length('반품 택배는 지정 택배사로만 보낸다.') +
      2;

    const packed = packPolicyContext('환불 신청 기간', [item], {
      maxItemChars: budget,
      maxTotalChars: budget,
    });
    const serialized = serializePolicyEvidence(packed.evidence[0]);

    expect(serialized).toContain('포장을 뜯지 않은 상품');
    expect(serialized).toContain('각인을 새긴 맞춤 상품');
    expect(serialized).toContain('수령 후 10 일 이내');
    expect(packed.evidence[0].text).toBe('반품 택배는 지정 택배사로만 보낸다.');
  });

  it('직렬화한 메타데이터와 구분선도 한도에 넣어 센다', () => {
    const first = evidence('meta-a', '첫째 근거 문장이다.', {
      section: '아주 긴 섹션 이름 '.repeat(5),
    });
    const second = evidence('meta-b', '둘째 근거 문장이다.');
    const firstLength = length(serializePolicyEvidence(first));
    const secondLength = length(serializePolicyEvidence(second));

    const tight = packPolicyContext('근거', [first, second], {
      maxTotalChars: firstLength + secondLength,
      maxItemChars: 500,
    });
    const roomy = packPolicyContext('근거', [first, second], {
      maxTotalChars:
        firstLength + secondLength + length(POLICY_EVIDENCE_SEPARATOR),
      maxItemChars: 500,
    });

    expect(tight.evidence).toHaveLength(1);
    expect(roomy.evidence).toHaveLength(2);
  });

  it('한 근거에 claim 이 여럿이면 질문이 원하는 종류의 claim 을 먼저 담는다', () => {
    const shipping = claim(
      'fee',
      '4만 원 미만 주문은 배송비 3000 원을 받는다.',
      {
        facet: 'amount',
      },
    );
    const dispatch = claim(
      'dispatch',
      '오후 3 시 전 결제 건은 그날 출고한다.',
      {
        facet: 'schedule',
      },
    );
    const item = evidence('shipping', '', {
      policyClaims: [shipping, dispatch],
    });
    const budget = length(
      serializePolicyEvidence({ ...item, policyClaims: [dispatch] }),
    );

    const packed = packPolicyContext('언제 출고돼요?', [item], {
      maxItemChars: budget,
      maxTotalChars: budget,
    });

    expect(
      packed.evidence[0].policyClaims?.map((item) => item.claimId),
    ).toEqual(['dispatch']);
    expect(packed.omittedHighConfidenceClaimIds).toEqual(['fee']);
  });

  it('한도를 넘는 묶음 요약 claim 은 질문에 맞는 완결 문장만 남겨 줄인다', () => {
    const summaryId = `${POLICY_GROUP_SUMMARY_CLAIM_ID_PREFIX}membership`;
    const goldSentence = '골드 등급은 무료 배송 쿠폰을 매달 두 장 받는다.';
    const summary = claim(
      summaryId,
      [
        '도토리 마켓 멤버십은 브론즈, 실버, 골드 세 단계로 나뉜다.',
        '단계는 해마다 첫날 지난해 구매 금액으로 다시 매긴다.',
        goldSentence,
        '실버 등급은 생일 달에 할인 쿠폰 한 장을 받는다.',
      ].join(' '),
    );
    const item = evidence('membership-summary', '', {
      policyClaims: [summary],
    });
    const budget =
      length(
        serializePolicyEvidence({
          ...item,
          policyClaims: [{ ...summary, statement: goldSentence }],
        }),
      ) + 4;

    const packed = packPolicyContext('골드 등급 혜택', [item], {
      maxItemChars: budget,
      maxTotalChars: budget,
    });

    expect(packed.evidence[0].policyClaims?.[0].statement).toBe(goldSentence);
    expect(packed.oversizedClaimIds).toEqual([summaryId]);
    expect(packed.omittedHighConfidenceClaimIds).toEqual([]);
  });

  it('묶음 요약 claim 만 담은 근거에는 설명 글을 다시 붙이지 않는다', () => {
    const item = evidence(
      'points-summary',
      '적립금 묶음 요약과 같은 설명이다.',
      {
        policyClaims: [
          claim(
            `${POLICY_GROUP_SUMMARY_CLAIM_ID_PREFIX}points`,
            '적립금은 구매 확정 때 쌓이고 2 년 뒤 소멸한다.',
          ),
        ],
      },
    );

    const packed = packPolicyContext('적립금', [item]);

    expect(packed.evidence[0].text).toBe('');
  });

  it('low claim 은 묶인 근거에 남기지 않는다', () => {
    const item = evidence('mixed', '', {
      policyClaims: [
        claim('sure', '리뷰를 쓰면 적립금 500 원을 준다.'),
        claim('unsure', '사진 리뷰는 더 줄 수도 있다.', { confidence: 'low' }),
      ],
    });

    const packed = packPolicyContext('리뷰 적립금', [item]);

    expect(
      packed.evidence[0].policyClaims?.map((item) => item.claimId),
    ).toEqual(['sure']);
  });
});

describe('orderEvidenceSlots', () => {
  it('질문 낱말을 가장 많이 덮는 기준 근거를 검색 순위와 상관없이 맨 앞에 둔다', () => {
    const ranked = [
      evidence('shipping', '', {
        policyGroup: 'shipping',
        policyClaims: [claim('free', '4만 원 이상 주문은 배송비가 무료다.')],
      }),
      evidence('points', '', {
        policyGroup: 'points',
        policyClaims: [claim('earn', '구매를 확정하면 적립금이 쌓인다.')],
      }),
      evidence('stacking', '', {
        policyGroup: 'coupon',
        policyClaims: [
          claim('stack', '쿠폰은 다른 쿠폰과 중복 사용할 수 없다.'),
        ],
      }),
    ];

    const ordered = orderEvidenceSlots('쿠폰 중복 사용 되나요?', ranked);

    expect(ordered.map((item) => item.chunkId)).toEqual([
      'stacking',
      'shipping',
      'points',
    ]);
  });

  it('한도·자격 질문은 기준 근거 뒤에 질문 낱말을 덮는 정책 근거를 더 둔다', () => {
    const ranked = [
      evidence('review', '', {
        policyGroup: 'points',
        policyClaims: [claim('review', '리뷰를 쓰면 적립금 500 원을 준다.')],
      }),
      evidence('coupon-expiry', '', {
        policyGroup: 'coupon',
        policyClaims: [claim('expiry', '쿠폰은 받은 날부터 14 일 안에 쓴다.')],
      }),
      evidence('coupon-limit', '', {
        policyGroup: 'coupon',
        policyClaims: [
          claim('limit', '쿠폰은 주문 한 건에 최대 한 장까지 쓸 수 있다.'),
        ],
      }),
    ];

    const ordered = orderEvidenceSlots('주문 한 건에 쿠폰 최대 몇 장?', ranked);

    expect(ordered.map((item) => item.chunkId)).toEqual([
      'coupon-limit',
      'coupon-expiry',
      'review',
    ]);
  });

  it('남은 자리는 한 묶음이 먼저 다 차지하지 못하게 다른 묶음에도 나눈다', () => {
    const ranked = [
      ...Array.from({ length: 5 }, (_, index) =>
        evidence(`points-${index}`, `적립금 설명 ${index}.`, {
          policyGroup: 'points',
        }),
      ),
      evidence('coupon-0', '쿠폰 설명.', { policyGroup: 'coupon' }),
      evidence('shipping-0', '배송 설명.', { policyGroup: 'shipping' }),
    ];

    const ordered = orderEvidenceSlots('혜택 정리', ranked, { maxItems: 5 });

    expect(ordered.slice(0, 5).map((item) => item.chunkId)).toEqual([
      'points-0',
      'points-1',
      'points-2',
      'coupon-0',
      'shipping-0',
    ]);
    expect(ordered.slice(5).map((item) => item.chunkId)).toEqual([
      'points-3',
      'points-4',
    ]);
  });

  it('다른 묶음이 없으면 한 묶음이 남은 자리를 모두 채운다', () => {
    const ranked = Array.from({ length: 6 }, (_, index) =>
      evidence(`points-${index}`, `적립금 설명 ${index}.`, {
        policyGroup: 'points',
      }),
    );

    const packed = packAnswerEvidence('혜택 정리', ranked);

    expect(packed.evidence.map((item) => item.chunkId)).toEqual([
      'points-0',
      'points-1',
      'points-2',
      'points-3',
      'points-4',
    ]);
  });

  it('한 조각 종류가 자리를 독점하지 않게 기술 조각에도 자리를 남긴다', () => {
    const ranked = [
      ...Array.from({ length: 4 }, (_, index) =>
        evidence(`policy-${index}`, `정책 설명 ${index}.`, {
          policyGroup: `group-${index}`,
        }),
      ),
      evidence('technical-0', '기술 설명.', {
        policyGroup: 'group-9',
        contextKind: 'technical',
      }),
    ];

    const ordered = orderEvidenceSlots('설명', ranked, {
      maxItems: 4,
    });

    expect(ordered.slice(0, 4).map((item) => item.chunkId)).toEqual([
      'policy-0',
      'policy-1',
      'policy-2',
      'technical-0',
    ]);
  });

  it('상한은 선택 사항으로 바꿀 수 있다', () => {
    const ranked = [
      evidence('a-0', '가.', { policyGroup: 'a' }),
      evidence('a-1', '나.', { policyGroup: 'a' }),
      evidence('b-0', '다.', { policyGroup: 'b' }),
    ];

    const ordered = orderEvidenceSlots('설명', ranked, {
      maxItems: 3,
      maxItemsPerGroup: 1,
    });

    expect(ordered.map((item) => item.chunkId)).toEqual(['a-0', 'b-0', 'a-1']);
  });
});

describe('packAnswerEvidence', () => {
  it('자리 순서를 정한 뒤 한도 안에서 묶는다', () => {
    const ranked = [
      evidence('shipping', '', {
        policyGroup: 'shipping',
        policyClaims: [claim('free', '4만 원 이상 주문은 배송비가 무료다.')],
      }),
      evidence('stacking', '', {
        policyGroup: 'coupon',
        policyClaims: [
          claim('stack', '쿠폰은 다른 쿠폰과 중복 사용할 수 없다.'),
        ],
      }),
    ];

    const packed = packAnswerEvidence('쿠폰 중복 사용 되나요?', ranked, {
      maxItems: 1,
    });

    expect(packed.evidence.map((item) => item.chunkId)).toEqual(['stacking']);
    expect(packed.omittedItemCount).toBe(1);
  });
});
