// Celery 작업(큐 구독), 작업 넣기(큐 발행), 주기 실행 표(예약 작업 + 발행)를 찾는다
// 큐 이름은 작업 이름이다. 보내는 쪽(send_task, delay, apply_async)과 받는 쪽이 같은 열쇠로 이어지도록 name= 이 있으면 그 값,
// 없으면 Celery 기본 규칙대로 모듈 경로와 함수 이름으로 만든다. queue= 는 근거에 적는다
import type {
  CodeSite,
  CodeSiteArgument,
  Detection,
  DetectionPreset,
  ExtractedSymbol,
  MessageDetection,
  PresetContext,
  ScheduleDetection,
} from '../../types.js';
import { WHOLE_MODULE_IMPORT } from '../../extractors/constants.js';
import {
  CELERY_ADD_PERIODIC_TASK_METHOD,
  CELERY_APP_CONSTRUCTOR,
  CELERY_BEAT_SCHEDULE_FIELD,
  CELERY_BEAT_SCHEDULE_KEY,
  CELERY_BEAT_TASK_KEY,
  CELERY_CONF_SEGMENT,
  CELERY_CONFIDENCE,
  CELERY_MODULE,
  CELERY_PRESET_NAME,
  CELERY_SCHEDULE_CALLS,
  CELERY_SEND_TASK_METHOD,
  CELERY_SHARED_TASK_DECORATOR,
  CELERY_SIGNATURE_PATTERN,
  CELERY_TASK_DECORATOR,
  CELERY_TASK_PUBLISH_METHODS,
  CELERY_UPDATE_METHOD,
  EXECUTABLE_KINDS,
  PYTHON_LANGUAGES,
  RUNTIME_SCHEDULE,
} from './constants.js';
import {
  detectionBase,
  importedNames,
  leafName,
  moduleFiles,
  namedImportLocal,
  pythonModulePath,
  readName,
  readPlainValue,
  receiverOf,
  resolveLocalSymbol,
  resolvePythonModule,
  siteLabel,
  splitArguments,
  symbolInFiles,
} from './support.js';
import type { CeleryTask, NameReading } from './types.js';

export const celeryPreset: DetectionPreset = {
  name: CELERY_PRESET_NAME,
  languages: PYTHON_LANGUAGES,
  detect(symbol, context) {
    const found: Detection[] = [];
    const task = celeryTask(symbol, context);
    if (task) {
      found.push(consumed(task, context));
    }
    for (const site of symbol.sites ?? []) {
      if (site.kind === 'call') {
        found.push(...callDetections(symbol, site, context));
      } else if (site.kind === 'assign' && isBeatScheduleName(site.name)) {
        found.push(...beatEntries(symbol, site, site.args[0], context));
      }
    }
    return found;
  },
};

/** 이 함수가 Celery 작업이면 그 이름과 큐 */
export function celeryTask(
  symbol: ExtractedSymbol,
  context: PresetContext,
): CeleryTask | undefined {
  if (!EXECUTABLE_KINDS.includes(symbol.kind)) {
    return undefined;
  }
  for (const site of symbol.sites ?? []) {
    if (site.kind !== 'decorator') {
      continue;
    }
    const confidence = taskDecoratorConfidence(symbol, site, context);
    if (confidence === undefined) {
      continue;
    }
    const { keywords } = splitArguments(site, symbol.language);
    const explicit = readName(keywords.name, context);
    const queue = readName(keywords.queue, context);
    return {
      symbol,
      name: explicit ?? {
        name: `${pythonModulePath(symbol.filePath)}.${symbol.symbol}`,
        dynamic: false,
      },
      defaultName: explicit === undefined,
      ...(queue ? { queue } : {}),
      line: site.line,
      confidence,
    };
  }
  return undefined;
}

/** 작업 데코레이터면 신뢰도. shared_task, 앱으로 확인한 `<앱>.task`, celery 에서 가져온 task */
function taskDecoratorConfidence(
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
): number | undefined {
  const leaf = leafName(site.name);
  const receiver = receiverOf(site.name);
  if (leaf === CELERY_SHARED_TASK_DECORATOR) {
    return CELERY_CONFIDENCE.task;
  }
  if (leaf !== CELERY_TASK_DECORATOR) {
    return undefined;
  }
  if (receiver === undefined) {
    return namedImportLocal(symbol, CELERY_MODULE, CELERY_TASK_DECORATOR) ===
      site.name
      ? CELERY_CONFIDENCE.task
      : undefined;
  }
  return isCeleryApp(symbol, receiver, context)
    ? CELERY_CONFIDENCE.task
    : CELERY_CONFIDENCE.unverifiedAppTask;
}

/** 이름이 같은 저장소에서 `Celery(…)` 로 만든 값인지 */
function isCeleryApp(
  symbol: ExtractedSymbol,
  name: string,
  context: PresetContext,
): boolean {
  const app = resolveLocalSymbol(symbol, name, context);
  return (app?.sites ?? []).some(
    (site) =>
      (site.kind === 'call' || site.kind === 'new') &&
      leafName(site.name) === CELERY_APP_CONSTRUCTOR,
  );
}

