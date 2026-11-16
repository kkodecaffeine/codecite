// 라우터 마운트 접두어. 서비스는 라우터를 앱 아래 접두어로 붙이므로(`app.use('/api', ordersRouter)`),
// 라우트 경로에 그 접두어를 붙여야 부르는 쪽 `/api/orders` 와 받는 쪽 경로가 맞는다
// - 저장소마다 마운트 간선을 한 번 모으고(같은 심볼 배열이면 재사용), 라우터마다 맨 위 앱까지 거슬러 올라가 접두어를 잇는다
// - 여러 곳에 붙은 라우터는 접두어마다 경로를 낸다. 접두어를 못 읽은 마운트는 접두어를 붙이지 않고 근거에 남긴다. 짐작하지 않는다
// - 순환 마운트는 지나온 길을 기억해 끊는다. 간선은 심볼 배열 순서(파일·줄 순서)로 모아 결과가 늘 같다
import type {
  CodeSite,
  CodeSiteArgument,
  ExtractedSymbol,
  PresetContext,
} from '../../types.js';
import { staticTexts } from './arguments.js';
import { MAX_MOUNT_PREFIXES, MOUNT_CROSS_FILE_PENALTY } from './constants.js';
import { joinHttpPaths } from './paths.js';
import {
  bindReceiver,
  callSites,
  factorySite,
  namedSymbols,
} from './repository.js';
import type {
  FactoryMatcher,
  MountEdge,
  MountFramework,
  MountGraph,
  MountResolution,
  PrefixedRoutes,
  ReceiverBinding,
} from './types.js';

const graphs = new WeakMap<
  readonly ExtractedSymbol[],
  Map<string, MountGraph>
>();

/** 라우터를 만든 자리의 열쇠. 타입 표기로만 안 받는 쪽은 만든 자리가 없어 열쇠도 없다 */
export function routerKey(
  binding: ReceiverBinding | undefined,
): string | undefined {
  return binding?.site
    ? `${binding.owner.filePath}#${binding.owner.symbol}@${binding.site.line}`
    : undefined;
}

/** 플러그인 함수(Fastify)의 열쇠. 함수 안에서 매개변수로 받은 인스턴스에 등록한 라우트가 이 열쇠를 쓴다 */
export function functionKey(symbol: ExtractedSymbol): string {
  return `${symbol.filePath}#${symbol.symbol}`;
}

/** 근거에 적는 마운트 자리 */
export function mountSite(symbol: ExtractedSymbol, site: CodeSite): string {
  return `${site.name} at ${symbol.filePath}:${site.line}`;
}

/** 저장소의 마운트 간선. 심볼 목록이 없으면 undefined */
export function mountGraph(
  framework: MountFramework,
  context: PresetContext,
): MountGraph | undefined {
  const symbols = context.symbols;
  if (!symbols) {
    return undefined;
  }
  let byFramework = graphs.get(symbols);
  if (!byFramework) {
    byFramework = new Map();
    graphs.set(symbols, byFramework);
  }
  const cached = byFramework.get(framework.name);
  if (cached) {
    return cached;
  }
  const incoming = new Map<string, MountEdge[]>();
  const owns = new Map<string, string>();
  const builder = {
    addEdge(edge: MountEdge) {
      const list = incoming.get(edge.child) ?? [];
      list.push(edge);
      incoming.set(edge.child, list);
    },
    setOwn(key: string, prefix: string) {
      if (!owns.has(key)) {
        owns.set(key, prefix);
      }
    },
  };
  for (const symbol of symbols) {
    if (!framework.languages.includes(symbol.language)) {
      continue;
    }
    for (const site of callSites(symbol)) {
      if (site.kind === 'call') {
        framework.read(symbol, site, context, builder);
      }
    }
  }
  const graph = { incoming, owns };
  byFramework.set(framework.name, graph);
  return graph;
}

