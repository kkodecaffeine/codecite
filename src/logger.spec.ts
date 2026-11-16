import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConsoleLogger, noopLogger } from './logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createConsoleLogger', () => {
  it('표준 오류에 JSON 한 줄을 남기고 정한 수준보다 낮은 로그는 버린다', () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const logger = createConsoleLogger('info');

    logger.debug('skipped', { candidates: 3 });
    logger.warn('dense retrieval failed', { error: 'timeout' });

    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0][0]);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      level: 'warn',
      message: 'dense retrieval failed',
      error: 'timeout',
    });
  });

  it('필드가 level·message 와 이름이 겹쳐도 덮지 못한다', () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    createConsoleLogger('debug').error('index failed', {
      level: 'debug',
      message: 'other',
    });

    expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
      level: 'error',
      message: 'index failed',
    });
  });
});

describe('noopLogger', () => {
  it('아무것도 남기지 않는다', () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    noopLogger.error('ignored');

    expect(write).not.toHaveBeenCalled();
  });
});
