// HTTP 탐지 프리셋이 함께 쓰는 값. 프레임워크가 정한 이름(데코레이터, 메서드, 만드는 함수)만 두고 회사 고유 이름은 두지 않는다
// 회사 고유 래퍼·주소 변수·프록시 접두어는 설정(hints, detectors)으로 받는다
import type { FactoryMatcher } from './types.js';

/** TS·JS 파일을 보는 프리셋의 언어 */
export const SCRIPT_LANGUAGES: readonly string[] = ['typescript', 'javascript'];
/** Python 파일을 보는 프리셋의 언어 */
export const PYTHON_LANGUAGES: readonly string[] = ['python'];

/** 경로를 쓰는 HTTP 메서드(소문자). 라우터 등록과 클라이언트 호출이 같은 이름을 쓴다 */
export const HTTP_VERBS: readonly string[] = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
];
/** 모든 메서드를 받는 라우트의 메서드 칸 */
export const ANY_HTTP_METHOD = '*';
/** 메서드를 적지 않은 호출의 기본 메서드 */
export const DEFAULT_HTTP_METHOD = 'GET';

/** 정규화한 경로에서 매개변수 자리 */
export const PATH_PARAMETER = ':param';
/** 템플릿 치환 자리를 경로 글 안에 잠시 적는 꼴. 정규화가 `:param` 으로 바꾼다 */
export const SUBSTITUTION_MARK = '${}';

// ── 신뢰도(0~1). 탐지기마다 고정값이고, 근거가 약하면 낮은 값을 쓴다 ──

/** 데코레이터 라우트: 프레임워크 데코레이터 인자에 경로가 그대로 적혀 있다 */
export const DECORATOR_ROUTE_CONFIDENCE = 0.99;
/** 데코레이터 라우트지만 받는 쪽(컨트롤러 기본 경로, 라우터 접두어)을 같은 저장소에서 찾지 못했다 */
export const DECORATOR_ROUTE_PARTIAL_CONFIDENCE = 0.93;
/** 라우터 등록: 받는 쪽이 그 프레임워크로 만든 라우터·앱임을 확인했다 */
export const REGISTRATION_ROUTE_CONFIDENCE = 0.95;
/** 라우터 등록이지만 받는 쪽은 그 프레임워크를 가져온 파일의 이름 관례로만 알았다 */
export const REGISTRATION_ROUTE_WEAK_CONFIDENCE = 0.9;
/** 파일 경로 라우트(Next.js `app` 아래 `route.ts`, `pages/api` 아래 파일) */
export const FILE_ROUTE_CONFIDENCE = 0.97;
/** `pages/api` 파일에서 기본 내보내기 표시 없이 하나뿐인 함수를 처리기로 고른 경우 */
export const FILE_ROUTE_GUESSED_HANDLER_CONFIDENCE = 0.85;

/** 클라이언트 호출: 경로를 정적으로 다 읽었다 */
export const CLIENT_CALL_CONFIDENCE = 0.9;
/** 클라이언트 호출: 경로 일부가 실행 중에 정해진다 */
export const CLIENT_CALL_PARTIAL_CONFIDENCE = 0.8;
/** 클라이언트 호출: 경로를 하나도 정적으로 읽지 못했다 */
export const CLIENT_CALL_UNKNOWN_CONFIDENCE = 0.6;
/** 받는 쪽 인스턴스를 약한 근거(저장소 안 같은 이름 하나, 같은 심볼의 만드는 자리 하나)로 이었을 때 빼는 값 */
export const WEAK_BINDING_PENALTY = 0.05;

// ── 서버 프레임워크 ──

/** NestJS 라우트 데코레이터 → 메서드. All 은 모든 메서드 */
export const NEST_ROUTE_DECORATORS: Readonly<Record<string, string>> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
  All: ANY_HTTP_METHOD,
};
/** NestJS 컨트롤러 클래스 데코레이터 */
export const NEST_CONTROLLER_DECORATOR = 'Controller';

