import { describe, expect, it } from 'vitest';
import {
  defaultSymbolExtractors,
  EXTRACTED_RELATION_TYPES,
  pythonExtractor,
  typescriptExtractor,
} from './index.js';

describe('extractors/index', () => {
  it('기본 추출기와 맡는 확장자를 알려 주고, 두 추출기의 확장자는 겹치지 않는다', () => {
    const extractors = defaultSymbolExtractors();

    expect(extractors.map((extractor) => extractor.name)).toEqual([
      'typescript',
      'python',
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
    expect(extractors[1].extensions).toEqual(['.py']);
    expect(typescriptExtractor().name).toBe('typescript');
    expect(pythonExtractor().name).toBe('python');
    const all = extractors.flatMap((extractor) => extractor.extensions);
    expect(new Set(all).size).toBe(all.length);
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
