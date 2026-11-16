// 같은 저장소의 다른 심볼을 보는 도우미. 탐지는 심볼 하나씩 하지만, 받는 쪽이 어디서 만들어졌는지는 다른 심볼에 있다
// 예: 메서드 경로 앞의 컨트롤러 기본 경로, 라우터 접두어, 다른 파일에서 만든 axios 인스턴스, 같은 파일의 처리 함수
// PresetContext.symbols 가 없으면 색인 없이 심볼 하나만 보고, 다른 심볼이 필요한 근거는 찾지 못한 것으로 둔다
import { ModuleIndex, parseImportTarget } from '../../imports.js';
import type {
  CodeSite,
  CodeSiteArgument,
  ExtractedSymbol,
  ImportedBinding,
  PresetContext,
} from '../../types.js';
import {
  CONSTRUCTOR_NAMES,
  DEFAULT_EXPORT_NAME,
  MODULE_SYMBOL_KIND,
  SELF_RECEIVERS,
  WHOLE_MODULE_NAME,
} from './constants.js';
import type {
  FactoryMatcher,
  ReceiverBinding,
  RepositorySymbolIndex,
} from './types.js';

/** 같은 배열이면 같은 색인. 파이프라인은 저장소마다 같은 배열을 넘긴다 */
const indexes = new WeakMap<
  readonly ExtractedSymbol[],
  RepositorySymbolIndex
>();

/** 저장소 심볼 색인. 심볼 목록이 없으면 undefined */
export function repositoryIndex(
  context: PresetContext,
): RepositorySymbolIndex | undefined {
  const symbols = context.symbols;
  if (!symbols) {
    return undefined;
  }
  const cached = indexes.get(symbols);
  if (cached) {
    return cached;
  }
  const byFile = new Map<string, ExtractedSymbol[]>();
  const byName = new Map<string, ExtractedSymbol[]>();
  for (const symbol of symbols) {
    append(byFile, symbol.filePath, symbol);
    append(byName, symbol.symbol, symbol);
  }
  const index = { byFile, byName, modules: new ModuleIndex(byFile.keys()) };
  indexes.set(symbols, index);
  return index;
}

function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

/** 같은 파일의 심볼. 색인이 없으면 이 심볼 하나 */
export function fileSymbols(
  symbol: ExtractedSymbol,
  context: PresetContext,
): readonly ExtractedSymbol[] {
  return repositoryIndex(context)?.byFile.get(symbol.filePath) ?? [symbol];
}

/** 같은 파일에서 이름이 같은 심볼 */
export function fileSymbol(
  filePath: string,
  name: string,
  context: PresetContext,
): ExtractedSymbol | undefined {
  return repositoryIndex(context)
    ?.byFile.get(filePath)
    ?.find((candidate) => candidate.symbol === name);
}

/** 파일 하나의 최상위 문장 심볼인지 */
export function isModuleSymbol(symbol: ExtractedSymbol): boolean {
  return symbol.kind === MODULE_SYMBOL_KIND;
}

/** 심볼에 바로 붙은 데코레이터인지. 매개변수 데코레이터(`@Query('page')`)는 DECORATED_BY 관계에 없다 */
export function isOwnDecorator(
  symbol: ExtractedSymbol,
  site: CodeSite,
): boolean {
  return (
    site.kind === 'decorator' &&
    symbol.relations.some(
      (relation) =>
        relation.type === 'DECORATED_BY' &&
        relation.target.symbol === site.name,
    )
  );
}

/** 호출·생성 자리만. assign·decorator 자리는 뺀다 */
export function callSites(symbol: ExtractedSymbol): CodeSite[] {
  return (symbol.sites ?? []).filter(
    (site) => site.kind === 'call' || site.kind === 'new',
  );
}

