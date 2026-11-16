// HTTP_CALLS: 모든 저장소의 받는 라우트 표 × 부르는 쪽 호출
// - 바깥 서비스(hints.external)에 맞는 호출은 잇지 않고 external 로 남긴다
// - 프록시 접두어(hints.proxyPrefixes)는 떼고 대상 저장소를 정한다. 아니면 주소 변수(hints.baseUrls)로 대상 저장소를 정한다
// - 힌트가 없으면 다른 저장소 전부에서 찾는다. 같은 저장소에 맞는 라우트가 있으면 저장소 안 호출로 보고 잇지 않는다(토폴로지의 몫)
// - 받는 처리기가 정확히 하나일 때만 잇는다. 힌트로 저장소를 정했으면 high, 아니면 medium
// - `/`, `/health` 같은 흔한 경로는 힌트 없이 잇지 않는다
import type { CurrentSymbolRecord } from '../../extensions/code-knowledge.js';
import { compareText } from '../files.js';
import type {
  GraphHints,
  HttpCallDetection,
  HttpRouteDetection,
} from '../types.js';
import { TRIVIAL_PATH_SEGMENTS } from './constants.js';
import {
  identifierMatches,
  type LinkContext,
  recordLabel,
  relationConfidence,
  unresolvedAt,
  uniqueRecords,
} from './context.js';
import type { HttpTargetHint, LinkDraft, LinkResult } from './types.js';

/** 매개변수 조각 하나로 맞추는 표시 */
const PARAMETER = ':param';

interface RouteProvider {
  detection: HttpRouteDetection;
  record: CurrentSymbolRecord;
  method: string;
}

export function linkHttp(context: LinkContext): LinkResult {
  const hints = context.config.hints;
  const providers = new Map<string, RouteProvider[]>();
  for (const route of context.detectionsOf('http-route')) {
    const record = context.recordFor(route);
    if (!record) {
      continue;
    }
    const key = routeKey(route.path);
    const list = providers.get(key) ?? [];
    list.push({ detection: route, record, method: route.method.toUpperCase() });
    providers.set(key, list);
  }

  const result: LinkResult = { drafts: [], unresolved: [] };
  for (const call of context.detectionsOf('http-call')) {
    const caller = context.recordFor(call);
    if (!caller) {
      continue;
    }
    const method = call.method.toUpperCase();
    const external = externalEntry(call, hints.external ?? []);
    if (external) {
      result.unresolved.push(
        unresolvedAt(call, 'HTTP_CALLS', 'external', externalValue(call)),
      );
      continue;
    }
    if (call.path === undefined) {
      result.unresolved.push(
        unresolvedAt(
          call,
          'HTTP_CALLS',
          'dynamic-target',
          `${method} <dynamic>`,
        ),
      );
      continue;
    }
    const hint = targetHint(call, routeKey(call.path), hints);
    const path = hint?.path ?? routeKey(call.path);
    const value = `${method} ${path}`;
    if (hint?.repository === caller.repository) {
      continue;
    }
    const matching = (providers.get(path) ?? []).filter((provider) =>
      methodMatches(provider.method, method),
    );
    if (
      !hint &&
      matching.some(
        (provider) => provider.record.repository === caller.repository,
      )
    ) {
      continue;
    }
    const cross = matching.filter(
      (provider) =>
        provider.record.repository !== caller.repository &&
        (!hint || provider.record.repository === hint.repository),
    );
    const handlers = uniqueRecords(cross.map((provider) => provider.record));
    if (handlers.length === 0) {
      result.unresolved.push(
        unresolvedAt(call, 'HTTP_CALLS', 'no-provider', value),
      );
      continue;
    }
    if (handlers.length > 1 || (!hint && isTrivialPath(path))) {
      result.unresolved.push(
        unresolvedAt(call, 'HTTP_CALLS', 'ambiguous-provider', value, handlers),
      );
      continue;
    }
    const provider = cross.find(
      (candidate) =>
        candidate.record.stableSymbolId === handlers[0].stableSymbolId,
    ) as RouteProvider;
    result.drafts.push(httpDraft(call, caller, provider, path, hint));
  }
  return result;
}

/**
 * 맞추는 열쇠로 쓰는 경로. 호스트·질의·해시를 떼고, 매개변수 조각(`:id`, `{id}`, `<id>`, `[id]`, `${…}` 가 든 조각)은 `:param` 하나로,
 * 빈 조각과 끝 `/` 는 없앤다. 탐지 단계가 이미 정규화했어도 다른 프리셋이 남긴 꼴을 한 번 더 맞춘다
 */
