import type { ExecutionFactKind } from '../extensions/code-knowledge.js';
import type { Logger } from '../ports.js';
import type { FileSkipCounts, GraphDetectorKind } from './types.js';

// ── 설정 ──

/** 그래프 설정 파일 이름. 설정 안의 상대 경로는 이 파일이 있는 폴더 기준이다 */
export const GRAPH_CONFIG_FILE = 'codecite.graph.json';
/** 결과 폴더 기본값 */
export const GRAPH_DEFAULT_OUTPUT = '.codecite/graph';
/** 캐시 폴더를 주지 않으면 결과 폴더 옆의 이 이름 폴더를 쓴다 */
export const GRAPH_DEFAULT_CACHE_NAME = 'cache';
/** 관계 선언이 없을 때 연결 컬럼으로 볼 이름 끝말 기본값 */
export const GRAPH_DEFAULT_FOREIGN_KEY_SUFFIXES: readonly string[] = [
  'Id',
  '_id',
];

/** 설정 파일에서 받는 항목. 오타로 생긴 모르는 항목이 조용히 무시되지 않게 이 밖의 항목은 거절한다 */
export const GRAPH_CONFIG_KEYS: readonly string[] = [
  'output',
  'cache',
  'repositories',
  'defaultExcludes',
  'presets',
  'hints',
  'detectors',
  'entities',
  'groups',
  'manualLinks',
  'extractorModules',
  'presetModules',
  'maxUnresolvedRatio',
];
export const GRAPH_REPOSITORY_KEYS: readonly string[] = [
  'name',
  'url',
  'path',
  'defaultBranch',
  'include',
  'exclude',
];
export const GRAPH_HINT_KEYS: readonly string[] = [
  'baseUrls',
  'proxyPrefixes',
  'packages',
  'graphqlSchemas',
  'external',
];
export const GRAPH_DETECTOR_KEYS: readonly string[] = [
  'kind',
  'call',
  'decorator',
  'nameArgument',
];
export const GRAPH_DETECTOR_KINDS: readonly GraphDetectorKind[] = [
  'http-client',
  'queue-publisher',
  'queue-consumer',
  'event-publisher',
  'event-handler',
  'scheduler',
];

/** 저장소 이름. 결과 파일 이름(`symbols/<이름>.jsonl`)으로도 쓰므로 경로 구분자와 앞 점을 막는다 */
export const GRAPH_REPOSITORY_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** 브랜치 이름에 쓸 수 있는 글자. 옵션처럼 보이는 이름과 상위 경로는 따로 막는다 */
export const GRAPH_BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

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

// ── 레코드와 결과 파일 ──

export const GRAPH_SCHEMA_VERSION = 1;
/** 결과 파일 형식 판. 바꾸면 지난 결과를 재사용하지 않는다 */
export const GRAPH_OUTPUT_FORMAT = 1;
export const GRAPH_TOOL_NAME = 'codecite';
export const GRAPH_MANIFEST_FILE = 'manifest.json';
export const GRAPH_SYMBOLS_FOLDER = 'symbols';
export const GRAPH_SYMBOLS_EXTENSION = '.jsonl';
/** 단계가 더하는 결과 파일 이름. 결과 폴더 바로 아래 JSON 파일만 쓴다 */
export const GRAPH_ARTIFACT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*\.json$/;

/** 현재 심볼 레코드가 가질 수 있는 키. 계약(CurrentSymbolRecord)에 없는 키는 받지 않는다 */
export const RECORD_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'recordType',
  'repository',
  'filePath',
  'language',
  'symbol',
  'stableSymbolId',
  'kind',
  'commitSha',
  'committedAt',
  'contentHash',
  'content',
  'lineStart',
  'lineEnd',
  'description',
  'relations',
  'triggeredBy',
  'policyGroup',
  'executionFacts',
]);
export const EXECUTION_FACT_KINDS: readonly ExecutionFactKind[] = [
  'condition',
  'assigns',
  'calls',
  'returns',
  'throws',
];

/** 레코드 어디에도 두지 않는 키. 변경 원문과 비밀값을 담는 이름이다(소문자, 밑줄 뺌) */
export const FORBIDDEN_RECORD_KEYS: readonly string[] = [
  'rawpatch',
  'patch',
  'diff',
  'secretvalue',
  'tokenvalue',
  'credentialvalue',
  'passwordvalue',
];

/** 심볼 수가 지난번의 이 비율 아래로 줄면 그 저장소에서 멈춘다 */
export const GRAPH_SYMBOL_COLLAPSE_RATIO = 0.5;
/** 실패 메시지를 남길 때 자르는 길이 */
export const GRAPH_FAILURE_MESSAGE_MAX_CHARS = 500;

// ── git ──

export const GIT_MAX_BUFFER_BYTES = 512 * 1024 * 1024;
/** 원격에 묻는 명령(ls-remote)을 기다리는 시간. 받기·꺼내기는 저장소 크기에 따라 길어 상한을 두지 않는다 */
export const GIT_REMOTE_QUERY_TIMEOUT_MS = 120_000;
/** git 오류를 보여 줄 때 자르는 길이 */
export const GIT_ERROR_SUMMARY_MAX_CHARS = 300;
/** 꺼낸 폴더에서 훅·파일 감시를 끈다. 사용자 전역 설정의 훅이 임시 폴더에서 돌지 않게 한다 */
export const GIT_CHECKOUT_SETTINGS: readonly string[] = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
];
/**
 * git 에 넘기는 고정 환경 변수
 * 대화형 질문을 끄고(멈추지 않게), 읽기 명령이 색인을 고쳐 쓰지 않게 하고, 대용량 파일은 내려받지 않고, 메시지를 영어로 받는다
 */
export const GIT_FIXED_VARIABLES: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_LFS_SKIP_SMUDGE: '1',
  LC_ALL: 'C',
};
/** 물려받지 않는 환경 변수. git 훅 안에서 부르면 이 값이 다른 저장소를 가리킨다 */
export const GIT_DROPPED_VARIABLES: readonly string[] = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];
/** 임시 작업 폴더 이름 앞머리 */
export const GRAPH_WORKSPACE_PREFIX = 'codecite-graph-';
/** url 저장소 캐시 안에서 저장소를 두는 폴더 */
export const GRAPH_CACHE_REPOSITORIES_FOLDER = 'repos';

/** 로거를 주지 않았을 때 쓰는 조용한 로거 */
export const SILENT_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
