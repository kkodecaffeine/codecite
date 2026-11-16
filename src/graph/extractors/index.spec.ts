import { describe, expect, it } from 'vitest';
import {
  defaultSymbolExtractors,
  EXTRACTED_RELATION_TYPES,
  typescriptExtractor,
} from './index.js';

describe('extractors/index', () => {
  it('기본 추출기와 맡는 확장자를 알려 준다', () => {
    const extractors = defaultSymbolExtractors();

    expect(extractors.map((extractor) => extractor.name)).toEqual([
      'typescript',
    ]);
    expect(extractors[0].extensions).toEqual([
      '.ts',
      '.tsx',
      '.mts',
      '.cts',
      '.js',
      '.jsx',
      '.mjs',
      '.cjs',
    ]);
    expect(typescriptExtractor().name).toBe('typescript');
    expect(EXTRACTED_RELATION_TYPES).toEqual([
      'IMPORTS',
      'EXTENDS',
      'IMPLEMENTS',
      'DECORATED_BY',
      'INJECTS',
      'CALLS',
    ]);
  });
});
