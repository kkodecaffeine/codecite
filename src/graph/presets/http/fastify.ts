// Fastify 라우터 등록 프리셋: `fastify.get('/points', handler)`, `fastify.get(path, { schema }, handler)`, `fastify.route({ method, url, handler })`
// 플러그인이 받는 인스턴스 이름 `fastify` 는 관례로 받고, 다른 이름은 Fastify 로 만든 인스턴스이거나 Fastify 를 가져온 파일에서만 받는다
// `register(plugin, { prefix })` 로 붙인 접두어는 아직 경로에 더하지 않는다
import type { CodeSite, DetectionPreset, PresetContext } from '../../types.js';
import { readMethods, staticTexts } from './arguments.js';
import {
  ANY_HTTP_METHOD,
  FASTIFY_FACTORIES,
  FASTIFY_INSTANCE_NAME,
  FASTIFY_MODULES,
  FASTIFY_ROUTE_OBJECT,
  FASTIFY_ROUTE_VERBS,
  SCRIPT_LANGUAGES,
} from './constants.js';
import {
  handlerArgument,
  registrationRoutes,
  splitMemberCall,
} from './routes.js';
import type {
  HandlerArgument,
  RegistrationFramework,
  RouteRegistration,
} from './types.js';

const FASTIFY: RegistrationFramework = {
  name: 'fastify',
  modules: FASTIFY_MODULES,
  factories: FASTIFY_FACTORIES,
  conventionalReceivers: [FASTIFY_INSTANCE_NAME],
  receiverNames: /^(?:app|server|instance)$/i,
  read(_symbol, site, context) {
    const call = splitMemberCall(site.name);
    if (!call) {
      return undefined;
    }
    if (call.member === FASTIFY_ROUTE_OBJECT) {
      return readRouteObject(site, call.receiver, context);
    }
    if (!FASTIFY_ROUTE_VERBS.includes(call.member) || site.args.length < 2) {
      return undefined;
    }
    return {
      site,
      receiver: call.receiver,
      methods: [
        call.member === 'all' ? ANY_HTTP_METHOD : call.member.toUpperCase(),
      ],
      paths: staticTexts(site.args[0], context),
      handler: optionsHandler(site),
    };
  },
};

export const FASTIFY_PRESET: DetectionPreset = {
  name: FASTIFY.name,
  languages: SCRIPT_LANGUAGES,
  detect(symbol, context) {
    return registrationRoutes(FASTIFY, symbol, context);
  },
};

/** 처리기는 마지막 인자이거나, 마지막 옵션 객체의 handler 속성이다 */
function optionsHandler(site: CodeSite): HandlerArgument | undefined {
  const handler = site.args.at(-1)?.properties?.handler;
  if (handler) {
    return handler.identifier !== undefined
      ? { identifier: handler.identifier }
      : {};
  }
  return handlerArgument(site);
}

function readRouteObject(
  site: CodeSite,
  receiver: string,
  context: PresetContext,
): RouteRegistration | undefined {
  const options = site.args.length === 1 ? site.args[0]?.properties : undefined;
  const target = options?.url ?? options?.path;
  if (!options || !target) {
    return undefined;
  }
  const methods = readMethods(options.method, context);
  if (methods.length === 0) {
    return undefined;
  }
  const handler = options.handler;
  return {
    site,
    receiver,
    methods,
    paths: staticTexts(target, context),
    handler:
      handler?.identifier !== undefined
        ? { identifier: handler.identifier }
        : {},
  };
}
