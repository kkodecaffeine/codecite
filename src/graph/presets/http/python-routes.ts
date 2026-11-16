// Python 데코레이터 라우트(FastAPI, Flask)가 함께 쓰는 도우미
// `@router.get('/{order_id}')` 의 받는 쪽 router 를 같은 파일이나 가져온 파일의 `APIRouter(prefix=…)`·`Blueprint(url_prefix=…)` 와 이어 접두어를 붙인다
// 앱·상위 라우터에 붙인 마운트(`include_router(router, prefix=…)`, `register_blueprint(bp, url_prefix=…)`)도 맨 위 앱까지 이어 붙인다(mounts.ts)
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
  PYTHON_LANGUAGES,
  WEAK_BINDING_PENALTY,
} from './constants.js';
import {
  addMountEdges,
  mountedPrefixes,
  mountedRouter,
  mountPrefixes,
  prefixRoutes,
  routerKey,
} from './mounts.js';
import {
  bindReceiver,
  fileImportsModule,
  isOwnDecorator,
  isWeakBinding,
} from './repository.js';
import { routeDetections, splitMemberCall } from './routes.js';
import type { MountFramework, PythonRouteFramework } from './types.js';

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
    prefix = ownPrefix(framework, binding.site, binding.owner, context);
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
  const mounted = mountedPrefixes(
    framework.mount,
    routerKey(binding),
    prefix,
    context,
  );
  return prefixRoutes(mounted, input.paths, confidence, evidence).flatMap(
    (group) =>
      routeDetections({
        target: { ...input.target, evidence: group.evidence },
        detector: framework.name,
        confidence: group.confidence,
        methods: input.methods,
        paths: group.paths,
        context,
      }),
  );
}

/** 라우터 자기 접두어(`APIRouter(prefix=…)`, `Blueprint(…, url_prefix=…)`). 만든 자리 심볼 쪽에서 상수를 푼다 */
function ownPrefix(
  framework: Pick<PythonRouteFramework, 'prefixFactories' | 'prefixKeyword'>,
  site: CodeSite | undefined,
  owner: ExtractedSymbol,
  context: PresetContext,
): string {
  return site && framework.prefixFactories.includes(site.name)
    ? (staticText(
        keywordArguments(site)[framework.prefixKeyword],
        context,
        owner,
      ) ?? '')
    : '';
}

/**
 * Python 마운트 규칙: `받는쪽.<mountMethod>(라우터, <prefixKeyword>=…)`
 * 붙는 라우터와 붙이는 쪽의 자기 접두어를 함께 적어 두어, 위로 거슬러 올라갈 때 단계마다 더한다
 */
export function pythonMounts(
  framework: Omit<PythonRouteFramework, 'mount'>,
  input: {
    method: string;
    routerKeyword: string;
    prefixKeyword: string;
    combine: MountFramework['combine'];
  },
): MountFramework {
  return {
    name: framework.name,
    languages: PYTHON_LANGUAGES,
    combine: input.combine,
    read(symbol, site, context, builder) {
      const call = splitMemberCall(site.name);
      if (!call || call.member !== input.method) {
        return;
      }
      const keywords = keywordArguments(site);
      const child = mountedRouter(
        symbol,
        site,
        positionalArguments(site)[0] ?? keywords[input.routerKeyword],
        framework.factories,
        context,
      );
      if (!child) {
        return;
      }
      builder.setOwn(
        child.key,
        ownPrefix(framework, child.binding.site, child.binding.owner, context),
      );
      const parentBinding = bindReceiver(
        symbol,
        call.receiver,
        site,
        framework.factories,
        context,
      );
      const parent = routerKey(parentBinding);
      if (parent !== undefined && parentBinding) {
        builder.setOwn(
          parent,
          ownPrefix(
            framework,
            parentBinding.site,
            parentBinding.owner,
            context,
          ),
        );
      }
      const option = keywords[input.prefixKeyword];
      addMountEdges(builder, {
        parent,
        child: child.key,
        childFile: child.binding.owner.filePath,
        symbol,
        site,
        ...(option
          ? mountPrefixes(symbol, option, context)
          : { prefixes: [undefined] }),
      });
    },
  };
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
