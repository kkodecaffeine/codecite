#!/usr/bin/env node
import { runCli } from './cli/run.js';

// 종료 코드만 정하고 직접 끝내지 않는다. 출력이 다 나가고 서버가 닫힌 뒤에 끝난다
process.exitCode = await runCli(process.argv.slice(2));