/** 이 심볼의 가져오기 관계를 푼다(`api as shopApi from ../lib/api`). 이름 없이 모듈만 읽은 것은 뺀다 */
export function importBindings(symbol: ExtractedSymbol): ImportedBinding[] {
  return symbol.relations
    .filter((relation) => relation.type === 'IMPORTS')
    .map((relation) => parseImportTarget(relation.target.symbol ?? ''))
    .filter((binding): binding is ImportedBinding => binding !== undefined);
}

/** 이 심볼에서 쓰는 이름을 가져온 꼴. 같은 파일 다른 심볼의 가져오기도 본다 */
export function importedName(
  symbol: ExtractedSymbol,
  local: string,
  context: PresetContext,
): ImportedBinding | undefined {
  const own = importBindings(symbol).find((binding) => binding.local === local);
  if (own) {
    return own;
  }
  for (const other of fileSymbols(symbol, context)) {
    const found = importBindings(other).find(
      (binding) => binding.local === local,
    );
    if (found) {
      return found;
    }
  }
  return undefined;
}

/** 이 파일이 그 모듈(또는 그 아래 경로)에서 무엇이든 가져오는지 */
export function fileImportsModule(
  symbol: ExtractedSymbol,
  modules: readonly string[],
  context: PresetContext,
): boolean {
  return fileSymbols(symbol, context).some((other) =>
    importBindings(other).some((binding) =>
      modules.some(
        (module) =>
          binding.specifier === module ||
          binding.specifier.startsWith(`${module}/`) ||
          binding.specifier.startsWith(`${module}.`),
      ),
    ),
  );
}

/** 선언 원문이 `export default` 로 시작하는지. 원문 맨 앞은 선언 문법이라 주석·문자열이 아니다 */
export function isDefaultExport(symbol: ExtractedSymbol): boolean {
  return (
    symbol.symbol === DEFAULT_EXPORT_NAME ||
    /^export\s+default\b/.test(symbol.content)
  );
}

/**
 * 가져온 이름이 가리키는 심볼. 모듈 지정자가 저장소 안 파일로 풀리면 그 파일에서(resolved),
 * 못 풀면(패키지·경로 별칭) 저장소 전체에서 이름이 같은 것들을 돌려준다
 * 기본 내보내기는 `default` 심볼이나 `export default` 로 선언한 심볼이고, 모듈 전체(`* as x`)는 심볼 없이 파일만 돌려준다
 */
export function importedSymbols(
  symbol: ExtractedSymbol,
  binding: ImportedBinding,
  context: PresetContext,
): { symbols: ExtractedSymbol[]; files: string[]; resolved: boolean } {
  const index = repositoryIndex(context);
  if (!index) {
    return { symbols: [], files: [], resolved: false };
  }
  const files = index.modules.resolve(symbol.filePath, binding.specifier);
  if (files.length > 0) {
    const inFiles = files.flatMap((file) => index.byFile.get(file) ?? []);
    const found =
      binding.imported === WHOLE_MODULE_NAME
        ? []
        : binding.imported === DEFAULT_EXPORT_NAME
          ? inFiles.filter(isDefaultExport)
          : inFiles.filter(
              (candidate) => candidate.symbol === binding.imported,
            );
    return { symbols: found, files, resolved: true };
  }
  if (
    binding.imported === DEFAULT_EXPORT_NAME ||
    binding.imported === WHOLE_MODULE_NAME
  ) {
    return { symbols: [], files: [], resolved: false };
  }
  return {
    symbols: [...(index.byName.get(binding.imported) ?? [])],
    files: [],
    resolved: false,
  };
}

/**
 * 이름(`ordersRouter`)이나 모듈 멤버 연쇄(`orders.router`, `routes.couponRouter`)가 가리키는 심볼 후보
 * 같은 파일 → 가져온 파일 순서로 찾는다. 멤버 연쇄는 앞 이름이 모듈(`* as routes`, Python 하위 모듈 `from .routers import orders`)일 때만 푼다
 */
