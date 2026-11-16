import { relative } from 'node:path';
import { createCodecite } from '../codecite.js';
import { loadConfig } from '../config.js';
import { CONFIG_FILE_NAME } from '../constants.js';
import { noopLogger } from '../logger.js';
import type { PolicySource } from '../ports.js';
import type { Codecite, CodeciteConfig, CodeciteOptions } from '../types.js';
import type { CliContext } from './types.js';

/**
 * `--cwd` 의 설정을 읽어 엔진을 만든다. 엔진을 만들면 색인도 만들어진다
 * offline 이면 환경 변수에 키가 있어도 답변 모델과 임베더를 붙이지 않는다. 키 경고도 남기지 않는다
 * 설정 오류는 어느 설정인지, CSV 오류는 몇 번째 행인지 적힌 채로 throw 한다
 */
export async function openEngine(
  context: CliContext,
  options: { offline?: boolean } = {},
): Promise<{
  codecite: Codecite;
  config: CodeciteConfig;
  source: PolicySource;
}> {
  const offline = options.offline === true;
  const loaded = await loadConfig(context.cwd, {
    logger: offline ? noopLogger : context.logger,
    env: offline ? {} : context.io.env,
  });
  const engineOptions: CodeciteOptions = offline
    ? {
        ...loaded.options,
        llm: undefined,
        embedder: undefined,
        logger: context.logger,
      }
    : loaded.options;
  try {
    return {
      codecite: await createCodecite(engineOptions),
      config: loaded.config,
      source: engineOptions.source,
    };
  } catch (error) {
    throw missingSource(error, loaded.config, context.cwd) ?? error;
  }
}

/** 정책 CSV 가 없을 때의 파일 시스템 오류를 고칠 설정 이름이 적힌 문장으로 바꾼다 */
function missingSource(
  error: unknown,
  config: CodeciteConfig,
  cwd: string,
): Error | undefined {
  const failure = error as NodeJS.ErrnoException;
  if (failure?.code !== 'ENOENT' || failure.path !== config.source.path) {
    return undefined;
  }
  const shown = relative(cwd, config.source.path) || config.source.path;
  return new Error(
    `${CONFIG_FILE_NAME}: source.path points to ${shown}, which was not found.`,
    { cause: error },
  );
}
