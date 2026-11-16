// 언어 추출기가 함께 쓰는 상수. 관계 이름, 확장자, 글 길이 한도, 가림 표시, 조건 칸의 이름
import type { PythonExtractSettings } from './types.js';

/**
 * 추출기가 내는 관계 이름. 대상은 아직 풀지 않은 원문이다
 * - IMPORTS: target.symbol 에 `<가져온 꼴> from <모듈 지정자>`(`refundOrder from ../refund`, `refundOrder as refund from ../refund`,
 *   `default as OrderPage from ./order-page`, `* as points from ../points`). 이름 없이 모듈만 읽으면 `* from ./point-rules`
 * - EXTENDS·IMPLEMENTS·DECORATED_BY·INJECTS·CALLS: target.symbol 에 코드에 적힌 이름이나 호출식(`this.orderService.cancel`)
 * target.filePath 는 저장소 기준 경로 자리라 풀지 않은 지정자를 넣지 않는다. 원문을 어느 저장소의 어느 심볼로 풀지는 탐지·연결 단계가 정한다
 */
export const EXTRACTED_RELATION_TYPES = [
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'DECORATED_BY',
  'INJECTS',
  'CALLS',
] as const;

/** TypeScript 추출기가 맡는 확장자. JavaScript 도 같은 구문 트리로 읽는다 */
export const TYPESCRIPT_SOURCE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
];
export const JAVASCRIPT_SOURCE_EXTENSIONS: readonly string[] = [
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];
/** Python 추출기가 맡는 확장자 */
export const PYTHON_SOURCE_EXTENSIONS: readonly string[] = ['.py'];
/** 선언 파일은 본문이 없어 심볼을 만들지 않는다 */
export const DECLARATION_FILE_SUFFIXES: readonly string[] = [
  '.d.ts',
  '.d.mts',
  '.d.cts',
];

/** 본문을 실행 사실로 펼치는 심볼 종류 */
export const EXECUTABLE_SYMBOL_KINDS: readonly string[] = [
  'function',
  'method',
];

/** 클래스에 붙은 데코레이터 끝 이름 → 심볼 종류. 프레임워크를 알아보는 일은 프리셋이 맡고, 여기서는 이름만 본다 */
export const CLASS_KIND_BY_DECORATOR: Readonly<Record<string, string>> = {
  Controller: 'controller',
  Resolver: 'controller',
  Entity: 'entity',
  Schema: 'schema',
};

/** 실행 사실 글(대상, 값, 조건 하나) 길이 한도. 넘으면 자르고 끝에 CLIPPED_TEXT_MARK 를 붙인다 */
export const MAX_FACT_TEXT_LENGTH = 300;
export const CLIPPED_TEXT_MARK = '…';
/** 관계 대상 원문 길이 한도. 이보다 긴 호출식은 관계로 남기지 않는다 */
export const MAX_RELATION_TARGET_LENGTH = 240;
/** 심볼 하나가 남기는 CALLS 관계 수 한도. 나머지 관계 종류는 자르지 않는다 */
export const MAX_CALL_RELATIONS = 300;
/** 클래스·상수·열거형 원문 길이 한도. 넘으면 앞뒤만 남긴다. 함수·메서드 본문은 실행 사실과 맞추려고 자르지 않는다 */
export const MAX_DECLARATION_CONTENT_LENGTH = 20_000;
/** 원문을 자를 때 앞쪽에 남기는 비율 */
export const DECLARATION_CONTENT_HEAD_RATIO = 0.75;
/** 원문을 자른 자리에 남기는 생략 표시를 감싸는 주석 */
export const TYPESCRIPT_OMISSION_COMMENT = { open: '/*', close: '*/' };
/** 상수 객체를 속성별 대입 사실로 펼치는 깊이 */
export const MAX_OBJECT_FACT_DEPTH = 3;

