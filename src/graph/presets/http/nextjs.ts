// Next.js 파일 경로 라우트 프리셋. 경로는 코드가 아니라 파일 위치가 정한다
// - `app/**/route.ts`: 내보낸 `GET`·`POST`… 함수마다 그 메서드의 라우트. `(묶음)`·`@슬롯` 폴더는 경로에서 빼고, `_폴더` 아래는 라우트가 아니다
// - `pages/api/**`: 파일의 기본 내보내기 처리기 하나가 모든 메서드를 받는다. `index` 는 폴더 경로, `_` 로 시작하는 파일은 라우트가 아니다
import type {
  DetectionPreset,
  ExtractedSymbol,
  PresetContext,
} from '../../types.js';
import {
  ANY_HTTP_METHOD,
  DEFAULT_EXPORT_NAME,
  FILE_ROUTE_CONFIDENCE,
  FILE_ROUTE_GUESSED_HANDLER_CONFIDENCE,
  HANDLER_SYMBOL_KINDS,
  NEXT_PAGE_EXTENSIONS,
  NEXT_ROUTE_FILE,
  NEXT_ROUTE_METHODS,
  SCRIPT_LANGUAGES,
} from './constants.js';
import { fileSymbols, repositoryIndex } from './repository.js';
import { routeDetections } from './routes.js';

export const NEXTJS_PRESET: DetectionPreset = {
  name: 'nextjs',
  languages: SCRIPT_LANGUAGES,
  detect(symbol, context) {
    const appRoute = appRouterPath(symbol.filePath);
    if (appRoute !== undefined) {
      if (!NEXT_ROUTE_METHODS.includes(symbol.symbol) || !isExported(symbol)) {
        return [];
      }
      return routeDetections({
        target: {
          symbol,
          line: symbol.lineStart,
          evidence: `exported ${symbol.symbol} in route file ${symbol.filePath}`,
        },
        detector: NEXTJS_PRESET.name,
        confidence: FILE_ROUTE_CONFIDENCE,
        methods: [symbol.symbol],
        paths: [appRoute],
        context,
      });
    }
    const pageRoute = pagesApiPath(symbol.filePath);
    if (pageRoute === undefined) {
      return [];
    }
    const handler = defaultHandler(symbol, context);
    if (!handler) {
      return [];
    }
    return routeDetections({
      target: {
        symbol,
        line: symbol.lineStart,
        evidence: handler.guessed
          ? `only function in API page ${symbol.filePath}`
          : `default export of API page ${symbol.filePath}`,
      },
      detector: NEXTJS_PRESET.name,
      confidence: handler.guessed
        ? FILE_ROUTE_GUESSED_HANDLER_CONFIDENCE
        : FILE_ROUTE_CONFIDENCE,
      methods: [ANY_HTTP_METHOD],
      paths: [pageRoute],
      context,
    });
  },
};

/** `app` 폴더의 `route.ts` 면 그 라우트 경로(정규화 전), 아니면 undefined */
export function appRouterPath(filePath: string): string | undefined {
  const segments = filePath.split('/');
  const file = segments.at(-1) ?? '';
  const root = segments.indexOf('app');
  if (root < 0 || !NEXT_ROUTE_FILE.test(file)) {
    return undefined;
  }
  const folders = segments.slice(root + 1, -1);
  if (folders.some((folder) => folder.startsWith('_'))) {
    return undefined;
  }
  return `/${folders
    .filter((folder) => !/^\(.*\)$/.test(folder) && !folder.startsWith('@'))
    .join('/')}`;
}

/** `pages/api` 아래 파일이면 그 라우트 경로(정규화 전), 아니면 undefined */
export function pagesApiPath(filePath: string): string | undefined {
  const segments = filePath.split('/');
  const root = segments.findIndex(
    (segment, index) => segment === 'pages' && segments[index + 1] === 'api',
  );
  const file = segments.at(-1) ?? '';
  const extension = NEXT_PAGE_EXTENSIONS.find((candidate) =>
    file.endsWith(candidate),
  );
  if (root < 0 || extension === undefined || file.startsWith('_')) {
    return undefined;
  }
  const stem = file.slice(0, -extension.length);
  const folders = segments.slice(root + 1, -1);
  return `/${[...folders, ...(stem === 'index' ? [] : [stem])].join('/')}`;
}

/** 선언 원문이 `export` 로 시작하는지. 원문 맨 앞은 선언 문법이라 주석·문자열이 아니다 */
function isExported(symbol: ExtractedSymbol): boolean {
  return /^export\b/.test(symbol.content);
}

function isDefaultExport(symbol: ExtractedSymbol): boolean {
  return (
    symbol.symbol === DEFAULT_EXPORT_NAME ||
    /^export\s+default\b/.test(symbol.content)
  );
}

/**
 * 이 심볼이 API 페이지의 처리기인지. 기본 내보내기 표시가 있으면 그것,
 * 없으면(`export default handler;` 처럼 이름만 내보낸 경우) 파일에 하나뿐인 최상위 함수를 처리기로 고른다
 */
function defaultHandler(
  symbol: ExtractedSymbol,
  context: PresetContext,
): { guessed: boolean } | undefined {
  if (isDefaultExport(symbol)) {
    return { guessed: false };
  }
  if (
    !repositoryIndex(context) ||
    !HANDLER_SYMBOL_KINDS.includes(symbol.kind)
  ) {
    return undefined;
  }
  const siblings = fileSymbols(symbol, context);
  if (siblings.some(isDefaultExport)) {
    return undefined;
  }
  const functions = siblings.filter(
    (candidate) =>
      candidate.kind === 'function' && !candidate.symbol.includes('.'),
  );
  return functions.length === 1 && functions[0] === symbol
    ? { guessed: true }
    : undefined;
}
