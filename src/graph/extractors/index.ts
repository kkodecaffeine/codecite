// 언어 추출기 진입점. 파이프라인은 확장자로 추출기를 골라 파일 묶음을 넘긴다
import type { SymbolExtractor } from '../types.js';
import { pythonExtractor } from './python.js';
import { typescriptExtractor } from './typescript.js';

export { EXTRACTED_RELATION_TYPES } from './constants.js';
export { createTypeScriptFactProjector } from './facts-typescript.js';
export { pythonExtractor } from './python.js';
export { typescriptExtractor } from './typescript.js';
export type {
  ExtractedRelationType,
  PythonExtractorOptions,
  TypeScriptExtractorOptions,
} from './types.js';

/** 기본으로 켜는 추출기. typescript 와 python3 은 맡을 파일이 있을 때만 부른다 */
export function defaultSymbolExtractors(): SymbolExtractor[] {
  return [typescriptExtractor(), pythonExtractor()];
}
