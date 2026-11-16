// NestJS 의 이벤트·메시지 처리기, 같은 프로세스 이벤트 발행, 예약 작업, Bull 식 큐 구독·발행을 찾는다
// 발행 쪽은 받는 쪽(`this.<멤버>`)이 주입 멤버로 확인될 때만 잡는다. 멤버 목록이 없으면 잇지 않고, 그냥 `.add(` 는 잡지 않는다
// 같은 이름(nestjs)의 HTTP 프리셋과는 등록표가 합친다
import type {
  CodeSite,
  Detection,
  DetectionPreset,
  ExtractedSymbol,
  MessageDetection,
  PresetContext,
  ScheduleDetection,
} from '../../types.js';
import {
  NESTJS_CLIENT_PROXY_METHODS,
  NESTJS_CLIENT_PROXY_TYPES,
  NESTJS_CONFIDENCE,
  NESTJS_CRON_DECORATOR,
  NESTJS_CRON_EXPRESSION_ENUM,
  NESTJS_EVENT_EMIT_METHODS,
  NESTJS_EVENT_EMITTER_TYPES,
  NESTJS_EVENT_HANDLER_DECORATORS,
  NESTJS_INJECT_QUEUE_DECORATOR,
  NESTJS_INTERVAL_DECORATOR,
  NESTJS_PRESET_NAME,
  NESTJS_PROCESS_DECORATOR,
  NESTJS_PROCESSOR_DECORATOR,
  NESTJS_QUEUE_PUBLISH_METHODS,
  NESTJS_TIMEOUT_DECORATOR,
  NESTJS_WORKER_METHOD,
  RUNTIME_SCHEDULE,
  SCRIPT_LANGUAGES,
} from './constants.js';
import {
  classMemberSymbols,
  detectionBase,
  findDecorator,
  leafName,
  memberDecorator,
  ownerClass,
  readName,
  readPatterns,
  readPlainValue,
  readStaticText,
  receiverMember,
  receiverOf,
  siteLabel,
  symbolIndex,
  typeLeaf,
} from './support.js';
import type { NameReading } from './types.js';

export const nestjsMessagingPreset: DetectionPreset = {
  name: NESTJS_PRESET_NAME,
  languages: SCRIPT_LANGUAGES,
  detect(symbol, context) {
    const found: Detection[] = [];
    for (const site of symbol.sites ?? []) {
      if (site.kind === 'decorator') {
        found.push(...decoratorDetections(symbol, site, context));
      } else if (site.kind === 'call') {
        found.push(...publishDetections(symbol, site, context));
      }
    }
    found.push(...consumeDetections(symbol, context));
    return found;
  },
};

function decoratorDetections(
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
): Detection[] {
  const leaf = leafName(site.name);
  if (NESTJS_EVENT_HANDLER_DECORATORS.includes(leaf)) {
    return readOrDynamic(readPatterns(site.args[0], context)).map((name) =>
      message(
        symbol,
        context,
        site,
        'event-handle',
        name,
        NESTJS_CONFIDENCE.eventHandler,
        siteLabel(site),
      ),
    );
  }
  if (leaf === NESTJS_CRON_DECORATOR) {
    return [schedule(symbol, context, site, cronExpression(site, context))];
  }
  if (leaf === NESTJS_INTERVAL_DECORATOR || leaf === NESTJS_TIMEOUT_DECORATOR) {
    // Interval(ms) 또는 Interval('이름', ms). 주기는 늘 맨 뒤 인자다
    const value = readPlainValue(site.args[site.args.length - 1], context);
    const expression =
      value === undefined
        ? RUNTIME_SCHEDULE
        : `${leaf.toLowerCase()}(${value})`;
    return [schedule(symbol, context, site, expression)];
  }
  return [];
}

function cronExpression(site: CodeSite, context: PresetContext): string {
  const argument = site.args[0];
  const value = readStaticText(argument, context);
  if (value !== undefined) {
    return value;
  }
  const identifier = argument?.identifier;
  return identifier?.startsWith(`${NESTJS_CRON_EXPRESSION_ENUM}.`)
    ? identifier
    : RUNTIME_SCHEDULE;
}

