import { describe, expect, it } from 'vitest';
import { sanitizePublicPolicyAnswer } from './public-answer-sanitizer.js';

describe('sanitizePublicPolicyAnswer 파일 경로', () => {
  it('장비 절대 경로와 저장소 안 소스 경로를 줄 번호까지 가린다', () => {
    const answer = sanitizePublicPolicyAnswer(
      '적립 규칙은 /home/deploy/shop/points.ts 와 apps/api/src/points/earn-rule.ts:42 에 있어요.',
    );

    expect(answer).toBe(
      '적립 규칙은 [비공개 경로] 와 [비공개 경로] 에 있어요.',
    );
  });

  it('폴더 없는 소스 파일 이름과 .env 도 가리되 제품 이름과 데이터 파일 이름은 둔다', () => {
    expect(
      sanitizePublicPolicyAnswer(
        'couponRules.kt 와 .env.local 값을 읽고, Node.js 로 돌며 policies.csv 를 씁니다.',
      ),
    ).toBe(
      '[비공개 파일] 와 [비공개 파일] 값을 읽고, Node.js 로 돌며 policies.csv 를 씁니다.',
    );
  });

  it('API 경로와 공개 주소는 남긴다', () => {
    const answer =
      '반품은 POST /v1/returns 로 접수하고 안내는 https://dotori.example/help/return 에 있어요.';

    expect(sanitizePublicPolicyAnswer(answer)).toBe(answer);
  });
});

describe('sanitizePublicPolicyAnswer 내부 식별자', () => {
  it('데코레이터·함수 호출·Type.member 는 역할 낱말로 바꾸고 조사를 맞춘다', () => {
    expect(
      sanitizePublicPolicyAnswer(
        '@Cron(매일) 작업이 calcShippingFee()를 부르고 ShippingFeeTable.lookup이 금액을 정합니다.',
      ),
    ).toBe(
      '내부 구현 항목 작업이 내부 처리를 부르고 내부 처리가 금액을 정합니다.',
    );
  });

  it('구현 타입 이름은 백틱이 없어도 가리고 Date.now 같은 표준 이름은 둔다', () => {
    expect(
      sanitizePublicPolicyAnswer(
        'CouponIssueService는 Date.now 기준으로 쿠폰을 발급하고 `RefundHandler`가 환불을 맡습니다.',
      ),
    ).toBe(
      '내부 구현 항목은 Date.now 기준으로 쿠폰을 발급하고 내부 처리가 환불을 맡습니다.',
    );
  });

  it('백틱 식별자는 용어집 이름이나 역할 낱말로 바꾸고, 대문자 코드 값과 소문자 낱말은 백틱만 뗀다', () => {
    expect(
      sanitizePublicPolicyAnswer(
        '`expireAt`이 지나면 소멸하고 `pointBalance`와 함께 봅니다. 등급은 `VIP`, `gold` 로 나뉩니다.',
        { identifierGlossary: { expireAt: '만료 시각' } },
      ),
    ).toBe(
      '만료 시각이 지나면 소멸하고 내부 항목과 함께 봅니다. 등급은 VIP, gold 로 나뉩니다.',
    );
  });

  it('값이 붙은 백틱 식별자는 상태 문장으로 푼다', () => {
    expect(
      sanitizePublicPolicyAnswer(
        '`couponLocked=true` 면 못 쓰고 `memoText=null` 이면 메모를 비웁니다.',
      ),
    ).toBe(
      '내부 항목이 켜진 상태 면 못 쓰고 내부 항목이 비어 있는 상태 이면 메모를 비웁니다.',
    );
  });
});

describe('sanitizePublicPolicyAnswer 프롬프트 문구', () => {
  it('경계 태그, 지시문 자리 표시, claim id 를 지운다', () => {
    expect(
      sanitizePublicPolicyAnswer(
        '<근거>교환은 7 일 안에 됩니다 (claim-0a1b2c3d4e5f6a7b).</근거> [지시문 제거]',
      ),
    ).toBe('교환은 7 일 안에 됩니다.');
  });

  it('답변 형식 라벨과 말투 예시를 옮겨 적은 부분을 지우고 목록 줄은 둔다', () => {
    expect(
      sanitizePublicPolicyAnswer(
        '첫 번째 문장: 쿠폰은 한 장만 씁니다.\n• 마지막 문장: 다른 쿠폰과 겹쳐 쓸 수 없습니다. "~합니다"',
      ),
    ).toBe('쿠폰은 한 장만 씁니다.\n• 다른 쿠폰과 겹쳐 쓸 수 없습니다.');
  });

  it('지운 자리의 공백은 정리하되 답변 항목 줄은 합치지 않는다', () => {
    expect(
      sanitizePublicPolicyAnswer(
        '• 배송은 이틀 걸립니다.  \n• 제주는 하루 더 걸립니다 .',
      ),
    ).toBe('• 배송은 이틀 걸립니다.\n• 제주는 하루 더 걸립니다.');
  });
});
