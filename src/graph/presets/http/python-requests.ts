// Python HTTP 클라이언트 프리셋: requests 와 httpx
// - 모듈 함수: `requests.get(url)`, `httpx.post(url, json=…)`, `requests.request('DELETE', url)`
// - 인스턴스: `requests.Session()`, `httpx.Client(base_url=…)`, `httpx.AsyncClient(base_url=…)` 로 만든 이름(대입, with 문, `self.client`)
//   base_url 은 경로 앞에 붙이고, 그 식별자는 기준 주소 식별자로 남긴다
import type {
  CodeSite,
  DetectionPreset,
  ExtractedSymbol,
  HttpCallDetection,
  PresetContext,
} from '../../types.js';
import {
  keywordArguments,
  positionalArguments,
  readMethod,
  readUrl,
  withBaseUrl,
} from './arguments.js';
import { callDetection } from './calls.js';
import {
  ANY_HTTP_METHOD,
  HTTP_VERBS,
  PYTHON_BASE_URL_KEYWORD,
  PYTHON_HTTP_FACTORIES,
  PYTHON_HTTP_MODULES,
  PYTHON_LANGUAGES,
  PYTHON_METHOD_KEYWORD,
  PYTHON_REQUEST_FUNCTION,
  PYTHON_URL_KEYWORD,
  WHOLE_MODULE_NAME,
} from './constants.js';
import { bindReceiver, callSites, importedName } from './repository.js';
import { splitMemberCall } from './routes.js';
import type { ReceiverBinding, UrlReading } from './types.js';

export const PYTHON_REQUESTS_PRESET: DetectionPreset = {
  name: 'python-requests',
  languages: PYTHON_LANGUAGES,
  detect(symbol, context) {
    return callSites(symbol).flatMap((site) =>
      site.kind === 'call' ? clientCall(symbol, site, context) : [],
    );
  },
};

function clientCall(
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
): HttpCallDetection[] {
  const call = splitMemberCall(site.name);
  if (!call) {
    return [];
  }
  const positional = positionalArguments(site);
  const keywords = keywordArguments(site);
  let method: string;
  let url;
  if (HTTP_VERBS.includes(call.member)) {
    method = call.member.toUpperCase();
    url = positional[0] ?? keywords[PYTHON_URL_KEYWORD];
  } else if (call.member === PYTHON_REQUEST_FUNCTION) {
    method =
      readMethod(positional[0] ?? keywords[PYTHON_METHOD_KEYWORD], context) ??
      ANY_HTTP_METHOD;
    url = positional[1] ?? keywords[PYTHON_URL_KEYWORD];
  } else {
    return [];
  }
  let binding: ReceiverBinding | undefined;
  let base: UrlReading | undefined;
  if (!isClientModule(symbol, call.receiver, context)) {
    binding = bindReceiver(
      symbol,
      call.receiver,
      site,
      PYTHON_HTTP_FACTORIES,
      context,
    );
    if (!binding) {
      return [];
    }
    base = binding.site
      ? readUrl(
          keywordArguments(binding.site)[PYTHON_BASE_URL_KEYWORD],
          context,
        )
      : undefined;
  }
  const reading = readUrl(url, context);
  if (!reading) {
    return [];
  }
  return [
    callDetection({
      symbol,
      site,
      detector: PYTHON_REQUESTS_PRESET.name,
      method,
      reading: withBaseUrl(base, reading),
      ...(binding ? { binding } : {}),
      context,
    }),
  ];
}

/** requests·httpx 모듈 자체인지(`import requests`, `import httpx as http`) */
function isClientModule(
  symbol: ExtractedSymbol,
  receiver: string,
  context: PresetContext,
): boolean {
  if (PYTHON_HTTP_MODULES.includes(receiver)) {
    return true;
  }
  const binding = importedName(symbol, receiver, context);
  return (
    binding !== undefined &&
    PYTHON_HTTP_MODULES.includes(binding.specifier) &&
    binding.imported === WHOLE_MODULE_NAME
  );
}
