// 같은 저장소의 상수 이름을 문자열 값으로 푼다. 탐지기가 큐·이벤트 이름, 경로, 테이블 이름 인자를 이름으로 받았을 때 쓴다
// 실행 사실은 문자열을 `<literal>` 로 가리므로, 추출기가 상수·열거형 멤버 값에 남긴 assign 자리(비밀값을 가린 인자)를 먼저 읽는다
// assign 자리가 없는 심볼(자체 추출기 등)만 원문을 읽는다. TypeScript·JavaScript 는 컴파일러 구문 트리로,
// Python 은 `NAME = '...'` 꼴과 열거형 멤버만 읽는 작은 해석기로 읽는다. 값이 하나로 정해지지 않으면 추측하지 않고 undefined 를 돌려준다
import type TypeScript from 'typescript';
import type { Logger } from '../ports.js';
import {
  CLASS_MEMBER_WRAPPER,
  CONSTANT_REFERENCE_DEPTH,
  CONSTANT_SYMBOL_KINDS,
} from './constants.js';
import { JAVASCRIPT_SOURCE_EXTENSIONS } from './extractors/constants.js';
import {
  isSecretKeyName,
  redactSecretValue,
} from './extractors/site-secrets.js';
import type { TypeScriptModule } from './extractors/types.js';
import { importedBinding, ModuleIndex } from './imports.js';
import type {
  CodeSiteArgument,
  ConstantNode,
  ConstantOrigin,
  ConstantResolver,
  ExtractedSymbol,
} from './types.js';

