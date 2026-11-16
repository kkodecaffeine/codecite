import { describe, expect, it } from 'vitest';
import {
  isDecisionCriterionQuestion,
  isPolicyDomainOverviewQuery,
  isUserActionEligibilityQuestion,
  mentionsNumericFigure,
  policyCoverageModeForQuery,
  policyRetrievalScopeForQuery,
  preferredPolicyClaimFacets,
} from './query-intent.js';

describe('policyRetrievalScopeForQuery', () => {
  it.each([
    '쿠폰 두 장 같이 써도 돼?',
    '교환 신청서 잘못 냈는데 고칠 수 있나',
    '',
  ])('보통 정책 질문은 정책 조각만 검색한다: %s', (query) => {
    expect(policyRetrievalScopeForQuery(query)).toEqual({
      intent: 'policy',
      contextKinds: ['policy'],
      coverageMode: 'focused',
    });
  });

  it.each([
    '반품 접수 엔드포인트 경로가 뭐였지',
    '결제 webhook 서명 검증은 어떻게 해?',
    '택배사 연동 오류 나면 어떻게 돼?',
    '주문 생성 payload 에 배송 메모도 들어가?',
    '정산 배치가 처리를 몇 시에 끝내?',
    '결제 실패 로그 확인은 어디서 해?',
    '재고 큐가 적재가 안 되면?',
    '상품 이미지 리사이즈 worker 는 몇 개 떠 있어?',
    '교환 접수 화면에서 어떤 정보를 입력해야 해?',
    '쿠폰 등록할 때 넣는 값은 무슨 형식이야?',
    '주문 취소 시 바뀌는 컬럼 목록 보여줘',
  ])('구현을 분명히 묻는 질문은 기술 조각도 연다: %s', (query) => {
    expect(policyRetrievalScopeForQuery(query)).toEqual({
      intent: 'technical',
      contextKinds: ['technical', 'policy'],
      coverageMode: expect.any(String),
    });
  });

  it.each([
    '실버 등급이면 혜택 좀 정리해 줘',
    '멤버십 혜택 종류 다 보여 줘',
    '반품 규정 전부 정리해 줄래',
    '적립금은 어떻게 얻는 거야',
    '교환 안 되는 경우 목록',
    '리뷰 쓰고 적립금 지급받으려면 뭘 해야 해',
    '친구 초대 적립금 받는 법',
    '구매 적립 안 되는 조건 정리',
    '배송 완료 후 적립 처리는 어떻게 하는 거야',
    '도토리 페이에 대해 소개해 줘',
    '새벽배송이 무엇인가요?',
    '도토리 마켓은 무슨 서비스?',
    '멤버십 라운지란?',
    '배송비 규정 아는 대로 다 알려 줘',
    '포장 옵션은 어떤 경우에 적용돼?',
    '배송비가 따로 요구되는 때가 언제야',
  ])('목록·개요를 묻는 질문을 가른다: %s', (query) => {
    expect(policyCoverageModeForQuery(query)).toBe('broad-list');
  });

  it.each([
    '배송비 쿠폰 할인액이 얼마지',
    '이번 달 사라지는 적립금 만료일이 언제지',
    '환불 웹훅 API 주소만 콕 집어 줘',
    '등급 나누는 기준이 구매액이야?',
    '제주 추가 배송비 붙는지는 무슨 값 보고 정해?',
    '반품 사유 분류는 어떻게 돼 있어',
    '환불 상태값은 언제쯤 바뀌어?',
  ])('한 가지 사실을 묻는 질문은 focused 로 둔다: %s', (query) => {
    expect(policyCoverageModeForQuery(query)).toBe('focused');
  });

  it.each([
    '적립금이랑 예치금 뭐가 달라? 비교 좀',
    '배송비 쿠폰이랑 무료배송 쿠폰이 같나요',
    '교환이랑 반품은 별개야?',
  ])('비교 질문은 따로 가른다: %s', (query) => {
    expect(policyCoverageModeForQuery(query)).toBe('comparison');
  });
});

