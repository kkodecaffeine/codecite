// GRAPHQL_CALLS: 클라이언트 연산 호출 → 같은 저장소의 연산 문서(루트 필드·스키마) → 스키마 범위 안의 리졸버
// - 스키마 범위는 hints.graphqlSchemas[스키마](저장소와 경로). 스키마가 없거나 힌트에 없으면 다른 저장소 전부에서 찾는다
// - (부르는 쪽, 연산, 루트 필드)마다 간선 하나. 리졸버가 정확히 하나일 때만 잇는다. 못 이은 까닭은 모두 남긴다
// - 루트 필드 이름에는 점이 없다. `부모.필드` 꼴 필드 리졸버는 루트 필드와 잇지 않는다
import type { CurrentSymbolRecord } from '../../extensions/code-knowledge.js';
import { compareText, matchesGlob } from '../files.js';
import type {
  GraphHints,
  GraphqlDocumentDetection,
  GraphqlResolverDetection,
} from '../types.js';
import {
  type LinkContext,
  recordLabel,
  relationConfidence,
  unresolvedAt,
  uniqueRecords,
} from './context.js';
import type { LinkResult } from './types.js';

interface Resolver {
  detection: GraphqlResolverDetection;
  record: CurrentSymbolRecord;
}

type SchemaScope = NonNullable<GraphHints['graphqlSchemas']>[string];

export function linkGraphql(context: LinkContext): LinkResult {
  const resolvers = new Map<string, Resolver[]>();
  for (const detection of context.detectionsOf('graphql-resolver')) {
    const record = context.recordFor(detection);
    if (!record || !isRootField(detection.field)) {
      continue;
    }
    const key = fieldKey(detection.operationType, detection.field);
    resolvers.set(key, [...(resolvers.get(key) ?? []), { detection, record }]);
  }
  const documents = new Map<string, GraphqlDocumentDetection[]>();
  for (const document of context.detectionsOf('graphql-document')) {
    const key = `${document.repository}\0${document.operationName}`;
    documents.set(key, [...(documents.get(key) ?? []), document]);
  }

  const result: LinkResult = { drafts: [], unresolved: [] };
  for (const call of context.detectionsOf('graphql-client-call')) {
    const caller = context.recordFor(call);
    if (!caller) {
      continue;
    }
    const found = distinctDocuments(
      (documents.get(`${call.repository}\0${call.operationName}`) ?? []).filter(
        (document) =>
          !call.schema || !document.schema || document.schema === call.schema,
      ),
    );
    if (found.length === 0) {
      result.unresolved.push(
        unresolvedAt(call, 'GRAPHQL_CALLS', 'no-provider', call.operationName),
      );
      continue;
    }
    if (found.length > 1) {
      result.unresolved.push(
        unresolvedAt(
          call,
          'GRAPHQL_CALLS',
          'ambiguous-provider',
          call.operationName,
          uniqueRecords(
            found.flatMap((document) => context.recordFor(document) ?? []),
          ),
        ),
      );
      continue;
    }
    const document = found[0];
    const schema = document.schema ?? call.schema;
    const scope = schema
      ? context.config.hints.graphqlSchemas?.[schema]
      : undefined;
    if (scope?.repository === caller.repository) {
      continue;
    }
    for (const field of [...new Set(document.rootFields)].sort(compareText)) {
      const value = `${document.operationType} ${call.operationName} → ${field}`;
      const matching =
        resolvers.get(fieldKey(document.operationType, field)) ?? [];
      if (
        !scope &&
        matching.some(
          (resolver) => resolver.record.repository === caller.repository,
        )
      ) {
        continue;
      }
      const cross = matching.filter(
        (resolver) =>
          resolver.record.repository !== caller.repository &&
          (!scope || inScope(resolver.record, scope)),
      );
      const handlers = uniqueRecords(cross.map((resolver) => resolver.record));
      if (handlers.length !== 1) {
        result.unresolved.push(
          unresolvedAt(
            call,
            'GRAPHQL_CALLS',
            handlers.length === 0 ? 'no-provider' : 'ambiguous-provider',
            value,
            handlers,
          ),
        );
        continue;
      }
      const resolver = cross.find(
        (candidate) =>
          candidate.record.stableSymbolId === handlers[0].stableSymbolId,
      ) as Resolver;
      result.drafts.push({
        relation: 'GRAPHQL_CALLS',
        source: caller,
        target: resolver.record,
        extraction: {
          kind: 'graphql-operation',
          locator: `${call.filePath}:${call.line}`,
          value,
        },
        confidence: relationConfidence(scope !== undefined, [
          call.confidence,
          document.confidence,
          resolver.detection.confidence,
        ]),
        evidence: [
          `client ${document.operationType} ${call.operationName} (${call.detector})`,
          `document ${document.filePath}:${document.line} selects ${field}`,
          `resolver ${recordLabel(resolver.record)} (${resolver.detection.detector})`,
          scope
            ? `schema ${schema} is served by ${scope.repository}`
            : 'only matching resolver in the other repositories',
        ],
        roles: { caller, handler: resolver.record },
      });
    }
  }
  return result;
}

/** 루트 필드 이름인지. 필드 리졸버(`Order.items`)는 아니다 */
export function isRootField(field: string): boolean {
  return field.length > 0 && !field.includes('.');
}

/**
 * 스키마 범위 안의 리졸버인지. 경로 항목에 glob 글자가 있으면 glob 으로, 아니면 폴더 접두어로 본다
 * 경로를 적지 않았으면 그 저장소 전체다
 */
function inScope(record: CurrentSymbolRecord, scope: SchemaScope): boolean {
  if (record.repository !== scope.repository) {
    return false;
  }
  const paths = scope.paths ?? [];
  return (
    paths.length === 0 ||
    paths.some((pattern) => {
      if (/[*?[{]/.test(pattern)) {
        return matchesGlob(record.filePath, pattern);
      }
      const prefix = pattern.replace(/\/+$/, '');
      return (
        record.filePath === prefix || record.filePath.startsWith(`${prefix}/`)
      );
    })
  );
}

/** 같은 연산 이름의 문서 가운데 뜻이 다른 것만 남긴다. 종류·루트 필드·스키마가 같으면 같은 문서로 본다 */
function distinctDocuments(
  documents: readonly GraphqlDocumentDetection[],
): GraphqlDocumentDetection[] {
  const seen = new Map<string, GraphqlDocumentDetection>();
  for (const document of documents) {
    const key = [
      document.operationType,
      [...new Set(document.rootFields)].sort(compareText).join(','),
      document.schema ?? '',
    ].join('\0');
    if (!seen.has(key)) {
      seen.set(key, document);
    }
  }
  return [...seen.values()];
}

function fieldKey(operationType: string, field: string): string {
  return `${operationType}\0${field}`;
}
