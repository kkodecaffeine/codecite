# 도토리 마켓 샘플

가상의 온라인 쇼핑몰 "도토리 마켓"의 정책 claim 과 골든 질문입니다. codecite 를 바로 돌려 보는 예제이자, CI 가 검색 품질을 재는 골든 평가 세트입니다. 회사 이름, 정책, 금액, 출처는 모두 지어낸 것이며 실제 서비스와 관계없습니다.

## 정책 묶음

| 묶음         | 주제        | 다루는 것                                                     | claim 수 |
| ------------ | ----------- | ------------------------------------------------------------- | -------- |
| `points`     | 적립금      | 적립률, 지급 시점, 사용 조건과 한도, 만료, 반환, 환불 시 회수 | 9        |
| `refund`     | 환불        | 신청 기간, 조건, 제외 상품, 반품 배송비, 환불 수단, 처리 순서 | 10       |
| `coupon`     | 쿠폰        | 발급, 최소 주문 금액, 중복 사용, 만료, 반환, 특가 제외, 등록  | 9        |
| `shipping`   | 배송        | 배송비, 무료 배송 기준, 출고 마감, 지연 보상, 도서 산간       | 9        |
| `membership` | 멤버십 등급 | 등급 기준, 산정 주기, 등급 할인, 무료 배송 혜택               | 8        |

일부러 가까운 개념을 함께 넣었습니다. 좋은 검색은 아래 줄마다 묶인 개념을 서로 섞지 않아야 합니다.

- 적립금 만료(적립일로부터 1 년), 쿠폰 만료(발급일로부터 30 일), 등급 쿠폰 만료(받은 달 말일)
- 등급 할인(골드 3%, VIP 5%)과 쿠폰 할인(등급 할인 뒤 금액에서 계산)
- 취소하면 돌려주는 적립금(쓴 적립금)과 환불하면 회수하는 적립금(받은 적립금)
- 무료 배송 기준(30,000 원 이상), VIP 무료 배송, 등급 혜택 무료 배송 쿠폰

## 파일

- `policies.csv`: 한 행이 claim 하나입니다. 열은 [설계 문서](../../docs/design/2026-11-16-v0.md#데이터-claim-csv)의 claim CSV 를 따릅니다. `claim_id` 를 비워 두었으므로 묶음·종류·문장으로 만든 내용 해시가 id 가 됩니다. `claim_conditions`, `claim_exceptions`, `user_question_examples`, `search_aliases` 처럼 값이 여러 개인 열은 `;` 로 나눕니다.
- `golden-questions.json`: 골든 질문 35 개입니다. 묶음마다 직접 묻는 질문, 다른 말로 바꾼 질문(포인트, 반품, 할인권, 택배비, 레벨), 조건·예외 질문, 말투가 섞인 질문을 두었습니다. 마지막 4 개는 데이터에 답이 없는 질문입니다.
- `baseline.json`: 골든 평가의 기준선입니다. 질문마다 hitAny, hitAll, status 가 맞았는지 적혀 있습니다. `codecite eval --write-baseline` 으로 만들고, 사람이 PR 로 검토해서만 바꿉니다.
- `codecite.config.json`: 소스 경로, 답변 모델, 동의어·질문 말투 낱말·묶음 별칭 설정입니다. API 키는 넣지 않습니다.

## 해 보기

CLI 는 현재 폴더의 `codecite.config.json` 을 읽으므로 이 폴더에서 실행합니다.

```bash
cd examples/dotori-market
npx codecite index
npx codecite ask "적립금은 언제 사라져요?"
```

`OPENAI_API_KEY` 가 없으면 답변 모델과 임베딩 없이 BM25 검색과 결정적 답변만으로 돕니다. 키를 쓰려면 `codecite.config.json` 의 `llm.model` 과 `embedding.model` 에 쓸 모델 이름을 적습니다. codecite 는 모델 기본값을 두지 않습니다. 그러면 하이브리드 검색과 답변 생성을 씁니다.

```bash
OPENAI_API_KEY=... npx codecite ask "VIP 등급이면 배송비 안 내도 돼?"
```

## 골든 평가

```bash
npx codecite eval
```

`eval` 은 모델을 부르지 않고, 질문마다 `expectedClaimIds` 의 claim 이 답변 모델에 넘길 근거에 들어갔는지(hitAny, hitAll) 잽니다. `expectedClaimIds` 가 비어 있고 `expectStatus` 가 `insufficient_evidence` 인 질문은 "근거 부족"으로 끝나야 맞습니다.

```json
{
  "id": "points-01",
  "question": "적립금은 언제 사라져요?",
  "expectedClaimIds": ["claim-8b2a9a4ce48882bc"]
}
```

결과는 `baseline.json` 과 질문별로 비교합니다. 기준선에서 맞던 항목(hitAny, hitAll, status)이 틀려지거나 기준선의 질문이 사라지면 회귀로 보고 종료 코드 1 로 끝납니다. 나아진 질문은 알리기만 하고 실패로 치지 않습니다. CI 는 `npm run eval` 로 PR 마다 이 검사를 돌립니다.

기대값은 내용 해시 id 이므로 claim 문장이나 종류를 고치면 id 가 바뀝니다. 그때는 골든 질문의 기대값도 함께 다시 봅니다. 골든 질문은 스크립트가 덮어쓰지 않고 사람이 PR 로만 고칩니다.

## 저장소 그래프 예제

`repos/` 에는 도토리 마켓의 가상 서비스 저장소 세 개가 있습니다. `codecite graph` 가 저장소 사이 관계를 어떻게 잇는지 보여 주는 예제이자, CI 의 그래프 회귀 검사 입력입니다.

| 저장소        | 기술                            | 담은 것                                                                    |
| ------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `shop-api`    | NestJS, TypeORM, GraphQL, Bull  | 주문·쿠폰·적립금 라우트, 주문 리졸버, 환불 큐, 쿠폰 만료 예약 작업, 엔티티 |
| `shop-web`    | Next.js, fetch, GraphQL codegen | 주문 취소·쿠폰 호출, 주문 조회 연산, 상태 확인 라우트                      |
| `shop-worker` | Python, Celery, requests        | 적립금 지급 작업과 shop-api 호출, 바깥 결제 대행사 호출                    |

일부러 넣은 못 잇는 경우는 다음과 같습니다.

- `getJson`: 주소를 인자로 받아 정적으로 읽을 수 없습니다(`dynamic-target`).
- `request_refund`: 바깥 결제 대행사 호출입니다(`external`).
- `check_status`: `/api/status` 를 shop-api 와 shop-web 이 모두 받아 하나로 정할 수 없습니다(`ambiguous-provider`).

```bash
# 저장소 루트에서
npm run build
npm run example:graph
```

`graph/prepare-repos.mjs` 는 `repos/*` 를 `.codecite/` 아래 git 원격과 클론으로 만듭니다. codecite 는 작업 트리가 아니라 원격 기본 브랜치의 커밋을 읽기 때문입니다. 커밋 시각과 작성자를 고정해 몇 번을 만들어도 같은 결과가 나옵니다. 기대 결과는 `graph/expected-links.json` 에 있습니다.
