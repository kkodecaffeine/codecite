// 그래프 기본 구성. buildCodeGraph 에 추출기·프리셋을 따로 주지 않으면 이 목록을 쓴다
// 프리셋은 고를 수 있는 목록일 뿐이고, 실제로 켜는 것은 설정 presets 의 이름이다
import { defaultSymbolExtractors } from './extractors/index.js';
import {
  GRAPHQL_PRESETS,
  graphqlDocumentExtractor,
} from './presets/graphql/index.js';
import { HTTP_PRESETS } from './presets/http/index.js';
import { MESSAGING_PRESETS, rulesPreset } from './presets/messaging/index.js';
import { ORM_PRESETS, prismaSchemaExtractor } from './presets/orm/index.js';
import type { DetectionPreset, SymbolExtractor } from './types.js';

/** 기본 추출기: TypeScript·JavaScript, Python, GraphQL 연산 문서, Prisma 스키마. 맡을 파일이 있을 때만 무거운 도구를 부른다 */
export function defaultGraphExtractors(): SymbolExtractor[] {
  return [
    ...defaultSymbolExtractors(),
    graphqlDocumentExtractor(),
    prismaSchemaExtractor(),
  ];
}

/** 설정 presets 에서 이름으로 고를 수 있는 기본 프리셋 전부. 같은 이름의 프리셋(nestjs 등)은 함께 켜진다 */
export const DEFAULT_GRAPH_PRESETS: readonly DetectionPreset[] = [
  ...HTTP_PRESETS,
  ...GRAPHQL_PRESETS,
  ...MESSAGING_PRESETS,
  ...ORM_PRESETS,
];

/** 설정 detectors 규칙을 탐지기로 바꾸는 기본 함수 */
export const defaultRulesPreset = rulesPreset;
