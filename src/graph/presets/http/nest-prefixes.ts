// NestJS 라우트 앞에 붙는 경로: 앱 전역 접두어와 RouterModule 모듈 경로
// - `app.setGlobalPrefix('api', { exclude: ['health'] })`: 저장소 전체에서 값이 하나로 정해질 때만 모든 라우트에 붙인다
//   값을 못 읽었거나(실행 중 값) 앱마다 값이 다르면 붙이지 않고 근거에 남긴다
// - `@Module({ controllers: [OrderController], imports: [RouterModule.register(routes)] })`: routes 상수의 `{ path, module, children }` 를 따라
//   모듈 → 경로를 만들고, 그 모듈의 컨트롤러 라우트 앞에 붙인다. 데코레이터 안에 배열을 바로 적은 꼴은 값이 가려져 읽지 못한다
import type {
  CodeSiteArgument,
  ExtractedSymbol,
  PresetContext,
} from '../../types.js';
import { readMethod, staticText, staticTexts } from './arguments.js';
import {
  NEST_GLOBAL_PREFIX,
  NEST_GLOBAL_PREFIX_EXCLUDE,
  NEST_MODULE_DECORATOR,
  NEST_ROUTER_MODULE_REGISTER,
  NEST_ROUTE_TREE_DEPTH,
  SCRIPT_LANGUAGES,
} from './constants.js';
import { mountSite } from './mounts.js';
import { joinHttpPaths } from './paths.js';
import { callSites, constantArgument } from './repository.js';
import { splitMemberCall } from './routes.js';
import type {
  NestGlobalPrefix,
  NestModulePrefix,
  NestPrefixes,
} from './types.js';

const cache = new WeakMap<readonly ExtractedSymbol[], NestPrefixes>();

/** 저장소의 NestJS 경로 앞머리. 심볼 목록이 없으면 비어 있다 */
export function nestPrefixes(context: PresetContext): NestPrefixes {
  const symbols = context.symbols;
  if (!symbols) {
    return { global: { exclude: [], notes: [] }, controllers: new Map() };
  }
  const cached = cache.get(symbols);
  if (cached) {
    return cached;
  }
  const scripts = symbols.filter((symbol) =>
    SCRIPT_LANGUAGES.includes(symbol.language),
  );
  const prefixes = {
    global: globalPrefix(scripts, context),
    controllers: controllerPrefixes(scripts, context),
  };
  cache.set(symbols, prefixes);
  return prefixes;
}

/** 전역 접두어를 붙이지 않는 라우트인지 */
export function isExcluded(
  global: NestGlobalPrefix,
  path: string,
  method: string,
): boolean {
  const normalized = joinHttpPaths(path);
  return global.exclude.some(
    (entry) =>
      entry.path === normalized &&
      (entry.method === undefined || entry.method === method),
  );
}

function globalPrefix(
  symbols: readonly ExtractedSymbol[],
  context: PresetContext,
): NestGlobalPrefix {
  const values = new Map<string, { filePath: string; site: string }>();
  const exclude: NestGlobalPrefix['exclude'] = [];
  const notes: string[] = [];
  for (const symbol of symbols) {
    for (const site of callSites(symbol)) {
      if (
        site.kind !== 'call' ||
        splitMemberCall(site.name)?.member !== NEST_GLOBAL_PREFIX
      ) {
        continue;
      }
      const where = mountSite(symbol, site);
      const value = staticText(site.args[0], context, symbol);
      if (value === undefined) {
        notes.push(`global prefix at ${where} is not readable`);
        continue;
      }
      if (!values.has(value)) {
        values.set(value, { filePath: symbol.filePath, site: where });
      }
      exclude.push(
        ...excludedRoutes(
          site.args[1]?.properties?.[NEST_GLOBAL_PREFIX_EXCLUDE],
          symbol,
          context,
        ),
      );
    }
  }
  if (values.size > 1) {
    return {
      exclude: [],
      notes: [
        ...notes,
        `several global prefixes (${[...values.keys()].join(', ')}), none applied`,
      ],
    };
  }
  const [only] = [...values.entries()];
  if (!only || notes.length > 0) {
    return { exclude: [], notes };
  }
  return {
    prefix: only[0],
    filePath: only[1].filePath,
    site: only[1].site,
    exclude,
    notes,
  };
}