/** 이름 하나나 점으로 이은 멤버 연쇄. 인스턴스 값(this·self)과 환경 변수 읽기는 정적으로 풀 수 없어 받지 않는다 */
const DOTTED_NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const UNRESOLVABLE_HEADS = new Set([
  'this',
  'self',
  'cls',
  'super',
  'process',
  'os',
]);
const SCRIPT_LANGUAGES = new Set(['typescript', 'javascript']);
const PYTHON_ASSIGNMENT = /^([A-Za-z_]\w*)\s*(?::[^=]*)?=(?!=)\s*([\s\S]*)$/;
const PYTHON_STRING_PREFIX = /^([rRuU]?)(['"])/;
const PYTHON_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\',
  "'": "'",
  '"': '"',
  n: '\n',
  t: '\t',
  r: '\r',
};

/**
 * 저장소 하나의 상수 풀이기를 만든다. TypeScript·JavaScript 상수가 있을 때만 typescript 를 불러오고,
 * 불러오지 못하면 그 상수는 풀지 않고 경고만 남긴다
 */
export async function createConstantResolver(
  symbols: readonly ExtractedSymbol[],
  options: {
    repository: string;
    logger: Logger;
    loadTypeScript?: () => Promise<TypeScriptModule>;
  },
): Promise<ConstantResolver> {
  const definitions = symbols.filter((symbol) =>
    CONSTANT_SYMBOL_KINDS.includes(symbol.kind),
  );
  let ts: TypeScriptModule | undefined;
  if (
    definitions.some(
      (symbol) =>
        SCRIPT_LANGUAGES.has(symbol.language) && !hasAssignSites(symbol),
    )
  ) {
    try {
      ts = await (options.loadTypeScript ?? loadInstalledTypeScript)();
    } catch (error) {
      options.logger.warn(
        'graph constants: typescript could not be loaded; TypeScript/JavaScript constants stay unresolved',
        { repository: options.repository, error: (error as Error).message },
      );
    }
  }
  return new SymbolConstantResolver(symbols, definitions, ts);
}

async function loadInstalledTypeScript(): Promise<TypeScriptModule> {
  const loaded = await import('typescript');
  return (loaded.default ?? loaded) as TypeScriptModule;
}

/**
 * 찾는 범위: 지금 보는 심볼의 파일 → 그 심볼이 이름을 가져온 파일 → 저장소 전체
 * 이름을 다른 모듈에서 가져왔으면 그 모듈 안에서만 찾는다(못 찾으면 저장소 전체로 넓히지 않는다. 패키지에서 온 이름일 수 있다)
 * 처음 찾은 범위에서 정의가 모두 같은 값으로 풀릴 때만 그 값을 돌려준다
 */
class SymbolConstantResolver implements ConstantResolver {
  private readonly byName = new Map<string, ExtractedSymbol[]>();
  private readonly modules: ModuleIndex;
  private readonly nodes = new Map<ExtractedSymbol, ConstantNode | null>();
  private readonly cache = new Map<string, string | undefined>();

  constructor(
    symbols: readonly ExtractedSymbol[],
    definitions: readonly ExtractedSymbol[],
    private readonly ts: TypeScriptModule | undefined,
  ) {
    for (const definition of definitions) {
      const list = this.byName.get(definition.symbol) ?? [];
      list.push(definition);
      this.byName.set(definition.symbol, list);
    }
    this.modules = new ModuleIndex(symbols.map((symbol) => symbol.filePath));
  }

  resolve(identifier: string, origin?: ConstantOrigin): string | undefined {
    const name = identifier.trim().replaceAll('?.', '.');
    const value = this.lookup(name, origin, 0);
    if (value === undefined) {
      return undefined;
    }
    const leaf = name.slice(name.lastIndexOf('.') + 1);
    return isSecretKeyName(leaf) ? undefined : redactSecretValue(value);
  }

  private lookup(
    name: string,
    origin: ConstantOrigin | undefined,
    depth: number,
  ): string | undefined {
    // 서로 가리키는 상수는 깊이 한도에서 멈춘다
    if (depth > CONSTANT_REFERENCE_DEPTH || !DOTTED_NAME.test(name)) {
      return undefined;
    }
    const parts = name.split('.');
    if (UNRESOLVABLE_HEADS.has(parts[0])) {
      return undefined;
    }
    const binding = origin
      ? importedBinding(origin.relations, parts[0])
      : undefined;
    const key = [
      name,
      depth,
      origin?.filePath ?? '',
      binding ? `${binding.imported}\0${binding.specifier}` : '',
    ].join('\0');
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    let value: string | undefined;
    if (origin && binding) {
      const files = new Set(
        this.modules.resolve(origin.filePath, binding.specifier),
      );
      const inner =
        binding.imported === '*'
          ? parts.slice(1)
          : [binding.imported, ...parts.slice(1)];
      value =
        inner.length > 0
          ? this.decide(
              this.candidates(inner, (file) => files.has(file)),
              depth,
            )
          : undefined;
    } else {
      const local = origin
        ? this.candidates(parts, (file) => file === origin.filePath)
        : [];
      value = this.decide(
        local.length > 0 ? local : this.candidates(parts, () => true),
        depth,
      );
    }
    this.cache.set(key, value);
    return value;
  }

  /** 이름을 앞에서부터 잘라 정의 이름과 그 안의 멤버 경로로 나눈 후보들(`Queues.ORDER` → `Queues.ORDER` 또는 `Queues` 의 ORDER) */
  private candidates(
    parts: readonly string[],
    inFile: (file: string) => boolean,
  ): Array<{ definition: ExtractedSymbol; path: string[] }> {
    const found: Array<{ definition: ExtractedSymbol; path: string[] }> = [];
    for (let length = parts.length; length >= 1; length -= 1) {
      const owner = parts.slice(0, length).join('.');
      for (const definition of this.byName.get(owner) ?? []) {
        if (inFile(definition.filePath)) {
          found.push({ definition, path: parts.slice(length) });
        }
      }
    }
    return found;
  }

  private decide(
    candidates: Array<{ definition: ExtractedSymbol; path: string[] }>,
    depth: number,
  ): string | undefined {
    const values = new Set<string>();
    for (const { definition, path } of candidates) {
      const node = this.node(definition);
      const value = node
        ? this.evaluate(node, path, definition, depth)
        : undefined;
      if (value === undefined) {
        return undefined;
      }
      values.add(value);
    }
    return values.size === 1 ? [...values][0] : undefined;
  }

  private evaluate(
    node: ConstantNode,
    path: readonly string[],
    definition: ExtractedSymbol,
    depth: number,
  ): string | undefined {
    switch (node.kind) {
      case 'text':
        return path.length === 0 ? node.value : undefined;
      case 'members': {
        const child = path.length > 0 ? node.members.get(path[0]) : undefined;
        return child
          ? this.evaluate(child, path.slice(1), definition, depth)
          : undefined;
      }
      case 'join': {
        if (path.length > 0) {
          return undefined;
        }
        let text = '';
        for (const part of node.parts) {
          const value = this.evaluate(part, [], definition, depth);
          if (value === undefined) {
            return undefined;
          }
          text += value;
        }
        return text;
      }
      case 'reference':
        return this.lookup(
          [node.name, ...path].join('.'),
          { filePath: definition.filePath, relations: definition.relations },
          depth + 1,
        );
    }
  }

  private node(definition: ExtractedSymbol): ConstantNode | undefined {
    if (!this.nodes.has(definition)) {
      let node: ConstantNode | undefined;
      if (hasAssignSites(definition)) {
        node = siteConstantNode(definition);
      } else if (definition.language === 'python') {
        node = pythonConstantNode(definition);
      } else if (this.ts && SCRIPT_LANGUAGES.has(definition.language)) {
        node = scriptConstantNode(this.ts, definition);
      }
      this.nodes.set(definition, node ?? null);
    }
    return this.nodes.get(definition) ?? undefined;
  }
}

// ── assign 자리 ──

function hasAssignSites(definition: ExtractedSymbol): boolean {
  return (definition.sites ?? []).some((site) => site.kind === 'assign');
}

/**
 * 추출기가 남긴 assign 자리의 값. 상수는 이름이 심볼과 같은 자리(`REFUND_QUEUE`, `Queues.ORDER`, `Coupon.__tablename__`),
 * 열거형은 `열거형.멤버` 자리들을 멤버로 읽는다. 객체 값은 properties 로 멤버를 따라간다
 */
function siteConstantNode(
  definition: ExtractedSymbol,
): ConstantNode | undefined {
  const assigns = (definition.sites ?? []).filter(
    (site) => site.kind === 'assign',
  );
  if (definition.kind === 'enum') {
    const prefix = `${definition.symbol}.`;
    const members = new Map<string, ConstantNode>();
    for (const site of assigns) {
      const value = site.args[0] ? argumentNode(site.args[0]) : undefined;
      if (site.name.startsWith(prefix) && value) {
        members.set(site.name.slice(prefix.length), value);
      }
    }
    return { kind: 'members', members };
  }
  const own = assigns.find((site) => site.name === definition.symbol);
  return own?.args[0] ? argumentNode(own.args[0]) : undefined;
}

function argumentNode(argument: CodeSiteArgument): ConstantNode | undefined {
  if (argument.literal !== undefined) {
    return { kind: 'text', value: argument.literal };
  }
  if (argument.template) {
    const substitutions = argument.substitutions ?? [];
    const parts: ConstantNode[] = [];
    for (const [index, piece] of argument.template.entries()) {
      parts.push({ kind: 'text', value: piece });
      if (index < argument.template.length - 1) {
        const inner = substitutions[index]
          ? argumentNode(substitutions[index])
          : undefined;
        if (!inner) {
          return undefined;
        }
        parts.push(inner);
      }
    }
    return { kind: 'join', parts };
  }
  if (argument.identifier !== undefined) {
    return { kind: 'reference', name: argument.identifier };
  }
  if (argument.properties) {
    const members = new Map<string, ConstantNode>();
    for (const [key, value] of Object.entries(argument.properties)) {
      const node = argumentNode(value);
      if (node) {
        members.set(key, node);
      }
    }
    return { kind: 'members', members };
  }
  return undefined;
}

// ── TypeScript·JavaScript ──

/**
 * 상수 심볼 원문의 값. 원문 꼴은 추출기를 따른다
 * - `export const ORDER_QUEUE = 'shop-orders';`, 선언이 여럿인 문장에서 떼어 낸 `ORDER_QUEUE = 'shop-orders'`
 * - `exports.ORDER_QUEUE = 'shop-orders';`, `export enum Topic { … }`
 * - 클래스 필드 `Queues.ORDER` 의 원문 `static readonly ORDER = 'shop-orders';`(static 필드만 이름으로 읽을 수 있다)
 */
function scriptConstantNode(
  ts: TypeScriptModule,
  definition: ExtractedSymbol,
): ConstantNode | undefined {
  const member = definition.symbol.includes('.');
  const text = member
    ? `${CLASS_MEMBER_WRAPPER.open}${definition.content}${CLASS_MEMBER_WRAPPER.close}`
    : definition.content;
  const source = ts.createSourceFile(
    'constant.ts',
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(ts, definition.filePath),
  );
  const name = definition.symbol.slice(definition.symbol.lastIndexOf('.') + 1);
  for (const statement of source.statements) {
    if (member) {
      if (!ts.isClassDeclaration(statement)) {
        continue;
      }
      const field = statement.members.find(
        (item): item is TypeScript.PropertyDeclaration =>
          ts.isPropertyDeclaration(item) &&
          item.name.getText(source) === name &&
          (ts.getModifiers(item) ?? []).some(
            (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
          ),
      );
      return field?.initializer ? scriptNode(ts, field.initializer) : undefined;
    }
    if (ts.isVariableStatement(statement)) {
      const declaration = statement.declarationList.declarations.find(
        (item) => ts.isIdentifier(item.name) && item.name.text === name,
      );
      if (declaration?.initializer) {
        return scriptNode(ts, declaration.initializer);
      }
      continue;
    }
    if (ts.isEnumDeclaration(statement) && statement.name.text === name) {
      return enumNode(ts, statement);
    }
    if (ts.isExportAssignment(statement) && name === 'default') {
      return scriptNode(ts, statement.expression);
    }
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = statement.expression.left;
      const assigned = ts.isIdentifier(target)
        ? target.text
        : ts.isPropertyAccessExpression(target)
          ? target.name.text
          : undefined;
      if (assigned === name) {
        return scriptNode(ts, statement.expression.right);
      }
    }
  }
  return undefined;
}

function scriptNode(
  ts: TypeScriptModule,
  expression: TypeScript.Expression,
): ConstantNode | undefined {
  const node = unwrap(ts, expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { kind: 'text', value: node.text };
  }
  if (ts.isTemplateExpression(node)) {
    const parts: ConstantNode[] = [{ kind: 'text', value: node.head.text }];
    for (const span of node.templateSpans) {
      const inner = scriptNode(ts, span.expression);
      if (!inner) {
        return undefined;
      }
      parts.push(inner, { kind: 'text', value: span.literal.text });
    }
    return { kind: 'join', parts };
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = scriptNode(ts, node.left);
    const right = scriptNode(ts, node.right);
    return left && right ? { kind: 'join', parts: [left, right] } : undefined;
  }
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    const name = referenceName(ts, node);
    return name ? { kind: 'reference', name } : undefined;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const members = new Map<string, ConstantNode>();
    for (const property of node.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        members.set(property.name.text, {
          kind: 'reference',
          name: property.name.text,
        });
        continue;
      }
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }
      const key =
        ts.isIdentifier(property.name) ||
        ts.isStringLiteral(property.name) ||
        ts.isNumericLiteral(property.name)
          ? property.name.text
          : undefined;
      const value = key ? scriptNode(ts, property.initializer) : undefined;
      if (key && value) {
        members.set(key, value);
      }
    }
    return { kind: 'members', members };
  }
  // Object.freeze({ … }) 는 안의 객체 그대로 본다
  if (
    ts.isCallExpression(node) &&
    node.arguments.length === 1 &&
    referenceName(ts, node.expression) === 'Object.freeze'
  ) {
    return scriptNode(ts, node.arguments[0]);
  }
  return undefined;
}