/** Express 라우터 등록 메서드. all 은 모든 메서드 */
export const EXPRESS_ROUTE_VERBS: readonly string[] = [...HTTP_VERBS, 'all'];
/** Express 의 `app.route('/path').get(...)` 연쇄에서 경로를 받는 메서드 */
export const EXPRESS_ROUTE_CHAIN = 'route';
export const EXPRESS_MODULES: readonly string[] = ['express'];
/** Express 앱·라우터를 만드는 호출 */
export const EXPRESS_FACTORIES: FactoryMatcher = {
  qualified: ['express', 'express.Router'],
  imported: { express: ['Router', 'default', '*'] },
};

/** Fastify 단축 등록 메서드. all 은 모든 메서드 */
export const FASTIFY_ROUTE_VERBS: readonly string[] = [...HTTP_VERBS, 'all'];
/** Fastify 의 `fastify.route({ method, url, handler })` */
export const FASTIFY_ROUTE_OBJECT = 'route';
export const FASTIFY_MODULES: readonly string[] = ['fastify'];
/** Fastify 플러그인이 관례로 받는 인스턴스 이름. 이 이름이면 가져오기 근거 없이도 Fastify 로 본다 */
export const FASTIFY_INSTANCE_NAME = 'fastify';
export const FASTIFY_FACTORIES: FactoryMatcher = {
  qualified: ['fastify', 'Fastify'],
  imported: { fastify: ['default', 'fastify', '*'] },
  types: ['FastifyInstance'],
};

/** Next.js 라우트 처리기 파일 이름(`app` 아래 `route.ts`) */
export const NEXT_ROUTE_FILE = /^route\.(?:ts|js|mts|mjs)$/;
/** Next.js `pages/api` 파일 확장자 */
export const NEXT_PAGE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
];
/** Next.js 라우트 처리기가 내보내는 메서드 함수 이름 */
export const NEXT_ROUTE_METHODS: readonly string[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
];

/** FastAPI 데코레이터 메서드. api_route 는 methods 인자를 읽는다 */
export const FASTAPI_ROUTE_VERBS: readonly string[] = [...HTTP_VERBS, 'trace'];
export const FASTAPI_API_ROUTE = 'api_route';
export const FASTAPI_MODULES: readonly string[] = ['fastapi'];
export const FASTAPI_FACTORIES: FactoryMatcher = {
  qualified: ['fastapi.FastAPI', 'fastapi.APIRouter'],
  imported: { fastapi: ['FastAPI', 'APIRouter'] },
};
/** 라우터 접두어를 받는 만드는 함수와 그 키워드 */
export const FASTAPI_PREFIX_FACTORIES: readonly string[] = [
  'APIRouter',
  'fastapi.APIRouter',
];
export const FASTAPI_PREFIX_KEYWORD = 'prefix';
export const FASTAPI_PATH_KEYWORD = 'path';

/** Flask 데코레이터 메서드. route 는 methods 인자를 읽고 없으면 GET 이다 */
export const FLASK_ROUTE_VERBS: readonly string[] = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
];
export const FLASK_ROUTE = 'route';
/** 데코레이터 대신 `app.add_url_rule(rule, view_func=…)` 로 등록하는 꼴 */
export const FLASK_URL_RULE = 'add_url_rule';
export const FLASK_MODULES: readonly string[] = ['flask'];
export const FLASK_FACTORIES: FactoryMatcher = {
  qualified: ['flask.Flask', 'flask.Blueprint'],
  imported: { flask: ['Flask', 'Blueprint'] },
};
export const FLASK_PREFIX_FACTORIES: readonly string[] = [
  'Blueprint',
  'flask.Blueprint',
];
export const FLASK_PREFIX_KEYWORD = 'url_prefix';
export const FLASK_RULE_KEYWORD = 'rule';
export const FLASK_VIEW_KEYWORD = 'view_func';

// ── 클라이언트 ──

/** 전역 fetch 를 부르는 이름 */
export const FETCH_CALLEES: readonly string[] = [
  'fetch',
  'window.fetch',
  'globalThis.fetch',
];
/** 주소를 감싸는 URL 생성자 */
export const URL_CONSTRUCTOR = 'URL';