/** exclude 항목: 문자열 경로, 또는 `{ path, method: RequestMethod.GET }` */
function excludedRoutes(
  argument: CodeSiteArgument | undefined,
  symbol: ExtractedSymbol,
  context: PresetContext,
): NestGlobalPrefix['exclude'] {
  return (argument?.elements ?? []).flatMap((element) => {
    const target = element.properties?.path ?? element;
    const path = staticText(target, context, symbol);
    if (path === undefined) {
      return [];
    }
    const method = readMethod(element.properties?.method, context);
    return [
      {
        path: joinHttpPaths(path),
        ...(method !== undefined ? { method } : {}),
      },
    ];
  });
}

/** 컨트롤러 클래스 이름 → RouterModule 경로. `@Module` 의 controllers 와 RouterModule.register 인자 상수로 만든다 */
function controllerPrefixes(
  symbols: readonly ExtractedSymbol[],
  context: PresetContext,
): Map<string, NestModulePrefix[]> {
  const controllerModules = new Map<string, string[]>();
  const modulePaths = new Map<string, NestModulePrefix[]>();
  const addPath = (module: string, prefix: NestModulePrefix): void => {
    const list = modulePaths.get(module) ?? [];
    if (!list.some((item) => item.prefix === prefix.prefix)) {
      list.push(prefix);
    }
    modulePaths.set(module, list);
  };
  const walk = (
    elements: readonly CodeSiteArgument[],
    base: string,
    owner: ExtractedSymbol,
    depth: number,
  ): void => {
    for (const element of elements) {
      if (element.identifier !== undefined) {
        addPath(leaf(element.identifier), {
          prefix: joinHttpPaths(base),
          filePath: owner.filePath,
        });
        continue;
      }
      const properties = element.properties;
      const path = properties?.path
        ? staticTexts(properties.path, context, owner)[0]
        : '';
      if (!properties || path === undefined) {
        continue;
      }
      const full = joinHttpPaths(base, path);
      const module = properties.module?.identifier;
      if (module !== undefined) {
        addPath(leaf(module), { prefix: full, filePath: owner.filePath });
      }
      const children = properties.children?.elements;
      if (children && depth < NEST_ROUTE_TREE_DEPTH) {
        walk(children, full, owner, depth + 1);
      }
    }
  };
  for (const symbol of symbols) {
    for (const site of symbol.sites ?? []) {
      if (site.kind !== 'decorator' || site.name !== NEST_MODULE_DECORATOR) {
        continue;
      }
      const options = site.args[0]?.properties;
      for (const controller of options?.controllers?.elements ?? []) {
        if (controller.identifier !== undefined) {
          const name = leaf(controller.identifier);
          controllerModules.set(name, [
            ...(controllerModules.get(name) ?? []),
            symbol.symbol,
          ]);
        }
      }
      for (const imported of options?.imports?.elements ?? []) {
        const routes = NEST_ROUTER_MODULE_REGISTER.exec(imported.text)?.[1];
        const found =
          routes === undefined
            ? undefined
            : constantArgument(symbol, routes, context);
        if (found?.argument.elements) {
          walk(found.argument.elements, '', found.owner, 0);
        }
      }
    }
  }
  const controllers = new Map<string, NestModulePrefix[]>();
  for (const [controller, modules] of controllerModules) {
    const prefixes = modules.flatMap((module) => modulePaths.get(module) ?? []);
    if (prefixes.length > 0) {
      controllers.set(controller, prefixes);
    }
  }
  return controllers;
}

function leaf(identifier: string): string {
  return identifier.split('.').at(-1) ?? identifier;
}
