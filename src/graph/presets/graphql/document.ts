// GraphQL 연산 문서 읽기. 정규식 한 줄 대신 토큰으로 나눠, 문자열·주석 안의 글자가 필드나 괄호로 읽히지 않게 한다
// 이름 있는 query·mutation·subscription 만 연산으로 내고, 이름 없는 연산·fragment·스키마 정의는 건너뛴다
// 루트 필드는 첫 선택 집합의 필드다. 별칭(`latest: order(id: 1)`)은 실제 필드로 바꾸고, fragment 펼침·인라인 fragment·지시문·`__typename` 은 뺀다
import type { GraphqlOperationType } from '../../types.js';
import {
  GRAPHQL_DEFINITION_KEYWORDS,
  GRAPHQL_OPERATION_TYPES,
  GRAPHQL_PUNCTUATORS,
  INTROSPECTION_FIELD_PREFIX,
} from './constants.js';
import type {
  GraphqlDocumentParse,
  GraphqlToken,
  ParsedGraphqlOperation,
} from './types.js';

/** 문서 읽기를 멈추는 오류. 줄 번호를 함께 둔다 */
class GraphqlSyntaxError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

/** 문서를 토큰으로 나눈다. 공백, 쉼표, `#` 주석은 버리고 문자열은 한 토큰으로 묶는다 */
export function tokenizeGraphql(source: string): GraphqlToken[] {
  const tokens: GraphqlToken[] = [];
  let index = 0;
  let line = 1;
  const push = (
    kind: GraphqlToken['kind'],
    start: number,
    end: number,
    startLine: number,
  ): void => {
    tokens.push({
      kind,
      value: source.slice(start, end),
      line: startLine,
      start,
      end,
    });
  };
  while (index < source.length) {
    const character = source[index] ?? '';
    if (character === '\n') {
      line += 1;
      index += 1;
      continue;
    }
    if (/[\s,\uFEFF]/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '#') {
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      continue;
    }
    const start = index;
    const startLine = line;
    if (source.startsWith('"""', index)) {
      index += 3;
      while (index < source.length && !source.startsWith('"""', index)) {
        if (source.startsWith('\\"""', index)) {
          index += 4;
          continue;
        }
        if (source[index] === '\n') {
          line += 1;
        }
        index += 1;
      }
      if (index >= source.length) {
        throw new GraphqlSyntaxError(startLine, 'unterminated block string');
      }
      index += 3;
      push('string', start, index, startLine);
      continue;
    }
    if (character === '"') {
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\n') {
          throw new GraphqlSyntaxError(startLine, 'unterminated string');
        }
        index += source[index] === '\\' ? 2 : 1;
      }
      if (index >= source.length) {
        throw new GraphqlSyntaxError(startLine, 'unterminated string');
      }
      index += 1;
      push('string', start, index, startLine);
      continue;
    }
    if (source.startsWith('...', index)) {
      index += 3;
      push('punctuator', start, index, startLine);
      continue;
    }
    if (GRAPHQL_PUNCTUATORS.includes(character)) {
      index += 1;
      push('punctuator', start, index, startLine);
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      while (index < source.length && /\w/.test(source[index] ?? '')) {
        index += 1;
      }
      push('name', start, index, startLine);
      continue;
    }
    if (/[-\d]/.test(character)) {
      index += 1;
      while (index < source.length && /[\w.+-]/.test(source[index] ?? '')) {
        index += 1;
      }
      push('number', start, index, startLine);
      continue;
    }
    throw new GraphqlSyntaxError(
      startLine,
      `unexpected character ${JSON.stringify(character)}`,
    );
  }
  return tokens;
}

/** 문서의 이름 있는 연산을 읽는다. 읽다가 막히면 그 앞까지 읽은 연산과 오류를 돌려준다 */
export function parseGraphqlDocument(source: string): GraphqlDocumentParse {
  let tokens: GraphqlToken[];
  try {
    tokens = tokenizeGraphql(source);
  } catch (error) {
    return { operations: [], error: syntaxError(error) };
  }
  const parser = new DocumentParser(tokens);
  try {
    parser.parse();
    return { operations: parser.operations };
  } catch (error) {
    return { operations: parser.operations, error: syntaxError(error) };
  }
}

function syntaxError(error: unknown): { line: number; message: string } {
  if (error instanceof GraphqlSyntaxError) {
    return { line: error.line, message: error.message };
  }
  throw error;
}

class DocumentParser {
  readonly operations: ParsedGraphqlOperation[] = [];
  private index = 0;

  constructor(private readonly tokens: readonly GraphqlToken[]) {}

