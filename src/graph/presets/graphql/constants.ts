// GraphQL 탐지 프리셋과 연산 문서 추출기가 쓰는 값. 라이브러리가 정한 이름(데코레이터, 훅, 태그)만 둔다
// 스키마 이름과 리졸버 위치는 설정 hints.graphqlSchemas 로 받는다
import type { GraphqlOperationType } from '../../types.js';

/** 연산 문서 파일 확장자 */
export const GRAPHQL_DOCUMENT_EXTENSIONS: readonly string[] = [
  '.graphql',
  '.gql',
];
/** 연산 문서 심볼의 언어와 종류 */
export const GRAPHQL_LANGUAGE = 'graphql';
export const GRAPHQL_OPERATION_KIND = 'operation';
/** 연산 문서와 클라이언트 코드를 보는 프리셋의 언어 */
export const GRAPHQL_CLIENT_LANGUAGES: readonly string[] = [
  'typescript',
  'javascript',
  GRAPHQL_LANGUAGE,
];
export const GRAPHQL_SERVER_LANGUAGES: readonly string[] = [
  'typescript',
  'javascript',
];

export const GRAPHQL_OPERATION_TYPES: readonly GraphqlOperationType[] = [
  'query',
  'mutation',
  'subscription',
];
/** 문서 맨 위에서 정의를 시작하는 낱말. 이 낱말에서 앞 정의를 건너뛰기를 멈춘다 */
export const GRAPHQL_DEFINITION_KEYWORDS: readonly string[] = [
  ...GRAPHQL_OPERATION_TYPES,
  'fragment',
  'schema',
  'scalar',
  'type',
  'interface',
  'union',
  'enum',
  'input',
  'directive',
  'extend',
];
/** 스키마 조회용 메타 필드(`__typename`) 머리. 루트 필드로 세지 않는다 */
export const INTROSPECTION_FIELD_PREFIX = '__';
/** 문서 토큰의 문장 부호. `...` 는 따로 읽는다 */
export const GRAPHQL_PUNCTUATORS = '!$&()[]{}:=@|';

// ── 신뢰도(0~1) ──

/** 리졸버 데코레이터(`@Query`, `@Mutation`, `@Subscription`) */
export const RESOLVER_CONFIDENCE = 0.98;
/** 타입 필드 리졸버(`@ResolveField`). 루트 필드가 아니라 연결보다 목록에 쓰인다 */
export const FIELD_RESOLVER_CONFIDENCE = 0.95;
/** `.graphql` 파일의 이름 있는 연산 */
export const DOCUMENT_FILE_CONFIDENCE = 0.99;
/** 코드 안 gql 태그 글·graphql() 호출의 이름 있는 연산 */
export const EMBEDDED_DOCUMENT_CONFIDENCE = 0.97;
/** 클라이언트 호출: 연산 문서를 같은 저장소에서 찾았다 */
export const CLIENT_OPERATION_CONFIDENCE = 0.9;
/** 클라이언트 호출: 이름 규칙으로 연산 이름만 알고 문서는 못 찾았다 */
export const CLIENT_OPERATION_NAME_ONLY_CONFIDENCE = 0.75;

// ── 서버: NestJS 리졸버 ──

/** 리졸버 메서드 데코레이터 → 연산 종류. field 는 타입 필드 리졸버 */
export const RESOLVER_DECORATORS: Readonly<
  Record<string, GraphqlOperationType | 'field'>
> = {
  Query: 'query',
  Mutation: 'mutation',
  Subscription: 'subscription',
  ResolveField: 'field',
};
export const RESOLVER_CLASS_DECORATOR = 'Resolver';
/** 같은 이름의 HTTP 매개변수 데코레이터(`@Query('page')`)를 내는 모듈. 이 모듈에서 가져온 이름이면 리졸버가 아니다 */
export const HTTP_DECORATOR_MODULES: readonly string[] = ['@nestjs/common'];
/** 필드 이름을 바꾸는 옵션 키 */
export const RESOLVER_NAME_OPTION = 'name';
/** 접근자 심볼 이름 끝(`Order.total:get`) */
export const ACCESSOR_SUFFIX = /:(?:get|set)$/;

// ── 클라이언트: graphql-codegen ──

/** 생성된 훅 이름 끝 → 연산 종류. 긴 끝부터 맞춘다 */
export const CODEGEN_HOOK_SUFFIXES: ReadonlyArray<
  [string, GraphqlOperationType]
> = [
  ['SuspenseQuery', 'query'],
  ['LazyQuery', 'query'],
  ['Query', 'query'],
  ['Mutation', 'mutation'],
  ['Subscription', 'subscription'],
];
export const CODEGEN_HOOK_PREFIX = 'use';
/** 생성된 문서 상수 이름 끝(`GetOrderDocument`) */
export const CODEGEN_DOCUMENT_SUFFIX = 'Document';
/**
 * 이름 규칙에는 맞지만 라이브러리가 직접 내는 훅. 연산 이름으로 읽지 않는다
 * Apollo Client, urql, TanStack Query, SWR 의 훅이다
 */
export const LIBRARY_HOOKS: readonly string[] = [
  'useQuery',
  'useLazyQuery',
  'useSuspenseQuery',
  'useBackgroundQuery',
  'useLoadableQuery',
  'useReadQuery',
  'useMutation',
  'useSubscription',
  'useInfiniteQuery',
  'useSuspenseInfiniteQuery',
  'useIsMutating',
  'useSWRMutation',
  'useSWRSubscription',
];

// ── 클라이언트: Apollo Client ──

/** 첫 인자로 연산 문서를 받는 훅 */
export const APOLLO_DOCUMENT_HOOKS: readonly string[] = [
  'useQuery',
  'useLazyQuery',
  'useSuspenseQuery',
  'useBackgroundQuery',
  'useLoadableQuery',
  'useMutation',
  'useSubscription',
];
/** 옵션 객체의 문서 속성으로 연산을 받는 클라이언트 메서드 → 문서 속성 이름 */
export const APOLLO_CLIENT_METHODS: Readonly<Record<string, string>> = {
  query: 'query',
  watchQuery: 'query',
  subscribe: 'query',
  mutate: 'mutation',
};
/** 연산 문서를 만드는 태그·함수 이름 */
export const DOCUMENT_TAGS: readonly string[] = ['gql', 'graphql'];
