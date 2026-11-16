// 큐·이벤트·예약 작업 프리셋의 이름표와 신뢰도
// 신뢰도는 탐지기마다 정한 고정값이다. 구문 자리 하나로 확정되는 것(데코레이터)이 가장 높고,
// 다른 심볼을 거쳐 이름을 잇는 것(주입 멤버, 가져온 작업)은 거친 단계만큼 낮춘다

/** TypeScript 추출기가 내는 언어 이름 */
export const SCRIPT_LANGUAGES: readonly string[] = ['typescript', 'javascript'];
export const PYTHON_LANGUAGES: readonly string[] = ['python'];

// ── NestJS ──

export const NESTJS_PRESET_NAME = 'nestjs';
/** 이벤트·메시지 처리기 데코레이터 */
export const NESTJS_EVENT_HANDLER_DECORATORS: readonly string[] = [
  'OnEvent',
  'EventPattern',
  'MessagePattern',
];
/** 예약 작업 데코레이터와 그 뜻 */
export const NESTJS_CRON_DECORATOR = 'Cron';
export const NESTJS_INTERVAL_DECORATOR = 'Interval';
export const NESTJS_TIMEOUT_DECORATOR = 'Timeout';
/** 프레임워크가 내주는 cron 식 열거형. 값을 못 풀어도 멤버 이름이 주기를 말해 주므로 그대로 적는다 */
export const NESTJS_CRON_EXPRESSION_ENUM = 'CronExpression';
/** Bull 식 큐 구독: 클래스의 큐 이름과 메서드의 작업 처리기 */
export const NESTJS_PROCESSOR_DECORATOR = 'Processor';
export const NESTJS_PROCESS_DECORATOR = 'Process';
/** 처리 데코레이터 없이 이 이름의 메서드 하나로 작업을 받는 꼴(작업자 기반 클래스) */
export const NESTJS_WORKER_METHOD = 'process';
/** 큐 주입 데코레이터와 그 큐에 작업을 넣는 메서드 */
export const NESTJS_INJECT_QUEUE_DECORATOR = 'InjectQueue';
export const NESTJS_QUEUE_PUBLISH_METHODS: readonly string[] = [
  'add',
  'addBulk',
];
/** 같은 프로세스 이벤트를 내는 주입 타입과 그 메서드 */
export const NESTJS_EVENT_EMITTER_TYPES: readonly string[] = [
  'EventEmitter2',
  'EventEmitter',
];
export const NESTJS_EVENT_EMIT_METHODS: readonly string[] = [
  'emit',
  'emitAsync',
];
/** 다른 서비스로 메시지를 보내는 주입 타입과 그 메서드 */
export const NESTJS_CLIENT_PROXY_TYPES: readonly string[] = ['ClientProxy'];
export const NESTJS_CLIENT_PROXY_METHODS: readonly string[] = ['emit', 'send'];

export const NESTJS_CONFIDENCE = {
  /** 처리기 데코레이터의 이름 인자 */
  eventHandler: 0.95,
  /** 주입 멤버의 타입으로 확인한 emit·send */
  eventPublish: 0.9,
  schedule: 0.95,
  /** 클래스 큐 이름 + 메서드 처리기 */
  queueConsume: 0.95,
  /** InjectQueue 로 묶인 멤버의 add */
  queuePublish: 0.9,
} as const;

// ── node-cron ──

export const NODE_CRON_PRESET_NAME = 'node-cron';
export const NODE_CRON_MODULE = 'node-cron';
export const NODE_CRON_SCHEDULE_FUNCTION = 'schedule';
/** 가져온 모듈의 schedule 호출 */
export const NODE_CRON_CONFIDENCE = 0.95;

// ── Celery ──

