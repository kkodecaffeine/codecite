import { describe, expect, it } from 'vitest';
import type { PolicyEvidence } from '../generation/types.js';
import {
  DEFAULT_KOREAN_VOCABULARY,
  mergeVocabulary,
} from '../text/vocabulary.js';
import {
  deferredProcedureSection,
  procedureStatementSummary,
  questionAnchorTerms,
  selectAnchorPolicyEvidence,
  selectPolicyFirstEvidence,
  selectProcedurePolicyEvidence,
  withDeferredProcedureEvidence,
} from './anchor-evidence.js';

function evidence(
  chunkId: string,
  statement: string,
  options: {
    confidence?: 'high' | 'low';
    examples?: string[];
    aliases?: string[];
    subject?: string;
  } = {},
): PolicyEvidence {
  return {
    chunkId,
    policyCode: chunkId,
    section: chunkId,
    internalSource: `data/claims.csv#${chunkId}`,
    sourceLabel: 'claims.csv',
    text: statement,
    policyClaims: [
      {
        claimId: chunkId,
        facet: 'eligibility',
        statement,
        ...(options.subject ? { subject: options.subject } : {}),
        confidence: options.confidence ?? 'high',
        provenanceChunkIds: [chunkId],
        userQuestionExamples: options.examples ?? [],
        searchAliases: options.aliases ?? [],
      },
    ],
  };
}

const minOrder = evidence(
  'min-order',
  '라이브쇼핑 쿠폰은 결제 금액이 2만 원 미만이면 적용하지 않고 2만 원 이상이면 적용한다.',
  {
    examples: [
      '라이브쇼핑 쿠폰은 얼마부터 쓸 수 있어요?',
      '라이브쇼핑 쿠폰 최소 결제 금액이 얼마예요?',
    ],
    aliases: ['2만원', '최소 결제', '라이브쇼핑'],
  },
);
const chatLimit = evidence(
  'chat-limit',
  '라이브쇼핑 채팅은 한 번에 200 자까지 보낼 수 있다.',
  { examples: ['라이브쇼핑 채팅 글자 수 제한 있어요?'] },
);
const hiddenReplay = evidence(
  'replay-hidden',
  '라이브쇼핑 다시보기를 숨김 처리한다.',
  { examples: ['라이브쇼핑 다시보기는 왜 안 보여요?'] },
);

describe('questionAnchorTerms', () => {
  it('조사와 질문 말투를 뺀 내용 낱말만 남긴다', () => {
    expect(
      questionAnchorTerms('라이브쇼핑 쿠폰 최소금액이 얼마부터예요?'),
    ).toEqual(['라이브쇼핑', '쿠폰', '최소금액', '얼마부터예요']);
    expect(
      questionAnchorTerms('라이브쇼핑 쿠폰 1만원짜리 주문에도 돼?'),
    ).toEqual(['라이브쇼핑', '쿠폰', '1만원짜리', '주문에']);
  });

  it('서비스 사전의 질문 말투 낱말도 뺀다', () => {
    const vocabulary = mergeVocabulary(DEFAULT_KOREAN_VOCABULARY, {
      stopwords: ['궁금해요'],
    });
    expect(questionAnchorTerms('라이브쇼핑 궁금해요', vocabulary)).toEqual([
      '라이브쇼핑',
    ]);
    expect(questionAnchorTerms('라이브쇼핑 궁금해요')).toEqual([
      '라이브쇼핑',
      '궁금',
    ]);
  });
});

