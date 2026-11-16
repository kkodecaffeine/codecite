// GraphQL 탐지 프리셋 세 개
// - nestjs: 리졸버 메서드(`@Query`, `@Mutation`, `@Subscription`, `@ResolveField`). 이름은 name 옵션이나 메서드 이름. HTTP nestjs 프리셋과 이름이 같아 함께 켜진다
// - graphql-codegen: 생성된 훅(`useGetOrderQuery`)과 문서 상수(`GetOrderDocument`) 이름에서 연산 이름을 읽는다
// - apollo-client: `useQuery(GET_ORDER)`, `client.query({ query: GET_ORDER })` 의 문서 인자를 같은 저장소의 gql 문서 상수로 풀어 연산 이름을 읽는다
// 연산 문서 탐지(.graphql 심볼, gql 태그 글 상수, graphql() 호출)는 graphql-codegen 이 켜져 있으면 그쪽이, 아니면 apollo-client 가 낸다
import type {
  CodeSite,
  CodeSiteArgument,
  DetectionPreset,
  ExtractedSymbol,
  GraphqlClientCallDetection,
  GraphqlDocumentDetection,
  GraphqlResolverDetection,
  PresetContext,
} from '../../types.js';
import { staticText } from '../http/arguments.js';
import {
  callSites,
  fileSymbol,
  importedName,
  importedSymbols,
  isOwnDecorator,
  repositoryIndex,
} from '../http/repository.js';
import {
  ACCESSOR_SUFFIX,
  APOLLO_CLIENT_METHODS,
  APOLLO_DOCUMENT_HOOKS,
  CLIENT_OPERATION_CONFIDENCE,
  CLIENT_OPERATION_NAME_ONLY_CONFIDENCE,
  CODEGEN_DOCUMENT_SUFFIX,
  CODEGEN_HOOK_PREFIX,
  CODEGEN_HOOK_SUFFIXES,
  DOCUMENT_FILE_CONFIDENCE,
  DOCUMENT_TAGS,
  EMBEDDED_DOCUMENT_CONFIDENCE,
  FIELD_RESOLVER_CONFIDENCE,
  GRAPHQL_CLIENT_LANGUAGES,
  GRAPHQL_LANGUAGE,
  GRAPHQL_SERVER_LANGUAGES,
  HTTP_DECORATOR_MODULES,
  LIBRARY_HOOKS,
  RESOLVER_CLASS_DECORATOR,
  RESOLVER_CONFIDENCE,
  RESOLVER_DECORATORS,
  RESOLVER_NAME_OPTION,
} from './constants.js';
import {
  callDocument,
  matchOperationName,
  schemaFor,
  symbolOperations,
} from './documents.js';
import { parseGraphqlDocument } from './document.js';
import type { ParsedGraphqlOperation } from './types.js';

