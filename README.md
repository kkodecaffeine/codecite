# codecite

정책 claim 을 근거로 질문에 답하고 답마다 출처를 붙이는 한국어 정책 에이전트입니다. 여러 저장소의 코드에서 호출·큐·데이터 관계 그래프를 만드는 도구도 함께 들어 있습니다.

- **답변 엔진**: claim CSV 를 색인해 질문에 답합니다. 근거가 없으면 지어내지 않고 "근거 부족"이라고 말합니다. 런타임 의존성이 없습니다.
- **저장소 그래프** (`codecite graph`): 저장소 목록만 주면 저장소 간 HTTP·GraphQL 호출, 큐·이벤트 발행과 구독, 예약 작업, 엔티티 관계, 필드 쓰기 색인을 만듭니다. 연결을 확신할 수 없으면 잇지 않고 이유와 함께 보고서에 남깁니다.

> 아직 0.x 입니다. 판이 오르면서 계약이 바뀔 수 있습니다.

## 30 초 만에 돌려 보기

Node.js 22.13 이상이 필요합니다.

```bash
git clone https://github.com/kkodecaffeine/codecite.git
cd codecite
npm ci && npm run build
cd examples/dotori-market
node ../../dist/cli.js ask "적립금은 언제 사라져요?"
```

예제는 가상의 온라인 쇼핑몰 "도토리 마켓"의 정책입니다. API 키가 없으면 답변 모델 없이 BM25 검색과 결정적 답변으로 돕니다.

## 설치

아직 npm 에 배포하지 않았습니다. GitHub 태그로 판을 고정해 설치합니다. 설치할 때 패키지가 스스로 빌드합니다.

```bash
npm i -D git+https://github.com/kkodecaffeine/codecite.git#v0.1.1
```

설치한 프로젝트 안에서는 아래 예시의 `npx codecite …` 가 그대로 돕니다. ESM 과 CommonJS(`require('codecite')`, `require('codecite/graph')`) 양쪽에서 불러올 수 있습니다.

## 답변 엔진

### 정책 데이터