  parse(): void {
    while (this.index < this.tokens.length) {
      const token = this.peek();
      if (!token) {
        return;
      }
      if (token.kind === 'punctuator' && token.value === '{') {
        // 이름 없는 query 줄임 꼴. 연산 이름이 없어 잇지 못하므로 건너뛴다
        this.skipGroup();
        continue;
      }
      if (
        token.kind === 'name' &&
        (GRAPHQL_OPERATION_TYPES as readonly string[]).includes(token.value)
      ) {
        this.readOperation();
        continue;
      }
      if (token.kind === 'name') {
        // fragment·스키마 정의(type, enum, schema …)는 연산이 아니다
        this.skipDefinition();
        continue;
      }
      if (token.kind === 'string') {
        // 스키마 정의 앞의 설명 글
        this.index += 1;
        continue;
      }
      throw new GraphqlSyntaxError(
        token.line,
        `unexpected ${JSON.stringify(token.value)} at top level`,
      );
    }
  }

  private peek(offset = 0): GraphqlToken | undefined {
    return this.tokens[this.index + offset];
  }

  private isPunctuator(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token?.kind === 'punctuator' && token.value === value;
  }

  private readOperation(): void {
    const keyword = this.tokens[this.index] as GraphqlToken;
    this.index += 1;
    const name = this.peek()?.kind === 'name' ? this.peek() : undefined;
    if (name) {
      this.index += 1;
    }
    if (this.isPunctuator('(')) {
      this.skipGroup();
    }
    this.skipDirectives();
    if (!this.isPunctuator('{')) {
      throw new GraphqlSyntaxError(
        keyword.line,
        `${keyword.value} ${name?.value ?? ''} has no selection set`.replace(
          /\s+/g,
          ' ',
        ),
      );
    }
    const selection = this.readRootSelection();
    if (name) {
      const last = this.tokens[selection.endIndex] ?? keyword;
      this.operations.push({
        operationType: keyword.value as GraphqlOperationType,
        operationName: name.value,
        rootFields: selection.fields,
        lineStart: keyword.line,
        lineEnd: last.line,
        start: keyword.start,
        end: last.end,
        closed: selection.closed,
      });
    }
    if (!selection.closed) {
      throw new GraphqlSyntaxError(
        keyword.line,
        `${keyword.value} ${name?.value ?? ''} is not closed`.replace(
          /\s+/g,
          ' ',
        ),
      );
    }
  }

  /** 첫 선택 집합의 필드. 지금 자리는 `{` 다 */
  private readRootSelection(): {
    fields: string[];
    endIndex: number;
    closed: boolean;
  } {
    const fields: string[] = [];
    this.index += 1;
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index] as GraphqlToken;
      if (token.kind === 'punctuator' && token.value === '}') {
        const endIndex = this.index;
        this.index += 1;
        return { fields: [...new Set(fields)], endIndex, closed: true };
      }
      if (token.kind === 'punctuator' && token.value === '...') {
        this.index += 1;
        if (this.peek()?.kind === 'name' && this.peek()?.value === 'on') {
          this.index += 2;
        } else if (this.peek()?.kind === 'name') {
          this.index += 1;
        }
        this.skipDirectives();
        if (this.isPunctuator('{')) {
          this.skipGroup();
        }
        continue;
      }
      if (token.kind === 'name') {
        this.index += 1;
        let field = token.value;
        if (this.isPunctuator(':') && this.peek(1)?.kind === 'name') {
          field = (this.peek(1) as GraphqlToken).value;
          this.index += 2;
        }
        if (!field.startsWith(INTROSPECTION_FIELD_PREFIX)) {
          fields.push(field);
        }
        if (this.isPunctuator('(')) {
          this.skipGroup();
        }
        this.skipDirectives();
        if (this.isPunctuator('{')) {
          this.skipGroup();
        }
        continue;
      }
      this.index += 1;
    }
    return {
      fields: [...new Set(fields)],
      endIndex: this.tokens.length - 1,
      closed: false,
    };
  }

  private skipDirectives(): void {
    while (this.isPunctuator('@')) {
      this.index += 1;
      if (this.peek()?.kind === 'name') {
        this.index += 1;
      }
      if (this.isPunctuator('(')) {
        this.skipGroup();
      }
    }
  }

  /** 지금 자리의 여는 괄호에서 짝이 맞는 닫는 괄호 뒤까지 건너뛴다. 닫히지 않으면 끝까지 간다 */
  private skipGroup(): void {
    const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
    const stack: string[] = [];
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index] as GraphqlToken;
      this.index += 1;
      if (token.kind !== 'punctuator') {
        continue;
      }
      const close = pairs[token.value];
      if (close) {
        stack.push(close);
      } else if (token.value === stack.at(-1)) {
        stack.pop();
        if (stack.length === 0) {
          return;
        }
      }
    }
  }

  /** 연산이 아닌 정의(fragment, 스키마 정의)를 다음 정의 낱말까지 건너뛴다 */
  private skipDefinition(): void {
    this.index += 1;
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index] as GraphqlToken;
      if (
        token.kind === 'punctuator' &&
        (token.value === '{' || token.value === '(' || token.value === '[')
      ) {
        this.skipGroup();
        continue;
      }
      if (
        token.kind === 'name' &&
        GRAPHQL_DEFINITION_KEYWORDS.includes(token.value)
      ) {
        return;
      }
      this.index += 1;
    }
  }
}
