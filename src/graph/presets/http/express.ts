// Express 라우터 등록 프리셋: `router.get('/orders', listOrders)`, `app.route('/points').get(...).post(...)`
// 처리기 인자가 같은 파일의 함수 이름이면 그 함수에, 아니면 등록한 심볼(함수, 메서드, 파일 최상위 모듈 심볼)에 라우트를 단다
// `app.use('/api', ordersRouter)`, `router.use('/v1', sub)` 마운트 접두어는 맨 위 앱까지 이어 경로 앞에 붙인다(mounts.ts)
import type {
  CodeSite,
  CodeSiteArgument,
  DetectionPreset,
  ExtractedSymbol,
  PresetContext,
} from '../../types.js';
import { staticTexts } from './arguments.js';
import {
  ANY_HTTP_METHOD,
  EXPRESS_FACTORIES,
  EXPRESS_MODULES,
  EXPRESS_MOUNT,
  EXPRESS_ROUTE_CHAIN,
  EXPRESS_ROUTE_VERBS,
  SCRIPT_LANGUAGES,
} from './constants.js';
import {
  addMountEdges,
  mountedRouter,
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
  MountFramework,
  RegistrationFramework,
  RouteRegistration,
} from './types.js';

/** `app.route('/points').get(a).post(b)` 연쇄의 뒤쪽 호출 이름 */
const ROUTE_CHAIN = new RegExp(
  `^([\\w$.]+)\\.${EXPRESS_ROUTE_CHAIN}\\(\\)(?:\\.\\w+\\(\\))*\\.(\\w+)$`,
);

/**
 * Express 마운트: `받는쪽.use(접두어?, …미들웨어, 라우터…)`
 * 첫 인자가 라우터가 아니면 접두어 자리다. 문자열·상수면 접두어, 함수(미들웨어)면 접두어 없음, 못 읽으면 알림으로 남긴다
 */
const EXPRESS_MOUNTS: MountFramework = {
  name: 'express',
  languages: SCRIPT_LANGUAGES,
  combine: (edgePrefix) => edgePrefix ?? '',
  read(symbol, site, context, builder) {
    const call = splitMemberCall(site.name);
    const [first, ...rest] = site.args;
    if (!call || call.member !== EXPRESS_MOUNT || !first) {
      return;
    }
    let children = site.args;
    let prefixes: Array<string | undefined> = [undefined];
    let unresolved: string | undefined;
    if (!mountedRouter(symbol, site, first, EXPRESS_FACTORIES, context)) {
      if (rest.length === 0) {
        return;
      }
      children = rest;
      if (!isMiddleware(symbol, first, context)) {
        ({ prefixes, unresolved } = mountPrefixes(symbol, first, context));
      }
    }
    const parent = routerKey(
      bindReceiver(symbol, call.receiver, site, EXPRESS_FACTORIES, context),
    );
    for (const argument of children) {
      const child = mountedRouter(
        symbol,
        site,
        argument,
        EXPRESS_FACTORIES,
        context,
      );
      if (child) {
        addMountEdges(builder, {
          parent,
          child: child.key,
          childFile: child.binding.owner.filePath,
          symbol,
          site,
          prefixes,
          ...(unresolved !== undefined ? { unresolved } : {}),
        });
      }
    }
  },
};

const EXPRESS: RegistrationFramework = {
  name: 'express',
  mount: EXPRESS_MOUNTS,
  mountKey: (_symbol, binding) => routerKey(binding),
  modules: EXPRESS_MODULES,
  factories: EXPRESS_FACTORIES,
  conventionalReceivers: [],
  receiverNames: /^(?:app|server)$|router$/i,
  read(symbol, site, context) {
    return readChain(symbol, site, context) ?? readShortcut(site, context);
  },
};

export const EXPRESS_PRESET: DetectionPreset = {
  name: EXPRESS.name,
  languages: SCRIPT_LANGUAGES,
  detect(symbol, context) {
    return registrationRoutes(EXPRESS, symbol, context);
  },
};

function methodOf(verb: string): string {
  return verb === 'all' ? ANY_HTTP_METHOD : verb.toUpperCase();
}

function readShortcut(
  site: CodeSite,
  context: PresetContext,
): RouteRegistration | undefined {
  const call = splitMemberCall(site.name);
  if (
    !call ||
    !EXPRESS_ROUTE_VERBS.includes(call.member) ||
    site.args.length < 2
  ) {
    return undefined;
  }
  return {
    site,
    receiver: call.receiver,
    methods: [methodOf(call.member)],
    paths: staticTexts(site.args[0], context),
    handler: handlerArgument(site),
  };
}

/** 연쇄의 경로는 같은 심볼에서 바로 앞의 `받는쪽.route('/path')` 자리에 있다 */
function readChain(
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
): RouteRegistration | undefined {
  const match = ROUTE_CHAIN.exec(site.name);
  const receiver = match?.[1];
  const verb = match?.[2];
  if (
    receiver === undefined ||
    verb === undefined ||
    !EXPRESS_ROUTE_VERBS.includes(verb) ||
    site.args.length === 0
  ) {
    return undefined;
  }
  const opener = (symbol.sites ?? [])
    .filter(
      (candidate) =>
        candidate.kind === 'call' &&
        candidate.name === `${receiver}.${EXPRESS_ROUTE_CHAIN}` &&
        candidate.line <= site.line,
    )
    .at(-1);
  if (!opener) {
    return undefined;
  }
  return {
    site,
    receiver,
    methods: [methodOf(verb)],
    paths: staticTexts(opener.args[0], context),
    handler: handlerArgument(site),
  };
}

/** 마운트 첫 인자가 접두어가 아니라 미들웨어인지. 문자열이 아닌 식이나 같은 저장소의 함수 이름이면 미들웨어다 */
function isMiddleware(
  symbol: ExtractedSymbol,
  argument: CodeSiteArgument,
  context: PresetContext,
): boolean {
  if (argument.literal !== undefined || argument.template !== undefined) {
    return false;
  }
  if (argument.identifier === undefined) {
    return argument.elements === undefined;
  }
  return namedSymbols(symbol, argument.identifier, context).symbols.some(
    (candidate) => candidate.kind === 'function',
  );
}