export function namedSymbols(
  symbol: ExtractedSymbol,
  name: string,
  context: PresetContext,
): { symbols: ExtractedSymbol[]; resolved: boolean } {
  const index = repositoryIndex(context);
  if (!index) {
    return { symbols: [], resolved: false };
  }
  const parts = name.split('.');
  const [head, member] = parts;
  if (head === undefined || parts.length > 2) {
    return { symbols: [], resolved: false };
  }
  if (member === undefined) {
    const local = (index.byFile.get(symbol.filePath) ?? []).filter(
      (candidate) => candidate.symbol === head && candidate !== symbol,
    );
    if (local.length > 0) {
      return { symbols: local, resolved: true };
    }
    const binding = importedName(symbol, head, context);
    return binding
      ? importedSymbols(symbol, binding, context)
      : { symbols: [], resolved: false };
  }
  const binding = importedName(symbol, head, context);
  if (!binding) {
    return { symbols: [], resolved: false };
  }
  const specifiers =
    binding.imported === WHOLE_MODULE_NAME
      ? [binding.specifier]
      : symbol.language === 'python'
        ? [
            `${binding.specifier}${binding.specifier.endsWith('.') ? '' : '.'}${binding.imported}`,
          ]
        : [];
  const files = specifiers.flatMap((specifier) =>
    index.modules.resolve(symbol.filePath, specifier),
  );
  return {
    symbols: files.flatMap((file) =>
      (index.byFile.get(file) ?? []).filter(
        (candidate) => candidate.symbol === member,
      ),
    ),
    resolved: files.length > 0,
  };
}

/**
 * 상수 이름(`API_PREFIX`, `Paths.ORDERS`, `Prefix.Admin`)의 값 인자를 그 이름을 쓴 심볼 쪽에서 찾는다
 * 같은 파일의 상수·열거형, 아니면 가져온 파일의 상수·열거형 하나의 assign 자리 값이다. 객체 멤버는 속성을 따라간다
 */
export function constantArgument(
  origin: ExtractedSymbol,
  identifier: string,
  context: PresetContext,
): { argument: CodeSiteArgument; owner: ExtractedSymbol } | undefined {
  const [head, ...rest] = identifier.split('.');
  if (head === undefined) {
    return undefined;
  }
  const owners = namedSymbols(origin, head, context).symbols.filter(
    (candidate) => candidate.kind === 'constant' || candidate.kind === 'enum',
  );
  const owner = owners.length === 1 ? owners[0] : undefined;
  if (!owner) {
    return undefined;
  }
  const assigns = (owner.sites ?? []).filter((site) => site.kind === 'assign');
  const exact = assigns.find((site) => site.name === identifier)?.args[0];
  if (exact) {
    return { argument: exact, owner };
  }
  let argument = assigns.find((site) => site.name === head)?.args[0];
  for (const part of rest) {
    argument = argument?.properties?.[part];
  }
  return argument ? { argument, owner } : undefined;
}

/** 만드는 호출 자리인지(`axios.create(...)`, `Router()`, `httpx.Client(...)`) */
export function isFactorySite(
  site: CodeSite,
  owner: ExtractedSymbol,
  matcher: FactoryMatcher,
  context: PresetContext,
): boolean {
  if (site.kind !== 'call' && site.kind !== 'new') {
    return false;
  }
  if (matcher.qualified.includes(site.name)) {
    return true;
  }
  if (site.name.includes('.')) {
    return false;
  }
  const binding = importedName(owner, site.name, context);
  return (
    binding !== undefined &&
    (matcher.imported[binding.specifier] ?? []).includes(binding.imported)
  );
}

/** 심볼 안의 만드는 호출 자리. 줄을 주면 그 줄에서만 */
export function factorySite(
  owner: ExtractedSymbol,
  matcher: FactoryMatcher,
  context: PresetContext,
  line?: number,
): CodeSite | undefined {
  return (owner.sites ?? []).find(
    (site) =>
      (line === undefined || site.line === line) &&
      isFactorySite(site, owner, matcher, context),
  );
}