function enumNode(
  ts: TypeScriptModule,
  declaration: TypeScript.EnumDeclaration,
): ConstantNode {
  const members = new Map<string, ConstantNode>();
  for (const member of declaration.members) {
    const key =
      ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
        ? member.name.text
        : undefined;
    const value = member.initializer
      ? scriptNode(ts, member.initializer)
      : undefined;
    if (key && value) {
      members.set(key, value);
    }
  }
  return { kind: 'members', members };
}

function unwrap(
  ts: TypeScriptModule,
  node: TypeScript.Expression,
): TypeScript.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return unwrap(ts, node.expression);
  }
  return node;
}

/** 이름 하나나 이름으로만 이은 멤버 연쇄의 글. 그 밖의 꼴(호출, 첨자, this)은 undefined */
function referenceName(
  ts: TypeScriptModule,
  node: TypeScript.Expression,
): string | undefined {
  if (ts.isIdentifier(node)) {
    return node.text === 'undefined' ? undefined : node.text;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const owner = referenceName(ts, node.expression);
    return owner ? `${owner}.${node.name.text}` : undefined;
  }
  return undefined;
}

function scriptKind(
  ts: TypeScriptModule,
  filePath: string,
): TypeScript.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (lower.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }
  return JAVASCRIPT_SOURCE_EXTENSIONS.some((extension) =>
    lower.endsWith(extension),
  )
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
}