export const AXIOS_MODULES: readonly string[] = ['axios'];
/** axios 모듈 자체를 부르는 이름(가져온 이름이 다르면 가져오기로 찾는다) */
export const AXIOS_DEFAULT_NAME = 'axios';
/** 설정 객체 하나로 부르는 메서드 */
export const AXIOS_REQUEST_METHOD = 'request';
/** axios 인스턴스를 만드는 호출과, 인스턴스임을 알리는 타입 표기 */
export const AXIOS_FACTORIES: FactoryMatcher = {
  qualified: ['axios.create'],
  imported: {},
  types: ['AxiosInstance', 'AxiosStatic', 'HttpService'],
};
/** NestJS HttpService 가 감싼 axios 인스턴스로 가는 속성. 떼고 받는 쪽을 찾는다 */
export const AXIOS_REFERENCE_PROPERTY = 'axiosRef';

/** Python HTTP 클라이언트 모듈 */
export const PYTHON_HTTP_MODULES: readonly string[] = ['requests', 'httpx'];
/** 모듈 함수 하나로 메서드와 주소를 함께 받는 이름 */
export const PYTHON_REQUEST_FUNCTION = 'request';
export const PYTHON_HTTP_FACTORIES: FactoryMatcher = {
  qualified: [
    'requests.Session',
    'requests.session',
    'httpx.Client',
    'httpx.AsyncClient',
  ],
  imported: {
    requests: ['Session', 'session'],
    httpx: ['Client', 'AsyncClient'],
  },
};
/** 인스턴스의 기준 주소 키워드 */
export const PYTHON_BASE_URL_KEYWORD = 'base_url';
export const PYTHON_URL_KEYWORD = 'url';
export const PYTHON_METHOD_KEYWORD = 'method';
/** 메서드 목록을 받는 데코레이터 키워드(FastAPI api_route, Flask route·add_url_rule) */
export const PYTHON_METHODS_KEYWORD = 'methods';

/** 클래스 안에서 자기 인스턴스를 가리키는 이름 */
export const SELF_RECEIVERS: readonly string[] = ['this', 'self'];
/** 생성자 심볼 이름 끝 */
export const CONSTRUCTOR_NAMES: readonly string[] = ['constructor', '__init__'];
/** 파일 하나의 최상위 문장을 모은 심볼 종류. 라우터 등록처럼 함수 밖에서 부르는 자리가 여기 붙는다 */
export const MODULE_SYMBOL_KIND = 'module';
/** 처리 함수로 볼 심볼 종류 */
export const HANDLER_SYMBOL_KINDS: readonly string[] = ['function', 'method'];

/** 기본 내보내기·모듈 전체 가져오기의 원래 이름 */
export const DEFAULT_EXPORT_NAME = 'default';
export const WHOLE_MODULE_NAME = '*';

// ── 라우터 마운트 ──

/** 다른 파일의 마운트·전역 접두어를 거쳐 붙인 경로의 신뢰도에서 빼는 값 */
export const MOUNT_CROSS_FILE_PENALTY = 0.02;
/** 라우터 하나에 붙는 접두어 수 한도. 마운트가 서로 얽혀 경우가 크게 늘어나는 것을 막는다 */
export const MAX_MOUNT_PREFIXES = 64;
/** Express `app.use(prefix, router)` */
export const EXPRESS_MOUNT = 'use';
/** Fastify `fastify.register(plugin, { prefix })` */
export const FASTIFY_MOUNT = 'register';
export const FASTIFY_PREFIX_OPTION = 'prefix';
/** FastAPI `app.include_router(router, prefix=…)` */
export const FASTAPI_MOUNT = 'include_router';
export const FASTAPI_ROUTER_KEYWORD = 'router';
/** Flask `app.register_blueprint(bp, url_prefix=…)` */
export const FLASK_MOUNT = 'register_blueprint';
export const FLASK_BLUEPRINT_KEYWORD = 'blueprint';
/** NestJS 앱 전역 접두어 `app.setGlobalPrefix('api', { exclude })` */
export const NEST_GLOBAL_PREFIX = 'setGlobalPrefix';
export const NEST_GLOBAL_PREFIX_EXCLUDE = 'exclude';
/** NestJS 모듈 데코레이터와 RouterModule 등록 */
export const NEST_MODULE_DECORATOR = 'Module';
export const NEST_ROUTER_MODULE_REGISTER =
  /^RouterModule\.register\(\s*([\w$.]+)\s*\)$/;
/** RouterModule 경로 나무(children)를 따라 내려가는 깊이 한도 */
export const NEST_ROUTE_TREE_DEPTH = 8;
