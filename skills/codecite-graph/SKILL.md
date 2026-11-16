---
name: codecite-graph
description: 여러 저장소의 호출·큐·이벤트·데이터 관계 그래프를 codecite 로 만든다. 사용자가 저장소 목록을 주며 "그래프 만들어 줘", "서비스 간 호출 관계 정리해 줘", "어느 저장소가 이 API 를 부르는지", "이 필드를 누가 바꾸는지" 를 물을 때, 또는 codecite.graph.json 을 만들거나 고칠 때 쓴다.
---

# codecite 저장소 그래프 만들기

사용자가 준 저장소들로 저장소 간 호출(HTTP·GraphQL), 큐·이벤트 발행과 구독, 예약 작업, 엔티티 관계, 필드 쓰기 색인을 만든다. 연결을 정하는 것은 codecite 의 결정적 엔진이다. 에이전트는 설정을 쓰고, 엔진이 못 이은 빈칸을 코드에서 근거를 찾아 채운다.

## 지키는 것

- 원본 저장소는 읽기만 한다. codecite 는 원격 기본 브랜치의 고정 커밋을 임시 폴더에 꺼내 읽는다. 작업 트리를 고치거나 커밋하지 않는다.
- 비밀값(키, 토큰, 비밀번호, `.env` 값)을 설정·수동 연결·보고에 옮겨 적지 않는다.
- 추정한 연결을 확인된 것처럼 쓰지 않는다. 수동 연결에는 근거가 된 파일과 줄을 적는다.
- 결과 폴더(`.codecite/graph/`)의 파일을 손으로 고치지 않는다. 결과는 설정과 수동 연결로만 바꾼다.

## 준비

- Node 22.13 이상, `git`.
- codecite 를 설치한다(`npm i -D git+https://github.com/kkodecaffeine/codecite.git#v0.1.0`). TypeScript·JavaScript 저장소가 있으면 `typescript` 도 설치한다(`npm i -D typescript`).
- Python 저장소가 있으면 `python3` 이 있어야 한다.
- 저장소마다 읽기 권한이 있는 주소나 받아 둔 경로가 있어야 한다.

## 절차

### 1. 저장소 목록과 기본 브랜치 확인

사용자에게 받은 저장소마다 주소(또는 받아 둔 경로)와 기본 브랜치를 확인한다. 받아 둔 경로라면 `git -C <경로> fetch` 로 원격 추적 브랜치를 최신으로 맞춘다. 접근이 안 되는 저장소는 사용자에게 알리고 목록에서 뺀다.

### 2. 설정 뼈대 만들기

```bash
npx codecite graph init ../shop-api ../shop-web https://example.com/dotori-market/shop-worker.git
```

받아 둔 저장소는 `package.json`, `requirements.txt`, `pyproject.toml` 을 읽어 프리셋을 고른다. 주소만 준 저장소는 의존성을 못 읽으므로, 저장소의 의존성 파일을 직접 보고 `presets` 에 더한다.

| 의존성                                        | 프리셋                                        |
| --------------------------------------------- | --------------------------------------------- |
| `@nestjs/core`                                | `nestjs`                                      |
| `express`, `fastify`, `next`                  | `express`, `fastify`, `nextjs`                |
| `fastapi`, `flask`                            | `fastapi`, `flask`                            |
| 내장 `fetch`, `axios`                         | `fetch`, `axios`                              |
| `requests`, `httpx`                           | `python-requests`                             |
| `@graphql-codegen/cli`, `@apollo/client`      | `graphql-codegen`, `apollo-client`            |
| `typeorm`, `prisma`, `mongoose`, `sqlalchemy` | `typeorm`, `prisma`, `mongoose`, `sqlalchemy` |
| `node-cron`, `celery`                         | `node-cron`, `celery`                         |

### 3. 힌트 채우기

클라이언트 코드를 읽고 `hints` 를 채운다. 힌트가 없으면 엔진은 모든 저장소에서 후보를 찾고, 후보가 둘 이상이면 잇지 않는다.

- `baseUrls`: 호출 주소 앞부분에 쓰는 변수 이름 → 그 주소가 가리키는 저장소. 예: `{ "SHOP_API_URL": "shop-api" }`. 환경 변수 이름만 적고 값은 적지 않는다.
- `proxyPrefixes`: 앞단 프록시가 떼고 넘기는 경로 접두어 → 실제로 받는 저장소.
- `packages`: 공유 패키지 이름이나 범위 → 그 패키지를 내는 저장소.
- `graphqlSchemas`: GraphQL 스키마 이름 → 리졸버가 있는 저장소와 경로.
- `external`: 바깥 서비스의 호스트나 이름. 이 호출은 내부 처리기와 잇지 않는다.

프리셋이 모르는 자체 도구(큐 래퍼, 자체 데코레이터)는 `detectors` 규칙으로 더한다. 예: `{ "kind": "queue-publisher", "call": "orderQueue.send", "nameArgument": 0 }`.

### 4. 만들고 보고서 읽기

```bash
npx codecite graph build
npx codecite graph report
```

`build` 는 저장소마다 커밋, 심볼 수, 재사용 여부를 보인다. 심볼 수가 지난번의 절반 아래로 줄면 그 저장소에서 멈춘다. 경로·권한 설정이 맞는지 먼저 확인하고, 줄어든 까닭이 맞을 때만 `--accept-symbol-drop <이름>` 으로 다시 돌린다.

### 5. 못 이은 항목 처리

보고서의 항목마다 코드를 읽고 아래 가운데 하나를 고른다.

| 이유                 | 할 일                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------- |
| `no-provider`        | 받는 저장소가 목록에 없으면 더하고, 프레임워크 프리셋이 꺼져 있으면 켜고, 프록시면 힌트 |
| `ambiguous-provider` | `baseUrls` 힌트로 대상 저장소를 좁힌다                                                  |
| `dynamic-target`     | 호출하는 쪽을 따라가 대상이 하나로 정해지면 근거와 함께 수동 연결, 아니면 그대로 둔다   |
| `external`           | 할 일 없음                                                                              |
| `no-caller`          | 부르는 저장소가 목록에 없으면 더하고, 바깥 클라이언트가 부르면 그대로 둔다              |

수동 연결은 설정 `manualLinks` 가 가리키는 파일(예: `graph.links.json`)에 쓴다. `author` 는 `agent`, `evidence` 에는 근거가 된 파일과 줄을 한 문장으로 적는다.

### 6. 다시 만들고 검사

```bash
npx codecite graph build
npx codecite graph validate
```

`validate` 는 결과 파일이 계약 모양을 지키는지, 수동 연결의 양 끝 심볼이 실제로 있는지 본다. 실패하면 원인을 고치고 다시 돌린다.

### 7. 사용자에게 보고

- 저장소별 커밋과 심볼 수
- 처음 build 와 마지막 build 의 연결 수, 못 이은 항목 수
- 더한 힌트·규칙·수동 연결과 그 근거
- 그대로 둔 못 이은 항목과 이유

### 8. (선택) claim 초안

사용자가 원하면 그래프와 코드를 읽고 claim CSV 초안을 쓴다. `source` 에는 심볼 자리(`저장소 경로#심볼`)를 적고 `claim_confidence` 는 `low` 로 둔다. 초안은 사람이 검토한 뒤에 답변 엔진 색인에 넣는다.
