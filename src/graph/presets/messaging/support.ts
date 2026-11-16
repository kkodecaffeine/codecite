// 프리셋 탐지기가 함께 쓰는 도우미. 자리 인자에서 이름 읽기, 다른 심볼 찾기, 주입 멤버 잇기, 근거 글 만들기
// 탐지는 추출기가 낸 자리(sites)·멤버·관계·실행 사실만 보고, 심볼 원문을 정규식으로 훑지 않는다
import type {
  ClassMember,
  CodeSite,
  CodeSiteArgument,
  DetectionBase,
  ExtractedSymbol,
  ImportedBinding,
  PresetContext,
} from '../../types.js';
import {
  IMPORT_TARGET_SEPARATOR,
  WHOLE_MODULE_IMPORT,
} from '../../extractors/constants.js';
import { ModuleIndex, parseImportTarget } from '../../imports.js';
import {
  DEFAULT_EXPORT_NAME,
  ENV_IDENTIFIER_PREFIXES,
  MAX_EVIDENCE_LENGTH,
  PYTHON_KEYWORD_ARGUMENT_PATTERN,
  PYTHON_LANGUAGES,
  PYTHON_MODULE_SUFFIX,
  PYTHON_PACKAGE_FILE,
} from './constants.js';
import type { NameReading, SiteArguments, SymbolIndex } from './types.js';

// ── 이름 ──

