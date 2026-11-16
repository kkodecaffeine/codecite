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
