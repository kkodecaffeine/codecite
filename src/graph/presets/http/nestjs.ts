// NestJS 라우트 프리셋. 메서드의 `@Get(':id')` 경로 앞에 같은 파일 컨트롤러 클래스의 `@Controller('orders')` 기본 경로를 붙인다
// 매개변수 데코레이터(`@Query('page')`, `@Param('id')`)는 메서드 데코레이터가 아니라서 DECORATED_BY 관계로 걸러 낸다
import type {
  CodeSiteArgument,
  DetectionPreset,
  ExtractedSymbol,
  PresetContext,
} from '../../types.js';
import { staticTexts } from './arguments.js';
import {
  DECORATOR_ROUTE_CONFIDENCE,
  DECORATOR_ROUTE_PARTIAL_CONFIDENCE,
  NEST_CONTROLLER_DECORATOR,
  NEST_ROUTE_DECORATORS,
  SCRIPT_LANGUAGES,
} from './constants.js';
import { joinHttpPaths } from './paths.js';
import { fileSymbol, isOwnDecorator } from './repository.js';
import { routeDetections } from './routes.js';

export const NESTJS_HTTP_PRESET: DetectionPreset = {
  name: 'nestjs',
  languages: SCRIPT_LANGUAGES,
  detect(symbol, context) {
    const dot = symbol.symbol.indexOf('.');
    if (symbol.kind !== 'method' || dot <= 0) {
      return [];
    }
    const routes = (symbol.sites ?? []).filter(
      (site) =>
        NEST_ROUTE_DECORATORS[site.name] !== undefined &&
        isOwnDecorator(symbol, site),
    );
    if (routes.length === 0) {
      return [];
    }
    const controller = controllerPaths(
      symbol,
      symbol.symbol.slice(0, dot),
      context,
    );
    return routes.flatMap((site) => {
      const method = NEST_ROUTE_DECORATORS[site.name] ?? '';
      const children = routePaths(site.args[0], context);
      if (children === undefined) {
        return [];
      }
      const bases = controller?.paths ?? [''];
      const paths = bases.flatMap((base) =>
        children.map((child) => joinHttpPaths(base, child)),
      );
      const evidence = controller
        ? `@${site.name}(${quoted(children)}) under @${NEST_CONTROLLER_DECORATOR}(${quoted(controller.paths)})`
        : `@${site.name}(${quoted(children)}); controller base path not found`;
      return routeDetections({
        target: { symbol, line: site.line, evidence },
        detector: NESTJS_HTTP_PRESET.name,
        confidence: controller
          ? DECORATOR_ROUTE_CONFIDENCE
          : DECORATOR_ROUTE_PARTIAL_CONFIDENCE,
        methods: [method],
        paths,
        context,
      });
    });
  },
};

/** 데코레이터 경로 인자. 비우면 기본 경로 그대로, 배열이면 경로마다. 읽지 못하면 undefined */
function routePaths(
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
): string[] | undefined {
  if (!argument) {
    return [''];
  }
  const target = argument.properties?.path ?? argument;
  const paths = staticTexts(target, context);
  return paths.length > 0 ? paths : undefined;
}

/** 같은 파일에서 이 메서드의 클래스를 찾아 `@Controller` 기본 경로를 읽는다. 클래스를 못 찾으면 undefined */
function controllerPaths(
  method: ExtractedSymbol,
  className: string,
  context: PresetContext,
): { paths: string[] } | undefined {
  const owner = fileSymbol(method.filePath, className, context);
  const decorator = owner?.sites?.find(
    (site) =>
      site.kind === 'decorator' && site.name === NEST_CONTROLLER_DECORATOR,
  );
  if (!owner || !decorator) {
    return undefined;
  }
  const paths = routePaths(decorator.args[0], context);
  return paths ? { paths } : undefined;
}

function quoted(paths: readonly string[]): string {
  return paths.map((path) => `'${path}'`).join(', ');
}
