// 설정 detectors 규칙을 탐지기로 바꾼다. 회사·팀마다 다른 큐 래퍼, 자체 데코레이터, HTTP 래퍼를 코드에 넣지 않고 설정으로 받는 자리다
// - call 규칙은 호출·생성 자리의 이름에, decorator 규칙은 데코레이터 자리의 이름에 맞춘다
//   이름이 같거나 멤버 연쇄의 뒤쪽이 같으면 맞는다(`orderQueue.send` 는 `this.orderQueue.send` 에도 맞는다)
// - nameArgument 번째 인자(없으면 첫 인자)에서 이름을 읽고, 상수 이름은 같은 저장소 상수로 푼다
// - 탐지기 이름은 `rule:<규칙 순번>`
import type {
  CodeSite,
  CodeSiteArgument,
  Detection,
  DetectionPreset,
  ExtractedSymbol,
  GraphDetectorRule,
  HttpCallDetection,
  PresetContext,
} from '../../types.js';
import { readUrl } from '../http/arguments.js';
import { ANY_HTTP_METHOD } from '../http/constants.js';
import {
  HTTP_METHOD_NAMES,
  RULE_CONFIDENCE,
  RULE_DEFAULT_NAME_ARGUMENT,
  RULE_DETECTOR_PREFIX,
  RULE_MESSAGE_KINDS,
  RULES_PRESET_NAME,
  RUNTIME_SCHEDULE,
} from './constants.js';
import {
  detectionBase,
  leafName,
  readName,
  siteLabel,
  splitArguments,
} from './support.js';
import type { NameReading } from './types.js';

/** 설정 규칙 목록으로 탐지기 하나를 만든다. 규칙이 없으면 아무것도 잡지 않는다 */
export function rulesPreset(
  rules: readonly GraphDetectorRule[],
): DetectionPreset {
  const ordered = rules.map((rule, index) => ({ rule, index }));
  return {
    name: RULES_PRESET_NAME,
    detect(symbol, context) {
      const found: Detection[] = [];
      for (const site of symbol.sites ?? []) {
        for (const { rule, index } of ordered) {
          if (matches(rule, site)) {
            found.push(
              detect(
                rule,
                `${RULE_DETECTOR_PREFIX}${index}`,
                symbol,
                site,
                context,
              ),
            );
          }
        }
      }
      return found;
    },
  };
}

function matches(rule: GraphDetectorRule, site: CodeSite): boolean {
  if (site.kind === 'decorator') {
    return rule.decorator !== undefined && sameName(site.name, rule.decorator);
  }
  if (site.kind === 'call' || site.kind === 'new') {
    return rule.call !== undefined && sameName(site.name, rule.call);
  }
  return false;
}

/** 이름이 같거나, 자리 이름이 `.규칙` 으로 끝난다 */
function sameName(siteName: string, ruleName: string): boolean {
  return siteName === ruleName || siteName.endsWith(`.${ruleName}`);
}

function detect(
  rule: GraphDetectorRule,
  detector: string,
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
): Detection {
  const argument = nameArgument(rule, symbol, site);
  const evidence = siteLabel(site);
  const base = detectionBase(
    symbol,
    context,
    detector,
    RULE_CONFIDENCE,
    site.line,
    evidence,
  );
  switch (rule.kind) {
    case 'queue-publisher':
    case 'queue-consumer':
    case 'event-publisher':
    case 'event-handler': {
      const name: NameReading = readName(argument, context) ?? {
        name: '',
        dynamic: true,
      };
      return {
        ...base,
        kind: RULE_MESSAGE_KINDS[rule.kind],
        name: name.name,
        dynamic: name.dynamic,
      };
    }
    case 'scheduler': {
      const value = readName(argument, context);
      return {
        ...base,
        kind: 'schedule',
        expression: value && !value.dynamic ? value.name : RUNTIME_SCHEDULE,
      };
    }
    case 'http-client':
      return { ...base, ...httpCall(site, argument, context) };
  }
}

function nameArgument(
  rule: GraphDetectorRule,
  symbol: ExtractedSymbol,
  site: CodeSite,
): CodeSiteArgument | undefined {
  const { positional } = splitArguments(site, symbol.language);
  return positional[rule.nameArgument ?? RULE_DEFAULT_NAME_ARGUMENT];
}

/**
 * HTTP 래퍼 호출. 메서드는 호출 끝 이름이 HTTP 메서드면 그것, 아니면 `*`
 * 주소는 HTTP 프리셋과 같은 규칙(readUrl)으로 읽어, 설정 규칙으로 찾은 호출과 프리셋이 찾은 호출의 경로 꼴을 맞춘다
 */
function httpCall(
  site: CodeSite,
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
): Pick<
  HttpCallDetection,
  'kind' | 'method' | 'path' | 'baseIdentifiers' | 'host' | 'dynamic'
> {
  const leaf = leafName(site.name).toLowerCase();
  const method = HTTP_METHOD_NAMES.includes(leaf)
    ? leaf.toUpperCase()
    : ANY_HTTP_METHOD;
  const target = readUrl(argument, context) ?? {
    baseIdentifiers: [],
    dynamic: true,
  };
  return {
    kind: 'http-call',
    method,
    ...(target.path !== undefined ? { path: target.path } : {}),
    baseIdentifiers: target.baseIdentifiers,
    ...(target.host !== undefined ? { host: target.host } : {}),
    dynamic: target.dynamic,
  };
}
