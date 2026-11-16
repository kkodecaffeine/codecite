// 자리 인자에서 주소·경로·메서드를 읽는다. 문자열, 템플릿 조각, 상수 이름만 보고 원문 글은 다시 읽지 않는다
// 상수 이름은 PresetContext.resolveConstant 로 같은 저장소의 문자열 값으로 푼다. 환경 변수 읽기는 풀지 않고 기준 주소 식별자로 남긴다
import type {
  CodeSite,
  CodeSiteArgument,
  ExtractedSymbol,
  PresetContext,
} from '../../types.js';
import { HTTP_VERBS, SUBSTITUTION_MARK } from './constants.js';
import {
  hostOf,
  isAbsoluteUrl,
  isPathLike,
  joinHttpPaths,
  normalizeHttpPath,
} from './paths.js';
import { constantArgument } from './repository.js';
import type { UrlPiece, UrlReading } from './types.js';

/** Python 키워드 인자를 모은 마지막 인자의 원문(`prefix=<literal>`) */
const KEYWORD_BUNDLE_TEXT = /^\*{0,2}[A-Za-z_]\w*=/;
/** 환경 변수 읽기 식별자 */
const ENV_IDENTIFIER = /^(?:process\.env|import\.meta\.env|os\.environ)\./;
/** 상수가 다른 상수를 가리킬 때 따라가는 깊이. 서로 가리키는 상수에서 멈춘다 */
const MAX_CONSTANT_DEPTH = 4;
const KNOWN_METHODS = new Set(
  [...HTTP_VERBS, 'trace'].map((verb) => verb.toUpperCase()),
);

/** Python 키워드 인자. TS·JS 자리에는 없어 빈 객체다 */
export function keywordArguments(
  site: CodeSite,
): Readonly<Record<string, CodeSiteArgument>> {
  const last = site.args.at(-1);
  return last && isKeywordBundle(last) ? (last.properties ?? {}) : {};
}

/** 키워드 묶음을 뺀 위치 인자 */
export function positionalArguments(site: CodeSite): CodeSiteArgument[] {
  const last = site.args.at(-1);
  return last && isKeywordBundle(last) ? site.args.slice(0, -1) : site.args;
}

function isKeywordBundle(argument: CodeSiteArgument): boolean {
  return (
    argument.properties !== undefined && KEYWORD_BUNDLE_TEXT.test(argument.text)
  );
}

/**
 * 상수 이름을 문자열로 푼다. 환경 변수는 풀지 않는다
 * origin 을 주면 그 심볼의 파일과 가져오기에서 상수 값을 먼저 찾는다. 지금 탐지하는 심볼이 아닌 다른 파일의 자리(라우터 마운트)를 읽을 때 쓴다
 */
export function resolveIdentifier(
  identifier: string,
  context: PresetContext,
  origin?: ExtractedSymbol,
  depth = 0,
): string | undefined {
  if (ENV_IDENTIFIER.test(identifier)) {
    return undefined;
  }
  if (origin && depth < MAX_CONSTANT_DEPTH) {
    const found = constantArgument(origin, identifier, context);
    const pieces = found
      ? urlPieces(found.argument, context, found.owner, depth + 1)
      : undefined;
    if (pieces?.every((piece) => piece.kind === 'static')) {
      return pieces.map((piece) => piece.text).join('');
    }
  }
  return context.resolveConstant(identifier);
}

/** 인자를 정적 글로 읽는다. 문자열, 풀리는 상수, 치환 자리가 모두 풀리는 템플릿만 받는다 */
export function staticText(
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
  origin?: ExtractedSymbol,
): string | undefined {
  if (!argument) {
    return undefined;
  }
  const pieces = urlPieces(argument, context, origin);
  return pieces.every((piece) => piece.kind === 'static')
    ? pieces.map((piece) => piece.text).join('')
    : undefined;
}

/** 인자를 글 목록으로 읽는다. 배열이면 원소마다 읽고, 못 읽은 원소는 뺀다 */
export function staticTexts(
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
  origin?: ExtractedSymbol,
): string[] {
  if (!argument) {
    return [];
  }
  if (argument.elements) {
    return argument.elements
      .map((element) => staticText(element, context, origin))
      .filter((value): value is string => value !== undefined);
  }
  const value = staticText(argument, context, origin);
  return value === undefined ? [] : [value];
}

/** 대문자 메서드. 문자열, 풀리는 상수, 메서드 이름으로 끝나는 열거형 멤버(`Method.POST`)를 읽는다 */
export function readMethod(
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
): string | undefined {
  if (!argument) {
    return undefined;
  }
  const value = staticText(argument, context);
  if (value !== undefined) {
    const upper = value.trim().toUpperCase();
    return KNOWN_METHODS.has(upper) ? upper : undefined;
  }
  const leaf = argument.identifier?.split('.').at(-1)?.toUpperCase();
  return leaf !== undefined &&
    argument.identifier?.includes('.') &&
    KNOWN_METHODS.has(leaf)
    ? leaf
    : undefined;
}

