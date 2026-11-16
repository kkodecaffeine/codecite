/** 구조화 로그 필드. 값은 JSON 으로 바꿀 수 있는 것을 쓴다 */
export type LogFields = Record<string, unknown>;

/** 로그를 남기는 포트. console 이나 쓰는 쪽의 로거를 붙인다 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}
