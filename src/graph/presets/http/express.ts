// Express 라우터 등록 프리셋: `router.get('/orders', listOrders)`, `app.route('/points').get(...).post(...)`
// 처리기 인자가 같은 파일의 함수 이름이면 그 함수에, 아니면 등록한 심볼(함수, 메서드, 파일 최상위 모듈 심볼)에 라우트를 단다
// `app.use('/api', router)` 로 붙인 접두어는 아직 경로에 더하지 않는다
import type {
  CodeSite,
  DetectionPreset,
  ExtractedSymbol,
  PresetContext,
} from '../../types.js';
import { staticTexts } from './arguments.js';
import {
  ANY_HTTP_METHOD,
  EXPRESS_FACTORIES,
  EXPRESS_MODULES,
  EXPRESS_ROUTE_CHAIN,
  EXPRESS_ROUTE_VERBS,
  SCRIPT_LANGUAGES,
} from './constants.js';
import {
  handlerArgument,
  registrationRoutes,
  splitMemberCall,
} from './routes.js';
import type { RegistrationFramework, RouteRegistration } from './types.js';

/** `app.route('/points').get(a).post(b)` 연쇄의 뒤쪽 호출 이름 */
const ROUTE_CHAIN = new RegExp(
  `^([\\w$.]+)\\.${EXPRESS_ROUTE_CHAIN}\\(\\)(?:\\.\\w+\\(\\))*\\.(\\w+)$`,
);

const EXPRESS: RegistrationFramework = {
  name: 'express',
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
