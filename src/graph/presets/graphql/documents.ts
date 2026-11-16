// 코드와 문서 파일에서 GraphQL 연산을 모은다
// - `.graphql` 심볼: 원문이 연산 문서다
// - gql 태그 글 상수(`const GET_ORDER = gql\`…\``): 상수 값이 통째로 태그 글일 때만(대입 자리 값이 `gql<literal>`) 원문의 백틱 사이를 문서로 읽는다
// - `graphql('query …')`·`gql('…')` 호출: 자리 인자의 문자열을 문서로 읽는다
// 주석이나 일반 문자열 안의 연산 모양 글은 읽지 않는다
import { CLIPPED_TEXT_MARK } from '../../extractors/constants.js';
import { matchesGlob } from '../../files.js';
import type {
  CodeSite,
  CodeSiteArgument,
  ExtractedSymbol,
  PresetContext,
} from '../../types.js';
import { DOCUMENT_TAGS, GRAPHQL_LANGUAGE } from './constants.js';
import { parseGraphqlDocument } from './document.js';
import type {
  EmbeddedGraphqlDocument,
  ParsedGraphqlOperation,
  RepositoryGraphqlOperation,
} from './types.js';

/** 태그 글 값을 가린 꼴(`gql<literal>`, `Apollo.gql<literal>`) */
const TAGGED_TEMPLATE_VALUE = /^(?:[\w$]+\.)*([\w$]+)<literal>$/;

/** 같은 배열이면 같은 색인. 정규화한 연산 이름 → 연산들 */
const operationIndexes = new WeakMap<
  readonly ExtractedSymbol[],
  ReadonlyMap<string, readonly RepositoryGraphqlOperation[]>
>();

/** 심볼 하나가 담은 연산. 줄 번호는 파일 기준이다. 닫히지 않은(잘린) 연산도 이름과 함께 돌려준다 */
export function symbolOperations(
  symbol: ExtractedSymbol,
): Array<{ operation: ParsedGraphqlOperation; origin: string }> {
  if (symbol.language === GRAPHQL_LANGUAGE) {
    return parseGraphqlDocument(symbol.content).operations.map((operation) => ({
      operation: shiftLines(operation, symbol.lineStart - 1),
      origin: `document ${symbol.filePath}`,
    }));
  }
  return embeddedDocuments(symbol).flatMap((document) =>
    parseGraphqlDocument(document.text).operations.map((operation) => ({
      operation: shiftLines(operation, document.line - 1),
      origin: document.origin,
    })),
  );
}

function shiftLines(
  operation: ParsedGraphqlOperation,
  offset: number,
): ParsedGraphqlOperation {
  return {
    ...operation,
    lineStart: operation.lineStart + offset,
    lineEnd: operation.lineEnd + offset,
  };
}

/** 코드 심볼 안의 연산 문서: 태그 글 상수 값과 graphql()·gql() 호출 인자 */
export function embeddedDocuments(
  symbol: ExtractedSymbol,
): EmbeddedGraphqlDocument[] {
  const documents: EmbeddedGraphqlDocument[] = [];
  const tagged = taggedDocument(symbol);
  if (tagged) {
    documents.push(tagged);
  }
  for (const site of symbol.sites ?? []) {
    const document = callDocument(site);
    if (document) {
      documents.push(document);
    }
  }
  return documents;
}

/** 값 전체가 gql 태그 글인 상수인지. 상수의 대입 자리나 대입 사실 값이 `gql<literal>` 꼴이면 그렇다 */
function isTaggedConstant(symbol: ExtractedSymbol): boolean {
  if (symbol.kind !== 'constant') {
    return false;
  }
  const values = [
    ...(symbol.sites ?? [])
      .filter((site) => site.kind === 'assign' && site.name === symbol.symbol)
      .map((site) => site.args[0]?.text),
    ...(symbol.executionFacts ?? [])
      .filter(
        (fact) => fact.kind === 'assigns' && fact.subject === symbol.symbol,
      )
      .map((fact) => fact.value),
  ];
  return values.some((value) => {
    const tag =
      value === undefined ? undefined : TAGGED_TEMPLATE_VALUE.exec(value)?.[1];
    return tag !== undefined && DOCUMENT_TAGS.includes(tag);
  });
}

/** 태그 글 상수의 문서. 원문의 첫 백틱과 마지막 백틱 사이이고, `${fragment}` 치환 자리는 공백으로 지운다 */
function taggedDocument(
  symbol: ExtractedSymbol,
): EmbeddedGraphqlDocument | undefined {
  if (!isTaggedConstant(symbol)) {
    return undefined;
  }
  const open = symbol.content.indexOf('`');
  const close = symbol.content.lastIndexOf('`');
  if (open < 0 || close <= open) {
    return undefined;
  }
  const before = symbol.content.slice(0, open);
  return {
    text: blankSubstitutions(symbol.content.slice(open + 1, close)),
    line: symbol.lineStart + countLines(before),
    origin: `gql template ${symbol.symbol}`,
  };
}