// ── Python ──

/**
 * Python 상수 심볼 원문의 값. 추출기는 모듈 상수(`ORDER_QUEUE = 'shop-orders'`)와 클래스 속성(`Coupon.__tablename__` 의
 * 원문 `__tablename__ = 'coupons'`)을 상수 심볼로, 표준 enum 을 상속한 클래스를 열거형 심볼 하나로 낸다
 * 값은 문자열 리터럴(이어 붙인 리터럴 포함)이나 다른 상수 이름만 읽는다
 */
function pythonConstantNode(
  definition: ExtractedSymbol,
): ConstantNode | undefined {
  if (definition.kind === 'enum') {
    return pythonEnumNode(definition.content);
  }
  const match = PYTHON_ASSIGNMENT.exec(definition.content.trim());
  const name = definition.symbol.slice(definition.symbol.lastIndexOf('.') + 1);
  return match && match[1] === name ? pythonValueNode(match[2]) : undefined;
}

/** 클래스 몸통 바로 아래 줄의 `NAME = 값` 만 멤버로 읽는다. 메서드 안의 대입이나 여러 줄 값은 보지 않는다 */
function pythonEnumNode(content: string): ConstantNode {
  // 데코레이터 줄을 지나 class 머리줄 다음부터 본다
  const lines = content.split(/\r?\n/);
  const header = lines.findIndex((line) => /^\s*class\s/.test(line));
  const members = new Map<string, ConstantNode>();
  let indent: string | undefined;
  for (const line of lines.slice(header + 1)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const leading = /^[ \t]*/.exec(line)?.[0] ?? '';
    indent ??= leading;
    if (leading !== indent || indent === '') {
      continue;
    }
    const match = PYTHON_ASSIGNMENT.exec(trimmed);
    const value = match ? pythonValueNode(match[2]) : undefined;
    if (match && value) {
      members.set(match[1], value);
    }
  }
  return { kind: 'members', members };
}

