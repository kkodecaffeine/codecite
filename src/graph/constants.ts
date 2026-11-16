import type { FileSkipCounts } from './types.js';

// ── 파일 고르기 ──

/**
 * 바닥 규칙. 설정과 상관없이 늘 빼고, 끌 수 없다. 경로의 어느 조각(폴더·파일 이름)에든 대소문자 없이 맞춘다
 * 환경 설정과 CSV 데이터는 경로나 확장자 문맥과 상관없이 넣지 않는다. 비밀값이 든 파일과 의존성 폴더도 뺀다
 */
export const GRAPH_FLOOR_EXCLUDES: readonly string[] = [
  '.env*',
  '*.env*',
  '*.csv*',
  '.git',
  'node_modules',
  '.venv',
  '__pycache__',
  '.ssh',
  '.gnupg',
  '*secret*',
  '*credential*',
  '*private-key*',
  '*private_key*',
  '*privatekey*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.ppk',
  '*.tfstate*',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  '.htpasswd',
];

/** 기본 제외. 정책 근거가 아닌 테스트·예제·마이그레이션을 뺀다. 설정 `defaultExcludes` 로 바꾸거나 끈다 */
export const GRAPH_DEFAULT_EXCLUDES: readonly string[] = [
  '**/*.spec.*',
  '**/*.test.*',
  '**/*.e2e-spec.*',
  '**/*_test.*',
  '**/test_*.py',
  '**/conftest.py',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/__snapshots__/**',
  '**/__fixtures__/**',
  '**/fixtures/**',
  '**/test/**',
  '**/tests/**',
  '**/e2e/**',
  '**/example/**',
  '**/examples/**',
  '**/migration/**',
  '**/migrations/**',
];

/** 이보다 큰 파일은 묶어 낸 결과물이나 만들어 낸 코드로 보고 읽지 않는다 */
export const GRAPH_MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
/** 글 파일인지 볼 때 NUL 바이트를 찾는 앞부분 길이 */
export const GRAPH_BINARY_PROBE_BYTES = 8000;

export const EMPTY_FILE_SKIP_COUNTS: Readonly<FileSkipCounts> = {
  floor: 0,
  defaultExcludes: 0,
  exclude: 0,
  notIncluded: 0,
  unsupported: 0,
  binary: 0,
  tooLarge: 0,
};

// ── 비밀값 가리기 ──

export const REDACTED_VALUE = '[REDACTED]';
export const REDACTED_PRIVATE_KEY = '[REDACTED PRIVATE KEY]';
export const REDACTED_TOKEN = '[REDACTED TOKEN]';

/**
 * 이름의 마지막 낱말이 이것이면 비밀값 이름으로 본다. 이름은 낙타 표기·밑줄·하이픈으로 낱말을 나눈다
 * 마지막 낱말만 보므로 passwordHint·tokenType 처럼 비밀값을 설명하는 이름의 값(안내 문구, 종류)은 남는다
 */
export const SECRET_NAME_LAST_WORDS: readonly string[] = [
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'secret',
  'token',
  'credential',
  'credentials',
  'authorization',
  'apikey',
  'accesskey',
  'privatekey',
  'secretkey',
];
/** 마지막 두 낱말이 이것이면 비밀값 이름으로 본다 */
export const SECRET_NAME_LAST_PAIRS: readonly string[] = [
  'api key',
  'access key',
  'private key',
  'secret key',
  'signing key',
  'encryption key',
  'master key',
];
/** 마지막 낱말이 이것이면 값이 무작위 문자열처럼 보일 때만 가린다(캐시 키 이름 같은 평범한 값은 남긴다) */
export const CREDENTIAL_NAME_LAST_WORDS: readonly string[] = [
  'key',
  'iv',
  'salt',
  'nonce',
];
/** 이름과 상관없이 무작위 문자열로 볼 최소 길이와 글자당 엔트로피(비트) */
export const RANDOM_LITERAL_MIN_LENGTH = 32;
export const RANDOM_LITERAL_MIN_ENTROPY = 4;
/** 이름이 비밀값을 가리킬 때 무작위 문자열로 볼 최소 길이(16 진수, 섞인 글자) */
export const CREDENTIAL_HEX_MIN_LENGTH = 16;
export const CREDENTIAL_MIXED_MIN_LENGTH = 20;

/**
 * 형식이 널리 알려진 토큰. 이름이나 따옴표와 상관없이 가린다
 * 앞 글자가 토큰 글자가 아닐 때만 시작해, 하이픈으로 이어진 긴 글에서 자리마다 다시 훑지 않게 한다
 */
export const KNOWN_TOKEN_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9_-])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{20,}/g,
  /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{20,}/g,
  /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9_-])[sr]k_live_[A-Za-z0-9]{16,}/g,
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9_-])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