/** 대입 사실 값이 만드는 호출로 시작하는지(`axios.create({ … })`, `await Fastify()`) */
function assignedFromFactory(
  value: string | undefined,
  owner: ExtractedSymbol,
  matcher: FactoryMatcher,
  context: PresetContext,
): boolean {
  if (value === undefined) {
    return false;
  }
  const callee = /^(?:await\s+|new\s+)?([\w$.]+)\s*\(/.exec(value)?.[1];
  return (
    callee !== undefined &&
    isFactorySite(
      { kind: 'call', name: callee, line: 0, args: [] },
      owner,
      matcher,
      context,
    )
  );
}

/** 타입 표기 글의 이름 부분(`Repository<Order>` → Repository, `axios.AxiosInstance` → AxiosInstance) */
function typeName(type: string | undefined): string | undefined {
  return type?.replace(/<.*$/s, '').trim().split('.').at(-1);
}

/**
 * 받는 쪽 이름(`router`, `this.http`, `self.client`)을 만든 자리를 찾는다
 * 찾는 차례: 같은 심볼의 대입·with 문 → 클래스 멤버(초기값, 생성자 대입, 타입 표기) → 같은 파일의 상수 → 가져온 심볼
 * 후보가 정확히 하나일 때만 잇는다
 */
export function bindReceiver(
  symbol: ExtractedSymbol,
  receiver: string,
  site: CodeSite,
  matcher: FactoryMatcher,
  context: PresetContext,
): ReceiverBinding | undefined {
  const parts = receiver.split('.');
  const [head, member] = parts;
  if (head === undefined) {
    return undefined;
  }
  if (SELF_RECEIVERS.includes(head)) {
    return parts.length === 2 && member !== undefined
      ? bindMember(symbol, receiver, member, matcher, context)
      : undefined;
  }
  if (parts.length !== 1) {
    return undefined;
  }
  return (
    bindLocal(symbol, receiver, site, matcher, context) ??
    bindInFile(symbol, receiver, matcher, context) ??
    bindImported(symbol, receiver, matcher, context)
  );
}

function bindLocal(
  symbol: ExtractedSymbol,
  receiver: string,
  site: CodeSite,
  matcher: FactoryMatcher,
  context: PresetContext,
): ReceiverBinding | undefined {
  const facts = symbol.executionFacts ?? [];
  const assigned = facts
    .filter(
      (fact) =>
        fact.kind === 'assigns' &&
        fact.subject === receiver &&
        fact.line <= site.line &&
        assignedFromFactory(fact.value, symbol, matcher, context),
    )
    .at(-1);
  if (assigned) {
    const found = factorySite(symbol, matcher, context, assigned.line);
    if (found) {
      return { site: found, owner: symbol, via: 'local' };
    }
  }
  // `with httpx.Client(...) as client:` 안의 호출은 그 with 조건 아래에 있다
  const call = facts.find(
    (fact) =>
      fact.kind === 'calls' &&
      fact.line === site.line &&
      fact.subject === site.name,
  );
  const opened = (call?.conditions ?? [])
    .map(
      (condition) => /^(?:async\s+)?with\s+([\w$.]+)\s*\(/.exec(condition)?.[1],
    )
    .filter((name): name is string => name !== undefined);
  for (const name of [...opened].reverse()) {
    const found = (symbol.sites ?? [])
      .filter(
        (candidate) =>
          candidate.name === name &&
          candidate.line <= site.line &&
          isFactorySite(candidate, symbol, matcher, context),
      )
      .at(-1);
    if (found) {
      return { site: found, owner: symbol, via: 'with' };
    }
  }
  return undefined;
}

function bindMember(
  symbol: ExtractedSymbol,
  receiver: string,
  member: string,
  matcher: FactoryMatcher,
  context: PresetContext,
): ReceiverBinding | undefined {
  const dot = symbol.symbol.indexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const className = symbol.symbol.slice(0, dot);
  const field = fileSymbol(symbol.filePath, `${className}.${member}`, context);
  const fieldSite = field && factorySite(field, matcher, context);
  if (field && fieldSite) {
    return { site: fieldSite, owner: field, via: 'member' };
  }
  const members = fileSymbols(symbol, context).filter((candidate) =>
    candidate.symbol.startsWith(`${className}.`),
  );
  const constructors = [
    ...members.filter((candidate) =>
      CONSTRUCTOR_NAMES.includes(candidate.symbol.slice(className.length + 1)),
    ),
    ...members,
  ];
  for (const owner of constructors) {
    const fact = (owner.executionFacts ?? []).find(
      (candidate) =>
        candidate.kind === 'assigns' &&
        candidate.subject === receiver &&
        assignedFromFactory(candidate.value, owner, matcher, context),
    );
    const found = fact && factorySite(owner, matcher, context, fact.line);
    if (found) {
      return { site: found, owner, via: 'member' };
    }
  }
  const owner = fileSymbol(symbol.filePath, className, context);
  const typed = owner?.members?.find((candidate) => candidate.name === member);
  const type = typeName(typed?.type);
  if (owner && type !== undefined && (matcher.types ?? []).includes(type)) {
    return { owner, via: 'type', type };
  }
  return undefined;
}

function bindInFile(
  symbol: ExtractedSymbol,
  receiver: string,
  matcher: FactoryMatcher,
  context: PresetContext,
): ReceiverBinding | undefined {
  for (const owner of fileSymbols(symbol, context)) {
    if (owner === symbol) {
      continue;
    }
    if (owner.symbol === receiver) {
      const found = factorySite(owner, matcher, context);
      if (found) {
        return { site: found, owner, via: 'file' };
      }
    }
    if (isModuleSymbol(owner)) {
      const fact = (owner.executionFacts ?? []).find(
        (candidate) =>
          candidate.kind === 'assigns' &&
          candidate.subject === receiver &&
          assignedFromFactory(candidate.value, owner, matcher, context),
      );
      const found = fact && factorySite(owner, matcher, context, fact.line);
      if (found) {
        return { site: found, owner, via: 'file' };
      }
    }
  }
  return undefined;
}

function bindImported(
  symbol: ExtractedSymbol,
  receiver: string,
  matcher: FactoryMatcher,
  context: PresetContext,
): ReceiverBinding | undefined {
  const binding = importedName(symbol, receiver, context);
  if (!binding) {
    return undefined;
  }
  const { symbols, files, resolved } = importedSymbols(
    symbol,
    binding,
    context,
  );
  const withFactory = (owners: readonly ExtractedSymbol[]) =>
    owners
      .map((owner) => ({ owner, site: factorySite(owner, matcher, context) }))
      .filter(
        (item): item is { owner: ExtractedSymbol; site: CodeSite } =>
          item.site !== undefined,
      );
  let bound = withFactory(symbols);
  // `module.exports = router`·`export default router;` 처럼 이름만 내보낸 파일은 그 파일에서 만든 것이 하나뿐일 때 그것으로 본다
  if (
    bound.length === 0 &&
    resolved &&
    (binding.imported === DEFAULT_EXPORT_NAME ||
      binding.imported === WHOLE_MODULE_NAME)
  ) {
    const index = repositoryIndex(context);
    bound = withFactory(files.flatMap((file) => index?.byFile.get(file) ?? []));
  }
  const only = bound.length === 1 ? bound[0] : undefined;
  return only
    ? {
        site: only.site,
        owner: only.owner,
        via: resolved ? 'import' : 'unique',
      }
    : undefined;
}

/** 약한 근거(파일로 못 푼 가져오기를 저장소 안 같은 이름 하나로 이음)인지. 신뢰도를 조금 낮춘다 */
export function isWeakBinding(binding: ReceiverBinding): boolean {
  return binding.via === 'unique';
}
