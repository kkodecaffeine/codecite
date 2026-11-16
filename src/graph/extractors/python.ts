// Python 추출기. python3 를 추출 한 번에 한 번만 띄우고, 파일 묶음을 표준 입출력 JSON 으로 주고받는다
// 구문 트리는 표준 라이브러리 ast 로 읽어 TypeScript 추출기와 같은 심볼·관계·실행 사실 꼴로 낸다
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import type {
  ExtractedSymbol,
  ExtractionFailure,
  ExtractionResult,
  SymbolExtractor,
} from '../types.js';
import {
  DEFAULT_PYTHON_COMMAND,
  EXECUTABLE_SYMBOL_KINDS,
  MINIMUM_PYTHON_VERSION,
  PYTHON_EXTRACT_SETTINGS,
  PYTHON_OMISSION_COMMENT,
  PYTHON_SOURCE_EXTENSIONS,
  PYTHON_STDERR_MAX_CHARS,
  PYTHON_VERSION_EXIT_CODE,
} from './constants.js';
import {
  boundDeclarationContent,
  errorMessage,
  finalizeExtraction,
  finalizeFacts,
  finalizeRelations,
  finalizeSites,
  hasExtension,
} from './normalize.js';
import { PYTHON_EXTRACTOR_SCRIPT } from './python-script.js';
import type {
  PythonExtractorOptions,
  PythonExtractRequest,
  PythonExtractResponse,
  PythonSymbolPayload,
} from './types.js';

/** `.py` 파일에서 심볼·관계·실행 사실을 뽑는 추출기. python3 3.9 이상이 필요하다 */
export function pythonExtractor(
  options: PythonExtractorOptions = {},
): SymbolExtractor {
  const command = options.command ?? DEFAULT_PYTHON_COMMAND;
  return {
    name: 'python',
    extensions: PYTHON_SOURCE_EXTENSIONS,
    async extract(files, context): Promise<ExtractionResult> {
      const targets = files.filter((file) =>
        hasExtension(file.filePath, PYTHON_SOURCE_EXTENSIONS),
      );
      if (targets.length === 0) {
        return { symbols: [], failures: [] };
      }
      const response = await runHelper(command, context.repository, {
        settings: PYTHON_EXTRACT_SETTINGS,
        // 파일 맨 앞의 BOM 은 ast 가 읽지 못한다. 줄 번호는 그대로다
        files: targets.map((file) => ({
          filePath: file.filePath,
          content: file.content.replace(/^\uFEFF/, ''),
        })),
      });
      const requested = new Set(targets.map((file) => file.filePath));
      const symbols: ExtractedSymbol[] = [];
      const failures: ExtractionFailure[] = [];
      for (const result of response.results) {
        if (!requested.has(result.filePath)) {
          throw new Error(
            `python helper answered for a file it was not given: ${result.filePath}`,
          );
        }
        if (result.error !== undefined) {
          failures.push({ filePath: result.filePath, message: result.error });
          continue;
        }
        for (const payload of result.symbols ?? []) {
          symbols.push(toSymbol(result.filePath, payload, context.repository));
        }
      }
      context.logger.debug('python extraction finished', {
        repository: context.repository,
        files: targets.length,
        symbols: symbols.length,
        failures: failures.length,
      });
      return finalizeExtraction({ symbols, failures });
    },
  };
}

function toSymbol(
  filePath: string,
  payload: PythonSymbolPayload,
  repository: string,
): ExtractedSymbol {
  const executable = EXECUTABLE_SYMBOL_KINDS.includes(payload.kind);
  const facts = finalizeFacts(payload.facts ?? []);
  // 도우미가 낸 인자 값은 아직 가리지 않은 상태라 여기서 가린 뒤 내보낸다
  const sites = finalizeSites(payload.sites ?? []);
  return {
    filePath,
    language: 'python',
    symbol: payload.symbol,
    kind: payload.kind,
    content: boundDeclarationContent(
      payload.content,
      payload.kind,
      PYTHON_OMISSION_COMMENT,
    ),
    lineStart: payload.lineStart,
    lineEnd: payload.lineEnd,
    ...(payload.description ? { description: payload.description } : {}),
    relations: finalizeRelations(repository, payload.relations),
    ...(executable || facts.length > 0 ? { executionFacts: facts } : {}),
    ...(sites.length > 0 ? { sites } : {}),
  };
}

/** 도우미를 한 번 띄워 요청을 넘기고 응답을 받는다. 도우미 자체가 실패하면 저장소 이름과 함께 던진다 */
function runHelper(
  command: string,
  repository: string,
  request: PythonExtractRequest,
): Promise<PythonExtractResponse> {
  return new Promise((resolve, reject) => {
    // -I: 환경 변수와 현재 폴더의 모듈을 읽지 않는다(현재 폴더의 json.py 같은 파일이 표준 모듈을 가리지 않게)
    const child = spawn(
      command,
      ['-I', '-c', PYTHON_EXTRACTOR_SCRIPT, String(PYTHON_VERSION_EXIT_CODE)],
      { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const fail = (message: string, cause?: unknown): void => {
      if (!settled) {
        settled = true;
        reject(new Error(message, cause === undefined ? undefined : { cause }));
      }
    };
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      fail(
        error.code === 'ENOENT'
          ? `${command} was not found, so the Python files of repository "${repository}" cannot be read. Install Python ${MINIMUM_PYTHON_VERSION} or newer and make sure "${command}" is on PATH`
          : `${command} could not be started for repository "${repository}": ${error.message}`,
        error,
      );
    });
    // 도우미가 먼저 끝나 입력 통로가 닫혀도 close 에서 종료 코드로 알린다
    child.stdin.on('error', () => undefined);
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      const errorText = Buffer.concat(stderr)
        .toString('utf8')
        .trim()
        .slice(-PYTHON_STDERR_MAX_CHARS);
      if (code === PYTHON_VERSION_EXIT_CODE) {
        fail(
          `${command} is older than Python ${MINIMUM_PYTHON_VERSION}, which repository "${repository}" needs for Python files: ${errorText}`,
        );
        return;
      }
      if (code !== 0) {
        fail(
          `python helper failed for repository "${repository}" (exit code ${code}): ${errorText}`,
        );
        return;
      }
      try {
        const response = JSON.parse(
          Buffer.concat(stdout).toString('utf8'),
        ) as PythonExtractResponse;
        if (!Array.isArray(response.results)) {
          throw new Error('results is missing');
        }
        settled = true;
        resolve(response);
      } catch (error) {
        fail(
          `python helper returned invalid output for repository "${repository}": ${errorMessage(error)}`,
          error,
        );
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
