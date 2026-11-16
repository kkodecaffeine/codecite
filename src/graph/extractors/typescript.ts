// TypeScript·JavaScript 추출기. 컴파일러 API 의 구문 트리만 쓰고 타입 검사는 하지 않는다
// typescript 는 선택 의존성이라 추출할 파일이 있을 때만 늦게 불러온다. 답변 엔진만 쓰는 쪽은 typescript 를 읽지 않는다
import type TypeScript from 'typescript';
import type { ExecutionFact } from '../../extensions/code-knowledge.js';
import type {
  ExtractContext,
  ExtractedSymbol,
  ExtractionFailure,
  SourceFile,
  SymbolExtractor,
} from '../types.js';
import {
  CLASS_KIND_BY_DECORATOR,
  DECLARATION_FILE_SUFFIXES,
  JAVASCRIPT_ONLY_DIAGNOSTIC_CODES,
  JAVASCRIPT_SOURCE_EXTENSIONS,
  MAX_RELATION_TARGET_LENGTH,
  TYPESCRIPT_INSTALL_COMMAND,
  TYPESCRIPT_OMISSION_COMMENT,
  TYPESCRIPT_PARSE_BATCH_SIZE,
  TYPESCRIPT_SOURCE_EXTENSIONS,
} from './constants.js';
import { createTypeScriptFactProjector } from './facts-typescript.js';
import {
  boundDeclarationContent,
  collapseText,
  errorMessage,
  finalizeExtraction,
  finalizeRelations,
  hasExtension,
  importTarget,
} from './normalize.js';
import type {
  ImportBinding,
  RawRelation,
  TypeScriptExtractorOptions,
  TypeScriptFactProjector,
  TypeScriptModule,
} from './types.js';

/** `.ts .tsx .mts .cts .js .jsx .mjs .cjs` 파일에서 심볼·관계·실행 사실을 뽑는 추출기 */
export function typescriptExtractor(
  options: TypeScriptExtractorOptions = {},
): SymbolExtractor {
  const load = options.loadTypeScript ?? loadInstalledTypeScript;
  const extensions = [
    ...TYPESCRIPT_SOURCE_EXTENSIONS,
    ...JAVASCRIPT_SOURCE_EXTENSIONS,
  ];
  return {
    name: 'typescript',
    extensions,
    async extract(files, context) {
      const targets = files.filter(
        (file) =>
          hasExtension(file.filePath, extensions) &&
          !hasExtension(file.filePath, DECLARATION_FILE_SUFFIXES),
      );
      if (targets.length === 0) {
        return { symbols: [], failures: [] };
      }
      const ts = await requireTypeScript(load, context.repository);
      const projector = createTypeScriptFactProjector(ts);
      const symbols: ExtractedSymbol[] = [];
      const failures: ExtractionFailure[] = [];
      for (
        let index = 0;
        index < targets.length;
        index += TYPESCRIPT_PARSE_BATCH_SIZE
      ) {
        const batch = targets.slice(index, index + TYPESCRIPT_PARSE_BATCH_SIZE);
        extractBatch(ts, projector, batch, context, symbols, failures);
      }
      context.logger.debug('typescript extraction finished', {
        repository: context.repository,
        files: targets.length,
        symbols: symbols.length,
        failures: failures.length,
      });
      return finalizeExtraction({ symbols, failures });
    },
  };
}

async function loadInstalledTypeScript(): Promise<TypeScriptModule> {
  const loaded = await import('typescript');
  return (loaded.default ?? loaded) as TypeScriptModule;
}

