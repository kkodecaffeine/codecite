// TypeScript·JavaScript 구문 트리에서 실행 사실을 뽑는다. 추출 때 한 번만 돌려 레코드에 저장한다
// - 조건: 바깥 분기를 쌓는다. else 는 `NOT (조건)`, 앞에서 return·throw 로 빠지는 if 뒤의 문장에는 그 if 의 부정을 더한다
// - switch 의 case, 반복문, try 의 catch·finally 도 조건 칸에 쌓는다
// - 대입: 삼항식은 갈래마다 따로 적는다(조건과 그 부정). 반환도 같다
// - 호출: 콜백 안의 호출도 그 자리의 조건으로 적는다. 콜백 안의 return 은 바깥 함수의 반환이 아니라 적지 않는다
// - 글: 문자열·템플릿 리터럴은 `<literal>`, 환경 변수 읽기는 `<env>`, 주석은 걷어 내고 공백을 줄여 자른다
import type TypeScript from 'typescript';
import type {
  ExecutionFact,
  ExecutionFactKind,
} from '../../extensions/code-knowledge.js';
import {
  CONDITION_LABELS,
  ENV_PLACEHOLDER,
  FUNCTION_BODY_PLACEHOLDER,
  LITERAL_PLACEHOLDER,
  MASK_CANDIDATE_PATTERN,
  MAX_OBJECT_FACT_DEPTH,
  MAX_RELATION_TARGET_LENGTH,
} from './constants.js';
import { collapseText, finalizeFacts, negateCondition } from './normalize.js';
import type { TypeScriptFactProjector, TypeScriptModule } from './types.js';

type Conditions = readonly string[];
type FunctionLike =
  | TypeScript.ArrowFunction
  | TypeScript.FunctionExpression
  | TypeScript.FunctionDeclaration
  | TypeScript.MethodDeclaration
  | TypeScript.AccessorDeclaration
  | TypeScript.ConstructorDeclaration;

interface FactFields {
  subject?: string;
  value?: string;
  conditions: Conditions;
}

