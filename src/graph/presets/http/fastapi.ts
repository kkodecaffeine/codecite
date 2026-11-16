// FastAPI 데코레이터 라우트 프리셋: `@router.get('/{order_id}')`, `@app.api_route('/x', methods=['GET', 'POST'])`
// 받는 쪽이 `APIRouter(prefix='/orders')` 면 그 접두어를, `app.include_router(router, prefix='/v1')` 로 붙였으면 그 앞에 마운트 접두어를 붙인다(겹친 라우터도)
import type { DetectionPreset } from '../../types.js';
import {
  FASTAPI_API_ROUTE,
  FASTAPI_MOUNT,
  FASTAPI_ROUTER_KEYWORD,
  FASTAPI_FACTORIES,
  FASTAPI_MODULES,
  FASTAPI_PATH_KEYWORD,
  FASTAPI_PREFIX_FACTORIES,
  FASTAPI_PREFIX_KEYWORD,
  FASTAPI_ROUTE_VERBS,
  PYTHON_LANGUAGES,
  PYTHON_METHODS_KEYWORD,
} from './constants.js';
import { joinHttpPaths } from './paths.js';
import { pythonDecoratorRoutes, pythonMounts } from './python-routes.js';
import type { PythonRouteFramework } from './types.js';

const FASTAPI_RULES: Omit<PythonRouteFramework, 'mount'> = {
  name: 'fastapi',
  modules: FASTAPI_MODULES,
  factories: FASTAPI_FACTORIES,
  verbs: FASTAPI_ROUTE_VERBS,
  methodsDecorator: FASTAPI_API_ROUTE,
  methodsKeyword: PYTHON_METHODS_KEYWORD,
  pathKeyword: FASTAPI_PATH_KEYWORD,
  prefixFactories: FASTAPI_PREFIX_FACTORIES,
  prefixKeyword: FASTAPI_PREFIX_KEYWORD,
};

const FASTAPI: PythonRouteFramework = {
  ...FASTAPI_RULES,
  mount: pythonMounts(FASTAPI_RULES, {
    method: FASTAPI_MOUNT,
    routerKeyword: FASTAPI_ROUTER_KEYWORD,
    prefixKeyword: FASTAPI_PREFIX_KEYWORD,
    combine: (edgePrefix, own) => joinHttpPaths(edgePrefix ?? '', own),
  }),
};

export const FASTAPI_PRESET: DetectionPreset = {
  name: FASTAPI.name,
  languages: PYTHON_LANGUAGES,
  detect(symbol, context) {
    return pythonDecoratorRoutes(FASTAPI, symbol, context);
  },
};