async function requireTypeScript(
  load: () => Promise<TypeScriptModule>,
  repository: string,
): Promise<TypeScriptModule> {
  try {
    return await load();
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    const missing =
      code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
    throw new Error(
      missing
        ? `typescript is not installed, so the TypeScript/JavaScript files of repository "${repository}" cannot be read. Install it with: ${TYPESCRIPT_INSTALL_COMMAND}`
        : `typescript could not be loaded for repository "${repository}": ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function extractBatch(
  ts: TypeScriptModule,
  projector: TypeScriptFactProjector,
  batch: readonly SourceFile[],
  context: ExtractContext,
  symbols: ExtractedSymbol[],
  failures: ExtractionFailure[],
): void {
  const parsed = batch.map((file) => ({
    file,
    sourceFile: ts.createSourceFile(
      `/${file.filePath}`,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(ts, file.filePath),
    ),
  }));
  const program = syntaxProgram(
    ts,
    parsed.map(({ sourceFile }) => sourceFile),
  );
  for (const { file, sourceFile } of parsed) {
    const syntaxError = firstSyntaxError(ts, program, sourceFile);
    if (syntaxError) {
      failures.push({ filePath: file.filePath, message: syntaxError });
      continue;
    }
    try {
      symbols.push(
        ...new FileSymbolReader(
          ts,
          projector,
          file,
          sourceFile,
          context.repository,
        ).read(),
      );
    } catch (error) {
      failures.push({
        filePath: file.filePath,
        message: `extraction failed: ${errorMessage(error)}`,
      });
    }
  }
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
  return hasExtension(lower, JAVASCRIPT_SOURCE_EXTENSIONS)
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TS;
}

/** 구문 진단만 보려고 만드는 프로그램. 다른 파일·타입 정의를 찾아 읽지 않는다 */
function syntaxProgram(
  ts: TypeScriptModule,
  sourceFiles: readonly TypeScript.SourceFile[],
): TypeScript.Program {
  const byName = new Map(
    sourceFiles.map((sourceFile) => [sourceFile.fileName, sourceFile]),
  );
  const host: TypeScript.CompilerHost = {
    getSourceFile: (fileName) => byName.get(fileName),
    getDefaultLibFileName: () => '/lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (fileName) => byName.has(fileName),
    readFile: () => undefined,
  };
  return ts.createProgram({
    rootNames: [...byName.keys()],
    options: {
      allowJs: true,
      noLib: true,
      noResolve: true,
      types: [],
      jsx: ts.JsxEmit.Preserve,
    },
    host,
  });
}

/** 첫 구문 오류를 `line N: 내용` 꼴로. JavaScript 파일에만 붙는 진단(타입 표기 등)은 오류로 보지 않는다 */
function firstSyntaxError(
  ts: TypeScriptModule,
  program: TypeScript.Program,
  sourceFile: TypeScript.SourceFile,
): string | undefined {
  const diagnostic = program
    .getSyntacticDiagnostics(sourceFile)
    .find(
      (item) =>
        item.category === ts.DiagnosticCategory.Error &&
        (item.code < JAVASCRIPT_ONLY_DIAGNOSTIC_CODES.from ||
          item.code > JAVASCRIPT_ONLY_DIAGNOSTIC_CODES.to),
    );
  if (!diagnostic) {
    return undefined;
  }
  const line =
    diagnostic.start === undefined
      ? undefined
      : sourceFile.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  return line === undefined ? message : `line ${line}: ${message}`;
}

/** 파일 하나의 최상위 선언을 심볼로 읽는다 */
class FileSymbolReader {
  private readonly imports: ImportBinding[];
  private readonly language: string;
  private readonly symbols: ExtractedSymbol[] = [];

  constructor(
    private readonly ts: TypeScriptModule,
    private readonly projector: TypeScriptFactProjector,
    private readonly file: SourceFile,
    private readonly sourceFile: TypeScript.SourceFile,
    private readonly repository: string,
  ) {
    this.imports = this.importBindings();
    this.language = hasExtension(file.filePath, JAVASCRIPT_SOURCE_EXTENSIONS)
      ? 'javascript'
      : 'typescript';
  }

  read(): ExtractedSymbol[] {
    for (const statement of this.sourceFile.statements) {
      this.readStatement(statement);
    }
    return this.symbols;
  }

  private readStatement(statement: TypeScript.Statement): void {
    const ts = this.ts;
    if (ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? this.defaultExportName(statement);
      if (name) {
        this.readClass(statement, name);
      }
      return;
    }
    if (ts.isFunctionDeclaration(statement)) {
      const name = statement.name?.text ?? this.defaultExportName(statement);
      if (name && statement.body) {
        this.addFunction(statement, name, statement, statement.body);
      }
      return;
    }
    if (ts.isVariableStatement(statement)) {
      const declarations = statement.declarationList.declarations;
      for (const declaration of declarations) {
        if (
          !ts.isIdentifier(declaration.name) ||
          !declaration.initializer ||
          this.requiredModule(declaration.initializer) !== undefined
        ) {
          continue;
        }
        // 선언이 하나면 export·const 까지 문장 전체를 원문으로 쓴다
        const node = declarations.length === 1 ? statement : declaration;
        this.addBinding(
          node,
          declaration.name.text,
          declaration.initializer,
          statement,
        );
      }
      return;
    }
    if (ts.isEnumDeclaration(statement)) {
      this.addSymbol(statement, statement.name.text, 'enum', {
        relations: this.importRelations(statement),
        facts: this.projector.enumFacts(this.sourceFile, statement),
      });
      return;
    }
    if (ts.isExportAssignment(statement)) {
      if (!ts.isIdentifier(statement.expression)) {
        this.addBinding(statement, 'default', statement.expression, statement);
      }
      return;
    }
    if (ts.isExpressionStatement(statement)) {
      this.readCommonJsExport(statement);
    }
  }

  /** CommonJS 내보내기: `exports.x = …`, `module.exports.x = …`, `module.exports = function …` */
  private readCommonJsExport(statement: TypeScript.ExpressionStatement): void {
    const ts = this.ts;
    const expression = statement.expression;
    if (
      !ts.isBinaryExpression(expression) ||
      expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !ts.isPropertyAccessExpression(expression.left)
    ) {
      return;
    }
    const target = expression.left;
    const owner = target.expression.getText(this.sourceFile);
    if (owner === 'exports' || owner === 'module.exports') {
      this.addBinding(statement, target.name.text, expression.right, statement);
      return;
    }
    if (
      owner === 'module' &&
      target.name.text === 'exports' &&
      this.functionLike(expression.right)
    ) {
      this.addBinding(statement, 'default', expression.right, statement);
    }
  }

  private defaultExportName(
    node: TypeScript.ClassDeclaration | TypeScript.FunctionDeclaration,
  ): string | undefined {
    const modifiers = this.ts.getModifiers(node) ?? [];
    return modifiers.some(
      (modifier) => modifier.kind === this.ts.SyntaxKind.DefaultKeyword,
    )
      ? 'default'
      : undefined;
  }

  /** 이름 하나에 값을 묶은 선언. 함수 값이면 함수 심볼, 아니면 상수 심볼 */
  private addBinding(
    node: TypeScript.Node,
    name: string,
    value: TypeScript.Expression,
    documented: TypeScript.Node,
  ): void {
    const fn = this.functionLike(value);
    if (fn) {
      this.addFunction(node, name, documented, fn.body);
      return;
    }
    if (this.ts.isClassExpression(value)) {
      return;
    }
    this.addSymbol(node, name, 'constant', {
      documented,
      relations: [...this.importRelations(node), ...this.callRelations(node)],
      facts: this.projector.constantFacts(this.sourceFile, name, value),
    });
  }

  private addFunction(
    node: TypeScript.Node,
    name: string,
    documented: TypeScript.Node,
    body: TypeScript.ConciseBody,
  ): void {
    this.addSymbol(node, name, 'function', {
      documented,
      relations: [
        ...this.importRelations(node),
        ...this.decoratorRelations(node),
        ...this.callRelations(node),
      ],
      facts: this.projector.bodyFacts(this.sourceFile, body),
    });
  }

  private readClass(node: TypeScript.ClassDeclaration, name: string): void {
    const ts = this.ts;
    const decorators = this.decoratorNames(node);
    const kind =
      decorators
        .map((decorator) => CLASS_KIND_BY_DECORATOR[leafName(decorator)])
        .find((value) => value !== undefined) ?? 'class';
    this.addSymbol(node, name, kind, {
      relations: [
        ...this.importRelations(node),
        ...this.heritageRelations(node),
        ...decorators.map((decorator): RawRelation => ({
          type: 'DECORATED_BY',
          symbol: decorator,
        })),
        ...this.injectRelations(node),
      ],
    });
    for (const member of node.members) {
      const memberName = member.name?.getText(this.sourceFile);
      const memberRelations = (): RawRelation[] => [
        ...this.importRelations(member),
        ...this.decoratorRelations(member),
        ...this.callRelations(member),
      ];
      if (ts.isConstructorDeclaration(member) && member.body) {
        this.addSymbol(member, `${name}.constructor`, 'method', {
          relations: memberRelations(),
          facts: this.projector.bodyFacts(this.sourceFile, member.body),
        });
        continue;
      }
      if (!memberName) {
        continue;
      }
      if (
        (ts.isMethodDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)) &&
        member.body
      ) {
        const suffix = ts.isGetAccessorDeclaration(member)
          ? ':get'
          : ts.isSetAccessorDeclaration(member)
            ? ':set'
            : '';
        this.addSymbol(member, `${name}.${memberName}${suffix}`, 'method', {
          relations: memberRelations(),
          facts: this.projector.bodyFacts(this.sourceFile, member.body),
        });
        continue;
      }
      if (ts.isPropertyDeclaration(member) && member.initializer) {
        const fn = this.functionLike(member.initializer);
        const symbol = `${name}.${memberName}`;
        this.addSymbol(member, symbol, fn ? 'method' : 'constant', {
          relations: memberRelations(),
          facts: fn
            ? this.projector.bodyFacts(this.sourceFile, fn.body)
            : this.projector.constantFacts(
                this.sourceFile,
                symbol,
                member.initializer,
              ),
        });
      }
    }
  }

  private addSymbol(
    node: TypeScript.Node,
    symbol: string,
    kind: string,
    details: {
      relations: RawRelation[];
      facts?: ExecutionFact[];
      documented?: TypeScript.Node;
    },
  ): void {
    const sourceFile = this.sourceFile;
    const start = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile),
    );
    const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    const description = this.documentation(details.documented ?? node);
    const executable = kind === 'function' || kind === 'method';
    this.symbols.push({
      filePath: this.file.filePath,
      language: this.language,
      symbol,
      kind,
      content: boundDeclarationContent(
        node.getText(sourceFile),
        kind,
        TYPESCRIPT_OMISSION_COMMENT,
      ),
      lineStart: start.line + 1,
      lineEnd: end.line + 1,
      ...(description ? { description } : {}),
      relations: finalizeRelations(this.repository, details.relations),
      ...(executable || (details.facts && details.facts.length > 0)
        ? { executionFacts: details.facts ?? [] }
        : {}),
    });
  }

  private documentation(node: TypeScript.Node): string | undefined {
    const ts = this.ts;
    const parts = ts
      .getJSDocCommentsAndTags(node)
      .filter(ts.isJSDoc)
      .map((doc) => ts.getTextOfJSDocComment(doc.comment)?.trim() ?? '')
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  private functionLike(
    value: TypeScript.Expression,
  ): TypeScript.ArrowFunction | TypeScript.FunctionExpression | undefined {
    const ts = this.ts;
    let inner = value;
    while (ts.isParenthesizedExpression(inner)) {
      inner = inner.expression;
    }
    return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)
      ? inner
      : undefined;
  }

  // ── 관계 ──

  private decoratorNames(node: TypeScript.Node): string[] {
    const ts = this.ts;
    if (!ts.canHaveDecorators(node)) {
      return [];
    }
    return (ts.getDecorators(node) ?? [])
      .map((decorator) => {
        const expression = ts.isCallExpression(decorator.expression)
          ? decorator.expression.expression
          : decorator.expression;
        return this.projector.callee(expression);
      })
      .filter((name): name is string => name !== undefined);
  }

  private decoratorRelations(node: TypeScript.Node): RawRelation[] {
    return this.decoratorNames(node).map((symbol) => ({
      type: 'DECORATED_BY',
      symbol,
    }));
  }

  private heritageRelations(node: TypeScript.ClassDeclaration): RawRelation[] {
    const ts = this.ts;
    return (node.heritageClauses ?? []).flatMap((clause) =>
      clause.types.map((type): RawRelation => ({
        type:
          clause.token === ts.SyntaxKind.ExtendsKeyword
            ? 'EXTENDS'
            : 'IMPLEMENTS',
        symbol: collapseText(
          type.expression.getText(this.sourceFile),
          MAX_RELATION_TARGET_LENGTH,
        ),
      })),
    );
  }

  /** 생성자 매개변수의 타입. 주입받는 의존성을 원문 그대로 남긴다 */
  private injectRelations(node: TypeScript.ClassDeclaration): RawRelation[] {
    const ts = this.ts;
    const constructors = node.members.filter(ts.isConstructorDeclaration);
    const constructor =
      constructors.find((member) => member.body !== undefined) ??
      constructors[0];
    return (constructor?.parameters ?? [])
      .map((parameter) => parameter.type)
      .filter((type): type is TypeScript.TypeNode => type !== undefined)
      .map((type) => ({
        type: 'INJECTS',
        symbol: collapseText(
          type.getText(this.sourceFile),
          MAX_RELATION_TARGET_LENGTH,
        ),
      }));
  }

  /**
   * 심볼 안의 모든 호출(콜백 안 포함). 모듈을 읽는 require·import() 는 IMPORTS 로,
   * 데코레이터는 DECORATED_BY 로 따로 남기므로 여기서 뺀다
   */
  private callRelations(node: TypeScript.Node): RawRelation[] {
    const ts = this.ts;
    const relations: RawRelation[] = [];
    const visit = (child: TypeScript.Node): void => {
      if (ts.isDecorator(child)) {
        return;
      }
      if (
        ts.isCallExpression(child) &&
        this.requiredModule(child) === undefined
      ) {
        const symbol = this.projector.callee(child.expression);
        if (symbol) {
          relations.push({ type: 'CALLS', symbol });
        }
      }
      ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return relations;
  }

  /** 파일 맨 위에서 가져온 이름 가운데 이 심볼이 쓰는 것, 그리고 심볼 안에서 읽는 모듈 */
  private importRelations(node: TypeScript.Node): RawRelation[] {
    const ts = this.ts;
    const used = new Set<string>();
    const relations: RawRelation[] = [];
    const visit = (child: TypeScript.Node): void => {
      if (ts.isIdentifier(child) && !isMemberName(ts, child)) {
        used.add(child.text);
      }
      if (ts.isCallExpression(child)) {
        const specifier = this.requiredModule(child);
        if (specifier !== undefined) {
          relations.push({
            type: 'IMPORTS',
            symbol: importTarget(specifier),
          });
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    for (const binding of this.imports) {
      if (used.has(binding.local)) {
        relations.push({
          type: 'IMPORTS',
          symbol: importTarget(binding.specifier, binding.imported),
        });
      }
    }
    return relations;
  }

  /** `require('…')`, `require('…').x`, `import('…')` 이 읽는 모듈 지정자 */
  private requiredModule(
    expression: TypeScript.Expression,
  ): string | undefined {
    const ts = this.ts;
    let call: TypeScript.Expression = expression;
    while (ts.isPropertyAccessExpression(call)) {
      call = call.expression;
    }
    if (!ts.isCallExpression(call) || call.arguments.length !== 1) {
      return undefined;
    }
    const callee = call.expression;
    const reads =
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === 'require');
    const [argument] = call.arguments;
    return reads && ts.isStringLiteralLike(argument)
      ? argument.text
      : undefined;
  }

  /** 파일 맨 위의 import·require 가 묶는 이름들 */
  private importBindings(): ImportBinding[] {
    const ts = this.ts;
    const bindings: ImportBinding[] = [];
    for (const statement of this.sourceFile.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
      ) {
        const specifier = statement.moduleSpecifier.text;
        const clause = statement.importClause;
        if (clause?.name) {
          const local = clause.name.text;
          bindings.push({ local, specifier, imported: `default as ${local}` });
        }
        const named = clause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) {
          const local = named.name.text;
          bindings.push({ local, specifier, imported: `* as ${local}` });
        } else if (named) {
          for (const element of named.elements) {
            const local = element.name.text;
            const imported = element.propertyName?.getText(this.sourceFile);
            bindings.push({
              local,
              specifier,
              imported: imported ? `${imported} as ${local}` : local,
            });
          }
        }
        continue;
      }
      if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        ts.isStringLiteralLike(statement.moduleReference.expression)
      ) {
        const local = statement.name.text;
        bindings.push({
          local,
          specifier: statement.moduleReference.expression.text,
          imported: `* as ${local}`,
        });
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          bindings.push(...this.requireBindings(declaration));
        }
      }
    }
    return bindings;
  }

  private requireBindings(
    declaration: TypeScript.VariableDeclaration,
  ): ImportBinding[] {
    const ts = this.ts;
    const initializer = declaration.initializer;
    const specifier = initializer && this.requiredModule(initializer);
    if (!initializer || specifier === undefined) {
      return [];
    }
    if (ts.isIdentifier(declaration.name)) {
      const local = declaration.name.text;
      const member = ts.isPropertyAccessExpression(initializer)
        ? initializer.name.text
        : undefined;
      return [
        {
          local,
          specifier,
          imported: member ? `${member} as ${local}` : `* as ${local}`,
        },
      ];
    }
    if (!ts.isObjectBindingPattern(declaration.name)) {
      return [];
    }
    return declaration.name.elements.flatMap((element) => {
      if (!ts.isIdentifier(element.name)) {
        return [];
      }
      const local = element.name.text;
      const imported = element.propertyName?.getText(this.sourceFile);
      return [
        {
          local,
          specifier,
          imported: imported ? `${imported} as ${local}` : local,
        },
      ];
    });
  }
}

/** 멤버 이름 자리의 식별자(`order.status` 의 status, `{ status: 1 }` 의 status). 가져온 이름을 쓴 것으로 세지 않는다 */
function isMemberName(
  ts: TypeScriptModule,
  node: TypeScript.Identifier,
): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent)) {
    return ts.isPropertyAccessExpression(parent)
      ? parent.name === node
      : parent.right === node;
  }
  return (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isJsxAttribute(parent)) &&
    parent.name === node
  );
}

function leafName(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}
