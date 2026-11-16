import type { PolicyClaimFacet, PolicyClaimProps } from '../domain/types.js';

/**
 * 설명과 claim 문장에서 claim 종류(facet)를 추론한다. 앞의 규칙이 먼저 이긴다
 * 만료 → 되돌림 → 시점 → 기간 → 자격 → 금액 → 예외 → 절차 순서로 보고, 어디에도 맞지 않으면 첫 claim 의 종류나 outcome 을 쓴다
 */
export function inferPolicyFacet(
  description: string,
  claims: readonly Pick<
    PolicyClaimProps,
    'statement' | 'predicate' | 'facet'
  >[] = [],
): PolicyClaimFacet {
  const text =
    `${description} ${claims.map((claim) => claim.statement).join(' ')}`.toLowerCase();
  if (/(만료|소멸|유효\s*기간)/u.test(text)) {
    return 'expiration';
  }
  if (/(취소|환불|회수|차감|되돌)/u.test(text)) {
    return 'reversal';
  }
  if (
    /(일정|주기|스케줄|매일|매주|매월|자정|실행\s*시점|(?:익일|다음\s*날|전날|즉시).{0,40}(?:지급|적립|리포트|배치|등록)|(?:지급|적립).{0,20}(?:익일|다음\s*날|전날|즉시))/u.test(
      text,
    )
  ) {
    return 'schedule';
  }
  if (/(기간|며칠|시간|ttl)/u.test(text)) {
    return 'duration';
  }
  if (/(대상|자격|조건|가능|검증|확인|선정|고른)/u.test(text)) {
    return 'eligibility';
  }
  if (/(금액|비율|퍼센트|한도|최대|최소|수량|잔액|포인트)/u.test(text)) {
    return 'amount';
  }
  if (
    /(실패|예외|오류|거부|불가|제외|없으면|중복)/u.test(text) ||
    claims.some((claim) => claim.predicate === 'throws')
  ) {
    return 'exception';
  }
  if (/(방법|절차|처리|생성|조회|저장|전송|발행|등록|수정|삭제)/u.test(text)) {
    return 'procedure';
  }
  return claims[0]?.facet ?? 'outcome';
}
