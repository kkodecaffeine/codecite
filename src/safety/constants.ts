/** 근거·도구 결과 안에서 지시문으로 판단해 지운 줄 대신 넣는 글 */
export const EMBEDDED_INSTRUCTION_PLACEHOLDER = '[지시문 제거]';

/** 근거·도구 결과 안에서 지시문으로 보고 지울 줄. 사람이 쓴 코드 주석·정책 문장에는 나오지 않는 명령형만 고른다 */
export const EMBEDDED_INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /(?:ignore|disregard|forget|override)\W{0,12}(?:(?:all|any|the|your|my|every|these|of)\W{0,6}){0,3}(?:previous|prior|above|earlier|preceding|system|initial|original)\W{0,12}(?:instructions?|prompts?|rules?|guidelines?|directions?|messages?)/iu,
  /(?:^|\W)(?:system|assistant|ai|llm|model)\W{0,3}(?:instruction|note|override)?\W{0,3}:\W{0,6}(?:ignore|you\W{0,3}(?:are|must|should|will)|from\W{0,3}now|reveal|output|print|respond|이전|지금부터|너는|출력|무시|공개)/iu,
  /(?:이전|위|상위|기존|모든)\s*(?:지시|명령|규칙|프롬프트|지침)(?:사항|들)?(?:은|는|을|를|이|가|도)?\s*(?:모두|전부|다)?\s*(?:무시|잊|버리|해제|취소|무효|따르지)/u,
  /(?:지금부터|이제부터)\s*(?:너는|넌|당신은|네가|ai는|모델은)/u,
  /(?:system|developer|시스템)\s*(?:prompt|프롬프트|지시|instructions?)(?:을|를|의)?\s*.{0,16}?(?:reveal|print|output|show|dump|출력|공개|보여|알려)/iu,
  /(?:you\W{0,3}are\W{0,3}now|from\W{0,3}now\W{0,3}on\W{0,3}you|new\W{0,3}instructions?\W{0,3}:|pretend\W{0,3}(?:you\W{0,3}are|to\W{0,3}be)|do\W{0,3}anything\W{0,3}now|jailbreak)/iu,
  /<\|?(?:im_start|im_end|system|endoftext)\|?>|\[\/?INST\]|<<\/?SYS>>/u,
  /(?:assistant|ai|model)(?:는|은|가|이)?\s*(?:must|should|will|해야|반드시)\s*.{0,24}?(?:reveal|output|print|respond\W{0,3}with|include|출력|공개|포함|답)/iu,
];

/** 프롬프트 구분자로 쓰는 태그 꼴. 사용자 입력에서 이 꼴은 전각 꺾쇠로 바꾼다 */
export const PROMPT_DELIMITER_PATTERN =
  /<\/?[\p{L}_][\p{L}\p{N}_\s|:.-]{0,60}>|<\|[^|<>]{1,40}\|>|\[\/?INST\]|<<\/?SYS>>/giu;

/** 바꾼 낱말 뒤에 바로 붙어 있던 조사. 바꾼 낱말의 받침에 맞춰 다시 붙인다 */
export const PUBLIC_ANSWER_PARTICLE_PATTERN =
  /(은|는|이|가|을|를|과|와|으로|로)(?=\s|$|[,.!?。)\]])/u;

/** 백틱 안이 코드 식별자(camelCase, snake_case, Type.member, 호출)인지 */
export const CODE_IDENTIFIER_PATTERN =
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/u;

/**
 * 구현 타입으로 보는 이름의 끝말. 이 끝말로 끝나는 이름은 답에 내보내지 않는다
 * Exception·Store·Provider 처럼 제품·오류 이름과 겹치는 끝말은 넣지 않는다
 */
export const IMPLEMENTATION_TYPE_SUFFIXES: readonly string[] = [
  'Dto',
  'Entity',
  'Enum',
  'Service',
  'Repository',
  'Adapter',
  'Controller',
  'UseCase',
  'Usecase',
  'Port',
  'Resolver',
  'Module',
  'Guard',
  'Interceptor',
  'Strategy',
  'Reader',
  'Writer',
  'Handler',
  'Processor',
  'Consumer',
  'Producer',
  'Factory',
  'Manager',
  'Helper',
  'Gateway',
  'Client',
  'Mapper',
  'Validator',
  'Middleware',
  'Listener',
  'Subscriber',
  'Scheduler',
  'Worker',
  'Builder',
  'Presenter',
  'Router',
  'Policy',
  'Command',
  'Component',
  'Reducer',
  'Impl',
];

/** 역할 낱말 "내부 처리" 로 부르는 식별자 끝말 */
export const PROCESSING_IDENTIFIER_SUFFIX_PATTERN =
  /(?:Resolver|Service|Repository|Reader|Writer|Handler|Query|Mutation|Scheduler|Job)$/u;

/** 저장소 안 소스 경로로 보는 확장자 */
export const SOURCE_PATH_EXTENSIONS =
  'ts|tsx|js|jsx|mjs|cjs|swift|kt|kts|java|py|rb|go|sql|graphql|gql|json|ya?ml|env|csv|xml|plist|gradle|proto';

/** 폴더 없이 써도 소스 파일로 보는 확장자. 데이터 파일(json, csv 등)은 공개 출처 이름일 수 있어 뺀다 */
export const SOURCE_FILE_EXTENSIONS =
  'ts|tsx|js|jsx|mjs|cjs|swift|kt|kts|java|py|rb|go|sql|graphql|gql|env|plist|gradle|proto';

/** `이름.js` 꼴이어도 소스 파일이 아니라 제품 이름인 것 */
export const JS_PRODUCT_NAMES: readonly string[] = [
  'Node',
  'Next',
  'Nuxt',
  'Vue',
  'React',
  'Express',
  'Three',
  'Chart',
  'D3',
  'Ember',
  'Alpine',
  'Day',
];

/** 서버·개발 장비 절대 경로의 첫 폴더. API 경로(`/v1/orders`)와 가르려고 이 폴더로 시작할 때만 경로로 본다 */
export const ABSOLUTE_PATH_ROOTS =
  'Users|home|var|etc|opt|srv|tmp|root|app|workspace|private|usr|mnt';

/** 파일 경로·파일 이름을 가린 자리에 넣는 글 */
export const HIDDEN_PATH_TEXT = '[비공개 경로]';
export const HIDDEN_FILE_TEXT = '[비공개 파일]';

/** 답에 옮겨 적힌 claim id. 인용은 결과의 citations 로만 내보낸다 */
export const CLAIM_ID_PATTERN =
  /[([]?\b(?:knowledge-)?claim-[0-9a-f]{12,}\b[)\]]?/gu;

/** 프롬프트의 답변 형식 지시를 답에 옮겨 적은 줄머리 라벨 */
export const PROMPT_FORMAT_LABEL_PATTERN =
  /^([-*•]\s*)?(?:(?:첫|두|세|네|마지막)\s*(?:번째\s*)?(?:문장|항목)|결론\s*문장)\s*[:：]\s*/gmu;

/** 프롬프트의 말투 예시(`"~합니다"`)를 답 끝에 그대로 붙인 꼴 */
export const PROMPT_TEMPLATE_ECHO_PATTERN =
  /\s*["“”'‘’]~(?:합니다|됩니다|주세요|입니다)["“”'‘’]\.?$/gmu;