/** `graphql('…')`·`gql(\`…\`)` 호출 자리의 문서. 이름만 보고 다른 인자 꼴은 읽지 않는다 */
export function callDocument(
  site: CodeSite,
): EmbeddedGraphqlDocument | undefined {
  if (site.kind !== 'call' || !DOCUMENT_TAGS.includes(site.name)) {
    return undefined;
  }
  const text = documentText(site.args[0]);
  return text === undefined
    ? undefined
    : { text, line: site.line, origin: `${site.name}() at line ${site.line}` };
}

function documentText(
  argument: CodeSiteArgument | undefined,
): string | undefined {
  const raw =
    argument?.literal ??
    (argument?.template ? argument.template.join(' ') : undefined);
  if (raw === undefined) {
    return undefined;
  }
  // 자리 인자 글은 길이 한도에서 잘린다. 잘린 표시를 떼면 앞쪽 연산의 이름은 읽을 수 있다
  return raw.endsWith(CLIPPED_TEXT_MARK)
    ? raw.slice(0, -CLIPPED_TEXT_MARK.length)
    : raw;
}

function countLines(text: string): number {
  let count = 0;
  for (const character of text) {
    if (character === '\n') {
      count += 1;
    }
  }
  return count;
}

/** `${…}` 를 같은 길이 공백으로 지운다. 줄 바꿈은 남겨 줄 번호를 지킨다 */
function blankSubstitutions(text: string): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    if (!text.startsWith('${', index)) {
      result += text[index];
      index += 1;
      continue;
    }
    let depth = 0;
    let end = index + 1;
    for (; end < text.length; end += 1) {
      if (text[end] === '{') {
        depth += 1;
      } else if (text[end] === '}') {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    result += text.slice(index, end + 1).replace(/[^\n]/g, ' ');
    index = end + 1;
  }
  return result;
}

/** 연산 이름을 견주는 꼴. 생성기가 이름을 PascalCase 로 바꾸므로 대소문자와 밑줄을 가리지 않는다 */
export function operationKey(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

/** 저장소 안 연산 색인. 심볼 목록이 없으면 undefined */
export function repositoryOperations(
  context: PresetContext,
): ReadonlyMap<string, readonly RepositoryGraphqlOperation[]> | undefined {
  const symbols = context.symbols;
  if (!symbols) {
    return undefined;
  }
  const cached = operationIndexes.get(symbols);
  if (cached) {
    return cached;
  }
  const index = new Map<string, RepositoryGraphqlOperation[]>();
  for (const symbol of symbols) {
    for (const { operation } of symbolOperations(symbol)) {
      const key = operationKey(operation.operationName);
      const list = index.get(key) ?? [];
      list.push({
        operation,
        filePath: symbol.filePath,
        symbol: symbol.symbol,
      });
      index.set(key, list);
    }
  }
  operationIndexes.set(symbols, index);
  return index;
}

/**
 * 이름 규칙으로 얻은 연산 이름(`GetOrder`)을 저장소의 연산 문서와 맞춘다
 * 같은 이름이 있으면 그대로, 대소문자·밑줄만 다른 이름이 하나뿐이면 그 이름(`getOrder`), 없으면 found 가 false 다
 */
export function matchOperationName(
  name: string,
  context: PresetContext,
): { name: string; found: boolean } {
  const candidates =
    repositoryOperations(context)?.get(operationKey(name)) ?? [];
  if (candidates.some((item) => item.operation.operationName === name)) {
    return { name, found: true };
  }
  const names = [
    ...new Set(candidates.map((item) => item.operation.operationName)),
  ];
  const only = names.length === 1 ? names[0] : undefined;
  return only === undefined
    ? { name, found: false }
    : { name: only, found: true };
}

/** 이 파일이 속한 스키마. hints.graphqlSchemas 가운데 이 저장소·경로를 덮는 것이 하나뿐일 때만 */
export function schemaFor(
  context: PresetContext,
  filePath: string,
): string | undefined {
  const matches = Object.entries(context.config.hints.graphqlSchemas ?? {})
    .filter(
      ([, scope]) =>
        scope.repository === context.repository &&
        (scope.paths === undefined ||
          scope.paths.length === 0 ||
          scope.paths.some((path) => coversPath(path, filePath))),
    )
    .map(([name]) => name);
  return matches.length === 1 ? matches[0] : undefined;
}

function coversPath(pattern: string, filePath: string): boolean {
  if (/[*?[{]/.test(pattern)) {
    return matchesGlob(filePath, pattern);
  }
  const prefix = pattern.replace(/\/+$/, '');
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}