export const CELERY_PRESET_NAME = 'celery';
export const CELERY_MODULE = 'celery';
/** 앱 없이 쓰는 작업 데코레이터 */
export const CELERY_SHARED_TASK_DECORATOR = 'shared_task';
/** `<앱>.task` 의 끝 이름 */
export const CELERY_TASK_DECORATOR = 'task';
/** 앱을 만드는 생성자. 데코레이터 앞 이름이 이것으로 만든 값이면 앱으로 확인한다 */
export const CELERY_APP_CONSTRUCTOR = 'Celery';
/** 작업을 큐에 넣는 작업 메서드와 이름으로 넣는 앱 메서드 */
export const CELERY_TASK_PUBLISH_METHODS: readonly string[] = [
  'delay',
  'apply_async',
];
export const CELERY_SEND_TASK_METHOD = 'send_task';
/** 주기 실행 표: conf.update(beat_schedule=…), conf.beat_schedule.update(…), add_periodic_task(…) */
export const CELERY_BEAT_SCHEDULE_KEY = 'beat_schedule';
export const CELERY_CONF_SEGMENT = 'conf';
export const CELERY_UPDATE_METHOD = 'update';
export const CELERY_ADD_PERIODIC_TASK_METHOD = 'add_periodic_task';
/** 주기 실행 표 항목의 작업 이름·주기 키 */
export const CELERY_BEAT_TASK_KEY = 'task';
export const CELERY_BEAT_SCHEDULE_FIELD = 'schedule';
/** 작업 서명을 만드는 메서드(`expire_coupons.s()`). add_periodic_task 의 둘째 인자에서 작업을 읽는다 */
export const CELERY_SIGNATURE_PATTERN =
  /^([A-Za-z_][\w.]*)\.(?:s|si|signature)\(/;
/** 주기 값을 만드는 호출. 인자의 문자열은 가려져 있어 같은 자리의 호출 인자로 다시 적는다 */
export const CELERY_SCHEDULE_CALLS: readonly string[] = ['crontab', 'solar'];

export const CELERY_CONFIDENCE = {
  /** shared_task, 또는 앱으로 확인한 `<앱>.task` */
  task: 0.9,
  /** 앱인지 확인하지 못한 `<이름>.task` */
  unverifiedAppTask: 0.7,
  /** 같은 저장소의 작업 심볼로 이은 delay·apply_async */
  boundPublish: 0.9,
  /** 작업 심볼을 못 찾아 가져온 모듈 경로로 이름을 만든 delay·apply_async */
  importedPublish: 0.75,
  /** send_task 의 이름 인자 */
  sendTask: 0.9,
  beat: 0.9,
} as const;

// ── 설정 규칙 ──

export const RULES_PRESET_NAME = 'rules';
/** 탐지기 이름 머리. 결과의 detector 는 `rule:<순번>` */
export const RULE_DETECTOR_PREFIX = 'rule:';
/** 설정 규칙에 nameArgument 가 없을 때 읽는 인자 */
export const RULE_DEFAULT_NAME_ARGUMENT = 0;
/** 사람이 설정에 적은 규칙이라 자리 이름만 맞으면 높게 둔다 */
export const RULE_CONFIDENCE = 0.9;
/** 설정 규칙 종류 → 큐·이벤트 탐지 결과 종류 */
export const RULE_MESSAGE_KINDS = {
  'queue-publisher': 'queue-publish',
  'queue-consumer': 'queue-consume',
  'event-publisher': 'event-publish',
  'event-handler': 'event-handle',
} as const;
/** http-client 규칙에서 메서드로 읽는 호출 끝 이름 */
export const HTTP_METHOD_NAMES: readonly string[] = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
];

// ── 공통 ──

/** 예약 실행·작업 처리 대상이 될 수 있는 심볼 종류 */
export const EXECUTABLE_KINDS: readonly string[] = ['function', 'method'];
/** 정적으로 못 읽은 주기 */
export const RUNTIME_SCHEDULE = 'runtime';
/** 환경 변수 읽기 식별자의 머리. 상수로 풀지 않는다 */
export const ENV_IDENTIFIER_PREFIXES: readonly string[] = [
  'process.env.',
  'import.meta.env.',
  'os.environ.',
];
/** Python 키워드 인자 묶음의 원문 꼴(`name=…`, `**options`) */
export const PYTHON_KEYWORD_ARGUMENT_PATTERN = /^(?:\*\*|[A-Za-z_]\w*=(?!=))/;
/** Python 모듈 파일과 꾸러미 파일 */
export const PYTHON_MODULE_SUFFIX = '.py';
export const PYTHON_PACKAGE_FILE = '__init__';
/** IMPORTS 대상의 기본 내보내기 이름 */
export const DEFAULT_EXPORT_NAME = 'default';
/** 근거 글 길이 한도 */
export const MAX_EVIDENCE_LENGTH = 200;