describe('selectAnchorPolicyEvidence', () => {
  it.each([
    '라이브쇼핑 쿠폰 최소금액이 얼마부터예요?',
    '라이브쇼핑 쿠폰 1만원짜리 주문에도 돼?',
    '라이브쇼핑 몇 만원부터 쿠폰 돼?',
    '라이브쇼핑 쿠폰 결제 제한 있어?',
    '라이브쇼핑은 결제가 얼마 이상이어야 쿠폰이 붙나요?',
  ])(
    '같은 기능 claim 가운데 질문 낱말을 가장 많이 덮는 것을 고른다: %s',
    (question) => {
      expect(
        selectAnchorPolicyEvidence(question, [
          hiddenReplay,
          chatLimit,
          minOrder,
        ]),
      ).toEqual([minOrder]);
    },
  );

  it('기능 이름만 겹치는 claim 은 기준 근거로 삼지 않는다', () => {
    expect(
      selectAnchorPolicyEvidence('라이브쇼핑 상품 품절이면 환불돼?', [
        hiddenReplay,
        minOrder,
      ]),
    ).toEqual([]);
  });

  it('신뢰도가 low 인 claim 은 고르지 않는다', () => {
    const low = evidence('low', minOrder.text, {
      confidence: 'low',
      aliases: ['2만원'],
    });
    expect(
      selectAnchorPolicyEvidence('라이브쇼핑 쿠폰 1만원짜리 주문에도 돼?', [
        low,
      ]),
    ).toEqual([]);
  });

  it('덮는 비율이 같으면 검색 순서를 따르고 최대 개수까지만 고른다', () => {
    const planA = evidence('plan-a', '포장 상자 크기 기준 A 안.');
    const planB = evidence('plan-b', '포장 상자 크기 기준 B 안.');
    expect(
      selectAnchorPolicyEvidence('포장 상자 기준', [planA, planB], 1),
    ).toEqual([planA]);
  });

  it('덮는 비율이 같으면 claim 주제가 질문 낱말을 담은 행을 본문에서 언급만 한 행보다 앞에 둔다', () => {
    const returnFee = evidence(
      'return-fee',
      '반품 배송비는 5,000 원이다. 교환 배송비와 달리 왕복이 아니다.',
      { subject: '반품 배송비 금액' },
    );
    const exchangeFee = evidence(
      'exchange-fee',
      '교환 배송비는 왕복 6,000 원이다.',
      { subject: '교환 배송비 금액' },
    );

    expect(
      selectAnchorPolicyEvidence('교환 배송비는?', [returnFee, exchangeFee]),
    ).toEqual([exchangeFee]);
  });
});

describe('selectPolicyFirstEvidence', () => {
  const unrelated = evidence('unrelated', '앱 첫 화면 배너 순서를 바꾼다.');

  it('기준 근거를 먼저 두고 질문 낱말을 하나라도 덮는 high claim 근거로 최대 개수까지 채운다', () => {
    expect(
      selectPolicyFirstEvidence('라이브쇼핑 쿠폰 최소금액이 얼마부터예요?', [
        hiddenReplay,
        unrelated,
        chatLimit,
        minOrder,
      ]).map((item) => item.chunkId),
    ).toEqual(['min-order', 'replay-hidden', 'chat-limit']);
  });

  it('기준 근거가 없어도 기능 이름을 덮는 high claim 근거는 검색 순서대로 고른다', () => {
    expect(
      selectPolicyFirstEvidence('라이브쇼핑 상품 품절이면 환불돼?', [
        unrelated,
        hiddenReplay,
        minOrder,
      ]).map((item) => item.chunkId),
    ).toEqual(['replay-hidden', 'min-order']);
  });

  it('low claim 과 질문 낱말을 하나도 덮지 않는 근거는 고르지 않고 개수 상한을 지킨다', () => {
    const low = evidence('low', '라이브쇼핑 임시 메모.', {
      confidence: 'low',
    });
    expect(
      selectPolicyFirstEvidence(
        '라이브쇼핑 쿠폰 최소금액이 얼마부터예요?',
        [low, unrelated, hiddenReplay, chatLimit, minOrder],
        2,
      ).map((item) => item.chunkId),
    ).toEqual(['min-order', 'replay-hidden']);
  });
});