export function createTypeScriptFactProjector(
  ts: TypeScriptModule,
): TypeScriptFactProjector {
  const lineOf = (
    sourceFile: TypeScript.SourceFile,
    node: TypeScript.Node,
  ): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;

  /** `process.env`, `import.meta.env` 자체인지 */
  const isEnvObject = (node: TypeScript.Node): boolean => {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'env') {
      return false;
    }
    const owner = node.expression;
    if (ts.isIdentifier(owner)) {
      return owner.text === 'process';
    }
    return (
      ts.isMetaProperty(owner) &&
      owner.keywordToken === ts.SyntaxKind.ImportKeyword &&
      owner.name.text === 'meta'
    );
  };

  const isEnvRead = (node: TypeScript.Node): boolean =>
    isEnvObject(node) ||
    ((ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
      isEnvObject(node.expression));

  const maskFor = (node: TypeScript.Node): string | undefined => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      return LITERAL_PLACEHOLDER;
    }
    if (ts.isJsxText(node)) {
      return node.containsOnlyTriviaWhiteSpaces
        ? undefined
        : LITERAL_PLACEHOLDER;
    }
    return isEnvRead(node) ? ENV_PLACEHOLDER : undefined;
  };

  const text = (
    sourceFile: TypeScript.SourceFile,
    node: TypeScript.Node,
  ): string => {
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const raw = sourceFile.text.slice(start, end);
    if (!MASK_CANDIDATE_PATTERN.test(raw)) {
      return collapseText(raw);
    }
    // 시작 위치 → 바꿀 끝 위치와 글. 주석은 토큰 사이 공백에서 찾는다
    const edits = new Map<number, { end: number; replacement: string }>();
    const visit = (current: TypeScript.Node): void => {
      const mask = maskFor(current);
      if (mask !== undefined) {
        edits.set(current.getStart(sourceFile), {
          end: current.getEnd(),
          replacement: mask,
        });
        return;
      }
      for (const child of current.getChildren(sourceFile)) {
        // 앞 토큰과 같은 줄의 주석은 trailing, 다음 줄부터는 leading 으로 잡힌다
        const comments = [
          ...(ts.getTrailingCommentRanges(sourceFile.text, child.pos) ?? []),
          ...(ts.getLeadingCommentRanges(sourceFile.text, child.pos) ?? []),
        ];
        for (const comment of comments) {
          if (
            comment.pos >= start &&
            comment.end <= end &&
            !edits.has(comment.pos)
          ) {
            edits.set(comment.pos, { end: comment.end, replacement: ' ' });
          }
        }
        if (!ts.isJSDoc(child)) {
          visit(child);
        }
      }
    };
    visit(node);
    let result = '';
    let cursor = start;
    for (const [position, edit] of [...edits].sort(
      ([left], [right]) => left - right,
    )) {
      if (position < cursor) {
        continue;
      }
      result += sourceFile.text.slice(cursor, position) + edit.replacement;
      cursor = edit.end;
    }
    result += sourceFile.text.slice(cursor, end);
    return collapseText(result);
  };

  const printCallee = (node: TypeScript.Expression): string | undefined => {
    if (isEnvRead(node)) {
      return ENV_PLACEHOLDER;
    }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      return node.text;
    }
    switch (node.kind) {
      case ts.SyntaxKind.ThisKeyword:
        return 'this';
      case ts.SyntaxKind.SuperKeyword:
        return 'super';
      case ts.SyntaxKind.ImportKeyword:
        return 'import';
    }
    if (ts.isPropertyAccessExpression(node)) {
      const owner = printCallee(node.expression);
      return owner === undefined
        ? undefined
        : `${owner}${node.questionDotToken ? '?.' : '.'}${node.name.text}`;
    }
    if (ts.isElementAccessExpression(node)) {
      const owner = printCallee(node.expression);
      return owner === undefined
        ? undefined
        : `${owner}${node.questionDotToken ? '?.' : ''}[...]`;
    }
    if (ts.isCallExpression(node)) {
      const owner = printCallee(node.expression);
      return owner === undefined ? undefined : `${owner}()`;
    }
    if (ts.isNewExpression(node)) {
      const owner = printCallee(node.expression);
      return owner === undefined ? undefined : `new ${owner}()`;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAwaitExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node)
    ) {
      return printCallee(node.expression);
    }
    return undefined;
  };

  const callee = (expression: TypeScript.Expression): string | undefined => {
    const printed = printCallee(expression);
    return printed !== undefined && printed.length <= MAX_RELATION_TARGET_LENGTH
      ? printed
      : undefined;
  };

  const isFunctionLike = (node: TypeScript.Node): node is FunctionLike =>
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node);

  /** 값 자리의 함수는 본문 대신 인자 이름만 적는다. 본문의 사실은 따로 펼친다 */
  const functionSummary = (
    sourceFile: TypeScript.SourceFile,
    node: FunctionLike,
  ): string => {
    const isAsync = (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
    );
    const parameters = node.parameters
      .map((parameter) => text(sourceFile, parameter.name))
      .join(', ');
    return `${isAsync ? 'async ' : ''}(${parameters}) => ${FUNCTION_BODY_PLACEHOLDER}`;
  };

  const valueText = (
    sourceFile: TypeScript.SourceFile,
    node: TypeScript.Expression,
  ): string => {
    const inner = unwrapParentheses(node);
    return isFunctionLike(inner)
      ? functionSummary(sourceFile, inner)
      : text(sourceFile, node);
  };

  const unwrapParentheses = (
    node: TypeScript.Expression,
  ): TypeScript.Expression =>
    ts.isParenthesizedExpression(node)
      ? unwrapParentheses(node.expression)
      : node;

  const unwrapValue = (node: TypeScript.Expression): TypeScript.Expression =>
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node)
      ? unwrapValue(node.expression)
      : node;

  const bodyFacts = (
    sourceFile: TypeScript.SourceFile,
    body: TypeScript.ConciseBody,
  ): ExecutionFact[] => {
    const facts: ExecutionFact[] = [];
    const add = (
      line: number,
      kind: ExecutionFactKind,
      fields: FactFields,
    ): void => {
      facts.push({
        line,
        kind,
        ...(fields.subject ? { subject: fields.subject } : {}),
        ...(fields.value ? { value: fields.value } : {}),
        conditions: [...fields.conditions],
      });
    };

    /** 삼항식을 갈래로 펼친다. 중첩 삼항식도 끝까지 */
    const branches = (
      value: TypeScript.Expression,
      conditions: Conditions,
    ): Array<{ value: string; conditions: Conditions }> => {
      const inner = unwrapParentheses(value);
      if (ts.isConditionalExpression(inner)) {
        const predicate = text(sourceFile, inner.condition);
        return [
          ...branches(inner.whenTrue, [...conditions, predicate]),
          ...branches(inner.whenFalse, [
            ...conditions,
            negateCondition(predicate),
          ]),
        ];
      }
      return [{ value: valueText(sourceFile, value), conditions }];
    };

    /** 호출이 처음 보이는 줄. 여러 줄에 걸친 연쇄 호출은 그 호출의 이름이 있는 줄을 쓴다 */
    const callLine = (call: TypeScript.CallExpression): number =>
      ts.isPropertyAccessExpression(call.expression)
        ? lineOf(sourceFile, call.expression.name)
        : lineOf(sourceFile, call);

    const argumentText = (call: TypeScript.CallExpression): string =>
      call.arguments
        .map((argument) => valueText(sourceFile, argument))
        .join(', ');

    /** 식 안의 호출을 계산 순서대로 적는다. && · || · ?? · 삼항식의 오른쪽은 그 조건 아래에서 불린다 */
    const collectCalls = (root: TypeScript.Node, conditions: Conditions) => {
      const visit = (node: TypeScript.Node, active: Conditions): void => {
        if (isFunctionLike(node)) {
          nestedFunction(node, active);
          return;
        }
        if (ts.isClassLike(node)) {
          return;
        }
        if (ts.isBinaryExpression(node)) {
          const operator = node.operatorToken.kind;
          const guard =
            operator === ts.SyntaxKind.AmpersandAmpersandToken
              ? (left: string) => left
              : operator === ts.SyntaxKind.BarBarToken
                ? negateCondition
                : operator === ts.SyntaxKind.QuestionQuestionToken
                  ? (left: string) => `${left} == null`
                  : undefined;
          if (guard) {
            visit(node.left, active);
            visit(node.right, [...active, guard(text(sourceFile, node.left))]);
            return;
          }
        }
        if (ts.isConditionalExpression(node)) {
          visit(node.condition, active);
          const predicate = text(sourceFile, node.condition);
          visit(node.whenTrue, [...active, predicate]);
          visit(node.whenFalse, [...active, negateCondition(predicate)]);
          return;
        }
        ts.forEachChild(node, (child) => visit(child, active));
        if (ts.isCallExpression(node)) {
          const subject = callee(node.expression);
          if (subject) {
            add(callLine(node), 'calls', {
              subject,
              value: argumentText(node),
              conditions: active,
            });
          }
        }
      };
      visit(root, conditions);
    };

    /** 콜백·안쪽 함수. 그 자리의 조건으로 펼치고 return 은 적지 않는다 */
    const nestedFunction = (node: FunctionLike, conditions: Conditions) => {
      if (!node.body) {
        return;
      }
      if (ts.isBlock(node.body)) {
        walkStatements(node.body.statements, conditions, true);
      } else {
        collectCalls(node.body, conditions);
      }
    };

    const assignment = (
      line: number,
      subject: string,
      value: TypeScript.Expression,
      conditions: Conditions,
      operator?: string,
    ): void => {
      for (const branch of branches(value, conditions)) {
        add(line, 'assigns', {
          subject,
          value: operator ? `${operator} ${branch.value}` : branch.value,
          conditions: branch.conditions,
        });
      }
      collectCalls(value, conditions);
    };

    const expressionStatement = (
      expression: TypeScript.Expression,
      conditions: Conditions,
    ): void => {
      if (ts.isBinaryExpression(expression)) {
        const operator = expression.operatorToken.kind;
        if (operator === ts.SyntaxKind.CommaToken) {
          expressionStatement(expression.left, conditions);
          expressionStatement(expression.right, conditions);
          return;
        }
        if (
          operator >= ts.SyntaxKind.FirstAssignment &&
          operator <= ts.SyntaxKind.LastAssignment
        ) {
          collectCalls(expression.left, conditions);
          assignment(
            lineOf(sourceFile, expression),
            text(sourceFile, expression.left),
            expression.right,
            conditions,
            operator === ts.SyntaxKind.EqualsToken
              ? undefined
              : expression.operatorToken.getText(sourceFile),
          );
          return;
        }
      }
      if (
        (ts.isPostfixUnaryExpression(expression) ||
          ts.isPrefixUnaryExpression(expression)) &&
        (expression.operator === ts.SyntaxKind.PlusPlusToken ||
          expression.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        add(lineOf(sourceFile, expression), 'assigns', {
          subject: text(sourceFile, expression.operand),
          value:
            expression.operator === ts.SyntaxKind.PlusPlusToken
              ? '+= 1'
              : '-= 1',
          conditions,
        });
        collectCalls(expression.operand, conditions);
        return;
      }
      collectCalls(expression, conditions);
    };

    /** 이 문장을 지나면 그 뒤로는 실행되지 않는지(return·throw·break·continue) */
    const exits = (node: TypeScript.Statement): boolean => {
      if (
        ts.isReturnStatement(node) ||
        ts.isThrowStatement(node) ||
        ts.isBreakStatement(node) ||
        ts.isContinueStatement(node)
      ) {
        return true;
      }
      if (ts.isBlock(node)) {
        return node.statements.some(exits);
      }
      if (ts.isIfStatement(node)) {
        return (
          node.elseStatement !== undefined &&
          exits(node.thenStatement) &&
          exits(node.elseStatement)
        );
      }
      return false;
    };

    const loopPredicate = (node: TypeScript.IterationStatement): string => {
      if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
        const binding = ts.isVariableDeclarationList(node.initializer)
          ? node.initializer.declarations
              .map((declaration) => text(sourceFile, declaration.name))
              .join(', ')
          : text(sourceFile, node.initializer);
        const keyword = ts.isForOfStatement(node) ? 'of' : 'in';
        return `${binding} ${keyword} ${text(sourceFile, node.expression)}`;
      }
      if (ts.isForStatement(node)) {
        return node.condition ? text(sourceFile, node.condition) : 'for (;;)';
      }
      return ts.isWhileStatement(node) || ts.isDoStatement(node)
        ? text(sourceFile, node.expression)
        : 'loop';
    };

    const loopHeader = (
      node: TypeScript.IterationStatement,
    ): TypeScript.Node[] => {
      if (ts.isForStatement(node)) {
        return [node.initializer, node.condition, node.incrementor].filter(
          (part): part is TypeScript.ForInitializer | TypeScript.Expression =>
            part !== undefined,
        );
      }
      return ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node)
        ? [node.expression]
        : [];
    };

    /**
     * switch 는 case 마다 조건을 만든다. 문장 없이 이어지는 case 는 다음 case 와 묶어 `||` 로 잇고,
     * default 는 다른 묶음의 case 를 모두 부정한 조건이 된다
     */
    const switchStatement = (
      node: TypeScript.SwitchStatement,
      conditions: Conditions,
      nested: boolean,
    ): void => {
      collectCalls(node.expression, conditions);
      const subject = text(sourceFile, node.expression);
      const groups: TypeScript.CaseOrDefaultClause[][] = [];
      let pending: TypeScript.CaseOrDefaultClause[] = [];
      for (const clause of node.caseBlock.clauses) {
        pending.push(clause);
        if (clause.statements.length > 0) {
          groups.push(pending);
          pending = [];
        }
      }
      if (pending.length > 0) {
        groups.push(pending);
      }
      const casePredicate = (clause: TypeScript.CaseClause): string =>
        `${subject} === ${text(sourceFile, clause.expression)}`;
      for (const group of groups) {
        const cases = group.filter(ts.isCaseClause);
        for (const clause of cases) {
          collectCalls(clause.expression, conditions);
        }
        let predicate: string | undefined;
        if (cases.length < group.length) {
          const others = groups
            .filter((other) => other !== group)
            .flatMap((other) => other.filter(ts.isCaseClause))
            .map(casePredicate);
          predicate =
            others.length > 0
              ? negateCondition(others.join(' || '))
              : undefined;
        } else {
          predicate = cases.map(casePredicate).join(' || ');
        }
        const inner = predicate ? [...conditions, predicate] : conditions;
        if (predicate) {
          add(lineOf(sourceFile, group[0]), 'condition', {
            value: predicate,
            conditions,
          });
        }
        walkStatements(
          group.flatMap((clause) => [...clause.statements]),
          inner,
          nested,
        );
      }
    };

    /** 문장 하나를 펼친다. 뒤따르는 문장에 더할 조건(앞에서 빠져나간 if 의 부정)이 있으면 돌려준다 */
    const walkStatement = (
      node: TypeScript.Statement,
      conditions: Conditions,
      nested: boolean,
    ): string | undefined => {
      if (ts.isBlock(node)) {
        walkStatements(node.statements, conditions, nested);
        return undefined;
      }
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (declaration.initializer) {
            assignment(
              lineOf(sourceFile, declaration),
              text(sourceFile, declaration.name),
              declaration.initializer,
              conditions,
            );
          }
        }
        return undefined;
      }
      if (ts.isExpressionStatement(node)) {
        expressionStatement(node.expression, conditions);
        return undefined;
      }
      if (ts.isIfStatement(node)) {
        const predicate = text(sourceFile, node.expression);
        add(lineOf(sourceFile, node.expression), 'condition', {
          value: predicate,
          conditions,
        });
        collectCalls(node.expression, conditions);
        walkStatement(node.thenStatement, [...conditions, predicate], nested);
        if (node.elseStatement) {
          walkStatement(
            node.elseStatement,
            [...conditions, negateCondition(predicate)],
            nested,
          );
        }
        const thenExits = exits(node.thenStatement);
        const elseExits =
          node.elseStatement !== undefined && exits(node.elseStatement);
        if (thenExits && !elseExits) {
          return negateCondition(predicate);
        }
        if (elseExits && !thenExits) {
          return predicate;
        }
        return undefined;
      }
      if (ts.isReturnStatement(node)) {
        if (!nested) {
          const line = lineOf(sourceFile, node);
          if (node.expression) {
            for (const branch of branches(node.expression, conditions)) {
              add(line, 'returns', branch);
            }
          } else {
            add(line, 'returns', { conditions });
          }
        }
        if (node.expression) {
          collectCalls(node.expression, conditions);
        }
        return undefined;
      }
      if (ts.isThrowStatement(node)) {
        add(lineOf(sourceFile, node), 'throws', {
          value: text(sourceFile, node.expression),
          conditions,
        });
        collectCalls(node.expression, conditions);
        return undefined;
      }
      if (ts.isTryStatement(node)) {
        walkStatement(node.tryBlock, conditions, nested);
        if (node.catchClause) {
          walkStatement(
            node.catchClause.block,
            [...conditions, CONDITION_LABELS.catch],
            nested,
          );
        }
        if (node.finallyBlock) {
          walkStatement(
            node.finallyBlock,
            [...conditions, CONDITION_LABELS.finally],
            nested,
          );
        }
        return undefined;
      }
      if (ts.isIterationStatement(node, false)) {
        const predicate = loopPredicate(node);
        add(lineOf(sourceFile, node), 'condition', {
          value: predicate,
          conditions,
        });
        for (const part of loopHeader(node)) {
          collectCalls(part, conditions);
        }
        walkStatement(node.statement, [...conditions, predicate], nested);
        return undefined;
      }
      if (ts.isSwitchStatement(node)) {
        switchStatement(node, conditions, nested);
        return undefined;
      }
      if (ts.isLabeledStatement(node)) {
        return walkStatement(node.statement, conditions, nested);
      }
      if (ts.isFunctionDeclaration(node)) {
        nestedFunction(node, conditions);
        return undefined;
      }
      if (
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isBreakStatement(node) ||
        ts.isContinueStatement(node) ||
        ts.isEmptyStatement(node) ||
        ts.isDebuggerStatement(node)
      ) {
        return undefined;
      }
      collectCalls(node, conditions);
      return undefined;
    };

    const walkStatements = (
      statements: readonly TypeScript.Statement[],
      conditions: Conditions,
      nested: boolean,
    ): void => {
      let current = conditions;
      for (const statement of statements) {
        const narrowed = walkStatement(statement, current, nested);
        if (narrowed) {
          current = [...current, narrowed];
        }
      }
    };

    if (ts.isBlock(body)) {
      walkStatements(body.statements, [], false);
    } else {
      const line = lineOf(sourceFile, body);
      for (const branch of branches(body, [])) {
        add(line, 'returns', branch);
      }
      collectCalls(body, []);
    }
    return finalizeFacts(facts);
  };

  const constantFacts = (
    sourceFile: TypeScript.SourceFile,
    subject: string,
    initializer: TypeScript.Expression,
  ): ExecutionFact[] => {
    const facts: ExecutionFact[] = [];
    const visit = (
      name: string,
      value: TypeScript.Expression,
      depth: number,
    ): void => {
      const inner = unwrapValue(value);
      if (
        ts.isObjectLiteralExpression(inner) &&
        depth < MAX_OBJECT_FACT_DEPTH
      ) {
        const before = facts.length;
        for (const property of inner.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            (ts.isIdentifier(property.name) ||
              ts.isNumericLiteral(property.name))
          ) {
            visit(
              `${name}.${property.name.text}`,
              property.initializer,
              depth + 1,
            );
          } else if (ts.isShorthandPropertyAssignment(property)) {
            facts.push({
              line: lineOf(sourceFile, property),
              kind: 'assigns',
              subject: `${name}.${property.name.text}`,
              value: property.name.text,
            });
          }
        }
        if (facts.length > before) {
          return;
        }
      }
      facts.push({
        line: lineOf(sourceFile, value),
        kind: 'assigns',
        subject: name,
        value: valueText(sourceFile, value),
      });
    };
    visit(subject, initializer, 0);
    return finalizeFacts(facts);
  };

  /** 열거형 멤버. 값을 적지 않은 숫자 멤버는 앞 멤버에 1 을 더한 값으로 적는다 */
  const enumFacts = (
    sourceFile: TypeScript.SourceFile,
    declaration: TypeScript.EnumDeclaration,
  ): ExecutionFact[] => {
    const facts: ExecutionFact[] = [];
    let next: number | undefined = 0;
    for (const member of declaration.members) {
      let value: string | undefined;
      if (member.initializer) {
        value = text(sourceFile, member.initializer);
        next = ts.isNumericLiteral(member.initializer)
          ? Number(member.initializer.text) + 1
          : undefined;
      } else if (next !== undefined) {
        value = String(next);
        next += 1;
      }
      facts.push({
        line: lineOf(sourceFile, member),
        kind: 'assigns',
        subject: `${declaration.name.text}.${member.name.getText(sourceFile)}`,
        ...(value !== undefined ? { value } : {}),
      });
    }
    return finalizeFacts(facts);
  };

  return { bodyFacts, constantFacts, enumFacts, text, callee };
}
