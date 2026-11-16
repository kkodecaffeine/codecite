// Fastify 라우터 등록 프리셋: `fastify.get('/points', handler)`, `fastify.get(path, { schema }, handler)`, `fastify.route({ method, url, handler })`
// 플러그인이 받는 인스턴스 이름 `fastify` 는 관례로 받고, 다른 이름은 Fastify 로 만든 인스턴스이거나 Fastify 를 가져온 파일에서만 받는다
// `register(plugin, { prefix })` 접두어는 플러그인 함수 안에서 등록한 라우트에 붙인다. 플러그인 안의 register 도 이어 붙인다(mounts.ts)
import type {
  CodeSite,
  DetectionPreset,
  ExtractedSymbol,
  PresetContext,
} from '../../types.js';
import { readMethods, staticTexts } from './arguments.js';
import {
  ANY_HTTP_METHOD,
  FASTIFY_FACTORIES,
  FASTIFY_INSTANCE_NAME,
  FASTIFY_MODULES,
  FASTIFY_MOUNT,
  FASTIFY_PREFIX_OPTION,
  HANDLER_SYMBOL_KINDS,
  FASTIFY_ROUTE_OBJECT,
  FASTIFY_ROUTE_VERBS,
  SCRIPT_LANGUAGES,
} from './constants.js';
import {
  addMountEdges,
  functionKey,
  mountPrefixes,
  routerKey,
} from './mounts.js';
import { bindReceiver, namedSymbols } from './repository.js';
import {
  handlerArgument,
  registrationRoutes,
  splitMemberCall,
} from './routes.js';
import type {
  HandlerArgument,
  MountFramework,
  ReceiverBinding,
  RegistrationFramework,
  RouteRegistration,
} from './types.js';

/** 등록한 받는 쪽의 열쇠. Fastify() 로 만든 앱이면 그 자리, 아니면 플러그인 함수(매개변수로 받은 인스턴스) */
function fastifyKey(
  symbol: ExtractedSymbol,
  binding: ReceiverBinding | undefined,
): string | undefined {
  return (
    routerKey(binding) ??
    (HANDLER_SYMBOL_KINDS.includes(symbol.kind)
      ? functionKey(symbol)
      : undefined)
  );
}

/** Fastify 마운트: `받는쪽.register(플러그인, { prefix })`. 플러그인은 같은 파일이나 가져온 파일의 함수 하나 */
const FASTIFY_MOUNTS: MountFramework = {
  name: 'fastify',
  languages: SCRIPT_LANGUAGES,
  combine: (edgePrefix) => edgePrefix ?? '',
  read(symbol, site, context, builder) {
    const call = splitMemberCall(site.name);
    const plugin = site.args[0]?.identifier;
    if (!call || call.member !== FASTIFY_MOUNT || plugin === undefined) {
      return;
    }
    const functions = namedSymbols(symbol, plugin, context).symbols.filter(
      (candidate) => HANDLER_SYMBOL_KINDS.includes(candidate.kind),
    );
    const target = functions.length === 1 ? functions[0] : undefined;
    if (!target) {
      return;
    }
    const option = site.args[1]?.properties?.[FASTIFY_PREFIX_OPTION];
    const read = option
      ? mountPrefixes(symbol, option, context)
      : { prefixes: [undefined] };
    addMountEdges(builder, {
      parent: fastifyKey(
        symbol,
        bindReceiver(symbol, call.receiver, site, FASTIFY_FACTORIES, context),
      ),
      child: functionKey(target),
      childFile: target.filePath,
      symbol,
      site,
      ...read,
    });
  },
};

const FASTIFY: RegistrationFramework = {
  name: 'fastify',
  mount: FASTIFY_MOUNTS,
  mountKey: fastifyKey,
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
