// Python 데코레이터 라우트(FastAPI, Flask)가 함께 쓰는 도우미
// `@router.get('/{order_id}')` 의 받는 쪽 router 를 같은 파일이나 가져온 파일의 `APIRouter(prefix=…)`·`Blueprint(url_prefix=…)` 와 이어 접두어를 붙인다
// 받는 쪽을 못 찾아도 그 프레임워크를 가져온 파일이면 접두어 없이 낮은 신뢰도로 낸다
import type {
  CodeSite,
  ExtractedSymbol,
  HttpRouteDetection,
  PresetContext,
} from '../../types.js';
import {
  keywordArguments,
  positionalArguments,
  readMethods,
  staticText,
  staticTexts,
} from './arguments.js';
import {
  DECORATOR_ROUTE_CONFIDENCE,
  DECORATOR_ROUTE_PARTIAL_CONFIDENCE,
  DEFAULT_HTTP_METHOD,
  WEAK_BINDING_PENALTY,
} from './constants.js';
import { joinHttpPaths } from './paths.js';
import {
  bindReceiver,
  fileImportsModule,
  isOwnDecorator,
  isWeakBinding,
} from './repository.js';
import { routeDetections, splitMemberCall } from './routes.js';
import type { PythonRouteFramework } from './types.js';

/** 데코레이터 라우트를 읽는다. 함수·메서드 심볼에만 데코레이터가 붙는다 */
export function pythonDecoratorRoutes(
  framework: PythonRouteFramework,
  symbol: ExtractedSymbol,
  context: PresetContext,
): HttpRouteDetection[] {
  return (symbol.sites ?? []).flatMap((site) => {
    if (!isOwnDecorator(symbol, site)) {
      return [];
    }
    const call = splitMemberCall(site.name);
    if (!call) {
      return [];
    }
    const methods = decoratorMethods(framework, call.member, site, context);
    if (methods.length === 0) {
      return [];
    }
    const pathArgument =
      positionalArguments(site)[0] ??
      keywordArguments(site)[framework.pathKeyword];
    const paths = staticTexts(pathArgument, context);
    return pythonRoutes(framework, {
      symbol,
      site,
      receiver: call.receiver,
      methods,
      paths,
      target: { symbol, line: site.line },
      context,
    });
  });
}

/** 라우트 경로와 메서드를 받는 쪽 근거와 함께 탐지로 바꾼다. 근거가 없으면 내지 않는다 */
export function pythonRoutes(
  framework: PythonRouteFramework,
  input: {
    symbol: ExtractedSymbol;
    site: CodeSite;
    receiver: string;
    methods: string[];
    paths: string[];
    target: { symbol: ExtractedSymbol; line: number; note?: string };
    context: PresetContext;
  },
): HttpRouteDetection[] {
  const { symbol, site, receiver, context } = input;
  if (input.paths.length === 0) {
    return [];
  }
  const binding = bindReceiver(
    symbol,
    receiver,
    site,
    framework.factories,
    context,
  );
  let confidence: number;
  let prefix = '';
  let evidence = `${site.name} at line ${site.line}`;
  if (binding?.site) {
    confidence = isWeakBinding(binding)
      ? DECORATOR_ROUTE_CONFIDENCE - WEAK_BINDING_PENALTY
      : DECORATOR_ROUTE_CONFIDENCE;
    if (framework.prefixFactories.includes(binding.site.name)) {
      prefix =
        staticText(
          keywordArguments(binding.site)[framework.prefixKeyword],
          context,
        ) ?? '';
    }
    evidence += `; ${receiver} from ${binding.site.name} in ${binding.owner.filePath}`;
    if (prefix) {
      evidence += ` with prefix '${prefix}'`;
    }
  } else if (fileImportsModule(symbol, framework.modules, context)) {
    confidence = DECORATOR_ROUTE_PARTIAL_CONFIDENCE;
    evidence += `; ${receiver} not found, prefix unknown`;
  } else {
    return [];
  }
  if (input.target.note) {
    evidence += `; ${input.target.note}`;
  }
  return routeDetections({
    target: { ...input.target, evidence },
    detector: framework.name,
    confidence,
    methods: input.methods,
    paths: input.paths.map((path) => joinHttpPaths(prefix, path)),
    context,
  });
}

function decoratorMethods(
  framework: PythonRouteFramework,
  member: string,
  site: CodeSite,
  context: PresetContext,
): string[] {
  if (framework.verbs.includes(member)) {
    return [member.toUpperCase()];
  }
  if (member !== framework.methodsDecorator) {
    return [];
  }
  const methods = readMethods(
    keywordArguments(site)[framework.methodsKeyword],
    context,
  );
  return methods.length > 0 ? methods : [DEFAULT_HTTP_METHOD];
}
