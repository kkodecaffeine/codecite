// `.graphql`·`.gql` 연산 문서 추출기. 이름 있는 연산마다 심볼 하나를 낸다(이름 = 연산 이름, 원문 = 그 연산 글)
// 스키마 정의만 있는 파일은 심볼을 내지 않는다. 읽다가 막힌 파일은 건너뛰고 까닭을 남긴다
import {
  finalizeExtraction,
  hasExtension,
} from '../../extractors/normalize.js';
import type {
  ExtractedSymbol,
  ExtractionFailure,
  SymbolExtractor,
} from '../../types.js';
import {
  GRAPHQL_DOCUMENT_EXTENSIONS,
  GRAPHQL_LANGUAGE,
  GRAPHQL_OPERATION_KIND,
} from './constants.js';
import { parseGraphqlDocument } from './document.js';

export function graphqlDocumentExtractor(): SymbolExtractor {
  return {
    name: GRAPHQL_LANGUAGE,
    extensions: GRAPHQL_DOCUMENT_EXTENSIONS,
    async extract(files, context) {
      const symbols: ExtractedSymbol[] = [];
      const failures: ExtractionFailure[] = [];
      for (const file of files) {
        if (!hasExtension(file.filePath, GRAPHQL_DOCUMENT_EXTENSIONS)) {
          continue;
        }
        const parsed = parseGraphqlDocument(file.content);
        if (parsed.error) {
          failures.push({
            filePath: file.filePath,
            message: `line ${parsed.error.line}: ${parsed.error.message}`,
          });
          continue;
        }
        for (const operation of parsed.operations) {
          symbols.push({
            filePath: file.filePath,
            language: GRAPHQL_LANGUAGE,
            symbol: operation.operationName,
            kind: GRAPHQL_OPERATION_KIND,
            content: file.content.slice(operation.start, operation.end),
            lineStart: operation.lineStart,
            lineEnd: operation.lineEnd,
            description: `${operation.operationType} ${operation.operationName}: ${operation.rootFields.join(', ')}`,
            relations: [],
          });
        }
      }
      context.logger.debug('graphql document extraction finished', {
        repository: context.repository,
        files: files.length,
        symbols: symbols.length,
        failures: failures.length,
      });
      return finalizeExtraction({ symbols, failures });
    },
  };
}
