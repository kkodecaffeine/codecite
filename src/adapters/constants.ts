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
