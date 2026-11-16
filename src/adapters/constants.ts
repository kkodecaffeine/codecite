/** OpenAI 기본 주소. 모델 이름은 기본값을 두지 않고 쓰는 쪽이 정한다 */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** API 키를 옵션으로 주지 않으면 읽는 환경 변수 */
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';
/** 임베딩 요청 한 번에 보내는 글 수 */
export const OPENAI_EMBEDDING_BATCH_SIZE = 128;

/** Ollama 기본값. 로컬에서 도는 모델이라 OpenAI 보다 오래 기다린다. 모델 이름은 기본값을 두지 않는다 */
export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const OLLAMA_DEFAULT_TIMEOUT_MS = 120_000;

/** 모델 이름 없이 부를 때의 오류 문장. 앞에 제공자 이름을 붙여 쓴다 */
export const MISSING_CHAT_MODEL_MESSAGE =
  'chat model is not set: pass model (llm.model in codecite.config.json).';
export const MISSING_EMBEDDING_MODEL_MESSAGE =
  'embedding model is not set: pass embeddingModel (embedding.model in codecite.config.json).';
export const OLLAMA_EMBEDDING_BATCH_SIZE = 32;

/** 답변 모델 요청을 기다리는 시간과 답 길이 상한(토큰) */
export const LLM_DEFAULT_TIMEOUT_MS = 60_000;
export const LLM_DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

/** 오류 응답에서 꺼내 보여 줄 오류 코드 꼴. 메시지 본문은 키 일부를 되돌려 주는 서버가 있어 쓰지 않는다 */
export const HTTP_ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
/** 비밀값이 없는 로컬 서버의 오류 글을 보여 줄 때 자르는 길이 */
export const HTTP_ERROR_TEXT_MAX_CHARS = 200;

/** claim CSV 에 꼭 있어야 하는 열. 열이 없거나 행의 값이 비면 행 번호와 함께 실패한다 */
export const CLAIM_CSV_REQUIRED_COLUMNS = [
  'policy_group',
  'feature_name',
  'claim_statement',
] as const;

/** claim CSV 가 읽는 열. 여기에 없는 열은 무시한다 */
export const CLAIM_CSV_COLUMNS = [
  ...CLAIM_CSV_REQUIRED_COLUMNS,
  'claim_facet',
  'claim_id',
  'claim_confidence',
  'claim_conditions',
  'claim_exceptions',
  'claim_value',
  'user_question_examples',
  'search_aliases',
  'context_text',
  'source',
] as const;

/** `claim_confidence` 가 받는 값. 비우면 high 다 */
export const CLAIM_CSV_CONFIDENCES = ['high', 'low'] as const;

/**
 * CSV 한 행을 정책 글로 펼칠 때 쓰는 섹션 머리
 * 기능은 조각 머리에 함께 두는 섹션, 질문 예시·검색 표현은 검색 글에만 붙는 섹션이다(`domain/constants.ts`)
 */
export const CLAIM_CSV_HEADINGS = Object.freeze({
  conditions: '적용 조건',
  exceptions: '예외',
  value: '값',
  feature: '기능',
  questionExamples: '질문 예시',
  searchAliases: '검색 표현',
});

/** 색인 캐시 파일 위치(현재 폴더 기준)와 파일 형식 판. 형식이 바뀌면 판을 올려 예전 캐시를 버린다 */
export const DEFAULT_INDEX_CACHE_PATH = '.codecite/index.json';
export const INDEX_CACHE_FORMAT_VERSION = 1;