/** `this.<멤버>.<메서드>(…)` 호출 가운데 주입 멤버로 확인한 발행 */
function publishDetections(
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
): Detection[] {
  const method = leafName(site.name);
  const member = receiverMember(symbol, receiverOf(site.name), context);
  if (!member) {
    return [];
  }
  const injectQueue = memberDecorator(member, [NESTJS_INJECT_QUEUE_DECORATOR]);
  if (injectQueue && NESTJS_QUEUE_PUBLISH_METHODS.includes(method)) {
    const queue = readName(injectQueue.args[0], context) ?? unnamed();
    const job = site.args[0]?.literal;
    const evidence = `${site.name}(${job ?? '…'}) → ${siteLabel(injectQueue)}`;
    return [
      message(
        symbol,
        context,
        site,
        'queue-publish',
        queue,
        NESTJS_CONFIDENCE.queuePublish,
        evidence,
      ),
    ];
  }
  const type = typeLeaf(member.type);
  const emitter =
    type !== undefined &&
    NESTJS_EVENT_EMITTER_TYPES.includes(type) &&
    NESTJS_EVENT_EMIT_METHODS.includes(method);
  const client =
    type !== undefined &&
    NESTJS_CLIENT_PROXY_TYPES.includes(type) &&
    NESTJS_CLIENT_PROXY_METHODS.includes(method);
  if (!emitter && !client) {
    return [];
  }
  // 같은 프로세스 이벤트는 이름 하나, 서비스 사이 메시지는 객체 패턴도 받는다
  const single = readName(site.args[0], context);
  const names = readOrDynamic(
    emitter ? (single ? [single] : []) : readPatterns(site.args[0], context),
  );
  const evidence = `${siteLabel(site)} on ${member.name}: ${member.type}`;
  return names.map((name) =>
    message(
      symbol,
      context,
      site,
      'event-publish',
      name,
      NESTJS_CONFIDENCE.eventPublish,
      evidence,
    ),
  );
}

/**
 * Bull 식 큐 구독. 큐 이름은 클래스의 Processor 데코레이터에 있고 작업은 메서드가 받는다
 * - Process 데코레이터가 붙은 메서드마다 하나
 * - Process 메서드가 없으면 작업자 기반 클래스의 process 메서드에 하나
 * - 둘 다 없거나 다른 심볼을 볼 수 없으면 클래스에 하나
 */
function consumeDetections(
  symbol: ExtractedSymbol,
  context: PresetContext,
): MessageDetection[] {
  const index = symbolIndex(context);
  const processor = findDecorator(symbol.sites, [NESTJS_PROCESSOR_DECORATOR]);
  if (processor) {
    if (index) {
      const methods = classMemberSymbols(context, symbol);
      const handled = methods.some(
        (method) =>
          findDecorator(method.sites, [NESTJS_PROCESS_DECORATOR]) !==
            undefined ||
          method.symbol === `${symbol.symbol}.${NESTJS_WORKER_METHOD}`,
      );
      if (handled) {
        return [];
      }
    }
    return [consume(symbol, context, processor, processor)];
  }
  const owner = ownerClass(symbol, context);
  const ownerProcessor =
    owner && findDecorator(owner.sites, [NESTJS_PROCESSOR_DECORATOR]);
  if (!owner || !ownerProcessor) {
    return [];
  }
  const process = findDecorator(symbol.sites, [NESTJS_PROCESS_DECORATOR]);
  if (process) {
    return [consume(symbol, context, ownerProcessor, process)];
  }
  if (symbol.symbol !== `${owner.symbol}.${NESTJS_WORKER_METHOD}`) {
    return [];
  }
  const siblings = classMemberSymbols(context, owner);
  const anyProcess = siblings.some(
    (method) =>
      findDecorator(method.sites, [NESTJS_PROCESS_DECORATOR]) !== undefined,
  );
  return anyProcess
    ? []
    : [consume(symbol, context, ownerProcessor, undefined)];
}

function consume(
  symbol: ExtractedSymbol,
  context: PresetContext,
  processor: CodeSite,
  handler: CodeSite | undefined,
): MessageDetection {
  const argument = processor.args[0];
  const queue =
    readName(argument?.properties?.name ?? argument, context) ?? unnamed();
  const evidence =
    handler && handler !== processor
      ? `${siteLabel(processor)} + ${siteLabel(handler)}`
      : siteLabel(processor);
  const line = handler?.line ?? symbol.lineStart;
  return {
    ...detectionBase(
      symbol,
      context,
      NESTJS_PRESET_NAME,
      NESTJS_CONFIDENCE.queueConsume,
      line,
      evidence,
    ),
    kind: 'queue-consume',
    name: queue.name,
    dynamic: queue.dynamic,
  };
}

function message(
  symbol: ExtractedSymbol,
  context: PresetContext,
  site: CodeSite,
  kind: MessageDetection['kind'],
  name: NameReading,
  confidence: number,
  evidence: string,
): MessageDetection {
  return {
    ...detectionBase(
      symbol,
      context,
      NESTJS_PRESET_NAME,
      confidence,
      site.line,
      evidence,
    ),
    kind,
    name: name.name,
    dynamic: name.dynamic,
  };
}

function schedule(
  symbol: ExtractedSymbol,
  context: PresetContext,
  site: CodeSite,
  expression: string,
): ScheduleDetection {
  return {
    ...detectionBase(
      symbol,
      context,
      NESTJS_PRESET_NAME,
      NESTJS_CONFIDENCE.schedule,
      site.line,
      siteLabel(site),
    ),
    kind: 'schedule',
    expression,
  };
}

/** 이름 인자가 없을 때. 이름을 지어내지 않고 빈 이름의 동적 이름으로 남긴다 */
function unnamed(): NameReading {
  return { name: '', dynamic: true };
}

function readOrDynamic(names: NameReading[]): NameReading[] {
  return names.length > 0 ? names : [unnamed()];
}
