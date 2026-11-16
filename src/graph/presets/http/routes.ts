// 서버 라우트 탐지가 함께 쓰는 도우미: 라우트 탐지 결과 만들기, 처리 함수 찾기, 라우터 등록 프리셋 돌리기
import type {
  CodeSite,
  ExtractedSymbol,
  HttpRouteDetection,
  PresetContext,
} from '../../types.js';
import {
  HANDLER_SYMBOL_KINDS,
  REGISTRATION_ROUTE_CONFIDENCE,
  REGISTRATION_ROUTE_WEAK_CONFIDENCE,
  WEAK_BINDING_PENALTY,
} from './constants.js';
import { isPathLike, joinHttpPaths } from './paths.js';
import {
  bindReceiver,
  callSites,
  fileImportsModule,
  fileSymbol,
  isWeakBinding,
} from './repository.js';
import { mountedPrefixes, prefixRoutes } from './mounts.js';
import type {
  HandlerArgument,
  ReceiverBinding,
  RegistrationFramework,
  RouteTarget,
} from './types.js';

/** 경로 목록과 메서드 목록을 곱해 라우트 탐지를 만든다. 같은 메서드·경로는 한 번만 */
export function routeDetections(input: {
  target: RouteTarget;
  detector: string;
  confidence: number;
  methods: readonly string[];
  paths: readonly string[];
  context: PresetContext;
}): HttpRouteDetection[] {
  const seen = new Set<string>();
  const detections: HttpRouteDetection[] = [];
  for (const path of input.paths) {
    if (!isPathLike(path)) {
      continue;
    }
    const normalized = joinHttpPaths(path);
    for (const method of input.methods) {
      const key = `${method} ${normalized}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      detections.push({
        kind: 'http-route',
        repository: input.context.repository,
        filePath: input.target.symbol.filePath,
        symbol: input.target.symbol.symbol,
        line: input.target.line,
        detector: input.detector,
        confidence: input.confidence,
        evidence: input.target.evidence,
        method,
        path: normalized,
      });
    }
  }
  return detections;
}

/**
 * 등록 자리의 처리기 인자가 같은 파일의 함수 이름이면 그 함수에, 아니면 등록한 심볼에 라우트를 단다
 * 근거에는 어느 쪽에 달았는지와 등록 줄을 적는다
 */
export function routeTarget(
  symbol: ExtractedSymbol,
  site: CodeSite,
  handler: HandlerArgument | undefined,
  context: PresetContext,
): RouteTarget {
  const registered = `${site.name} at line ${site.line} in ${symbol.symbol}`;
  const name = handler?.identifier;
  const candidate =
    name === undefined ? undefined : fileSymbol(symbol.filePath, name, context);
  if (candidate && HANDLER_SYMBOL_KINDS.includes(candidate.kind)) {
    return {
      symbol: candidate,
      line: candidate.lineStart,
      evidence: `route on handler ${candidate.symbol}; registered by ${registered}`,
    };
  }
  const reason =
    name === undefined
      ? 'inline or wrapped handler'
      : `handler ${name} is not a function in this file`;
  return {
    symbol,
    line: site.line,
    evidence: `route on registering symbol (${reason}); registered by ${registered}`,
  };
}

/**
 * 라우터 등록 프리셋(Express, Fastify)을 심볼 하나에 돌린다
 * 받는 쪽이 그 프레임워크로 만든 앱·라우터임을 확인하면 0.95, 그 프레임워크를 가져온 파일에서 이름 관례(`app`, `…Router`)로만 알면 0.9
 * 둘 다 아니면 다른 라이브러리의 같은 이름 메서드(`map.get`, 클라이언트 `api.post`)일 수 있어 내지 않는다
 */
export function registrationRoutes(
  framework: RegistrationFramework,
  symbol: ExtractedSymbol,
  context: PresetContext,
): HttpRouteDetection[] {
  const detections: HttpRouteDetection[] = [];
  for (const site of callSites(symbol)) {
    if (site.kind !== 'call') {
      continue;
    }
    const registration = framework.read(symbol, site, context);
    if (!registration || registration.paths.length === 0) {
      continue;
    }
    const receiver = receiverConfidence(
      framework,
      symbol,
      registration.receiver,
      site,
      context,
    );
    if (!receiver) {
      continue;
    }
    const target = routeTarget(symbol, site, registration.handler, context);
    const mounted = mountedPrefixes(
      framework.mount,
      framework.mountKey(symbol, receiver.binding),
      '',
      context,
    );
    for (const group of prefixRoutes(
      mounted,
      registration.paths,
      receiver.confidence,
      target.evidence,
    )) {
      detections.push(
        ...routeDetections({
          target: { ...target, evidence: group.evidence },
          detector: framework.name,
          confidence: group.confidence,
          methods: registration.methods,
          paths: group.paths,
          context,
        }),
      );
    }
  }
  return detections;
}

function receiverConfidence(
  framework: RegistrationFramework,
  symbol: ExtractedSymbol,
  receiver: string,
  site: CodeSite,
  context: PresetContext,
): { confidence: number; binding?: ReceiverBinding } | undefined {
  const binding = bindReceiver(
    symbol,
    receiver,
    site,
    framework.factories,
    context,
  );
  if (binding) {
    return {
      confidence: isWeakBinding(binding)
        ? REGISTRATION_ROUTE_CONFIDENCE - WEAK_BINDING_PENALTY
        : REGISTRATION_ROUTE_CONFIDENCE,
      binding,
    };
  }
  if (framework.conventionalReceivers.includes(receiver)) {
    return { confidence: REGISTRATION_ROUTE_WEAK_CONFIDENCE };
  }
  return framework.receiverNames.test(receiver) &&
    fileImportsModule(symbol, framework.modules, context)
    ? { confidence: REGISTRATION_ROUTE_WEAK_CONFIDENCE }
    : undefined;
}

/** `router.get` → 받는 쪽 router, 메서드 get. 연쇄 호출(`a().get`)은 undefined */
export function splitMemberCall(
  name: string,
): { receiver: string; member: string } | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  const receiver = name.slice(0, dot);
  return receiver.includes('(') || receiver.includes('[')
    ? undefined
    : { receiver, member: name.slice(dot + 1) };
}

/** 처리기 인자. 마지막 인자가 이름이면 그 이름 */
export function handlerArgument(site: CodeSite): HandlerArgument | undefined {
  const last = site.args.at(-1);
  if (!last) {
    return undefined;
  }
  return last.identifier !== undefined ? { identifier: last.identifier } : {};
}