function pythonValueNode(text: string): ConstantNode | undefined {
  let rest = text.trim();
  if (PYTHON_STRING_PREFIX.test(rest)) {
    let value = '';
    while (PYTHON_STRING_PREFIX.test(rest)) {
      const literal = readPythonString(rest);
      if (!literal) {
        return undefined;
      }
      value += literal.value;
      rest = rest.slice(literal.length).trimStart();
    }
    return rest === '' || rest.startsWith('#')
      ? { kind: 'text', value }
      : undefined;
  }
  const name = rest.replace(/\s*#.*$/, '');
  return DOTTED_NAME.test(name) ? { kind: 'reference', name } : undefined;
}

/** 한 줄 문자열 리터럴 하나(`'…'`, `"…"`, 앞머리 r·u). 세 따옴표와 f·b 문자열은 읽지 않는다 */
function readPythonString(
  text: string,
): { value: string; length: number } | undefined {
  const prefix = PYTHON_STRING_PREFIX.exec(text);
  if (!prefix) {
    return undefined;
  }
  const raw = prefix[1].toLowerCase() === 'r';
  const quote = prefix[2];
  const start = prefix[0].length;
  if (text.startsWith(quote.repeat(2), start)) {
    // 빈 문자열('')이면 읽고, 세 따옴표면 읽지 않는다
    return text[start + 2] === quote
      ? undefined
      : { value: '', length: start + 1 };
  }
  let value = '';
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (character === '\n') {
      return undefined;
    }
    if (character === quote) {
      return { value, length: index + 1 };
    }
    if (character === '\\' && index + 1 < text.length) {
      const next = text[index + 1];
      value += raw ? `\\${next}` : (PYTHON_ESCAPES[next] ?? `\\${next}`);
      index += 1;
      continue;
    }
    value += character;
  }
  return undefined;
}