/** 문자열·템플릿 리터럴과 환경 변수 읽기를 바꿔 적는 표시 */
export const LITERAL_PLACEHOLDER = '<literal>';
export const ENV_PLACEHOLDER = '<env>';
/** 식 안에 들어간 함수 본문을 줄여 적을 때 쓰는 표시 */
export const FUNCTION_BODY_PLACEHOLDER = '…';
/** 원문을 그대로 줄이기만 하면 되는지 가르는 꼴. 따옴표·백틱·주석·JSX·환경 변수가 없으면 구문 트리를 다시 돌지 않는다 */
export const MASK_CANDIDATE_PATTERN = /['"`/<]|env/;

/** 조건 칸에 적는 말. else·부정은 `NOT (조건)` 이고, 분기가 아닌 자리는 이름으로 적는다 */
export const CONDITION_LABELS = {
  /** 부정 조건의 머리말 */
  not: 'NOT',
  /** 예외를 받은 갈래 */
  catch: 'catch',
  /** 마무리 갈래 */
  finally: 'finally',
  /** Python try 의 else: 예외 없이 끝난 갈래 */
  noException: 'no exception',
  /** Python for·while 의 else: break 없이 끝난 갈래 */
  noBreak: 'no break',
  /** Python with 블록 */
  with: 'with',
} as const;

/** 이름 하나(멤버 연쇄 포함)를 `!` 로 뒤집은 조건. 부정할 때 `!` 만 떼어 낸다 */
export const SIMPLE_NEGATION_PATTERN =
  /^!\s*([A-Za-z_$#][\w$]*(?:\??\.[A-Za-z_$#][\w$]*)*)$/;

/** IMPORTS 대상에서 가져온 꼴과 모듈 지정자를 가르는 말, 그리고 이름 없이 모듈 전체를 읽을 때 쓰는 가져온 꼴 */
export const IMPORT_TARGET_SEPARATOR = ' from ';
export const WHOLE_MODULE_IMPORT = '*';

/** 같은 파일에 같은 이름 심볼이 또 나오면 이름 뒤에 붙이는 꼬리(`refundOrder~2`). 나온 순서로 센다 */
export const DUPLICATE_SYMBOL_SEPARATOR = '~';

/** typescript 로 한 번에 읽는 파일 수. 묶음이 끝나면 구문 트리를 놓아 큰 저장소에서도 메모리가 늘지 않게 한다 */
export const TYPESCRIPT_PARSE_BATCH_SIZE = 200;
/** JavaScript 파일에만 붙는 진단(타입 표기는 TypeScript 파일에서만 쓸 수 있다 등)의 코드 범위. 구문 오류가 아니라 실패로 보지 않는다 */
export const JAVASCRIPT_ONLY_DIAGNOSTIC_CODES = { from: 8000, to: 8999 };
export const TYPESCRIPT_INSTALL_COMMAND = 'npm i -D typescript';

/** Python 원문을 자른 자리에 남기는 생략 표시를 감싸는 주석 */
export const PYTHON_OMISSION_COMMENT = { open: '#', close: '' };
export const DEFAULT_PYTHON_COMMAND = 'python3';
export const MINIMUM_PYTHON_VERSION = '3.9';
/** Python 도우미가 판이 낮을 때 내는 종료 코드. 도우미에게 인자로 넘긴다 */
export const PYTHON_VERSION_EXIT_CODE = 3;
/** Python 도우미의 오류 출력을 보여 줄 때 자르는 길이 */
export const PYTHON_STDERR_MAX_CHARS = 2_000;
/** 깊게 중첩된 식도 읽도록 도우미가 올려 두는 재귀 한도 */
export const PYTHON_RECURSION_LIMIT = 10_000;
/** Python 표준 enum 의 기반 클래스. 이것을 상속한 클래스는 열거형으로 읽는다 */
export const PYTHON_ENUM_BASES: readonly string[] = [
  'Enum',
  'IntEnum',
  'StrEnum',
  'Flag',
  'IntFlag',
];

/** Python 도우미에 넘기는 값. TypeScript 추출기와 같은 표시·한도·이름으로 적게 한다 */
export const PYTHON_EXTRACT_SETTINGS: PythonExtractSettings = {
  maxTextLength: MAX_FACT_TEXT_LENGTH,
  maxRelationTargetLength: MAX_RELATION_TARGET_LENGTH,
  clippedMark: CLIPPED_TEXT_MARK,
  literal: LITERAL_PLACEHOLDER,
  env: ENV_PLACEHOLDER,
  functionBody: FUNCTION_BODY_PLACEHOLDER,
  labels: CONDITION_LABELS,
  classKinds: CLASS_KIND_BY_DECORATOR,
  enumBases: PYTHON_ENUM_BASES,
  importSeparator: IMPORT_TARGET_SEPARATOR,
  wholeModuleImport: WHOLE_MODULE_IMPORT,
  recursionLimit: PYTHON_RECURSION_LIMIT,
};