describe('isPolicyDomainOverviewQuery', () => {
  it.each([
    '도토리 페이에 대해 소개해 줘',
    '새벽배송이 무엇인가요?',
    '도토리 마켓은 무슨 서비스?',
    '멤버십 라운지란?',
    '포장 서비스가 뭐야?',
  ])('대상 자체를 묻는 짧은 질문을 알아본다: %s', (query) => {
    expect(isPolicyDomainOverviewQuery(query)).toBe(true);
  });

  it.each([
    '등급 나누는 기준이 뭐야?',
    '교환 절차가 뭐야?',
    '반품 수거 기한이 뭐야?',
    '실버 등급 혜택이 뭐야?',
    '배송비 쿠폰 할인 금액이 뭐야?',
    '환불 예외에 대해 설명해 줘',
    '포인트 적립 시점이 뭐야?',
    '제주 추가 배송비 붙는지는 무슨 값 보고 정해?',
  ])('구체적인 사실을 묻는 질문은 개요 질문으로 보지 않는다: %s', (query) => {
    expect(isPolicyDomainOverviewQuery(query)).toBe(false);
  });
});

describe('preferredPolicyClaimFacets', () => {
  it.each([
    ['적립금이 안 들어왔는데 왜 그런 거야?', ['eligibility']],
    ['교환 배송비 얼마 내야 돼?', ['amount']],
    ['환불금은 언제 들어와?', ['schedule', 'duration']],
    ['포장 옵션은 어떤 경우에 적용돼?', ['eligibility']],
    ['배송비가 따로 요구되는 때가 언제야', ['eligibility']],
    ['오늘 주문하면 몇 시에 출고돼?', ['schedule', 'duration']],
    ['적립금은 바로 지급이야 아니면 다음날이야?', ['schedule', 'duration']],
    ['쿠폰 유효기간 지나면?', ['expiration']],
    ['주문 취소하면 적립금 빠져?', ['reversal']],
    ['멤버십 신청 방법', ['procedure']],
    ['배송 완료 후 적립 처리는 어떻게 하는 거야', ['eligibility']],
    ['친구 초대 적립금 받는 법', ['eligibility']],
    ['웰컴 쿠폰은 어떻게 받는 건데', ['eligibility']],
    ['등급 나누는 기준이 구매액이야?', ['eligibility']],
    ['제주 추가 배송비 붙는지는 무슨 값 보고 정해?', ['eligibility']],
    ['적립 조건 좀 봐 줘, 2만 원 넘게 사야 해?', ['eligibility', 'amount']],
    ['7천원 할인 쿠폰 진짜야?', ['amount']],
    ['리뷰 5번 쓰면 등급 올라가?', ['amount']],
  ])('%s', (query, primary) => {
    expect(preferredPolicyClaimFacets(query).primary).toEqual(primary);
  });
});

describe('isDecisionCriterionQuestion', () => {
  it.each([
    '등급 나누는 기준이 구매액이야?',
    '제주 추가 배송비 붙는지는 무슨 값 보고 정해?',
    '반품 사유 분류는 어떻게 돼 있어',
    '포장 옵션 값으로 뭐가 갈려?',
    '상품 문의 게시판에 댓글 남길 수 있나?',
  ])('판단 기준을 묻는 질문을 알아본다: %s', (query) => {
    expect(isDecisionCriterionQuestion(query)).toBe(true);
  });

  it.each([
    '멤버십 혜택 종류 다 보여 줘',
    '적립금은 바로 지급이야 아니면 다음날이야?',
    '정산 배치가 처리를 몇 시에 끝내?',
    '쿠폰함에 쿠폰 몇 장까지 쌓여?',
    '수신 동의 여부 바꾸면 쿠폰 사라져?',
    '해외 배송 가능 여부만 알려 줘',
    '비회원 주문 여부랑 상관없이 쿠폰 써져?',
    '등급 기준은 누가 정했어?',
  ])('한 가지 사실 질문을 판단 기준 질문으로 넓히지 않는다: %s', (query) => {
    expect(isDecisionCriterionQuestion(query)).toBe(false);
  });
});

describe('isUserActionEligibilityQuestion', () => {
  it('글·댓글을 쓰거나 올릴 수 있는지 묻는 질문만 알아본다', () => {
    expect(
      isUserActionEligibilityQuestion('상품 문의 게시판에 글 올릴 수 있어?'),
    ).toBe(true);
    expect(isUserActionEligibilityQuestion('리뷰 댓글은 언제 지워져?')).toBe(
      false,
    );
  });
});

describe('mentionsNumericFigure', () => {
  it('단위가 붙은 숫자만 숫자 기준으로 본다', () => {
    expect(mentionsNumericFigure('5,000원 이상 사면 적립돼?')).toBe(true);
    expect(mentionsNumericFigure('2주 지나면 반품 못 해?')).toBe(true);
    expect(mentionsNumericFigure('1만 원 쿠폰 있어?')).toBe(true);
    expect(mentionsNumericFigure('골드 2 등급이 뭐야?')).toBe(false);
  });
});
