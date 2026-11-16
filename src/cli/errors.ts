/** 인자를 잘못 줬을 때. 종료 코드 2 로 끝나고 어느 명령의 도움말을 볼지 안내한다 */
export class CliUsageError extends Error {
  /** 도움말을 안내할 명령(예: `codecite ask`). 비우면 명령을 고르는 쪽이 채운다 */
  command?: string;

  constructor(message: string, command?: string) {
    super(message);
    this.name = 'CliUsageError';
    this.command = command;
  }
}
