import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
} from '../constants.js';
import { startServer } from '../server.js';
import type { CodeciteAnswer } from '../types.js';
import { EXIT_OK } from './constants.js';
import { openEngine } from './engine.js';
import { CliUsageError } from './errors.js';
import type { CliContext, CliLeafCommand } from './types.js';

/** `codecite index`: CSV 를 읽어 색인을 만들고 요약을 보인다 */
export const indexCommand: CliLeafCommand = {
  name: 'index',
  summary: 'Read the policy CSV and build the search index',
  usage: '[options]',
  description: [
    'Reads codecite.config.json and the policy CSV it names, then builds the index.',
    'With an embedding model it also writes the vector cache (index.path) and reuses it',
    'while the CSV and the model stay the same. A CSV format error stops with its row number.',
  ],
  async run(context) {
    rejectPositionals(context);
    const { codecite } = await openEngine(context);
    const { chunks, retrieval, reusedVectors } = codecite.indexSummary;
    context.io.stdout(
      `Indexed ${chunks} chunks (retrieval: ${retrieval}, reused vectors: ${reusedVectors ? 'yes' : 'no'})\n`,
    );
    return EXIT_OK;
  },
};

/** `codecite ask`: 질문 하나에 답하고 쓴 claim 을 번호를 붙여 보인다 */
export const askCommand: CliLeafCommand = {
  name: 'ask',
  summary: 'Answer one question and cite the claims it used',
  usage: '<question> [--json]',
  description: [
    'Answers from the policy claims only. When the claims do not cover the question,',
    'the status is insufficient_evidence and no answer is made up.',
    'Without OPENAI_API_KEY (or a local model) it uses BM25 search and deterministic answers.',
  ],
  options: {
    json: {
      type: 'boolean',
      description:
        'Print the whole answer (status, answer, citations, trace) as JSON',
    },
  },
  async run(context) {
    const question = context.positionals.join(' ').trim();
    if (!question) {
      throw new CliUsageError('ask needs a question');
    }
    const { codecite } = await openEngine(context);
    const answer = await codecite.ask(question);
    context.io.stdout(
      context.values.json === true
        ? `${JSON.stringify(answer, null, 2)}\n`
        : formatAnswer(answer),
    );
    return EXIT_OK;
  },
};

/** `codecite serve`: HTTP 서버를 열고 종료 신호가 올 때까지 기다린다 */
export const serveCommand: CliLeafCommand = {
  name: 'serve',
  summary: 'Start the HTTP server (POST /ask, GET /health)',
  usage: '[--port <port>] [--host <host>]',
  description: [
    'POST /ask    body {"question": "..."}; returns the answer JSON (same shape as ask --json)',
    'GET  /health returns {"status": "ok", "index": {...}}',
    `Requests with bad JSON or an empty question get 400; bodies over ${DEFAULT_MAX_REQUEST_BODY_BYTES / 1024} KB get 413.`,
    'Stops on Ctrl+C (SIGINT) or SIGTERM.',
  ],
  options: {
    port: {
      type: 'string',
      valueName: '<port>',
      description: `Port to listen on (default: ${DEFAULT_SERVER_PORT})`,
    },
    host: {
      type: 'string',
      valueName: '<host>',
      description: `Address to listen on (default: ${DEFAULT_SERVER_HOST})`,
    },
  },
  logLevel: 'info',
  async run(context) {
    rejectPositionals(context);
    // 인자 오류는 색인을 만들기 전에 알린다
    const port = portValue(context.values.port);
    const host = context.values.host ?? DEFAULT_SERVER_HOST;
    if (typeof host !== 'string' || !host.trim()) {
      throw new CliUsageError('--host needs an address');
    }
    const { codecite } = await openEngine(context);
    const server = await startServer(codecite, {
      port,
      host: host.trim(),
      logger: context.logger,
    });
    context.logger.info('server listening', { url: server.url });
    await shutdownSignal();
    await server.close();
    context.logger.info('server stopped');
    return EXIT_OK;
  },
};

function formatAnswer(answer: CodeciteAnswer): string {
  const lines = [answer.answer.trim()];
  if (answer.citations.length > 0) {
    lines.push('', 'Citations');
    answer.citations.forEach((citation, index) => {
      const marker = `${index + 1}. `;
      lines.push(`${marker}${citation.statement}`);
      if (citation.source) {
        lines.push(`${' '.repeat(marker.length)}source: ${citation.source}`);
      }
    });
  }
  return `${lines.join('\n')}\n`;
}

function rejectPositionals(context: CliContext): void {
  if (context.positionals.length > 0) {
    throw new CliUsageError(`unexpected argument "${context.positionals[0]}"`);
  }
}

function portValue(value: string | boolean | undefined): number {
  if (value === undefined) {
    return DEFAULT_SERVER_PORT;
  }
  const port = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65_535) {
    throw new CliUsageError('--port must be a number from 0 to 65535');
  }
  return Number(port);
}

function shutdownSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
