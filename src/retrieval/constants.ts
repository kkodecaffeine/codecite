/** BM25 낱말 빈도 포화 세기와 문서 길이 보정 세기 */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/** RRF 순위 상수. 클수록 위 순위와 아래 순위의 점수 차이가 줄어든다 */
export const DEFAULT_RRF_CONSTANT = 60;

/** 근거 우선순위를 다시 매길 때 검색 순위를 이 크기의 구간으로 묶는다. 구간을 넘어 끌어올리지 않는다 */
export const RELEVANCE_BAND_SIZE = 5;

/** 근거 글에서 조건·비교·숫자·결정을 세어 구체적인 규칙을 단순 구조 설명보다 앞에 둔다 */
export const POLICY_CONDITION_PATTERN =
  /(조건|경우|대상|이상|이하|초과|미만|없으면|있으면|해야|제외|예외|만료|취소|회수|차감)/g;
export const POLICY_COMPARISON_PATTERN = /(===|!==|>=|<=|>|<|\bif\s*\()/g;
export const POLICY_NUMERIC_PATTERN =
  /\b\d+(?:[._,]\d+)*(?:%|원|건|일|시간|분)?\b/g;
export const POLICY_DECISION_PATTERN =
  /(적립|지급|선택|처리|사용|저장|반환|제한|최대|최소)/g;

/** 무엇을 입력·요청해야 하는지 묻는 질문. 입력 데이터 계약은 기술 근거가 답한다 */
export const INPUT_CONTRACT_QUERY_PATTERN =
  /(?=.*(?:입력|등록|요청|전송))(?=.*(?:데이터|정보|값|필드))(?=.*(?:필요|어떤|무슨))/i;

/** 기술 구현 근거를 열어야 하는 질문 신호. 하나라도 맞으면 기술 조각도 검색한다 */
export const TECHNICAL_QUERY_PATTERNS: readonly RegExp[] = [
  /\b(api|webhook|graphql|rest|endpoint|dto|cron|scheduler|worker|queue|payload|provider|model|runtime|environment|timeout|retry|controller|cli|dlq)\b/i,
  /(?:컬럼|칼럼|\bcolumns?\b)/i,
  /(웹훅|엔드포인트|외부\s*연동|연동(?:은|이|을|를)?\s*(어떻게|뭐|무엇|방식|구조|오류|실패)|운영\s*환경|로컬\s*환경|사용(?:하는)?\s*모델|재시도|스케줄러|크론|배치(?:는|가|를)?\s*(언제|작업|처리|주기|스케줄|실행)|메시지\s*큐|페이로드|상태\s*코드|인증\s*헤더|데이터베이스|DB\s*테이블|이벤트\s*(발행|처리|핸들러)|producer|consumer|프로듀서|컨슈머|로그(?:는|가|를)?\s*(어디|위치|확인|기록|남)|장애\s*(대응|처리)|타임아웃|명령어|큐(?:는|가|를|의)?\s*(상태|적재|대기|생성|발행|소비|처리)|대기\s*메시지)/i,
  INPUT_CONTRACT_QUERY_PATTERN,
];

/** 목록·종류·전체·받는 방법처럼 여러 claim 을 함께 보여야 하는 질문 */
export const BROAD_LIST_QUERY_PATTERN =
  /(뭐가\s*(?:있|가능)|무엇이\s*(?:있|가능)|어떤\s*(?:것|항목|혜택|정책|조건|예외)|종류|전체|전부|모두|다\s*(?:알려|말해)|아는\s*대로|정리|목록|리스트|항목|혜택(?:은|이|을|를)?\s*(?:뭐|무엇|알려|정리)?|어떻게\s*(?:받|얻|적립|참여)|(?:적립|지급)(?:은|는|이|가|을|를)?\s*(?:어떻게|방법|처리)|받는\s*(?:법|방법)|지급\s*조건|(?:받지?\s*못|안\s*되는?)\s*조건)/i;

/** 무엇을 어떻게 받거나 얻는지 묻는 질문 */
export const ACQUISITION_OVERVIEW_QUERY_PATTERN =
  /(?:어떻게.{0,20}(?:받|얻|적립|지급|참여)|(?:받|얻|적립|지급).{0,20}(?:조건|방법|어떻게|해야|하려면|수\s*있))/i;

/** "~란?", "~가 뭐야?", "~에 대해 알려줘" 처럼 질문 끝에서 대상의 개요를 묻는 말투 */
export const DOMAIN_OVERVIEW_QUERY_PATTERN =
  /(?:(?:(?:이란|란)(?:\s*(?:뭐|무엇))?|(?:이|가)\s*(?:뭐야|무엇인가요?)|무슨\s*서비스|어떤\s*서비스|서비스(?:야|인가요?|인지))|에\s*(?:대해|관해)(?:서)?\s*(?:알려\s*(?:줘|주세요)|설명\s*해?\s*(?:줘|주세요)|소개\s*해?\s*(?:줘|주세요)|안내\s*해?\s*(?:줘|주세요)))\s*[?.!]*$/i;

/** 개요 말투여도 구체적인 정책 사실을 묻는다는 낱말 */
export const POLICY_DETAIL_QUERY_PATTERN =
  /(?:조건|기준|대상|방법|절차|혜택|금액|비율|시점|기간|기한|만료일|예외|사유|횟수|수량)/u;

export const COMPARISON_QUERY_PATTERN =
  /(비교|차이|다른\s*점|같(?:은|아|나요)|동일|별개|versus|\bvs\.?\b)/i;

/** 값 하나를 콕 집어 묻는 질문. 목록 말투가 섞여 있어도 한 가지 사실에 맞춰 답한다 */
export const FOCUSED_QUERY_PATTERN =
  /(얼마|며칠|몇\s*(?:시|원|회|일|시간|분|개|건)|시간대|언제|만료일|날짜|시점|금액|API|엔드포인트|payload|페이로드|웹훅)/i;

/** 금액·비율·횟수·기간처럼 단위가 붙은 숫자 */
export const NUMERIC_FIGURE_QUERY_PATTERN =
  /(?:\d[\d,]*(?:\.\d+)?\s*(?:원|%|퍼센트|건|회|번|개|일|시간|분|개월|주|코인|포인트)|\d+\s*(?:만|천)\s*원?)/u;

/** 언제·어떤 경우에 필요하거나 적용되는지 묻는 질문. 시점이 아니라 적용 대상을 묻는다 */
export const ELIGIBILITY_WHEN_QUERY_PATTERN =
  /(?:(?:언제|어떤\s*(?:경우|때)|무슨\s*경우).{0,20}(?:필요|요구|해야|적용)|(?:필요|요구|적용).{0,20}(?:언제|경우|때))/i;

/** 무엇을 기준으로 판단·구분하는지 묻는 질문 */
export const DECISION_CRITERION_QUERY_PATTERN =
  /(?:기준|판단|구분|결정|분류|어떤\s*값|무슨\s*값|값으로|(?:여부.{0,20}(?:무엇|뭘|어떤\s*값|무슨\s*값|기준|판단|결정|구분|분류)|(?:무엇|뭘|어떤\s*값|무슨\s*값|기준|판단|결정|구분|분류).{0,20}여부))/i;

/** 기준이 아니라 누가 정했는지를 묻는 질문. 판단 기준 질문에서 뺀다 */
export const DECISION_OWNER_QUERY_PATTERN =
  /(?:누가|주체|담당|소유|owner|정했)/i;

/** 글·댓글을 쓰거나 올릴 수 있는지 묻는 이용 자격 질문 */
export const USER_ACTION_ELIGIBILITY_PATTERN =
  /(?:(?:게시판|게시글|게시물|글|댓글|답글).{0,24}(?:작성|쓰|쓸|남기|남길|남겨|올리|올릴|등록)|(?:작성|쓰|쓸|남기|남길|남겨|올리|올릴|등록).{0,24}(?:게시판|게시글|게시물|글|댓글|답글)).{0,20}(?:수\s*(?:있|없)|가능|불가|허용|해도\s*되|안\s*(?:돼|되))/u;

/**
 * 검색 순서로 받은 근거에서 질문 낱말을 가장 많이 덮는 high claim 근거 한 개를 근거 묶음 앞자리에 둔다
 * 기능 이름 하나만 겹치는 claim 은 고르지 않도록 덮은 낱말 수와 비율에 하한을 둔다
 */
export const ANCHOR_POLICY_EVIDENCE_SLOT_LIMIT = 1;
export const ANCHOR_POLICY_EVIDENCE_MIN_MATCHED_TERMS = 2;
export const ANCHOR_POLICY_EVIDENCE_MIN_COVERAGE = 0.5;

/** 질문 말투라 claim 과 겹쳐도 근거가 되지 않는 낱말 */
export const ANCHOR_QUESTION_FILLER_PATTERN =
  /^(?:몇|뭐|뭔|무엇|무슨|어떻게|어떤|언제|왜|어디|누가|수|좀|혹시|그럼|그러면|그런데|근데|그래서|그리고|또|또한|그거|그건|이건|가능.*|있.*|없.*|되.*|돼.*|하나요|해요|인가요|알려.*)$/u;

/**
 * 노출, 한도, 이용 자격을 묻는 질문은 high 정책 근거가 답의 바탕이라 근거 묶음 앞자리를 최대 이 개수만큼 정책 근거에 준다
 * 기준 근거(anchor) 를 먼저 두고, 검색 순서에서 질문 낱말을 하나라도 덮는 high claim 근거로 채운다
 */
export const POLICY_FIRST_EVIDENCE_SLOT_LIMIT = 3;
export const POLICY_FIRST_EVIDENCE_MIN_MATCHED_TERMS = 1;

/**
 * 실행 흐름 질문의 앞자리에 둘 절차 행 수. 환불·주문 취소처럼 여러 단계가 이어지는 흐름을 함께 보이려고 기준 근거보다 많이 둔다
 * 너무 적으면 즉시 처리 행과 그 하위 단계 행이 자리를 다 써서 나중에 도는 배치 행이 빠진다
 */
export const PROCEDURE_POLICY_EVIDENCE_SLOT_LIMIT = 6;
export const PROCEDURE_POLICY_EVIDENCE_MIN_MATCHED_TERMS = 2;

/** 모든 절차 행이 덮는 흐름 낱말. 절차 행을 고를 때 덮은 낱말 수에서 뺀다 */
export const PROCEDURE_GENERIC_QUESTION_TERM_PATTERN =
  /^(?:처리.*|순서.*|절차.*|흐름.*|프로세스.*|과정.*|방법.*|단계.*|진행.*|자세.*|정확.*)$/u;

/** 충분성 판정에서 답의 근거로 인정하는 claim 지식 종류. 내부 운영·구현 상세는 뺀다 */
export const USER_FACING_KNOWLEDGE_KINDS: ReadonlySet<string> = new Set([
  'product-capability',
  'user-policy',
  'partner-operation',
]);
