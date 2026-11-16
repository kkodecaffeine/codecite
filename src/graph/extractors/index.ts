// 언어 추출기 진입점. 파이프라인은 확장자로 추출기를 골라 파일 묶음을 넘긴다
import type { SymbolExtractor } from '../types.js';
import { typescriptExtractor } from './typescript.js';

export { EXTRACTED_RELATION_TYPES } from './constants.js';
export { createTypeScriptFactProjector } from './facts-typescript.js';
export { typescriptExtractor } from './typescript.js';
export type {
  ExtractedRelationType,
  TypeScriptExtractorOptions,
} from './types.js';

/** 기본으로 켜는 추출기. typescript 는 맡을 파일이 있을 때만 불러온다 */
export function defaultSymbolExtractors(): SymbolExtractor[] {
  return [typescriptExtractor()];
}