/** 메서드 목록. 배열이면 원소마다 */
export function readMethods(
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
): string[] {
  if (!argument) {
    return [];
  }
  const items = argument.elements ?? [argument];
  return items
    .map((item) => readMethod(item, context))
    .filter((method): method is string => method !== undefined);
}

/** 주소 인자를 정적 조각과 실행 중에 정해지는 조각으로 펼친다. 이웃한 정적 조각은 합친다 */
export function urlPieces(
  argument: CodeSiteArgument,
  context: PresetContext,
  origin?: ExtractedSymbol,
  depth = 0,
): UrlPiece[] {
  const pieces: UrlPiece[] = [];
  const push = (piece: UrlPiece): void => {
    const last = pieces.at(-1);
    if (piece.kind === 'static' && last?.kind === 'static') {
      last.text += piece.text;
      return;
    }
    if (piece.kind === 'static' && piece.text.length === 0) {
      return;
    }
    pieces.push(piece);
  };
  const visit = (current: CodeSiteArgument): void => {
    if (current.literal !== undefined) {
      push({ kind: 'static', text: current.literal });
      return;
    }
    if (current.template) {
      current.template.forEach((text, index) => {
        push({ kind: 'static', text });
        const substitution = current.substitutions?.[index];
        if (substitution) {
          visit(substitution);
        }
      });
      return;
    }
    if (current.identifier !== undefined) {
      const value = resolveIdentifier(
        current.identifier,
        context,
        origin,
        depth,
      );
      push(
        value === undefined
          ? { kind: 'dynamic', identifier: current.identifier }
          : { kind: 'static', text: value },
      );
      return;
    }
    push({ kind: 'dynamic' });
  };
  visit(argument);
  return pieces;
}

/**
 * 주소 인자를 읽는다. 맨 앞의 실행 중 값은 기준 주소로 보고 그 식별자를 남긴다
 * 그 뒤의 실행 중 값은 `:param` 자리가 되고 dynamic 이 된다. 정적으로 읽은 경로 글자가 없으면 path 를 비운다
 * 공백이 섞인 글이면 주소가 아니라서 undefined
 */
export function readUrl(
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
): UrlReading | undefined {
  if (!argument) {
    return undefined;
  }
  const pieces = urlPieces(argument, context);
  if (
    pieces.some((piece) => piece.kind === 'static' && !isPathLike(piece.text))
  ) {
    return undefined;
  }
  const baseIdentifiers: string[] = [];
  let index = 0;
  for (; index < pieces.length; index += 1) {
    const piece = pieces[index];
    if (piece?.kind !== 'dynamic') {
      break;
    }
    if (piece.identifier !== undefined) {
      baseIdentifiers.push(piece.identifier);
    }
  }
  const hasBase = index > 0;
  const rest = pieces
    .slice(index)
    .map((piece) => (piece.kind === 'static' ? piece.text : SUBSTITUTION_MARK))
    .join('');
  if (!hasBase && rest.length === 0) {
    return { path: '/', baseIdentifiers, dynamic: false };
  }
  const host = isAbsoluteUrl(rest) ? hostOf(rest) : undefined;
  const pathPart = pathPortion(rest);
  const dynamicPath = pathPart.includes(SUBSTITUTION_MARK);
  const staticChars = pathPart
    .split(SUBSTITUTION_MARK)
    .join('')
    .replace(/\//g, '');
  const nothingStatic =
    (hasBase && pathPart.length === 0) ||
    (dynamicPath && staticChars.length === 0);
  if (nothingStatic) {
    return {
      ...(host ? { host } : {}),
      baseIdentifiers,
      dynamic: true,
    };
  }
  return {
    path: normalizeHttpPath(rest),
    ...(host ? { host } : {}),
    baseIdentifiers,
    dynamic: dynamicPath,
  };
}

/** 인스턴스의 기준 주소를 호출 주소 앞에 잇는다. 호출 주소에 호스트가 있으면 기준 주소는 쓰지 않는다 */
export function withBaseUrl(
  base: UrlReading | undefined,
  call: UrlReading,
): UrlReading {
  if (!base || call.host !== undefined) {
    return call;
  }
  const baseIdentifiers = [
    ...new Set([...base.baseIdentifiers, ...call.baseIdentifiers]),
  ];
  const host = base.host;
  if (call.path === undefined) {
    return { ...(host ? { host } : {}), baseIdentifiers, dynamic: true };
  }
  const prefixed = base.path !== undefined && base.path !== '/';
  return {
    path: prefixed ? joinHttpPaths(base.path ?? '', call.path) : call.path,
    ...(host ? { host } : {}),
    baseIdentifiers,
    dynamic: call.dynamic || (prefixed && base.dynamic),
  };
}

/** 주소 글에서 호스트와 질의·해시를 뗀 경로 부분 */
function pathPortion(value: string): string {
  let rest = value;
  if (isAbsoluteUrl(rest)) {
    const afterScheme = rest.slice(rest.indexOf('//') + 2);
    const end = afterScheme.search(/[/?#]/);
    rest = end < 0 ? '' : afterScheme.slice(end);
  }
  return rest.split(/[?#]/, 1)[0] ?? '';
}
