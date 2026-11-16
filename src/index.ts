/** 패키지 버전 */
export const version = '0.0.0';

export { createCodecite } from './codecite.js';
export { loadConfig } from './config.js';
export { consoleLogger, createConsoleLogger, noopLogger } from './logger.js';
export {
  CsvFormatError,
  csvPolicySource,
} from './adapters/csv-policy-source.js';
export { openAiClient } from './adapters/openai.js';
export { ollamaClient } from './adapters/ollama.js';
export {
  indexFingerprint,
  jsonIndexCache,
} from './adapters/json-index-cache.js';
export { InMemoryVectorIndex } from './retrieval/vector-index.js';
export { buildPolicyAnswerPrompt, planQuestion } from './generation/prompts.js';
export { createRequestHandler, startServer } from './server.js';

export type {
  Codecite,
  CodeciteAnswer,
  CodeciteCitation,
  CodeciteConfig,
  CodeciteIndexSummary,
  CodeciteLimits,
  CodeciteOptions,
  CodeciteProviderConfig,
  CodeciteRequestHandler,
  CodeciteRequestHandlerOptions,
  CodeciteServer,
  CodeciteServerOptions,
  CodeciteTrace,
  LoadConfigOptions,
  LoadedConfig,
  LogLevel,
} from './types.js';
export type {
  Embedder,
  LlmClient,
  LlmCompletionRequest,
  LogFields,
  Logger,
  PolicySource,
  VectorIndex,
  VectorSearchOptions,
} from './ports.js';
export type {
  PolicyAnswerMode,
  PolicyAnswerPrompt,
  PolicyAnswerPromptInput,
  PolicyEvidence,
  QuestionPlan,
  QuestionPlanOptions,
} from './generation/types.js';
export type {
  CachedIndex,
  CachedVectors,
  CsvPolicySourceOptions,
  JsonIndexCacheOptions,
  OllamaClientOptions,
  OpenAiClientOptions,
} from './adapters/types.js';
export type { CsvPolicySource } from './adapters/csv-policy-source.js';
export type { JsonIndexCache } from './adapters/json-index-cache.js';
export type { OllamaClient } from './adapters/ollama.js';
export type { OpenAiClient } from './adapters/openai.js';
export type { Policy } from './domain/policy.js';
export type { PolicyChunk } from './domain/policy-chunk.js';
export type { PolicyClaimFacet } from './domain/types.js';
export type { RetrievalMode } from './retrieval/types.js';
export type { Vocabulary } from './text/types.js';

export type * from './extensions/index.js';
export {
  DEFAULT_RESEARCH_BUDGET,
  DEFAULT_RESEARCH_PACKING,
  RESEARCH_FINISH_TOOL_NAME,
  RESEARCH_TOOL_NAMES,
} from './extensions/index.js';