/** 멤버 연쇄의 끝 이름(`this.orderQueue.add` → `add`) */
export function leafName(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

/** 끝 이름 앞의 받는 쪽(`this.orderQueue.add` → `this.orderQueue`). 없으면 undefined */
export function receiverOf(name: string): string | undefined {
  const index = name.lastIndexOf('.');
  return index < 0 ? undefined : name.slice(0, index);
}

/** `this.<이름>` 꼴 받는 쪽의 멤버 이름. 한 단계만 본다 */
export function thisMemberName(
  receiver: string | undefined,
): string | undefined {
  if (!receiver?.startsWith('this.')) {
    return undefined;
  }
  const name = receiver.slice('this.'.length);
  return /^[A-Za-z_$#][\w$]*$/.test(name) ? name : undefined;
}

/** 타입 글의 바깥 이름(`Repository<Order>` → `Repository`, `events.EventEmitter` → `EventEmitter`) */
export function typeLeaf(type: string | undefined): string | undefined {
  if (!type) {
    return undefined;
  }
  const outer = type.replace(/<[\s\S]*$/, '').trim();
  return outer ? leafName(outer) : undefined;
}

/** 타입 글의 첫 타입 인자(`Repository<Order>` → `Order`). 인자가 이름 하나가 아니면 undefined */
export function typeArgument(type: string | undefined): string | undefined {
  const match = type
    ? /^[\w$.]+\s*<\s*([A-Za-z_$][\w$.]*)\s*>$/.exec(type.trim())
    : null;
  return match?.[1];
}

/** 화살표 함수가 돌려주는 이름 하나(`() => Member` → `Member`) */
export function arrowTarget(text: string | undefined): string | undefined {
  const match = text
    ? /^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*([A-Za-z_$][\w$.]*)$/.exec(
        text.trim(),
      )
    : null;
  return match?.[1];
}

export function isEnvIdentifier(identifier: string): boolean {
  return ENV_IDENTIFIER_PREFIXES.some((prefix) =>
    identifier.startsWith(prefix),
  );
}

/**
 * 자리 인자에서 큐·이벤트 이름을 읽는다. 문자열이면 그 값, 상수 이름이면 같은 저장소 상수로 풀고,
 * 템플릿은 치환 자리를 모두 풀 수 있을 때만 정적 이름으로 본다. 못 풀면 dynamic 이고 이름은 코드에 적힌 식이다
 * 인자가 없으면 undefined. 이름을 지어내지 않는다
 */
export function readName(
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
): NameReading | undefined {
  if (!argument) {
    return undefined;
  }
  if (argument.literal !== undefined) {
    return { name: argument.literal, dynamic: false };
  }
  if (argument.template) {
    const pieces = argument.template;
    const substitutions = argument.substitutions ?? [];
    let name = pieces[0] ?? '';
    let dynamic = false;
    substitutions.forEach((substitution, index) => {
      const inner = readName(substitution, context);
      if (inner && !inner.dynamic) {
        name += inner.name;
      } else {
        dynamic = true;
        name += `\${${substitution.identifier ?? substitution.text}}`;
      }
      name += pieces[index + 1] ?? '';
    });
    return { name, dynamic };
  }
  if (argument.identifier !== undefined) {
    const identifier = argument.identifier;
    const value = isEnvIdentifier(identifier)
      ? undefined
      : context.resolveConstant(identifier);
    return value === undefined
      ? { name: identifier, dynamic: true }
      : { name: value, dynamic: false };
  }
  return { name: argument.text, dynamic: true };
}

/**
 * 메시지 패턴 인자. 문자열·상수는 readName 과 같고, 배열은 원소마다 하나, 객체 패턴(`{ cmd: 'refund' }`)은
 * 키 순서로 정렬한 JSON 한 줄로 적는다(보내는 쪽과 받는 쪽이 같은 글이 되게). 값을 못 읽은 객체는 dynamic
 */
export function readPatterns(
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
): NameReading[] {
  if (!argument) {
    return [];
  }
  if (argument.elements) {
    return argument.elements.flatMap((element) =>
      readPatterns(element, context),
    );
  }
  if (argument.properties) {
    const entries: Array<[string, string]> = [];
    for (const key of Object.keys(argument.properties).sort()) {
      const value = readName(argument.properties[key], context);
      if (!value || value.dynamic) {
        return [{ name: argument.text, dynamic: true }];
      }
      entries.push([key, value.name]);
    }
    return [
      { name: JSON.stringify(Object.fromEntries(entries)), dynamic: false },
    ];
  }
  const reading = readName(argument, context);
  return reading ? [reading] : [];
}

/** 주기 인자. 문자열·풀린 상수는 그 값, 못 읽으면 undefined(부르는 쪽이 `runtime` 등으로 적는다) */
export function readStaticText(
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
): string | undefined {
  const reading = readName(argument, context);
  return reading && !reading.dynamic ? reading.name : undefined;
}

/** 숫자 같은 그대로 적힌 값(`60_000`, `30.0`). 상수 이름이면 푼다 */
export function readPlainValue(
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
): string | undefined {
  if (!argument) {
    return undefined;
  }
  if (argument.identifier !== undefined) {
    return readStaticText(argument, context);
  }
  if (argument.literal !== undefined || argument.template) {
    return readStaticText(argument, context);
  }
  return /^[\d_.]+$/.test(argument.text) ? argument.text : undefined;
}

/**
 * 호출 인자를 위치 인자와 키워드 인자로 나눈다. Python 은 키워드 인자를 맨 뒤 인자 하나로 모아 두므로 그것을 푼다
 * TypeScript·JavaScript 는 키워드 인자가 없다
 */
export function splitArguments(
  site: CodeSite,
  language: string,
): SiteArguments {
  const args = site.args;
  const last = args[args.length - 1];
  if (
    PYTHON_LANGUAGES.includes(language) &&
    last &&
    PYTHON_KEYWORD_ARGUMENT_PATTERN.test(last.text)
  ) {
    return { positional: args.slice(0, -1), keywords: last.properties ?? {} };
  }
  return { positional: [...args], keywords: {} };
}

/** 옵션 객체 인자들(위치 인자 가운데 속성이 있는 것과 Python 키워드)에서 키 하나의 값 */
export function optionArgument(
  site: CodeSite,
  language: string,
  key: string,
): CodeSiteArgument | undefined {
  const { positional, keywords } = splitArguments(site, language);
  if (keywords[key]) {
    return keywords[key];
  }
  for (const argument of positional) {
    const value = argument.properties?.[key];
    if (value) {
      return value;
    }
  }
  return undefined;
}

// ── 결과 ──

/** 근거 글을 한 줄로 줄이고 자른다 */
export function evidenceText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_EVIDENCE_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_EVIDENCE_LENGTH - 1)}…`;
}

/** 탐지 결과 공통 필드 */
export function detectionBase(
  symbol: ExtractedSymbol,
  context: PresetContext,
  detector: string,
  confidence: number,
  line: number,
  evidence: string,
): DetectionBase {
  return {
    repository: context.repository,
    filePath: symbol.filePath,
    symbol: symbol.symbol,
    line,
    detector,
    confidence,
    evidence: evidenceText(evidence),
  };
}

/** 자리를 사람이 읽는 꼴로(`@OnEvent(order.paid)`, `this.refundQueue.add(…)`) */
export function siteLabel(site: CodeSite): string {
  const args = site.args
    .map((argument) => argument.literal ?? argument.text)
    .join(', ');
  const head =
    site.kind === 'decorator'
      ? `@${site.name}`
      : site.kind === 'new'
        ? `new ${site.name}`
        : site.name;
  return site.kind === 'assign' ? `${site.name} = ${args}` : `${head}(${args})`;
}

/** 같은 줄·같은 이름의 호출 실행 사실이 가진 바깥 조건 */
export function siteConditions(
  symbol: ExtractedSymbol,
  site: CodeSite,
): string[] | undefined {
  const fact = (symbol.executionFacts ?? []).find(
    (item) =>
      item.kind === 'calls' &&
      item.line === site.line &&
      item.subject === site.name,
  );
  return fact?.conditions && fact.conditions.length > 0
    ? [...fact.conditions]
    : undefined;
}

// ── 다른 심볼 ──

const INDEXES = new WeakMap<readonly ExtractedSymbol[], SymbolIndex>();

/** 저장소 심볼 색인. symbols 가 없으면 undefined 이고 탐지기는 심볼 하나만 보고 판단한다 */
export function symbolIndex(context: PresetContext): SymbolIndex | undefined {
  const symbols = context.symbols;
  if (!symbols) {
    return undefined;
  }
  const cached = INDEXES.get(symbols);
  if (cached) {
    return cached;
  }
  const byFile = new Map<string, Map<string, ExtractedSymbol>>();
  const byName = new Map<string, ExtractedSymbol[]>();
  for (const symbol of symbols) {
    let file = byFile.get(symbol.filePath);
    if (!file) {
      file = new Map();
      byFile.set(symbol.filePath, file);
    }
    if (!file.has(symbol.symbol)) {
      file.set(symbol.symbol, symbol);
    }
    const named = byName.get(symbol.symbol) ?? [];
    named.push(symbol);
    byName.set(symbol.symbol, named);
  }
  const index: SymbolIndex = {
    all: symbols,
    byFile,
    byName,
    derived: new Map(),
  };
  INDEXES.set(symbols, index);
  return index;
}

/** 색인에 딸린 프리셋 전용 색인을 한 번만 만든다 */
export function derivedIndex<T>(
  context: PresetContext,
  key: string,
  build: (index: SymbolIndex) => T,
): T | undefined {
  const index = symbolIndex(context);
  if (!index) {
    return undefined;
  }
  if (!index.derived.has(key)) {
    index.derived.set(key, build(index));
  }
  return index.derived.get(key) as T;
}

/** 같은 파일의 심볼 하나 */
export function fileSymbol(
  context: PresetContext,
  filePath: string,
  name: string,
): ExtractedSymbol | undefined {
  return symbolIndex(context)?.byFile.get(filePath)?.get(name);
}

/** 같은 파일에서 `<클래스>.` 로 시작하는 심볼들(메서드·속성) */
export function classMemberSymbols(
  context: PresetContext,
  classSymbol: ExtractedSymbol,
): ExtractedSymbol[] {
  const file = symbolIndex(context)?.byFile.get(classSymbol.filePath);
  if (!file) {
    return [];
  }
  const prefix = `${classSymbol.symbol}.`;
  return [...file.values()].filter((symbol) =>
    symbol.symbol.startsWith(prefix),
  );
}

/** 메서드·속성 심볼(`OrderService.cancel`)을 감싼 클래스 심볼 */
export function ownerClass(
  symbol: ExtractedSymbol,
  context: PresetContext,
): ExtractedSymbol | undefined {
  const index = symbol.symbol.indexOf('.');
  if (index <= 0) {
    return undefined;
  }
  return fileSymbol(context, symbol.filePath, symbol.symbol.slice(0, index));
}

/** `this.<이름>` 받는 쪽이 가리키는 클래스 멤버. 멤버 목록이 없으면 잇지 않는다 */
export function receiverMember(
  symbol: ExtractedSymbol,
  receiver: string | undefined,
  context: PresetContext,
): ClassMember | undefined {
  const name = thisMemberName(receiver);
  if (name === undefined) {
    return undefined;
  }
  return ownerClass(symbol, context)?.members?.find(
    (member) => member.name === name,
  );
}

/** 멤버에 붙은 데코레이터 가운데 끝 이름이 맞는 것 */
export function memberDecorator(
  member: ClassMember,
  names: readonly string[],
): CodeSite | undefined {
  return member.decorators.find((site) => names.includes(leafName(site.name)));
}

/** 자리 가운데 끝 이름이 맞는 데코레이터 */
export function findDecorator(
  sites: readonly CodeSite[] | undefined,
  names: readonly string[],
): CodeSite | undefined {
  return (sites ?? []).find(
    (site) => site.kind === 'decorator' && names.includes(leafName(site.name)),
  );
}

// ── 가져온 이름 ──

/**
 * 심볼의 IMPORTS 관계를 이 파일 안 이름 → 가져온 이름·모듈로 푼다
 * Python `import shop.points` 처럼 이름 없이 모듈을 읽은 것은 첫 조각 이름(`shop`)으로 그 모듈을 쓴다
 */
export function importedNames(
  symbol: ExtractedSymbol,
): Map<string, ImportedBinding> {
  const names = new Map<string, ImportedBinding>();
  for (const relation of symbol.relations) {
    const target = relation.target.symbol;
    if (relation.type !== 'IMPORTS' || !target) {
      continue;
    }
    const binding = parseImportTarget(target);
    if (binding) {
      names.set(binding.local, binding);
      continue;
    }
    const whole = `${WHOLE_MODULE_IMPORT}${IMPORT_TARGET_SEPARATOR}`;
    if (
      PYTHON_LANGUAGES.includes(symbol.language) &&
      target.startsWith(whole)
    ) {
      const specifier = target.slice(whole.length);
      const local = specifier.split('.')[0];
      if (local && !names.has(local)) {
        names.set(local, { local, imported: WHOLE_MODULE_IMPORT, specifier });
      }
    }
  }
  return names;
}

/** 심볼이 이 모듈에서 무엇이든 가져왔는지 */
export function importsModule(
  symbol: ExtractedSymbol,
  module: string,
): boolean {
  return [...importedNames(symbol).values()].some(
    (item) =>
      item.specifier === module ||
      item.specifier.startsWith(`${module}/`) ||
      item.specifier.startsWith(`${module}.`),
  );
}

/** 이 모듈에서 가져온 것을 이 파일에서 부르는 이름들. 기본·전체 가져오기만 */
export function moduleLocals(
  symbol: ExtractedSymbol,
  module: string,
): string[] {
  return [...importedNames(symbol).values()]
    .filter(
      (item) =>
        item.specifier === module &&
        (item.imported === WHOLE_MODULE_IMPORT ||
          item.imported === DEFAULT_EXPORT_NAME),
    )
    .map((item) => item.local);
}

/** 이 모듈에서 이름으로 가져온 것의 이 파일 안 이름 */
export function namedImportLocal(
  symbol: ExtractedSymbol,
  module: string,
  imported: string,
): string | undefined {
  return [...importedNames(symbol).values()].find(
    (item) => item.specifier === module && item.imported === imported,
  )?.local;
}

/** Python 파일 경로의 모듈 경로(`shop_worker/tasks.py` → `shop_worker.tasks`) */
export function pythonModulePath(filePath: string): string {
  const withoutSuffix = filePath.endsWith(PYTHON_MODULE_SUFFIX)
    ? filePath.slice(0, -PYTHON_MODULE_SUFFIX.length)
    : filePath;
  const parts = withoutSuffix.split('/');
  if (parts[parts.length - 1] === PYTHON_PACKAGE_FILE) {
    parts.pop();
  }
  return parts.join('.');
}

/** Python import 지정자를 모듈 경로로. 상대 지정자(`.tasks`, `..tasks`)는 가져오는 파일의 꾸러미 기준이다 */
export function resolvePythonModule(
  filePath: string,
  specifier: string,
): string {
  const dots = /^\.*/.exec(specifier)?.[0].length ?? 0;
  if (dots === 0) {
    return specifier;
  }
  const isPackage = filePath.endsWith(
    `/${PYTHON_PACKAGE_FILE}${PYTHON_MODULE_SUFFIX}`,
  );
  const own = pythonModulePath(filePath).split('.').filter(Boolean);
  const packageParts = isPackage ? own : own.slice(0, -1);
  const base = packageParts.slice(
    0,
    Math.max(0, packageParts.length - (dots - 1)),
  );
  const rest = specifier.slice(dots);
  return [...base, ...(rest ? rest.split('.') : [])].join('.');
}

/** 저장소 파일의 모듈 색인. 모듈 지정자를 같은 저장소 파일로 푸는 규칙은 그래프 전체가 함께 쓴다(imports.ts) */
function moduleIndex(context: PresetContext): ModuleIndex | undefined {
  return derivedIndex(
    context,
    'modules',
    (index) => new ModuleIndex(index.byFile.keys()),
  );
}

/** 모듈 지정자가 가리키는 같은 저장소 파일들. 다른 저장소의 꾸러미면 빈 목록 */
export function moduleFiles(
  context: PresetContext,
  fromFile: string,
  specifier: string,
): string[] {
  return moduleIndex(context)?.resolve(fromFile, specifier) ?? [];
}

/** 이 파일들에서 이름이 같은 심볼 하나. 여러 파일에 있으면 첫 파일의 것 */
export function symbolInFiles(
  context: PresetContext,
  files: readonly string[],
  name: string,
): ExtractedSymbol | undefined {
  const index = symbolIndex(context);
  for (const file of files) {
    const found = index?.byFile.get(file)?.get(name);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * 이 심볼이 쓰는 이름이 가리키는 같은 저장소 심볼. 같은 파일의 심볼을 먼저 보고, 없으면 가져온 이름을 파일로 풀어 찾는다
 * 찾지 못하면 undefined. 이름만 같은 다른 파일 심볼로 잇지 않는다
 */
export function resolveLocalSymbol(
  symbol: ExtractedSymbol,
  name: string,
  context: PresetContext,
): ExtractedSymbol | undefined {
  const same = fileSymbol(context, symbol.filePath, name);
  if (same) {
    return same;
  }
  const imported = importedNames(symbol).get(name);
  if (!imported || imported.imported === WHOLE_MODULE_IMPORT) {
    return undefined;
  }
  return symbolInFiles(
    context,
    moduleFiles(context, symbol.filePath, imported.specifier),
    imported.imported,
  );
}