function consumed(task: CeleryTask, context: PresetContext): MessageDetection {
  const parts = [`task ${task.name.name}`];
  if (task.defaultName) {
    parts.push('(default name from module path)');
  }
  if (task.queue) {
    parts.push(`queue=${task.queue.name}`);
  }
  return {
    ...detectionBase(
      task.symbol,
      context,
      CELERY_PRESET_NAME,
      task.confidence,
      task.line,
      parts.join(' '),
    ),
    kind: 'queue-consume',
    name: task.name.name,
    dynamic: task.name.dynamic,
  };
}

function callDetections(
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
): Detection[] {
  const leaf = leafName(site.name);
  const receiver = receiverOf(site.name);
  const { positional, keywords } = splitArguments(site, symbol.language);
  if (CELERY_TASK_PUBLISH_METHODS.includes(leaf) && receiver !== undefined) {
    const target = resolveTask(symbol, receiver, context);
    if (!target) {
      return [];
    }
    const queue = readName(keywords.queue, context);
    const evidence = `${site.name}(…)${queue ? ` queue=${queue.name}` : ''}${target.via ? ` via ${target.via}` : ''}`;
    return [
      published(
        symbol,
        site,
        context,
        target.name,
        target.confidence,
        evidence,
      ),
    ];
  }
  if (leaf === CELERY_SEND_TASK_METHOD && receiver !== undefined) {
    const name = readName(positional[0] ?? keywords.name, context);
    return name
      ? [
          published(
            symbol,
            site,
            context,
            name,
            CELERY_CONFIDENCE.sendTask,
            siteLabel(site),
          ),
        ]
      : [];
  }
  if (leaf === CELERY_ADD_PERIODIC_TASK_METHOD) {
    return periodicTask(symbol, site, positional, keywords, context);
  }
  if (leaf === CELERY_UPDATE_METHOD && receiver !== undefined) {
    if (leafName(receiver) === CELERY_CONF_SEGMENT) {
      return beatEntries(
        symbol,
        site,
        keywords[CELERY_BEAT_SCHEDULE_KEY],
        context,
      );
    }
    if (isBeatScheduleName(receiver)) {
      return beatEntries(symbol, site, positional[0], context);
    }
  }
  return [];
}

/**
 * 작업 넣기 호출의 받는 쪽(`expire_coupon`, `tasks.expire_coupon`)을 작업 이름으로 푼다
 * 같은 저장소의 작업 심볼을 찾으면 그 이름, 찾지 못했지만 가져온 이름이면 모듈 경로로 만든 이름(낮은 신뢰도),
 * 같은 저장소에서 찾은 것이 작업이 아니면 Celery 호출이 아니므로 잡지 않는다
 */
function resolveTask(
  symbol: ExtractedSymbol,
  receiver: string,
  context: PresetContext,
): { name: NameReading; confidence: number; via?: string } | undefined {
  const segments = receiver.split('.');
  if (
    segments.length > 2 ||
    segments.some((segment) => !/^[A-Za-z_]\w*$/.test(segment))
  ) {
    return undefined;
  }
  const imported = importedNames(symbol).get(segments[0]);
  let found: ExtractedSymbol | undefined;
  /** 작업이 있는 모듈의 import 지정자 */
  let specifier: string | undefined;
  let name: string;
  if (segments.length === 1) {
    name = segments[0];
    found = resolveLocalSymbol(symbol, name, context);
    if (!found && imported && imported.imported !== WHOLE_MODULE_IMPORT) {
      specifier = imported.specifier;
      name = imported.imported;
    }
  } else {
    if (!imported) {
      return undefined;
    }
    // `from shop_worker import tasks` 의 tasks 는 하위 모듈, `import shop_worker.tasks as tasks` 는 모듈 그 자체
    specifier =
      imported.imported === WHOLE_MODULE_IMPORT
        ? imported.specifier
        : `${imported.specifier}${imported.specifier.endsWith('.') ? '' : '.'}${imported.imported}`;
    name = segments[1];
    found = symbolInFiles(
      context,
      moduleFiles(context, symbol.filePath, specifier),
      name,
    );
  }
  if (found) {
    const task = celeryTask(found, context);
    return task
      ? { name: task.name, confidence: CELERY_CONFIDENCE.boundPublish }
      : undefined;
  }
  if (specifier === undefined) {
    return undefined;
  }
  if (moduleFiles(context, symbol.filePath, specifier).length > 0) {
    // 같은 저장소의 모듈인데 그 이름의 작업이 없다
    return undefined;
  }
  return {
    name: {
      name: `${resolvePythonModule(symbol.filePath, specifier)}.${name}`,
      dynamic: false,
    },
    confidence: CELERY_CONFIDENCE.importedPublish,
    via: 'import path',
  };
}

