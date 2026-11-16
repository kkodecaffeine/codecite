// TypeScript·JavaScript 구문 트리에서 호출·생성·데코레이터 자리를 읽는다
// 프리셋 탐지기는 이 자리의 인자 값(문자열, 템플릿 조각, 상수 이름, 객체 속성)으로 경로·큐 이름을 맞춘다
// 값의 비밀값 가리기는 normalize.ts 의 finalizeSites 가 추출기를 떠나기 전에 한다
import type TypeScript from 'typescript';
import type { CodeSite, CodeSiteArgument } from '../types.js';
import {
  CLIPPED_TEXT_MARK,
  MAX_SITE_ARGUMENT_DEPTH,
  MAX_SITE_ARGUMENT_ENTRIES,
  MAX_SITE_LITERAL_LENGTH,
  MODULE_LOADER_CALLEES,
} from './constants.js';
import type {
  TypeScriptFactProjector,
  TypeScriptModule,
  TypeScriptSiteReader,
} from './types.js';

export function createTypeScriptSiteReader(
  ts: TypeScriptModule,
  projector: TypeScriptFactProjector,
): TypeScriptSiteReader {
  const lineOf = (
    sourceFile: TypeScript.SourceFile,
    node: TypeScript.Node,
  ): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;

  const clipLiteral = (value: string): string =>
    value.length <= MAX_SITE_LITERAL_LENGTH
      ? value
      : `${value.slice(0, MAX_SITE_LITERAL_LENGTH - CLIPPED_TEXT_MARK.length)}${CLIPPED_TEXT_MARK}`;

  const unwrap = (node: TypeScript.Expression): TypeScript.Expression =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
      ? unwrap(node.expression)
      : node;

  /** `process.env`, `import.meta.env` 이면 그 이름 */
  const envOwner = (node: TypeScript.Expression): string | undefined => {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'env') {
      return undefined;
    }
    const owner = node.expression;
    if (ts.isIdentifier(owner) && owner.text === 'process') {
      return 'process.env';
    }
    return ts.isMetaProperty(owner) &&
      owner.keywordToken === ts.SyntaxKind.ImportKeyword &&
      owner.name.text === 'meta'
      ? 'import.meta.env'
      : undefined;
  };

  /** 이름 하나나 멤버 연쇄. 환경 변수 읽기는 `process.env.이름` 꼴 */
  const identifierOf = (node: TypeScript.Expression): string | undefined => {
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const env = envOwner(node.expression);
      if (env) {
        const key = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : ts.isStringLiteralLike(node.argumentExpression)
            ? node.argumentExpression.text
            : undefined;
        return key === undefined ? undefined : `${env}.${key}`;
      }
    }
    const chain = memberChain(node);
    return chain === 'this' ? undefined : chain;
  };

  const memberChain = (node: TypeScript.Expression): string | undefined => {
    if (ts.isIdentifier(node)) {
      return node.text;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      return 'this';
    }
    if (ts.isPropertyAccessExpression(node)) {
      const owner = memberChain(unwrap(node.expression));
      return owner === undefined ? undefined : `${owner}.${node.name.text}`;
    }
    return undefined;
  };

  const isStringLike = (node: TypeScript.Expression): boolean =>
    ts.isStringLiteralLike(node) || ts.isTemplateExpression(node);

  /** `a + 'b' + c` 를 더하기 순서대로 펼친다. 문자열이 하나도 없으면 undefined */
  const concatenation = (
    node: TypeScript.Expression,
  ): TypeScript.Expression[] | undefined => {
    if (
      !ts.isBinaryExpression(node) ||
      node.operatorToken.kind !== ts.SyntaxKind.PlusToken
    ) {
      return undefined;
    }
    const operands: TypeScript.Expression[] = [];
    const flatten = (current: TypeScript.Expression): void => {
      const inner = ts.isParenthesizedExpression(current)
        ? current.expression
        : current;
      if (
        ts.isBinaryExpression(inner) &&
        inner.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        flatten(inner.left);
        flatten(inner.right);
      } else {
        operands.push(inner);
      }
    };
    flatten(node);
    return operands.some(isStringLike) ? operands : undefined;
  };

  const argument = (
    sourceFile: TypeScript.SourceFile,
    node: TypeScript.Expression,
    depth = 0,
  ): CodeSiteArgument => {
    const text = projector.text(sourceFile, node);
    const inner = unwrap(node);
    if (ts.isStringLiteralLike(inner)) {
      return { text, literal: clipLiteral(inner.text) };
    }
    const pieces = ts.isTemplateExpression(inner)
      ? [inner]
      : concatenation(inner);
    if (pieces) {
      const template = [''];
      const substitutions: CodeSiteArgument[] = [];
      const substitute = (expression: TypeScript.Expression): void => {
        substitutions.push(argument(sourceFile, expression, depth + 1));
        template.push('');
      };
      for (const piece of pieces) {
        if (ts.isStringLiteralLike(piece)) {
          template[template.length - 1] += piece.text;
        } else if (ts.isTemplateExpression(piece)) {
          template[template.length - 1] += piece.head.text;
          for (const span of piece.templateSpans) {
            substitute(span.expression);
            template[template.length - 1] += span.literal.text;
          }
        } else {
          substitute(piece);
        }
      }
      return { text, template: template.map(clipLiteral), substitutions };
    }
    const identifier = identifierOf(inner);
    if (identifier !== undefined) {
      return { text, identifier };
    }
    if (depth >= MAX_SITE_ARGUMENT_DEPTH) {
      return { text };
    }
    if (ts.isObjectLiteralExpression(inner)) {
      const entries: Array<[string, CodeSiteArgument]> = [];
      for (const property of inner.properties) {
        if (entries.length >= MAX_SITE_ARGUMENT_ENTRIES) {
          break;
        }
        if (ts.isShorthandPropertyAssignment(property)) {
          const name = property.name.text;
          entries.push([name, { text: name, identifier: name }]);
        } else if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) ||
            ts.isStringLiteralLike(property.name) ||
            ts.isNumericLiteral(property.name))
        ) {
          entries.push([
            property.name.text,
            argument(sourceFile, property.initializer, depth + 1),
          ]);
        }
      }
      return entries.length > 0
        ? { text, properties: Object.fromEntries(entries) }
        : { text };
    }
    if (ts.isArrayLiteralExpression(inner)) {
      return {
        text,
        elements: inner.elements
          .slice(0, MAX_SITE_ARGUMENT_ENTRIES)
          .map((element) => argument(sourceFile, element, depth + 1)),
      };
    }
    return { text };
  };

  const decoratorSite = (
    sourceFile: TypeScript.SourceFile,
    decorator: TypeScript.Decorator,
  ): CodeSite | undefined => {
    const expression = decorator.expression;
    const call = ts.isCallExpression(expression) ? expression : undefined;
    const name = projector.callee(call ? call.expression : expression);
    if (name === undefined) {
      return undefined;
    }
    return {
      kind: 'decorator',
      name,
      line: lineOf(sourceFile, decorator),
      args: (call?.arguments ?? []).map((item) => argument(sourceFile, item)),
    };
  };

  const decoratorSites = (
    sourceFile: TypeScript.SourceFile,
    node: TypeScript.Node,
  ): CodeSite[] =>
    (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [])
      .map((decorator) => decoratorSite(sourceFile, decorator))
      .filter((site): site is CodeSite => site !== undefined);

  const sites = (
    sourceFile: TypeScript.SourceFile,
    node: TypeScript.Node,
  ): CodeSite[] => {
    const found: CodeSite[] = [];
    const visit = (current: TypeScript.Node): void => {
      if (current !== node && ts.isClassLike(current)) {
        return;
      }
      if (ts.isDecorator(current)) {
        const site = decoratorSite(sourceFile, current);
        if (site) {
          found.push(site);
        }
        return;
      }
      ts.forEachChild(current, visit);
      if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
        const name = projector.callee(current.expression);
        if (name === undefined || MODULE_LOADER_CALLEES.includes(name)) {
          return;
        }
        const named =
          ts.isCallExpression(current) &&
          ts.isPropertyAccessExpression(current.expression)
            ? current.expression.name
            : current;
        found.push({
          kind: ts.isCallExpression(current) ? 'call' : 'new',
          name,
          line: lineOf(sourceFile, named),
          args: (current.arguments ?? []).map((item) =>
            argument(sourceFile, item),
          ),
        });
      }
    };
    visit(node);
    return found;
  };

  /** 값 하나를 받는 자리. 상수 이름이나 멤버 연쇄가 받는 쪽이다 */
  const assignSite = (
    sourceFile: TypeScript.SourceFile,
    name: string,
    value: TypeScript.Expression,
    at: TypeScript.Node,
  ): CodeSite => ({
    kind: 'assign',
    name,
    line: lineOf(sourceFile, at),
    args: [argument(sourceFile, value)],
  });

  return {
    sites,
    decoratorSites,
    assignSite,
    argument: (sourceFile, node) => argument(sourceFile, node),
  };
}
