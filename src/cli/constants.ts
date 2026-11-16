import type { LogLevel } from '../types.js';
import type { CliOption } from './types.js';

/** 종료 코드. 0 성공, 1 실패나 회귀, 2 사용법 오류 */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** 모든 명령이 받는 옵션 */
export const GLOBAL_OPTIONS: Readonly<Record<string, CliOption>> =
  Object.freeze({
    cwd: {
      type: 'string',
      valueName: '<dir>',
      description:
        'Folder that holds codecite.config.json (default: current folder)',
    },
    help: { type: 'boolean', short: 'h', description: 'Show help' },
    version: { type: 'boolean', short: 'v', description: 'Show the version' },
  });

/** 명령이 로그 수준을 정하지 않았을 때. 한 번 돌고 끝나는 명령은 경고부터 남겨 결과를 가리지 않는다 */
export const DEFAULT_CLI_LOG_LEVEL: LogLevel = 'warn';
