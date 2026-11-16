// 저장소 간 연결 단계의 상수. 회사·저장소에 묶인 표는 두지 않고, 어느 저장소 묶음에도 맞는 일반 규칙만 둔다
// 결과 파일 이름과 관계·까닭 목록은 결과 검사와 함께 쓰려고 data/constants.ts 에 둔 것을 쓴다
import type {
  CrossRepositoryRelation,
  RelationConfidence,
} from '../../extensions/code-knowledge.js';
import type { DetectionKind } from '../types.js';

/**
 * 실행이 이어지는 관계. 부르는(발행하는) 쪽과 처리하는 쪽이 있어 조건·예외 실행 사실과 handlerChain 을 단다
 * SHARES_* 는 같은 자원을 쓴다는 간접 관계이고 DEPENDS_ON_PACKAGE 는 코드 의존이라 달지 않는다
 */
export const EXECUTION_RELATIONS: readonly CrossRepositoryRelation[] = [
  'HTTP_CALLS',
  'GRAPHQL_CALLS',
  'PUBLISHES_TO_QUEUE',
  'CONSUMES_FROM_QUEUE',
  'PUBLISHES_EVENT',
  'HANDLES_EVENT',
  'CRON_TRIGGERS',
];

/** source 가 처리하는 쪽(구독자)이고 target 이 발행하는 쪽인 관계. 나머지 실행 관계는 source 가 부르는 쪽이다 */
export const HANDLER_SOURCE_RELATIONS: readonly CrossRepositoryRelation[] = [
  'CONSUMES_FROM_QUEUE',
  'HANDLES_EVENT',
];

/** 받는 쪽 계약(coverage)을 잇는 관계 */
export const PROVIDER_RELATIONS: readonly CrossRepositoryRelation[] = [
  'HTTP_CALLS',
  'GRAPHQL_CALLS',
];

/** 받는 쪽 계약으로 세는 탐지 */
export const PROVIDER_DETECTION_KINDS: readonly DetectionKind[] = [
  'http-route',
  'graphql-resolver',
];

/** 예약 작업이 저장소 안 호출을 따라 닿았을 때 CRON_TRIGGERS 로 이어 주는 관계(부르는 쪽이 예약 작업에서 닿은 심볼인 것) */
export const CRON_REACHABLE_RELATIONS: readonly CrossRepositoryRelation[] = [
  'HTTP_CALLS',
  'GRAPHQL_CALLS',
  'PUBLISHES_TO_QUEUE',
  'CONSUMES_FROM_QUEUE',
  'PUBLISHES_EVENT',
  'HANDLES_EVENT',
];

/**
 * 경로만으로는 어느 서비스의 처리기인지 알 수 없는 흔한 조각(대소문자 무시)
 * `/` 나 이 조각 하나뿐인 경로(`/health`), 매개변수 조각만 있는 경로(`/:param`)는 거의 모든 서비스에 있어,
 * 주소 변수·프록시 힌트로 대상 저장소를 정하지 않으면 잇지 않는다
 */
export const TRIVIAL_PATH_SEGMENTS: readonly string[] = [
  'health',
  'healthz',
  'healthcheck',
  'ping',
  'status',
  'ready',
  'readyz',
  'live',
  'livez',
  'alive',
  'metrics',
  'version',
  'info',
];

/**
 * 큐·이벤트 이름이 정규화한 뒤 이 낱말 하나뿐이면 어느 큐인지 말해 주지 않으므로 잇지 않는다
 * 이름이 같다는 것만으로 서로 다른 큐를 잇는 오탐을 막는다
 */
export const GENERIC_MESSAGE_NAMES: readonly string[] = [
  'queue',
  'queues',
  'event',
  'events',
  'job',
  'jobs',
  'task',
  'tasks',
  'message',
  'messages',
  'topic',
  'topics',
  'default',
  'main',
];

/** 주소 변수 이름 앞의 환경 변수 읽기 꼴. 떼고 hints.baseUrls·hints.external 의 이름과 맞춘다 */
export const ENV_IDENTIFIER_PREFIXES: readonly string[] = [
  'process.env.',
  'os.environ.',
  'import.meta.env.',
];

/** 처리하는 쪽에서 저장소 안 CALLS 를 따라가는 깊이와 handlerChain 에 남기는 심볼 수 */
export const HANDLER_CHAIN_MAX_DEPTH = 3;
export const HANDLER_CHAIN_MAX_SYMBOLS = 12;
/** 예약 작업에서 저장소 간 호출까지 저장소 안 CALLS 를 따라가는 깊이 */
export const CRON_MAX_DEPTH = 3;

/**
 * 탐지 신뢰도(0~1)가 허락하는 가장 높은 관계 신뢰도. 탐지기가 정한 값에서 시작해 힌트 여부로 high·medium 을 고른다
 * 연결에 쓴 탐지 가운데 가장 낮은 값이 HIGH 아래면 medium 까지, MEDIUM 아래면 low 다
 */
export const LINK_HIGH_DETECTION_FLOOR = 0.75;
export const LINK_MEDIUM_DETECTION_FLOOR = 0.5;
/** 관계 신뢰도 높낮이 */
export const RELATION_CONFIDENCE_RANK: Readonly<
  Record<RelationConfidence, number>
> = { low: 0, medium: 1, high: 2 };

/** 수동 연결 한 줄에 쓸 수 있는 키 */
export const MANUAL_LINK_KEYS: readonly string[] = [
  'relation',
  'from',
  'to',
  'evidence',
  'author',
];
export const MANUAL_LINK_END_KEYS: readonly string[] = [
  'repository',
  'filePath',
  'symbol',
];

/** 패키지 진입 파일을 찾는 저장소 안 폴더(맨 위, src, lib). 그 폴더의 index·__init__ 파일을 진입 파일로 본다 */
export const PACKAGE_ENTRY_FOLDERS: readonly string[] = ['.', 'src', 'lib'];
/** 못 이은 비율을 남길 때 소수 자리 */
export const UNRESOLVED_RATIO_DIGITS = 4;