const CODEGEN_PRESET_NAME = 'graphql-codegen';
const APOLLO_PRESET_NAME = 'apollo-client';
/** 생성된 문서 상수 이름(`GetOrderDocument`) */
const CODEGEN_DOCUMENT_NAME = new RegExp(
  `^([A-Z][A-Za-z0-9_]*)${CODEGEN_DOCUMENT_SUFFIX}$`,
);
/** `@Resolver(() => Order)`, `@Resolver(of => [Order])` 의 타입 이름 */
const RESOLVER_TYPE_ARROW = /=>\s*\[?\s*([A-Za-z_$][\w$]*)/;

// ── 서버: NestJS 리졸버 ──

export const NESTJS_GRAPHQL_PRESET: DetectionPreset = {
  name: 'nestjs',
  languages: GRAPHQL_SERVER_LANGUAGES,
  detect(symbol, context) {
    const dot = symbol.symbol.indexOf('.');
    if (symbol.kind !== 'method' || dot <= 0) {
      return [];
    }
    const methodName = symbol.symbol
      .slice(symbol.symbol.lastIndexOf('.') + 1)
      .replace(ACCESSOR_SUFFIX, '');
    return (symbol.sites ?? []).flatMap((site) => {
      const role = RESOLVER_DECORATORS[site.name];
      if (
        role === undefined ||
        !isOwnDecorator(symbol, site) ||
        isHttpDecorator(symbol, site, context)
      ) {
        return [];
      }
      const name = resolverName(site, context) ?? methodName;
      if (role !== 'field') {
        return [
          resolverDetection(symbol, site, context, {
            operationType: role,
            field: name,
            confidence: RESOLVER_CONFIDENCE,
            evidence: `@${site.name} ${name}`,
          }),
        ];
      }
      const parent = resolverType(
        symbol.filePath,
        symbol.symbol.slice(0, dot),
        context,
      );
      return parent === undefined
        ? []
        : [
            resolverDetection(symbol, site, context, {
              operationType: 'query',
              field: `${parent}.${name}`,
              confidence: FIELD_RESOLVER_CONFIDENCE,
              evidence: `@${site.name} ${name} on ${parent}`,
            }),
          ];
    });
  },
};

function resolverDetection(
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
  fields: Pick<
    GraphqlResolverDetection,
    'operationType' | 'field' | 'confidence' | 'evidence'
  >,
): GraphqlResolverDetection {
  return {
    kind: 'graphql-resolver',
    repository: context.repository,
    filePath: symbol.filePath,
    symbol: symbol.symbol,
    line: site.line,
    detector: NESTJS_GRAPHQL_PRESET.name,
    ...fields,
  };
}

/** 같은 이름의 HTTP 매개변수 데코레이터를 내는 모듈에서 가져온 이름인지 */
function isHttpDecorator(
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
): boolean {
  const binding = importedName(symbol, site.name, context);
  return (
    binding !== undefined && HTTP_DECORATOR_MODULES.includes(binding.specifier)
  );
}

/** 문자열 첫 인자(`@Query('orders')`)나 옵션의 name(`@Query(() => [Order], { name: 'orders' })`) */
function resolverName(
  site: CodeSite,
  context: PresetContext,
): string | undefined {
  for (const argument of site.args) {
    const direct = argument.literal;
    if (direct !== undefined) {
      return direct;
    }
    const option = argument.properties?.[RESOLVER_NAME_OPTION];
    const named = option && staticText(option, context);
    if (named) {
      return named;
    }
  }
  return undefined;
}

/** 클래스의 `@Resolver(() => Order)`·`@Resolver('Order')` 가 가리키는 타입 이름 */
function resolverType(
  filePath: string,
  className: string,
  context: PresetContext,
): string | undefined {
  const decorator = fileSymbol(filePath, className, context)?.sites?.find(
    (site) =>
      site.kind === 'decorator' && site.name === RESOLVER_CLASS_DECORATOR,
  );
  const argument = decorator?.args[0];
  if (!argument) {
    return undefined;
  }
  return (
    argument.literal ??
    argument.identifier?.split('.').at(-1) ??
    RESOLVER_TYPE_ARROW.exec(argument.text)?.[1]
  );
}

// ── 연산 문서 ──

/** 연산 문서 탐지. 두 클라이언트 프리셋이 함께 켜져도 한 번만 내도록 graphql-codegen 쪽이 맡는다 */
function documentDetections(
  detector: string,
  symbol: ExtractedSymbol,
  context: PresetContext,
): GraphqlDocumentDetection[] {
  if (
    detector === APOLLO_PRESET_NAME &&
    context.config.presets.includes(CODEGEN_PRESET_NAME)
  ) {
    return [];
  }
  const schema = schemaFor(context, symbol.filePath);
  const confidence =
    symbol.language === GRAPHQL_LANGUAGE
      ? DOCUMENT_FILE_CONFIDENCE
      : EMBEDDED_DOCUMENT_CONFIDENCE;
  return symbolOperations(symbol)
    .filter(({ operation }) => operation.closed)
    .map(({ operation, origin }) => ({
      kind: 'graphql-document',
      repository: context.repository,
      filePath: symbol.filePath,
      symbol: symbol.symbol,
      line: operation.lineStart,
      detector,
      confidence,
      evidence: `${operation.operationType} ${operation.operationName} in ${origin}`,
      operationType: operation.operationType,
      operationName: operation.operationName,
      rootFields: operation.rootFields,
      ...(schema ? { schema } : {}),
    }));
}

function clientCallDetection(
  detector: string,
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
  fields: Pick<
    GraphqlClientCallDetection,
    'operationName' | 'confidence' | 'evidence'
  >,
): GraphqlClientCallDetection {
  const schema = schemaFor(context, symbol.filePath);
  return {
    kind: 'graphql-client-call',
    repository: context.repository,
    filePath: symbol.filePath,
    symbol: symbol.symbol,
    line: site.line,
    detector,
    ...fields,
    ...(schema ? { schema } : {}),
  };
}

// ── 클라이언트: graphql-codegen ──

export const GRAPHQL_CODEGEN_PRESET: DetectionPreset = {
  name: CODEGEN_PRESET_NAME,
  languages: GRAPHQL_CLIENT_LANGUAGES,
  detect(symbol, context) {
    const documents = documentDetections(CODEGEN_PRESET_NAME, symbol, context);
    if (symbol.language === GRAPHQL_LANGUAGE) {
      return documents;
    }
    const calls: GraphqlClientCallDetection[] = [];
    const seen = new Set<string>();
    const add = (site: CodeSite, derived: string, how: string): void => {
      const key = `${derived}\0${site.line}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const matched = matchOperationName(derived, context);
      calls.push(
        clientCallDetection(CODEGEN_PRESET_NAME, symbol, site, context, {
          operationName: matched.name,
          confidence: matched.found
            ? CLIENT_OPERATION_CONFIDENCE
            : CLIENT_OPERATION_NAME_ONLY_CONFIDENCE,
          evidence: matched.found
            ? `${how} at line ${site.line}`
            : `${how} at line ${site.line}; operation document not found in repository`,
        }),
      );
    };
    for (const site of callSites(symbol)) {
      if (site.kind !== 'call') {
        continue;
      }
      const hook = generatedHook(site.name, context);
      if (hook) {
        add(site, hook, `generated hook ${site.name}`);
      }
      for (const identifier of argumentIdentifiers(site.args)) {
        const leaf = identifier.split('.').at(-1) ?? identifier;
        const operation = CODEGEN_DOCUMENT_NAME.exec(leaf)?.[1];
        if (operation) {
          add(site, operation, `generated document ${leaf}`);
        }
      }
    }
    return [...documents, ...calls];
  },
};

/**
 * 생성된 훅 이름에서 연산 이름을 읽는다(`useGetOrderLazyQuery` → GetOrder)
 * 라이브러리 훅이거나, 같은 저장소에 손으로 만든 같은 이름 함수가 있으면(같은 파일에 생성된 문서 상수가 없으면) 읽지 않는다
 */
function generatedHook(
  name: string,
  context: PresetContext,
): string | undefined {
  const leaf = name.split('.').at(-1) ?? name;
  if (!leaf.startsWith(CODEGEN_HOOK_PREFIX) || LIBRARY_HOOKS.includes(leaf)) {
    return undefined;
  }
  const rest = leaf.slice(CODEGEN_HOOK_PREFIX.length);
  const suffix = CODEGEN_HOOK_SUFFIXES.find(([candidate]) =>
    rest.endsWith(candidate),
  );
  const operation = suffix ? rest.slice(0, -suffix[0].length) : undefined;
  if (!operation || !/^[A-Z]/.test(operation)) {
    return undefined;
  }
  const defined = repositoryIndex(context)?.byName.get(leaf) ?? [];
  const handWritten = defined.some(
    (candidate) =>
      candidate.kind === 'function' &&
      !fileSymbol(
        candidate.filePath,
        `${operation}${CODEGEN_DOCUMENT_SUFFIX}`,
        context,
      ),
  );
  return handWritten ? undefined : operation;
}

/** 인자(객체 속성·배열 원소 포함)에 쓴 이름 */
function argumentIdentifiers(args: readonly CodeSiteArgument[]): string[] {
  const found: string[] = [];
  const visit = (argument: CodeSiteArgument): void => {
    if (argument.identifier !== undefined) {
      found.push(argument.identifier);
    }
    for (const value of Object.values(argument.properties ?? {})) {
      visit(value);
    }
    for (const element of argument.elements ?? []) {
      visit(element);
    }
    for (const substitution of argument.substitutions ?? []) {
      visit(substitution);
    }
  };
  args.forEach(visit);
  return found;
}

// ── 클라이언트: Apollo Client ──

export const APOLLO_CLIENT_PRESET: DetectionPreset = {
  name: APOLLO_PRESET_NAME,
  languages: GRAPHQL_CLIENT_LANGUAGES,
  detect(symbol, context) {
    const documents = documentDetections(APOLLO_PRESET_NAME, symbol, context);
    if (symbol.language === GRAPHQL_LANGUAGE) {
      return documents;
    }
    const calls = callSites(symbol).flatMap((site) => {
      const argument = documentArgument(site);
      if (!argument) {
        return [];
      }
      const resolved = resolveDocument(symbol, site, argument, context);
      return (resolved?.operations ?? []).map((operation) =>
        clientCallDetection(APOLLO_PRESET_NAME, symbol, site, context, {
          operationName: operation.operationName,
          confidence: CLIENT_OPERATION_CONFIDENCE,
          evidence: `${site.name} at line ${site.line}; ${resolved?.origin ?? ''}`,
        }),
      );
    });
    return [...documents, ...calls];
  },
};

/** 문서를 받는 인자. 훅은 첫 인자, 클라이언트 메서드는 옵션 객체 하나의 query·mutation 속성 */
function documentArgument(site: CodeSite): CodeSiteArgument | undefined {
  if (site.kind !== 'call') {
    return undefined;
  }
  if (APOLLO_DOCUMENT_HOOKS.includes(site.name)) {
    return site.args[0];
  }
  const dot = site.name.lastIndexOf('.');
  const property =
    dot > 0 ? APOLLO_CLIENT_METHODS[site.name.slice(dot + 1)] : undefined;
  const options = site.args.length === 1 ? site.args[0] : undefined;
  return property === undefined ? undefined : options?.properties?.[property];
}

/**
 * 문서 인자를 연산으로 푼다
 * - 이름: 같은 파일의 상수, 아니면 가져온 파일의 상수(파일로 못 풀면 저장소 안 같은 이름 문서 상수가 하나일 때)
 * - 인자 자리의 `gql(…)`·`graphql(…)` 호출: 같은 줄의 그 호출 자리 글
 */
function resolveDocument(
  symbol: ExtractedSymbol,
  site: CodeSite,
  argument: CodeSiteArgument,
  context: PresetContext,
): { operations: ParsedGraphqlOperation[]; origin: string } | undefined {
  const inline = DOCUMENT_TAGS.find((tag) =>
    argument.text.startsWith(`${tag}(`),
  );
  if (inline) {
    const document = (symbol.sites ?? [])
      .filter((candidate) => candidate.line === site.line)
      .map(callDocument)
      .find((item) => item !== undefined);
    return document
      ? {
          operations: namedOperations(
            parseGraphqlDocument(document.text).operations,
          ),
          origin: document.origin,
        }
      : undefined;
  }
  const name = argument.identifier;
  if (name === undefined || name.includes('.')) {
    return undefined;
  }
  const local = fileSymbol(symbol.filePath, name, context);
  const owners: ExtractedSymbol[] = [];
  if (local) {
    owners.push(local);
  } else {
    const binding = importedName(symbol, name, context);
    if (binding) {
      owners.push(...importedSymbols(symbol, binding, context).symbols);
    }
  }
  const withDocuments = owners
    .map((owner) => ({
      owner,
      operations: namedOperations(
        symbolOperations(owner).map(({ operation }) => operation),
      ),
    }))
    .filter((item) => item.operations.length > 0);
  const only = withDocuments.length === 1 ? withDocuments[0] : undefined;
  return only
    ? {
        operations: only.operations,
        origin: `document ${only.owner.symbol} in ${only.owner.filePath}`,
      }
    : undefined;
}

function namedOperations(
  operations: readonly ParsedGraphqlOperation[],
): ParsedGraphqlOperation[] {
  const seen = new Set<string>();
  return operations.filter((operation) => {
    if (seen.has(operation.operationName)) {
      return false;
    }
    seen.add(operation.operationName);
    return true;
  });
}
