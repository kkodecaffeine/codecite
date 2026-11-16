import { LOG_LEVEL_ORDER } from './constants.js';
import type { LogFields, Logger } from './ports.js';
import type { LogLevel } from './types.js';

/** 아무것도 남기지 않는 로거. 라이브러리로 쓸 때의 기본값이다 */
export const noopLogger: Logger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});

/**
 * 표준 오류에 JSON 한 줄씩 남기는 로거. 표준 출력은 답을 내보내는 데 쓰도록 비워 둔다
 * 허브는 질문 본문을 로그에 넘기지 않으므로 이 로거에도 질문 길이, 후보 수, 생성 경로 같은 값만 온다
 * time·level·message 는 같은 이름의 필드가 와도 덮이지 않는다
 */
export function createConsoleLogger(minLevel: LogLevel = 'info'): Logger {
  const write =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[minLevel]) {
        return;
      }
      process.stderr.write(
        `${JSON.stringify({
          ...fields,
          time: new Date().toISOString(),
          level,
          message,
        })}\n`,
      );
    };
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
  };
}

/** info 이상만 남기는 표준 오류 로거 */
export const consoleLogger: Logger = createConsoleLogger();
