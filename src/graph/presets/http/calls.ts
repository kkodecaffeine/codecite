// 클라이언트 호출 탐지 결과를 만든다. 신뢰도는 경로를 얼마나 정적으로 읽었는지로 정한다
import type {
  CodeSite,
  ExtractedSymbol,
  HttpCallDetection,
  PresetContext,
} from '../../types.js';
import {
  CLIENT_CALL_CONFIDENCE,
  CLIENT_CALL_PARTIAL_CONFIDENCE,
  CLIENT_CALL_UNKNOWN_CONFIDENCE,
  WEAK_BINDING_PENALTY,
} from './constants.js';
import { isWeakBinding } from './repository.js';
import type { ReceiverBinding, UrlReading } from './types.js';

export function callDetection(input: {
  symbol: ExtractedSymbol;
  site: CodeSite;
  detector: string;
  method: string;
  reading: UrlReading;
  binding?: ReceiverBinding;
  context: PresetContext;
}): HttpCallDetection {
  const { symbol, site, reading, binding } = input;
  const base =
    reading.path === undefined
      ? CLIENT_CALL_UNKNOWN_CONFIDENCE
      : reading.dynamic
        ? CLIENT_CALL_PARTIAL_CONFIDENCE
        : CLIENT_CALL_CONFIDENCE;
  const confidence =
    binding && isWeakBinding(binding) ? base - WEAK_BINDING_PENALTY : base;
  const parts = [`${site.name} at line ${site.line}`];
  if (binding) {
    parts.push(
      binding.site
        ? `instance from ${binding.site.name} in ${binding.owner.symbol}`
        : `instance typed ${binding.type ?? 'unknown'} in ${binding.owner.symbol}`,
    );
  }
  if (reading.path === undefined) {
    parts.push('address not readable statically');
  } else if (reading.dynamic) {
    parts.push('path partly built at runtime');
  }
  return {
    kind: 'http-call',
    repository: input.context.repository,
    filePath: symbol.filePath,
    symbol: symbol.symbol,
    line: site.line,
    detector: input.detector,
    confidence: Number(confidence.toFixed(2)),
    evidence: parts.join('; '),
    method: input.method,
    ...(reading.path !== undefined ? { path: reading.path } : {}),
    baseIdentifiers: reading.baseIdentifiers,
    ...(reading.host !== undefined ? { host: reading.host } : {}),
    dynamic: reading.dynamic,
  };
}
