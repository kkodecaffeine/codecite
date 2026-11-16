// GraphQL 탐지 프리셋 묶음과 연산 문서 추출기. nestjs 는 HTTP 쪽 nestjs 프리셋과 이름이 같아 레지스트리가 함께 켠다
import type { DetectionPreset } from '../../types.js';
import {
  APOLLO_CLIENT_PRESET,
  GRAPHQL_CODEGEN_PRESET,
  NESTJS_GRAPHQL_PRESET,
} from './graphql.js';

export const GRAPHQL_PRESETS: readonly DetectionPreset[] = [
  NESTJS_GRAPHQL_PRESET,
  GRAPHQL_CODEGEN_PRESET,
  APOLLO_CLIENT_PRESET,
];

export { parseGraphqlDocument } from './document.js';
export { graphqlDocumentExtractor } from './extractor.js';