/**
 * 라우터 하나의 접두어 목록. 자기 접두어(own)와 마운트 자리 접두어를 맨 위 앱까지 잇는다
 * 마운트가 없거나 모두 못 읽었으면 자기 접두어 하나를 그대로 돌려준다
 */
export function mountedPrefixes(
  framework: MountFramework,
  key: string | undefined,
  own: string,
  context: PresetContext,
): MountResolution {
  const graph = key === undefined ? undefined : mountGraph(framework, context);
  const asIs: MountResolution = {
    prefixes: [{ prefix: joinHttpPaths(own), crossFile: false, via: [] }],
    notes: [],
  };
  if (!graph || key === undefined) {
    return asIs;
  }
  const ownOf = (current: string): string =>
    current === key ? own : (graph.owns.get(current) ?? '');
  const visit = (
    current: string,
    path: ReadonlySet<string>,
  ): MountResolution => {
    const edges = graph.incoming.get(current) ?? [];
    const self = joinHttpPaths(ownOf(current));
    if (edges.length === 0) {
      return {
        prefixes: [{ prefix: self, crossFile: false, via: [] }],
        notes: [],
      };
    }
    const result: MountResolution = { prefixes: [], notes: [] };
    for (const edge of edges) {
      if (edge.unresolved !== undefined) {
        result.notes.push(
          `mount ${edge.site} has unreadable prefix ${edge.unresolved}`,
        );
        continue;
      }
      if (edge.parent !== undefined && path.has(edge.parent)) {
        result.notes.push(`mount cycle at ${edge.site}`);
        continue;
      }
      const upper =
        edge.parent === undefined
          ? {
              prefixes: [{ prefix: '/', crossFile: false, via: [] }],
              notes: [],
            }
          : visit(edge.parent, new Set([...path, current]));
      result.notes.push(...upper.notes);
      const part = framework.combine(edge.prefix, ownOf(current));
      for (const above of upper.prefixes) {
        if (result.prefixes.length >= MAX_MOUNT_PREFIXES) {
          break;
        }
        result.prefixes.push({
          prefix: joinHttpPaths(above.prefix, part),
          crossFile: above.crossFile || edge.crossFile,
          via: [...above.via, edge.site],
        });
      }
    }
    if (result.prefixes.length === 0) {
      result.prefixes.push({ prefix: self, crossFile: false, via: [] });
    }
    return {
      prefixes: uniquePrefixes(result.prefixes),
      notes: [...new Set(result.notes)],
    };
  };
  return visit(key, new Set([key]));
}

/** 같은 접두어는 하나로. 같은 파일 마운트로 닿는 길이 있으면 그 길을 남긴다 */
function uniquePrefixes(
  prefixes: MountResolution['prefixes'],
): MountResolution['prefixes'] {
  const byPrefix = new Map<string, MountResolution['prefixes'][number]>();
  for (const item of prefixes) {
    const seen = byPrefix.get(item.prefix);
    if (!seen || (seen.crossFile && !item.crossFile)) {
      byPrefix.set(item.prefix, item);
    }
  }
  return [...byPrefix.values()];
}

/**
 * 라우트 경로에 접두어를 붙인다. 접두어마다 경로 묶음 하나이고, 다른 파일의 마운트를 거쳤으면 신뢰도를 조금 낮춘다
 * 근거에는 거친 마운트 자리와 못 읽은 마운트 알림을 덧붙인다
 */
export function prefixRoutes(
  resolution: MountResolution,
  paths: readonly string[],
  confidence: number,
  evidence: string,
): PrefixedRoutes[] {
  const notes =
    resolution.notes.length > 0 ? `; ${resolution.notes.join('; ')}` : '';
  return resolution.prefixes.map((item) => ({
    paths: paths.map((path) => joinHttpPaths(item.prefix, path)),
    confidence: Number(
      (item.crossFile
        ? confidence - MOUNT_CROSS_FILE_PENALTY
        : confidence
      ).toFixed(2),
    ),
    evidence:
      item.via.length > 0
        ? `${evidence}; mounted at '${item.prefix}' via ${item.via.join(' > ')}${notes}`
        : `${evidence}${notes}`,
  }));
}

