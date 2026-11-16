// FastAPI 데코레이터 라우트 프리셋: `@router.get('/{order_id}')`, `@app.api_route('/x', methods=['GET', 'POST'])`
// 받는 쪽이 `APIRouter(prefix='/orders')` 면 접두어를 붙인다. `app.include_router(router, prefix=…)` 로 붙인 접두어는 아직 더하지 않는다
import type { DetectionPreset } from '../../types.js';
import {
  FASTAPI_API_ROUTE,
  FASTAPI_FACTORIES,
  FASTAPI_MODULES,
  FASTAPI_PATH_KEYWORD,
  FASTAPI_PREFIX_FACTORIES,
  FASTAPI_PREFIX_KEYWORD,
  FASTAPI_ROUTE_VERBS,
  PYTHON_LANGUAGES,
  PYTHON_METHODS_KEYWORD,
} from './constants.js';
import { pythonDecoratorRoutes } from './python-routes.js';
import type { PythonRouteFramework } from './types.js';

const FASTAPI: PythonRouteFramework = {
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

export const FASTAPI_PRESET: DetectionPreset = {
  name: FASTAPI.name,
  languages: PYTHON_LANGUAGES,
  detect(symbol, context) {
    return pythonDecoratorRoutes(FASTAPI, symbol, context);
  },
};
