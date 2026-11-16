// 전역 fetch 호출 프리셋: `fetch('/api/orders')`, `fetch(\`${SHOP_API_URL}/orders/${id}\`, { method: 'POST' })`, `fetch(new URL('/points', base))`
// 메서드는 옵션 객체의 method 속성에서 읽고, 없으면 fetch 기본값 GET, 있는데 읽지 못하면 `*` 이다
import type {
  CodeSite,
  DetectionPreset,
  ExtractedSymbol,
  PresetContext,
} from '../../types.js';
import { readMethod, readUrl, withBaseUrl } from './arguments.js';
import { callDetection } from './calls.js';
import {
  ANY_HTTP_METHOD,
  DEFAULT_HTTP_METHOD,
  FETCH_CALLEES,
  SCRIPT_LANGUAGES,
  URL_CONSTRUCTOR,
} from './constants.js';
import { callSites, fileSymbol } from './repository.js';
import type { UrlReading } from './types.js';

export const FETCH_PRESET: DetectionPreset = {
  name: 'fetch',
  languages: SCRIPT_LANGUAGES,
  detect(symbol, context) {
    // 같은 파일에 fetch 라는 함수를 따로 만들었으면 그 함수를 부르는 것이다
    const shadowed =
      fileSymbol(symbol.filePath, 'fetch', context) !== undefined;
    return callSites(symbol).flatMap((site) => {
      if (
        site.kind !== 'call' ||
        !FETCH_CALLEES.includes(site.name) ||
        (shadowed && site.name === 'fetch')
      ) {
        return [];
      }
      const reading = fetchUrl(symbol, site, context);
      if (!reading) {
        return [];
      }
      const option = site.args[1]?.properties?.method;
      return [
        callDetection({
          symbol,
          site,
          detector: FETCH_PRESET.name,
          method:
            option === undefined
              ? DEFAULT_HTTP_METHOD
              : (readMethod(option, context) ?? ANY_HTTP_METHOD),
          reading,
          context,
        }),
      ];
    });
  },
};

/** 첫 인자가 `new URL(경로, 기준)` 이면 같은 줄의 URL 생성 자리에서 읽는다 */
function fetchUrl(
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
): UrlReading | undefined {
  const target = site.args[0];
  if (!target) {
    return undefined;
  }
  if (target.text.startsWith(`new ${URL_CONSTRUCTOR}(`)) {
    const constructed = (symbol.sites ?? []).find(
      (candidate) =>
        candidate.kind === 'new' &&
        candidate.name === URL_CONSTRUCTOR &&
        candidate.line === site.line,
    );
    const path = readUrl(constructed?.args[0], context);
    if (!path) {
      return undefined;
    }
    return withBaseUrl(readUrl(constructed?.args[1], context), path);
  }
  return readUrl(target, context);
}