export function routeKey(path: string): string {
  const withoutOrigin = path
    .trim()
    .replace(/^(?:[a-z][a-z\d+.-]*:)?\/\/[^/]*/i, '');
  const pathOnly = withoutOrigin.split(/[?#]/, 1)[0] ?? '';
  const segments = pathOnly
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) =>
      /^:|^\{.*\}$|^<.*>$|^\[.*\]$|\$\{|^\*$/.test(segment)
        ? PARAMETER
        : segment,
    );
  return `/${segments.join('/')}`;
}

/** 경로만으로는 처리기를 고를 수 없는 경로인지: `/`, 매개변수 조각만 있는 경로, 흔한 조각 하나(`/health`) */
export function isTrivialPath(key: string): boolean {
  const segments = key.split('/').filter(Boolean);
  if (segments.every((segment) => segment === PARAMETER)) {
    return true;
  }
  return (
    segments.length === 1 &&
    TRIVIAL_PATH_SEGMENTS.includes(segments[0].toLowerCase())
  );
}

/**
 * 힌트로 정한 대상 저장소. 프록시 접두어(긴 것부터)가 맞으면 떼고 그 저장소, 아니면 주소 변수가 가리키는 저장소가 하나일 때 그 저장소
 * 주소 변수가 서로 다른 저장소를 가리키면 힌트가 없는 것으로 본다
 */
export function targetHint(
  call: HttpCallDetection,
  path: string,
  hints: GraphHints,
): HttpTargetHint | undefined {
  const proxies = Object.entries(hints.proxyPrefixes ?? {})
    .map(([prefix, repository]) => [routeKey(prefix), repository] as const)
    .sort(
      ([left], [right]) =>
        right.length - left.length || compareText(left, right),
    );
  for (const [prefix, repository] of proxies) {
    if (prefix === '/') {
      continue;
    }
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return {
        repository,
        path: routeKey(path.slice(prefix.length)),
        note: `proxy prefix ${prefix} points to ${repository}`,
      };
    }
  }
  const named = Object.entries(hints.baseUrls ?? {})
    .filter(([name]) =>
      call.baseIdentifiers.some((identifier) =>
        identifierMatches(identifier, name),
      ),
    )
    .sort(([left], [right]) => compareText(left, right));
  const repositories = new Set(named.map(([, repository]) => repository));
  if (repositories.size !== 1) {
    return undefined;
  }
  const [name, repository] = named[0];
  return {
    repository,
    path,
    note: `base address ${name} points to ${repository}`,
  };
}

/**
 * 호출이 바깥 서비스를 부르는지. hints.external 의 항목이 호스트(또는 주소)면 같은 호스트나 그 하위 호스트,
 * 이름이면 주소 변수 이름, `/` 로 시작하면 그 경로 접두어에 맞춘다
 */
export function externalEntry(
  call: HttpCallDetection,
  entries: readonly string[],
): string | undefined {
  const host = call.host?.toLowerCase();
  const path = call.path === undefined ? undefined : routeKey(call.path);
  return [...entries].sort(compareText).find((entry) => {
    const text = entry.trim();
    if (text.startsWith('/')) {
      const prefix = routeKey(text);
      return (
        path !== undefined &&
        prefix !== '/' &&
        (path === prefix || path.startsWith(`${prefix}/`))
      );
    }
    const hinted = entryHost(text);
    if (host && (host === hinted || host.endsWith(`.${hinted}`))) {
      return true;
    }
    return call.baseIdentifiers.some((identifier) =>
      identifierMatches(identifier, text),
    );
  });
}

function httpDraft(
  call: HttpCallDetection,
  caller: CurrentSymbolRecord,
  provider: RouteProvider,
  path: string,
  hint: HttpTargetHint | undefined,
): LinkDraft {
  const method =
    provider.method === '*' ? call.method.toUpperCase() : provider.method;
  return {
    relation: 'HTTP_CALLS',
    source: caller,
    target: provider.record,
    extraction: {
      kind: 'route',
      locator: `${call.filePath}:${call.line}`,
      value: `${method} ${path}`,
    },
    confidence: relationConfidence(hint !== undefined, [
      call.confidence,
      provider.detection.confidence,
    ]),
    evidence: [
      `call ${call.method.toUpperCase()} ${call.path ?? ''} (${call.detector})`,
      `route ${provider.method} ${provider.detection.path} at ${recordLabel(provider.record)} (${provider.detection.detector})`,
      hint?.note ?? 'only matching route in the other repositories',
    ],
    roles: { caller, handler: provider.record },
  };
}

function methodMatches(route: string, call: string): boolean {
  return route === '*' || call === '*' || route === call;
}

function externalValue(call: HttpCallDetection): string {
  const where = call.host ?? call.baseIdentifiers[0] ?? '';
  return `${call.method.toUpperCase()} ${where}${call.path ?? ''}`.trim();
}

/** 주소면 호스트만, 아니면 그 글을 소문자로. 계정 정보와 포트는 뗀다 */
function entryHost(entry: string): string {
  const address = /^[a-z][a-z\d+.-]*:\/\/([^/?#]+)/i.exec(entry);
  return (address ? address[1].replace(/^[^@]*@/, '') : entry)
    .toLowerCase()
    .replace(/:\d+$/, '');
}
