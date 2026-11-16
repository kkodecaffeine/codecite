import type { Logger } from '../ports.js';
import type { LogLevel } from '../types.js';

/** CLI 가 바깥과 주고받는 통로. 테스트는 이것을 바꿔 끼워 프로세스 없이 명령을 돌린다 */
export interface CliIo {
  /** `--cwd` 를 풀 기준 폴더 */
  cwd: string;
  /** API 키를 읽을 환경 변수 */
  env: Readonly<Record<string, string | undefined>>;
  /** 결과(답, 요약, 표)를 쓴다 */
  stdout(text: string): void;
  /** 오류와 사용법 안내를 쓴다 */
  stderr(text: string): void;
  /** 명령에 넘길 로거를 만든다. 없으면 표준 오류에 JSON 한 줄씩 남기는 로거 */
  createLogger?(level: LogLevel): Logger;
}

/** 명령 옵션 하나. `parseArgs` 옵션과 도움말 줄을 함께 만든다 */
export interface CliOption {
  type: 'string' | 'boolean';
  /** 한 글자 별칭(예: `h` → `-h`) */
  short?: string;
  /** string 옵션의 값 자리 이름(예: `<port>`) */
  valueName?: string;
  description: string;
}

/** 해석한 옵션 값. 주지 않은 옵션은 undefined */
export type CliOptionValues = Readonly<
  Record<string, string | boolean | undefined>
>;

/** 명령 하나가 받는 것 */
export interface CliContext {
  /** `--cwd` 를 푼 절대 경로 */
  cwd: string;
  positionals: readonly string[];
  values: CliOptionValues;
  io: CliIo;
  logger: Logger;
}

/** 실행하는 명령 */
export interface CliLeafCommand {
  name: string;
  /** 명령 목록에 보일 한 줄 설명 */
  summary: string;
  /** 명령 이름 뒤에 붙는 사용법(예: `<question> [--json]`) */
  usage: string;
  /** 도움말 본문. 한 줄씩 그대로 찍는다 */
  description?: readonly string[];
  options?: Readonly<Record<string, CliOption>>;
  /** 로그 수준. 없으면 warn */
  logLevel?: LogLevel;
  /** 종료 코드를 돌려준다. 인자가 틀리면 `CliUsageError` 를 throw 한다 */
  run(context: CliContext): Promise<number>;
}

/** 하위 명령을 묶은 명령(예: `graph build`). 다음 위치 인자로 하위 명령을 고른다 */
export interface CliCommandGroup {
  name: string;
  summary: string;
  description?: readonly string[];
  commands: readonly CliCommand[];
}

export type CliCommand = CliLeafCommand | CliCommandGroup;