한 행이 claim(정책 한 문장) 하나인 CSV 입니다. 꼭 필요한 열은 `policy_group`, `feature_name`, `claim_statement` 세 개입니다. 조건·예외·값, 사람들이 실제로 묻는 말, 출처 같은 열은 [v0 설계의 claim CSV 표](docs/design/2026-11-16-v0.md#데이터-claim-csv)에 있습니다. 예제는 [`examples/dotori-market/policies.csv`](examples/dotori-market/policies.csv)입니다.

### 설정: `codecite.config.json`

```json
{
  "source": { "type": "csv", "path": "policies.csv" },
  "llm": { "provider": "openai", "model": "<답변 모델 이름>" },
  "embedding": { "provider": "openai", "model": "<임베딩 모델 이름>" },
  "index": { "path": ".codecite/index.json" },
  "vocabulary": {
    "synonyms": { "적립금": ["포인트"] },
    "groupAliases": { "points": ["적립금", "포인트"] }
  }
}
```

- API 키는 설정 파일에 쓰지 않고 `OPENAI_API_KEY` 환경 변수로만 받습니다. `provider` 는 `openai` 와 `ollama` 를 받습니다.
- 모델 이름은 기본값이 없습니다. 제공자를 정했으면 `model` 도 적어야 합니다.
- `llm`·`embedding` 을 빼거나 키가 없으면 BM25 검색과 결정적 답변으로 돕니다.
- 서비스마다 다른 말(동의어, 묶음 별칭)은 `vocabulary` 에만 둡니다.

### CLI

```bash
npx codecite index                 # CSV 를 읽어 색인을 만든다. 내용과 모델이 같으면 다시 임베딩하지 않는다
npx codecite ask "환불은 며칠 걸려요?"
npx codecite ask "환불은 며칠 걸려요?" --json   # 상태, 답, 인용, 추적 정보를 JSON 으로
npx codecite eval                  # 골든 질문을 모델 없이 돌려 기준선과 비교한다. 회귀가 있으면 종료 코드 1
npx codecite serve --port 3000     # POST /ask { "question": "..." }, GET /health
```

CLI 는 현재 폴더(또는 `--cwd`)의 `codecite.config.json` 을 읽습니다.

### 라이브러리

```ts
import { createCodecite, csvPolicySource, openAiClient } from 'codecite';

const openai = openAiClient({
  apiKey: process.env.OPENAI_API_KEY,
  model: '<답변 모델 이름>',
  embeddingModel: '<임베딩 모델 이름>',
});
const codecite = await createCodecite({
  source: csvPolicySource({ path: 'policies.csv' }),
  llm: openai,
  embedder: openai.embedder(),
});

const result = await codecite.ask('적립금은 언제 사라져요?');
// result.status: 'answered' | 'insufficient_evidence'
// result.answer: 바로 보여 줄 문장
// result.citations: 답에 쓰인 claim(id, 문장, 출처)
```

`llm` 을 빼면 결정적 답변을, `embedder` 를 빼면 BM25 만 씁니다. 정책 소스, 벡터 색인, 모델은 `src/ports.ts` 의 인터페이스로 바꿔 끼울 수 있습니다.

## 내 저장소로 그래프 만들기

### 준비

- `git` 과 저장소 읽기 권한.
- TypeScript·JavaScript 저장소가 있으면 [설치](#설치)한 codecite 옆에 `typescript` 도 설치합니다: `npm i -D typescript`.
- Python 저장소가 있으면 `python3` 이 `PATH` 에 있어야 합니다.

codecite 는 개발자의 작업 트리를 읽지 않습니다. 저장소마다 원격 기본 브랜치의 끝 커밋을 임시 폴더에 따로 꺼내 읽고, 원본 저장소에는 아무것도 쓰지 않습니다. `.env*`, `*.csv*`, 비밀 키 파일은 설정과 상관없이 늘 뺍니다. 코드 안의 비밀값 모양 리터럴은 저장하기 전에 가립니다.

### 1. 설정 만들기

```bash
npx codecite graph init ../shop-api ../shop-web https://example.com/dotori-market/shop-worker.git
```

받아 둔 경로나 git 주소를 줍니다. 받아 둔 저장소는 `package.json`·`requirements.txt`·`pyproject.toml` 을 읽어 프리셋을 고릅니다. 결과는 `codecite.graph.json` 입니다.

```json
{
  "repositories": [
    { "name": "shop-api", "path": "../shop-api" },
    { "name": "shop-web", "path": "../shop-web" },
    {
      "name": "shop-worker",
      "url": "https://example.com/dotori-market/shop-worker.git"
    }
  ],
  "presets": ["fetch", "graphql-codegen", "nestjs", "nextjs", "typeorm"],
  "hints": {
    "baseUrls": { "SHOP_API_URL": "shop-api" },
    "external": ["pay.example.com"]
  }
}
```

### 2. 프리셋과 힌트

| 프리셋                                        | 찾는 것                                                              |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `nestjs`                                      | 라우트(전역 접두어·RouterModule 포함), 리졸버, 큐, 이벤트, 예약 작업 |
| `express`, `fastify`, `nextjs`                | 라우트와 라우터 마운트 접두어, 파일 경로 라우트                      |
| `fastapi`, `flask`                            | 데코레이터 라우트와 라우터·블루프린트 접두어                         |
| `fetch`, `axios`, `python-requests`           | HTTP 호출                                                            |
| `graphql-codegen`, `apollo-client`            | 클라이언트 연산 → 루트 필드 → 리졸버                                 |
| `typeorm`, `prisma`, `mongoose`, `sqlalchemy` | 엔티티·컬럼·관계 선언, 읽기·쓰기, 필드 쓰기                          |
| `node-cron`, `celery`                         | 예약 작업, 작업 발행과 소비                                          |

힌트는 회사마다 다른 규칙을 코드가 아니라 설정으로 알려 주는 자리입니다.

| 힌트             | 뜻                                                     |
| ---------------- | ------------------------------------------------------ |
| `baseUrls`       | 호출 주소 앞부분 변수 이름 → 그 주소가 가리키는 저장소 |
| `proxyPrefixes`  | 앞단 프록시가 떼고 넘기는 경로 접두어 → 받는 저장소    |
| `packages`       | 공유 패키지 이름이나 범위 → 그 패키지를 내는 저장소    |
| `graphqlSchemas` | GraphQL 스키마 이름 → 리졸버가 있는 저장소와 경로      |
| `external`       | 바깥 서비스 호스트. 이 호출은 내부 처리기와 잇지 않음  |

프리셋이 모르는 자체 도구(큐 래퍼, 자체 데코레이터)는 `detectors` 규칙으로 더합니다. 예: `{ "kind": "queue-publisher", "call": "orderQueue.send", "nameArgument": 0 }`. 설정 항목 전체는 [그래프 설계](docs/design/2026-11-16-graph.md#설정-codecitegraphjson)에 있습니다.

### 3. 만들고 보고서 읽기

```bash
npx codecite graph build      # 스냅샷 → 추출 → 탐지 → 연결 → 결과 파일
npx codecite graph report     # 못 이은 항목과 이유
```

결과는 `.codecite/graph/` 에 씁니다.

| 파일                     | 내용                                           |
| ------------------------ | ---------------------------------------------- |
| `manifest.json`          | 저장소별 커밋·시각, 설정 지문, 도구 판         |
| `symbols/<저장소>.jsonl` | 심볼 레코드(실행 사실 포함), 한 줄에 하나      |
| `detections.json`        | 저장소별 탐지 결과(라우트·호출·큐·예약·엔티티) |
| `topology.json`          | 저장소 안 구조와 호출                          |
| `cross-repository.json`  | 저장소 간 연결과 커버리지                      |
| `entities.json`          | 테이블·컬럼·관계                               |
| `field-writers.json`     | `저장소:필드` → 그 필드를 바꾸는 심볼과 조건   |
| `report.json`            | 못 이은 항목과 이유                            |

같은 커밋과 같은 설정이면 결과 파일이 바이트 단위로 같습니다. 커밋과 입력이 그대로인 저장소는 지난 결과를 재사용합니다. 저장소의 심볼 수가 지난번의 절반 아래로 줄면 경로·권한 문제로 보고 멈춥니다.

### 4. 못 이은 항목 채우기

| 이유                 | 할 일                                         |
| -------------------- | --------------------------------------------- |
| `no-provider`        | 받는 저장소 등록, 프리셋 켜기, 프록시 힌트    |
| `ambiguous-provider` | `baseUrls` 힌트로 대상 저장소 좁히기          |
| `dynamic-target`     | 근거 있는 수동 연결, 또는 그대로 둠           |
| `external`           | 없음                                          |
| `no-caller`          | 부르는 저장소 등록, 또는 바깥 클라이언트로 둠 |

수동 연결은 설정의 `manualLinks` 가 가리키는 파일에 근거 문장과 함께 적습니다. 결정적 연결과 따로 표시됩니다.

### 5. 검사

```bash
npx codecite graph validate
```

결과 파일의 모양, 참조(연결 끝·수동 연결·필드 쓰기)가 실제 심볼을 가리키는지, 정렬 순서, 절대 경로와 비밀값이 없는지 봅니다. 오류가 있으면 종료 코드 1 입니다.

### AI 코딩 에이전트에게 맡기기

[`skills/codecite-graph/SKILL.md`](skills/codecite-graph/SKILL.md) 는 에이전트가 따라 하는 절차서입니다. Claude Code 라면 이 폴더를 `.claude/skills/` 아래에 두고 "이 저장소들로 그래프 만들어 줘"라고 하면 됩니다. 다른 에이전트도 평문 절차서로 읽을 수 있습니다. 에이전트는 설정을 쓰고, build 를 돌리고, 보고서의 빈칸을 코드에서 근거를 찾아 채운 뒤 validate 로 마무리합니다. 연결을 정하는 것은 결정적 엔진이고, 에이전트는 엔진이 못 잡은 빈칸만 근거와 함께 채웁니다.

### 라이브러리

```ts
import { buildCodeGraph, loadGraphConfig } from 'codecite/graph';

const config = await loadGraphConfig(process.cwd());
const result = await buildCodeGraph(config);
```

그래프는 `codecite/graph` 진입점으로 따로 냅니다. 답변 엔진만 불러오는 쪽은 `typescript` 를 읽지 않습니다. 자체 추출기(`extractorModules`)와 프리셋(`presetModules`)을 모듈 경로로 더할 수 있습니다.

### 예제

[`examples/dotori-market/repos/`](examples/dotori-market/repos/) 에 API 서버(NestJS·TypeORM), 웹(Next.js·fetch·GraphQL), 작업자(Python·Celery·requests) 세 저장소가 있습니다. 일부러 못 잇는 경우(동적 주소, 바깥 결제 서비스, 후보가 여럿인 경로)도 넣었습니다.

```bash
npm ci && npm run build
npm run example:graph   # 예제를 git 저장소로 만들고 build → report
```

CI 는 이 예제로 그래프를 처음부터 두 번 만들어, [`expected-links.json`](examples/dotori-market/graph/expected-links.json)의 연결·못 이은 항목·엔티티·필드 쓰기와 같은지, 두 결과가 바이트 단위로 같은지 봅니다.

## 문서

- [아키텍처와 원칙](docs/architecture.md): 근거 원칙, claim 중심 지식, 검색, 답변 계약, 안전
- [v0 설계](docs/design/2026-11-16-v0.md): 답변 엔진의 모듈, 설정, 확장 계약, 로드맵
- [그래프 설계](docs/design/2026-11-16-graph.md): 저장소 그래프의 파이프라인, 결과 파일, 보고서
- [기여 안내](CONTRIBUTING.md), [보안 정책](SECURITY.md)

## 라이선스

[Apache License 2.0](LICENSE)
