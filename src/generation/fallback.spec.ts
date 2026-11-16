import { describe, expect, it } from 'vitest';
import type { PolicyClaimProps } from '../domain/types.js';
import { POLICY_GROUP_SUMMARY_CLAIM_ID_PREFIX } from '../retrieval/constants.js';
import { NO_EVIDENCE_ANSWER, UNANSWERED_EVIDENCE_ANSWER } from './constants.js';
import { deterministicPolicyFallback } from './fallback.js';
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

describe('deterministicPolicyFallback', () => {
  it('근거가 없으면 근거를 찾지 못했다고만 답한다', () => {
    expect(
      deterministicPolicyFallback({
        question: '매장에서 직접 받아 갈 수 있어요?',
        evidence: [],
      }),
    ).toBe(NO_EVIDENCE_ANSWER);
  });

  it('질문이 원하는 종류의 claim 문장을 먼저 답한다', () => {
    const answer = deterministicPolicyFallback({
      question: '쿠폰 유효 기간 알려줘',
      evidence: [
        evidence('coupon', '', {
          policyClaims: [
            claim('use', '쿠폰은 주문 한 건에 한 장 쓴다.'),
            claim('expire', '쿠폰은 받은 날부터 14 일 뒤 사라진다.', {
              facet: 'expiration',
            }),
          ],
        }),
      ],
    });

    expect(answer).toBe(
      '• 쿠폰은 받은 날부터 14 일 뒤 사라진다.\n• 쿠폰은 주문 한 건에 한 장 쓴다.',
    );
  });

  it('묶음 요약 claim 은 문장으로 나눠 질문이 원하는 종류의 문장부터 답한다', () => {
    const answer = deterministicPolicyFallback({
      question: '실버 등급 조건이 뭐예요?',
      evidence: [
        evidence('membership', '', {
          policyClaims: [
            claim(
              `${POLICY_GROUP_SUMMARY_CLAIM_ID_PREFIX}membership`,
              [
                '멤버십 혜택은 등급마다 다르다.',
                '등급 계산은 내부 구현 모듈이 맡는다.',
                '적립금은 2 년 뒤 소멸한다.',
                '지난해 구매 금액이 20만 원 이상이면 실버 등급 대상이다.',
              ].join(' '),
            ),
          ],
        }),
      ],
    });

    expect(answer.split('\n')).toEqual([
      '• 지난해 구매 금액이 20만 원 이상이면 실버 등급 대상이다.',
      '• 멤버십 혜택은 등급마다 다르다.',
      '• 적립금은 2 년 뒤 소멸한다.',
    ]);
  });

  it('claim 이 없으면 근거 글의 완결 문장을 존댓말로 바꿔 항목 수 안에서 답한다', () => {
    const answer = deterministicPolicyFallback({
      question: '배송 규칙',
      evidence: [
        evidence(
          'shipping',
          [
            '결정: 4만 원 이상 주문은 배송비가 무료다.',
            '- 제주와 섬 지역은 추가 배송비가 붙는다.',
            '오후 3 시 전 결제 건은 그날 출고한다.',
            '새벽 배송은 서울에서만 된다.',
            '연휴에는 출고가 하루 늦어질 수 있다.',
          ].join('\n'),
        ),
      ],
    });

    expect(answer.split('\n')).toEqual([
      '• 4만 원 이상 주문은 배송비가 무료다.',
      '• 제주와 섬 지역은 추가 배송비가 붙는다.',
      '• 오후 3 시 전 결제 건은 그날 출고합니다.',
    ]);
    expect(answer).not.toContain('policies.csv');
  });

  it('구현 상세 claim 과 내부 색인 요약은 답으로 올리지 않는다', () => {
    const answer = deterministicPolicyFallback({
      question: '회원 등급은 어떻게 정해져요?',
      evidence: [
        evidence(
          'membership',
          '등급 계산은 내부 구현 모듈 세 곳이 나눠 맡는다.',
          {
            policyClaims: [
              claim('impl', '등급 코드가 3 이면 할인율 표를 다시 읽는다.', {
                knowledgeKind: 'implementation-detail',
              }),
              claim(
                'typed',
                'grade-rule 정책: tier 값이 2 보다 크면 할인한다.',
              ),
              claim('summary', '등급 표는 색인 메타 정보로만 남겨 둔다.'),
            ],
          },
        ),
      ],
    });

    expect(answer).toBe(UNANSWERED_EVIDENCE_ANSWER);
  });

  it('low claim 만 있으면 근거 글로 답한다', () => {
    const answer = deterministicPolicyFallback({
      question: '리뷰 적립금',
      evidence: [
        evidence('review', '사진 리뷰를 쓰면 적립금 700 원이 쌓인다.', {
          policyClaims: [
            claim('maybe', '동영상 리뷰는 더 받을 수도 있다.', {
              confidence: 'low',
            }),
          ],
        }),
      ],
    });

    expect(answer).toBe('사진 리뷰를 쓰면 적립금 700 원이 쌓인다.');
  });

  it('같은 문장은 한 번만 쓰고 상세 요청이면 항목을 더 남긴다', () => {
    const statements = Array.from(
      { length: 6 },
      (_, index) => `도토리 마켓 안내 문장 ${index + 1}.`,
    );
    const answer = deterministicPolicyFallback({
      question: '자세히',
      answerMode: 'detailed',
      evidence: [
        evidence('first', '', {
          policyClaims: statements.map((statement, index) =>
            claim(`c-${index}`, statement),
          ),
        }),
        evidence('copy', '', {
          policyClaims: [claim('dup', statements[0])],
        }),
      ],
    });

    expect(answer.split('\n')).toHaveLength(6);
  });

  it('결정적 답변도 공개 정보 정제를 거친다', () => {
    const answer = deterministicPolicyFallback({
      question: '포장 규칙',
      evidence: [
        evidence('packing', '', {
          policyClaims: [
            claim(
              'packing',
              '상자 포장 규칙은 `wrapPolicyTable`이 정하고 rules/packing.yml 에 적혀 있다.',
            ),
          ],
        }),
      ],
    });

    expect(answer).toBe(
      '상자 포장 규칙은 내부 항목이 정하고 [비공개 경로] 에 적혀 있다.',
    );
  });
});