function published(
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
  name: NameReading,
  confidence: number,
  evidence: string,
): MessageDetection {
  return {
    ...detectionBase(
      symbol,
      context,
      CELERY_PRESET_NAME,
      confidence,
      site.line,
      evidence,
    ),
    kind: 'queue-publish',
    name: name.name,
    dynamic: name.dynamic,
  };
}

function isBeatScheduleName(name: string): boolean {
  return leafName(name).toLowerCase().endsWith(CELERY_BEAT_SCHEDULE_KEY);
}

/** 주기 실행 표의 항목마다 예약 작업 하나와 그 작업 이름으로 넣는 발행 하나 */
function beatEntries(
  symbol: ExtractedSymbol,
  site: CodeSite,
  table: CodeSiteArgument | undefined,
  context: PresetContext,
): Detection[] {
  const entries = table?.properties;
  if (!entries) {
    return [];
  }
  const rebuild = scheduleRebuilder(symbol);
  const found: Detection[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    const task = readName(entry.properties?.[CELERY_BEAT_TASK_KEY], context);
    if (!task) {
      continue;
    }
    const expression = scheduleExpression(
      entry.properties?.[CELERY_BEAT_SCHEDULE_FIELD],
      rebuild,
      context,
    );
    const evidence = `${CELERY_BEAT_SCHEDULE_KEY}[${key}] → ${task.name}`;
    found.push(
      beatSchedule(symbol, site, context, expression, evidence),
      published(symbol, site, context, task, CELERY_CONFIDENCE.beat, evidence),
    );
  }
  return found;
}

/** add_periodic_task(주기, 작업.s(…), name=…) */
function periodicTask(
  symbol: ExtractedSymbol,
  site: CodeSite,
  positional: CodeSiteArgument[],
  keywords: Record<string, CodeSiteArgument>,
  context: PresetContext,
): Detection[] {
  const scheduleArgument = positional[0] ?? keywords.schedule;
  const signature = positional[1] ?? keywords.sig;
  const expression = scheduleExpression(
    scheduleArgument,
    scheduleRebuilder(symbol),
    context,
  );
  const receiver = signature
    ? CELERY_SIGNATURE_PATTERN.exec(signature.text)?.[1]
    : undefined;
  const task = receiver ? resolveTask(symbol, receiver, context) : undefined;
  const name: NameReading = task?.name ?? {
    name: signature?.text ?? '',
    dynamic: true,
  };
  const evidence = `${site.name}(…) → ${name.name}`;
  return [
    beatSchedule(symbol, site, context, expression, evidence),
    published(
      symbol,
      site,
      context,
      name,
      task?.confidence ?? CELERY_CONFIDENCE.beat,
      evidence,
    ),
  ];
}

function beatSchedule(
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
  expression: string,
  evidence: string,
): ScheduleDetection {
  return {
    ...detectionBase(
      symbol,
      context,
      CELERY_PRESET_NAME,
      CELERY_CONFIDENCE.beat,
      site.line,
      evidence,
    ),
    kind: 'schedule',
    expression,
  };
}

/**
 * 주기 값의 글. 숫자는 초 단위 주기이고, crontab(…) 같은 호출은 자리 인자의 문자열이 가려져 있어
 * 같은 심볼의 그 호출 자리(가린 글이 같은 것)를 차례로 짝지어 값을 다시 적는다. 짝이 없으면 가린 글 그대로다
 */
function scheduleExpression(
  argument: CodeSiteArgument | undefined,
  rebuild: (masked: string) => string | undefined,
  context: PresetContext,
): string {
  if (!argument) {
    return RUNTIME_SCHEDULE;
  }
  const plain = readPlainValue(argument, context);
  if (plain !== undefined) {
    return /^[\d_.]+$/.test(plain) ? `every ${plain}s` : plain;
  }
  if (argument.identifier !== undefined) {
    return RUNTIME_SCHEDULE;
  }
  return rebuild(argument.text) ?? argument.text;
}

function scheduleRebuilder(
  symbol: ExtractedSymbol,
): (masked: string) => string | undefined {
  const pending = (symbol.sites ?? [])
    .filter(
      (site) =>
        site.kind === 'call' &&
        CELERY_SCHEDULE_CALLS.includes(leafName(site.name)),
    )
    .map((site) => ({
      site,
      masked: `${site.name}(${site.args.map((argument) => argument.text).join(', ')})`,
    }));
  return (masked) => {
    const index = pending.findIndex((item) => item.masked === masked);
    if (index < 0) {
      return undefined;
    }
    const [{ site }] = pending.splice(index, 1);
    const { positional, keywords } = splitArguments(site, symbol.language);
    const parts = [
      ...positional.map((argument) => argument.literal ?? argument.text),
      ...Object.entries(keywords).map(
        ([key, value]) => `${key}=${value.literal ?? value.text}`,
      ),
    ];
    return `${site.name}(${parts.join(', ')})`;
  };
}
