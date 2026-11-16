// HTTP 탐지 프리셋 안에서 주고받는 모양. 탐지 결과 모양은 ../../types.ts 의 Detection 이다
import type { ModuleIndex } from '../../imports.js';
import type { CodeSite, ExtractedSymbol, PresetContext } from '../../types.js';

/** 주소 인자 하나를 읽은 결과 */
export interface UrlReading {
  /** 정규화한 경로. 정적으로 읽은 조각이 하나도 없으면 비운다 */
  path?: string;
  /** 주소에 적힌 호스트(소문자, 포트 뺌) */
  host?: string;
  /** 주소 앞부분이 나온 식별자. 기준 주소 변수나 실행 중에 정해지는 주소 전체 */
  baseIdentifiers: string[];
  /** 경로 일부가 실행 중에 정해지는지 */
  dynamic: boolean;
}

/** 주소 인자를 펼친 조각. 정적 글이거나 실행 중에 정해지는 값이다 */
export type UrlPiece =
  { kind: 'static'; text: string } | { kind: 'dynamic'; identifier?: string };

/** 저장소 심볼 색인. 탐지기에 넘어오는 같은 배열이면 한 번만 만든다 */
export interface RepositorySymbolIndex {
  /** 파일 경로 → 그 파일의 심볼(시작 줄 순서) */
  byFile: ReadonlyMap<string, readonly ExtractedSymbol[]>;
  /** 심볼 이름 → 그 이름의 심볼 */
  byName: ReadonlyMap<string, readonly ExtractedSymbol[]>;
  /** 모듈 지정자 → 저장소 안 파일. 상수 풀기·저장소 안 호출 잇기와 같은 규칙이다 */
  modules: ModuleIndex;
}

/**
 * 받는 쪽(라우터, 클라이언트 인스턴스)을 만드는 호출을 알아보는 규칙
 * qualified 는 모듈 이름 관례 그대로 부르는 꼴(`axios.create`), imported 는 모듈 → 가져온 원래 이름이다
 */
export interface FactoryMatcher {
  qualified: readonly string[];
  imported: Readonly<Record<string, readonly string[]>>;
  /** 클래스 멤버·주입 매개변수의 타입 표기로 알아볼 이름 */
  types?: readonly string[];
}

/** 받는 쪽 이름을 찾은 길. 근거 문장과 신뢰도에 쓴다 */
export type BindingVia =
  'local' | 'with' | 'member' | 'file' | 'import' | 'unique' | 'type';

/** 받는 쪽 이름이 가리키는 만드는 자리 */
export interface ReceiverBinding {
  /** 만드는 호출 자리(`axios.create({ baseURL })`). 타입 표기로만 알았으면 비운다 */
  site?: CodeSite;
  /** 만드는 자리나 타입 표기가 있는 심볼 */
  owner: ExtractedSymbol;
  via: BindingVia;
  /** 타입 표기로 알았을 때 그 타입 */
  type?: string;
}

/** 처리기 인자. 이름이면 같은 파일의 함수를 찾아 거기에 라우트를 단다 */
export interface HandlerArgument {
  identifier?: string;
}

/** 서버 라우트를 등록하는 자리 하나 */
export interface RouteRegistration {
  site: CodeSite;
  /** 받는 쪽 이름(`router`, `app`, `fastify`) */
  receiver: string;
  /** 대문자 메서드 목록 */
  methods: string[];
  /** 정규화 전 경로 글 목록 */
  paths: string[];
  handler?: HandlerArgument;
}

/** 라우터 등록 프리셋 하나의 규칙(Express, Fastify) */
export interface RegistrationFramework {
  name: string;
  modules: readonly string[];
  factories: FactoryMatcher;
  /** 이 이름의 받는 쪽은 가져오기 근거 없이도 이 프레임워크로 본다 */
  conventionalReceivers: readonly string[];
  /** 프레임워크를 가져온 파일에서 받는 쪽으로 볼 이름 관례 */
  receiverNames: RegExp;
  /** 호출 자리 하나를 등록으로 읽는다. 등록이 아니면 undefined */
  read(
    symbol: ExtractedSymbol,
    site: CodeSite,
    context: PresetContext,
  ): RouteRegistration | undefined;
}

/** 라우트를 달 심볼과 줄, 근거 */
export interface RouteTarget {
  symbol: ExtractedSymbol;
  line: number;
  evidence: string;
}

/** Python 데코레이터 라우트 프레임워크 하나의 규칙 */
export interface PythonRouteFramework {
  name: string;
  modules: readonly string[];
  factories: FactoryMatcher;
  /** 단축 데코레이터 메서드(소문자) */
  verbs: readonly string[];
  /** methods 키워드로 메서드를 받는 데코레이터 이름. 키워드가 없으면 GET */
  methodsDecorator: string;
  methodsKeyword: string;
  /** 경로를 키워드로 줄 때의 이름 */
  pathKeyword: string;
  /** 접두어를 받는 만드는 함수와 그 키워드 */
  prefixFactories: readonly string[];
  prefixKeyword: string;
}
