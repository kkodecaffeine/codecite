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

/**
 * `graph init` 이 프리셋을 고를 때 보는 의존성 이름 → 프리셋 이름
 * 저장소의 package.json(dependencies·devDependencies)이나 Python 의존성 파일에 이 이름이 있으면 그 프리셋을 켠다
 */
export const GRAPH_INIT_NODE_PRESETS: Readonly<Record<string, string>> =
  Object.freeze({
    '@nestjs/core': 'nestjs',
    express: 'express',
    fastify: 'fastify',
    next: 'nextjs',
    axios: 'axios',
    '@apollo/client': 'apollo-client',
    '@graphql-codegen/cli': 'graphql-codegen',
    'node-cron': 'node-cron',
    typeorm: 'typeorm',
    '@prisma/client': 'prisma',
    prisma: 'prisma',
    mongoose: 'mongoose',
  });

export const GRAPH_INIT_PYTHON_PRESETS: Readonly<Record<string, string>> =
  Object.freeze({
    fastapi: 'fastapi',
    flask: 'flask',
    requests: 'python-requests',
    celery: 'celery',
    sqlalchemy: 'sqlalchemy',
  });

/** JavaScript 저장소면 늘 켜는 프리셋. 내장 fetch 는 의존성 파일에 나오지 않는다 */
export const GRAPH_INIT_NODE_BASE_PRESETS: readonly string[] = ['fetch'];

/** Python 의존성을 읽는 파일 */
export const GRAPH_INIT_PYTHON_FILES: readonly string[] = [
  'requirements.txt',
  'pyproject.toml',
  'setup.py',
  'Pipfile',
];

/** `graph init` 에 저장소를 주지 않았을 때 넣는 자리표시 저장소 */
export const GRAPH_INIT_PLACEHOLDER_REPOSITORY = Object.freeze({
  name: 'my-api',
  path: '../my-api',
});
