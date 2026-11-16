// Flask 라우트 프리셋: `@bp.route('/<int:refund_id>', methods=['POST'])`, `@app.get('/x')`, `app.add_url_rule('/x', view_func=handler)`
// 받는 쪽이 `Blueprint(…, url_prefix='/refunds')` 면 접두어를 붙인다. `register_blueprint(bp, url_prefix=…)` 접두어는 아직 더하지 않는다
import type {
  DetectionPreset,
  ExtractedSymbol,
  HttpRouteDetection,
  PresetContext,
} from '../../types.js';
import {
  keywordArguments,
  positionalArguments,
  readMethods,
  staticTexts,
} from './arguments.js';
import {
  DEFAULT_HTTP_METHOD,
  FLASK_FACTORIES,
  FLASK_MODULES,
  FLASK_PREFIX_FACTORIES,
  FLASK_PREFIX_KEYWORD,
  FLASK_ROUTE,
  FLASK_ROUTE_VERBS,
  FLASK_RULE_KEYWORD,
  FLASK_URL_RULE,
  FLASK_VIEW_KEYWORD,
  PYTHON_LANGUAGES,
  PYTHON_METHODS_KEYWORD,
} from './constants.js';
import { pythonDecoratorRoutes, pythonRoutes } from './python-routes.js';
import { callSites } from './repository.js';
import { routeTarget, splitMemberCall } from './routes.js';
import type { PythonRouteFramework } from './types.js';

/** add_url_rule 의 view_func 위치 인자 순번(rule, endpoint, view_func) */
const VIEW_FUNCTION_POSITION = 2;

const FLASK: PythonRouteFramework = {
  name: 'flask',
  modules: FLASK_MODULES,
  factories: FLASK_FACTORIES,
  verbs: FLASK_ROUTE_VERBS,
  methodsDecorator: FLASK_ROUTE,
  methodsKeyword: PYTHON_METHODS_KEYWORD,
  pathKeyword: FLASK_RULE_KEYWORD,
  prefixFactories: FLASK_PREFIX_FACTORIES,
  prefixKeyword: FLASK_PREFIX_KEYWORD,
};

export const FLASK_PRESET: DetectionPreset = {
  name: FLASK.name,
  languages: PYTHON_LANGUAGES,
  detect(symbol, context) {
    return [
      ...pythonDecoratorRoutes(FLASK, symbol, context),
      ...urlRules(symbol, context),
    ];
  },
};

/** `app.add_url_rule(rule, endpoint, view_func, methods=[…])`. view_func 가 같은 파일의 함수면 그 함수에 단다 */
function urlRules(
  symbol: ExtractedSymbol,
  context: PresetContext,
): HttpRouteDetection[] {
  return callSites(symbol).flatMap((site) => {
    const call = splitMemberCall(site.name);
    if (!call || call.member !== FLASK_URL_RULE) {
      return [];
    }
    const positional = positionalArguments(site);
    const keywords = keywordArguments(site);
    const view =
      keywords[FLASK_VIEW_KEYWORD] ?? positional[VIEW_FUNCTION_POSITION];
    const methods = readMethods(keywords[PYTHON_METHODS_KEYWORD], context);
    const target = routeTarget(
      symbol,
      site,
      view?.identifier !== undefined ? { identifier: view.identifier } : {},
      context,
    );
    return pythonRoutes(FLASK, {
      symbol,
      site,
      receiver: call.receiver,
      methods: methods.length > 0 ? methods : [DEFAULT_HTTP_METHOD],
      paths: staticTexts(
        positional[0] ?? keywords[FLASK_RULE_KEYWORD],
        context,
      ),
      target: {
        symbol: target.symbol,
        line: target.line,
        note: target.evidence,
      },
      context,
    });
  });
}
