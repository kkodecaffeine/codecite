// node-cron 예약 작업. 이 모듈에서 가져온 이름의 schedule 호출만 잡는다(이름이 cron 이라는 것만으로 잡지 않는다)
// 등록 호출이 같은 저장소의 함수를 넘기면 그 함수가 예약 실행되는 심볼이고, 그 자리에서 쓴 함수 식이면 등록한 심볼이다
import type {
  CodeSite,
  DetectionPreset,
  ExtractedSymbol,
  PresetContext,
  ScheduleDetection,
} from '../../types.js';
import {
  EXECUTABLE_KINDS,
  NODE_CRON_CONFIDENCE,
  NODE_CRON_MODULE,
  NODE_CRON_PRESET_NAME,
  NODE_CRON_SCHEDULE_FUNCTION,
  RUNTIME_SCHEDULE,
  SCRIPT_LANGUAGES,
} from './constants.js';
import {
  detectionBase,
  moduleLocals,
  namedImportLocal,
  readStaticText,
  resolveLocalSymbol,
  siteLabel,
} from './support.js';

export const nodeCronPreset: DetectionPreset = {
  name: NODE_CRON_PRESET_NAME,
  languages: SCRIPT_LANGUAGES,
  detect(symbol, context) {
    const callees = scheduleCallees(symbol);
    if (callees.size === 0) {
      return [];
    }
    return (symbol.sites ?? [])
      .filter((site) => site.kind === 'call' && callees.has(site.name))
      .map((site) => scheduled(symbol, site, context));
  },
};

/** 이 심볼에서 node-cron 의 schedule 을 부르는 이름들(`cron.schedule`, `schedule`) */
function scheduleCallees(symbol: ExtractedSymbol): Set<string> {
  const callees = new Set(
    moduleLocals(symbol, NODE_CRON_MODULE).map(
      (local) => `${local}.${NODE_CRON_SCHEDULE_FUNCTION}`,
    ),
  );
  const named = namedImportLocal(
    symbol,
    NODE_CRON_MODULE,
    NODE_CRON_SCHEDULE_FUNCTION,
  );
  if (named) {
    callees.add(named);
  }
  return callees;
}

function scheduled(
  owner: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
): ScheduleDetection {
  const expression = readStaticText(site.args[0], context) ?? RUNTIME_SCHEDULE;
  const handlerName = site.args[1]?.identifier;
  const resolved =
    handlerName !== undefined
      ? resolveLocalSymbol(owner, handlerName, context)
      : undefined;
  const handler =
    resolved && EXECUTABLE_KINDS.includes(resolved.kind) ? resolved : undefined;
  const target = handler ?? owner;
  const evidence = handler
    ? `${siteLabel(site)} in ${owner.filePath}:${site.line}`
    : siteLabel(site);
  const line = handler ? handler.lineStart : site.line;
  return {
    ...detectionBase(
      target,
      context,
      NODE_CRON_PRESET_NAME,
      NODE_CRON_CONFIDENCE,
      line,
      evidence,
    ),
    kind: 'schedule',
    expression,
  };
}