describe('selectProcedurePolicyEvidence', () => {
  const procedure = (
    chunkId: string,
    statement: string,
    steps: string[],
    callees: string[] = [],
  ) =>
    ({
      ...evidence(chunkId, statement),
      text: [
        '[정책 안내]',
        statement,
        '[처리 순서]',
        ...steps.map((step, index) => `${index + 1}. ${step}`),
        ...(callees.length
          ? ['[이어지는 처리]', ...callees.map((callee) => `- ${callee}`)]
          : []),
      ].join('\n'),
    }) satisfies PolicyEvidence;

  it('처리 순서 섹션이 있는 행만 고르고, 흐름 낱말만 겹친 행은 고르지 않는다', () => {
    const selected = selectProcedurePolicyEvidence(
      '반품 접수되면 처리 순서가 어떻게 돼?',
      [
        evidence('plain-return', '반품 정책: 반품 안내.'),
        procedure('noise', '쿠폰 정책: 쿠폰 회수.', [
          '회수 처리',
          '처리 순서 남기기',
        ]),
        procedure('return-flow', '반품 정책: 반품 접수.', [
          '수거 기사 배정',
          '검수 뒤 환불 요청',
        ]),
      ],
    );

    expect(selected.map((item) => item.chunkId)).toEqual(['return-flow']);
  });

  it('다른 절차 행이 이어서 부르는 행은 그 행 뒤에 둔다', () => {
    const selected = selectProcedurePolicyEvidence('반품 절차 알려줘', [
      procedure('coupon-restore', '쿠폰 정책: 반품시 썼던 쿠폰 되살리기.', [
        '쓴 쿠폰 조회',
        '반품 주문 쿠폰 복구',
      ]),
      procedure(
        'return-flow',
        '반품 정책: 반품 접수.',
        ['수거 기사 배정', '반품 주문의 쿠폰 되살리기 요청'],
        ['반품시 썼던 쿠폰 되살리기'],
      ),
    ]);

    expect(selected.map((item) => item.chunkId)).toEqual([
      'return-flow',
      'coupon-restore',
    ]);
  });
});

describe('procedure sections', () => {
  const text = [
    '[정책 안내]',
    '주문 정책: 구매 확정 표시를 남긴다.',
    '[처리 순서]',
    '1. 확정 표시',
    '[나중에 이어지는 처리]',
    '- 정산 배치가 확정 표시를 읽는다',
  ].join('\n');

  it('정책 안내 첫 줄에서 "<주제> 정책:" 머리와 마침표를 뗀다', () => {
    expect(procedureStatementSummary(text)).toBe('구매 확정 표시를 남긴다');
    expect(procedureStatementSummary('안내 섹션이 없는 글')).toBe('');
  });

  it('나중에 이어지는 처리 섹션만 떼어 낸다', () => {
    expect(deferredProcedureSection(text).trim()).toBe(
      '- 정산 배치가 확정 표시를 읽는다',
    );
  });
});

describe('withDeferredProcedureEvidence', () => {
  const row = (
    chunkId: string,
    policyGroup: string,
    sections: string[],
  ): PolicyEvidence => ({
    ...evidence(chunkId, sections[1] ?? chunkId),
    policyGroup,
    text: sections.join('\n'),
  });
  const confirm = row('confirm', 'order', [
    '[정책 안내]',
    '주문 정책: 구매 확정.',
    '[처리 순서]',
    '1. 확정 표시 남기기',
    '[나중에 이어지는 처리]',
    '- 정산 배치가 읽는 조건: 확정된 주문 목록 조회',
    '- 정산 배치 시작: 매일 새벽 정산 진입점',
  ]);
  const couponLock = row('coupon-lock', 'coupon', [
    '[정책 안내]',
    '쿠폰 정책: 확정 주문 쿠폰 잠그기.',
    '[처리 순서]',
    '1. 쿠폰 잠금',
  ]);
  const settleStep = row('settle-step', 'settlement', [
    '[정책 안내]',
    '정산 정책: 판매자 금액 합산.',
    '[처리 순서]',
    '1. 판매자별 합계',
  ]);
  const targetQuery = row('target-query', 'settlement', [
    '[정책 안내]',
    '정산 정책: 확정된 주문 목록 조회.',
  ]);
  const batchEntry = row('batch-entry', 'settlement', [
    '[정책 안내]',
    '정산 정책: 매일 새벽 정산 진입점.',
    '[처리 순서]',
    '1. 같은 날 두 번 돌지 않게 막기',
  ]);

  it('요청 때 도는 행을 앞에, 나중에 도는 배치 진입·조회 행과 그 하위 단계 행을 뒤에 둔다', () => {
    const ordered = withDeferredProcedureEvidence(
      [settleStep, confirm, couponLock],
      [targetQuery, batchEntry],
    );

    expect(ordered.map((item) => item.chunkId)).toEqual([
      'confirm',
      'coupon-lock',
      'batch-entry',
      'target-query',
      'settle-step',
    ]);
  });

  it('나중 처리 섹션이 가리키는 행이 없으면 고른 순서를 그대로 둔다', () => {
    expect(
      withDeferredProcedureEvidence([settleStep, confirm], []).map(
        (item) => item.chunkId,
      ),
    ).toEqual(['settle-step', 'confirm']);
  });
});
