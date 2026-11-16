import { describe, expect, it } from 'vitest';
import * as codecite from './index.js';

describe('codecite', () => {
  it('패키지 버전을 내보낸다', () => {
    expect(codecite.version).toBe('0.0.0');
  });

  it('허브, 설정 읽기, 어댑터, 프롬프트를 공개 API 로 내보낸다', () => {
    for (const name of [
      'createCodecite',
      'loadConfig',
      'csvPolicySource',
      'CsvFormatError',
      'openAiClient',
      'ollamaClient',
      'jsonIndexCache',
      'indexFingerprint',
      'InMemoryVectorIndex',
      'planQuestion',
      'buildPolicyAnswerPrompt',
      'createConsoleLogger',
    ] as const) {
      expect(typeof codecite[name], name).toBe('function');
    }
  });

  it('로그를 남기지 않는 기본 로거와 표준 오류 로거를 내보낸다', () => {
    for (const logger of [codecite.noopLogger, codecite.consoleLogger]) {
      expect(Object.keys(logger).sort()).toEqual([
        'debug',
        'error',
        'info',
        'warn',
      ]);
    }
  });
});