/**
 * 마운트 자리 인자가 가리키는 라우터. 받는 쪽 이름 찾기와 같은 규칙으로 만든 자리를 찾는다
 * - 이름(`ordersRouter`): 같은 심볼·같은 파일·가져온 파일
 * - 모듈 멤버(`orders.router`): 가져온 모듈 파일의 그 이름
 * - 라우터를 만들어 돌려주는 함수 호출(`createOrderRouter()`): 그 함수 안에서 라우터를 만드는 자리가 하나일 때
 */
export function mountedRouter(
  symbol: ExtractedSymbol,
  site: CodeSite,
  argument: CodeSiteArgument | undefined,
  matcher: FactoryMatcher,
  context: PresetContext,
): { key: string; binding: ReceiverBinding } | undefined {
  if (!argument) {
    return undefined;
  }
  const name = argument.identifier;
  if (name !== undefined && !name.includes('.')) {
    const binding = bindReceiver(symbol, name, site, matcher, context);
    const key = routerKey(binding);
    return binding && key ? { key, binding } : undefined;
  }
  const called =
    name === undefined ? /^([\w$.]+)\s*\(/.exec(argument.text)?.[1] : undefined;
  const target = name ?? called;
  if (target === undefined) {
    return undefined;
  }
  const owners = namedSymbols(symbol, target, context).symbols.filter(
    (owner) =>
      called === undefined ||
      owner.kind === 'function' ||
      owner.kind === 'method',
  );
  const found = owners
    .map((owner) => ({ owner, made: factorySites(owner, matcher, context) }))
    .filter((item) => item.made.length === 1);
  const only = found.length === 1 ? found[0] : undefined;
  const made = only?.made[0];
  if (!only || !made) {
    return undefined;
  }
  const binding: ReceiverBinding = {
    site: made,
    owner: only.owner,
    via: only.owner.filePath === symbol.filePath ? 'file' : 'import',
  };
  const key = routerKey(binding);
  return key ? { key, binding } : undefined;
}

function factorySites(
  owner: ExtractedSymbol,
  matcher: FactoryMatcher,
  context: PresetContext,
): CodeSite[] {
  const first = factorySite(owner, matcher, context);
  if (!first) {
    return [];
  }
  return (owner.sites ?? []).filter(
    (candidate) =>
      candidate.name === first.name &&
      (candidate.kind === 'call' || candidate.kind === 'new'),
  );
}

/**
 * 마운트 자리의 접두어 인자를 읽는다. 마운트 자리 심볼 쪽에서 상수를 푼다
 * 못 읽으면 unresolved 에 원문을 담는다
 */
export function mountPrefixes(
  symbol: ExtractedSymbol,
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
): { prefixes: Array<string | undefined>; unresolved?: string } {
  if (!argument) {
    return { prefixes: [undefined] };
  }
  const texts = staticTexts(argument, context, symbol);
  return texts.length > 0
    ? { prefixes: texts }
    : { prefixes: [], unresolved: argument.text };
}

/** 마운트 간선들을 더한다(접두어마다 하나, 못 읽었으면 알림 간선 하나) */
export function addMountEdges(
  builder: { addEdge(edge: MountEdge): void },
  input: {
    parent: string | undefined;
    child: string;
    childFile: string;
    symbol: ExtractedSymbol;
    site: CodeSite;
    prefixes: Array<string | undefined>;
    unresolved?: string;
  },
): void {
  const base = {
    ...(input.parent !== undefined ? { parent: input.parent } : {}),
    child: input.child,
    crossFile: input.childFile !== input.symbol.filePath,
    site: mountSite(input.symbol, input.site),
  };
  if (input.unresolved !== undefined) {
    builder.addEdge({ ...base, unresolved: input.unresolved });
    return;
  }
  for (const prefix of input.prefixes) {
    builder.addEdge(prefix === undefined ? base : { ...base, prefix });
  }
}
