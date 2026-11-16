// axios 호출 프리셋
// - 모듈 함수: `axios.get(url)`, `axios.post(url, data)`, `axios.request({ url, method })`, `axios({ url, method })`, `axios(url, config)`
// - 인스턴스: `axios.create({ baseURL })` 로 만든 이름을 같은 심볼·같은 클래스·같은 파일·가져온 파일에서 찾아 기준 주소를 경로 앞에 붙인다
// - 타입 표기로 아는 인스턴스: 클래스 멤버가 `AxiosInstance` 나 NestJS `HttpService` 면 기준 주소 없이 받는다(`this.http.axiosRef.get` 도)
import type {
  CodeSite,
  CodeSiteArgument,
  DetectionPreset,
  ExtractedSymbol,
  HttpCallDetection,
  PresetContext,
} from '../../types.js';
import { readMethod, readUrl, withBaseUrl } from './arguments.js';
import { callDetection } from './calls.js';
import {
  ANY_HTTP_METHOD,
  AXIOS_DEFAULT_NAME,
  AXIOS_FACTORIES,
  AXIOS_MODULES,
  AXIOS_REFERENCE_PROPERTY,
  AXIOS_REQUEST_METHOD,
  DEFAULT_EXPORT_NAME,
  DEFAULT_HTTP_METHOD,
  HTTP_VERBS,
  SCRIPT_LANGUAGES,
  WHOLE_MODULE_NAME,
} from './constants.js';
import { bindReceiver, callSites, importedName } from './repository.js';
import { splitMemberCall } from './routes.js';
import type { ReceiverBinding, UrlReading } from './types.js';

/** 본문(data) 인자를 받는 메서드. 설정 객체가 세 번째 인자다 */
const BODY_VERBS: readonly string[] = ['post', 'put', 'patch'];

export const AXIOS_PRESET: DetectionPreset = {
  name: 'axios',
  languages: SCRIPT_LANGUAGES,
  detect(symbol, context) {
    return callSites(symbol).flatMap((site) =>
      site.kind === 'call' ? axiosCall(symbol, site, context) : [],
    );
  },
};

function axiosCall(
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
): HttpCallDetection[] {
  const call = splitMemberCall(site.name);
  const receiver = call?.receiver ?? site.name;
  const member = call?.member ?? '';
  const request = readRequest(member, site, context);
  if (!request) {
    return [];
  }
  let binding: ReceiverBinding | undefined;
  let base: UrlReading | undefined;
  if (!isAxiosModule(symbol, receiver, context)) {
    // 인스턴스를 함수처럼 부르는 꼴은 드물고 일반 함수 호출과 갈라 볼 근거가 없어 보지 않는다
    if (member === '') {
      return [];
    }
    const instance = receiver.endsWith(`.${AXIOS_REFERENCE_PROPERTY}`)
      ? receiver.slice(0, -AXIOS_REFERENCE_PROPERTY.length - 1)
      : receiver;
    binding = bindReceiver(symbol, instance, site, AXIOS_FACTORIES, context);
    if (!binding) {
      return [];
    }
    base = readUrl(baseUrlOf(binding.site?.args[0]), context);
  }
  const reading = readUrl(request.url, context);
  if (!reading) {
    return [];
  }
  const configBase = readUrl(baseUrlOf(request.config), context);
  return [
    callDetection({
      symbol,
      site,
      detector: AXIOS_PRESET.name,
      method: request.method,
      reading: withBaseUrl(configBase ?? base, reading),
      ...(binding ? { binding } : {}),
      context,
    }),
  ];
}

/** axios 모듈 자체인지. 기본 이름이거나, axios 모듈의 기본·전체 가져오기 이름 */
function isAxiosModule(
  symbol: ExtractedSymbol,
  receiver: string,
  context: PresetContext,
): boolean {
  if (receiver === AXIOS_DEFAULT_NAME) {
    return true;
  }
  const binding = importedName(symbol, receiver, context);
  return (
    binding !== undefined &&
    AXIOS_MODULES.includes(binding.specifier) &&
    (binding.imported === DEFAULT_EXPORT_NAME ||
      binding.imported === WHOLE_MODULE_NAME)
  );
}

function baseUrlOf(
  config: CodeSiteArgument | undefined,
): CodeSiteArgument | undefined {
  return config?.properties?.baseURL;
}

/** 메서드 이름과 인자 꼴로 주소·메서드·설정 객체를 고른다. 요청이 아니면 undefined */
function readRequest(
  member: string,
  site: CodeSite,
  context: PresetContext,
):
  | { url: CodeSiteArgument; method: string; config?: CodeSiteArgument }
  | undefined {
  const [first, second, third] = site.args;
  if (!first) {
    return undefined;
  }
  if (HTTP_VERBS.includes(member)) {
    const config = BODY_VERBS.includes(member) ? third : second;
    return {
      url: first,
      method: member.toUpperCase(),
      ...(config ? { config } : {}),
    };
  }
  if (member !== AXIOS_REQUEST_METHOD && member !== '') {
    return undefined;
  }
  // 설정 객체 하나(`request({ url, method })`)이거나, 직접 부른 꼴의 (주소, 설정)
  const config = first.properties ? first : second;
  const url = first.properties ? first.properties.url : first;
  if (!url || (member === '' && !first.properties && !isAddress(first))) {
    return undefined;
  }
  const methodArgument = config?.properties?.method;
  return {
    url,
    method:
      methodArgument === undefined
        ? DEFAULT_HTTP_METHOD
        : (readMethod(methodArgument, context) ?? ANY_HTTP_METHOD),
    ...(config ? { config } : {}),
  };
}

/** 직접 부른 꼴의 첫 인자가 주소처럼 생겼는지(문자열이나 템플릿) */
function isAddress(argument: CodeSiteArgument): boolean {
  return argument.literal !== undefined || argument.template !== undefined;
}
