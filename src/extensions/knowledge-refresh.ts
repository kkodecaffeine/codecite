// 지식 갱신 계약. 갱신은 모든 답의 근거를 바꾸므로, 누가 언제 어느 커밋으로 했는지 좁히고 남겨야 한다.
// 허용된 사람만 시작한다. 진행 중인 갱신이 있으면 새로 시작하지 않는다.
// 저장소마다 원격 기본 브랜치의 최신 커밋을 반영된 커밋과 견줘 바뀐 것만 다시 만든다. 모두 같으면 바로 이미 최신이라고 답한다.
// 개발자 작업 트리는 쓰지 않는다. 요청에 비밀값을 싣지 않는다. 반영 전에 오프라인 검사와 회귀 검사를 통과해야 한다.
// 결과 보고에는 역할 이름과 커밋만 쓴다.

/** 갱신 명령. repositories 가 비면 등록된 저장소 전부다 */
export interface KnowledgeRefreshCommand {
  repositories: string[];
  /** 임베딩까지 새로 만들지. 끄면 그래프·심볼 같은 구조 산출물만 다시 만든다 */
  rebuildEmbeddings: boolean;
}

/** 실행기로 보내는 요청. 키·토큰 같은 비밀값은 싣지 않는다 */
export interface KnowledgeRefreshRequest extends KnowledgeRefreshCommand {
  /** 요청한 사람의 id. 실행기는 비어 있거나 허용 목록에 없으면 거절한다 */
  requestedBy: string;
  /** 진행과 결과를 알릴 곳. 붙이는 쪽이 정하는 불투명한 키(대화 스레드 등)다 */
  replyTo: string;
}

/** 갱신 실행 한 번 */
export interface KnowledgeRefreshRun {
  id: string;
  /** 사람이 진행 상황을 볼 수 있는 주소 */
  url: string;
  status: string;
  createdAt: string;
}

/** 시작 요청의 결과. 막 시작한 실행이 아직 조회되지 않으면 run 은 비고 statusUrl 로 따라가게 한다 */
export interface KnowledgeRefreshDispatchResult {
  run?: KnowledgeRefreshRun;
  statusUrl: string;
}

/** 원격 기본 브랜치 이름과 그 끝 커밋 */
export interface KnowledgeRefreshSourceCommit {
  branch: string;
  sha: string;
}

/** 지식 갱신 트리거. 진행 중인 실행을 보고, 최신 커밋을 묻고, 새 실행을 시작한다 */
export interface KnowledgeRefreshTrigger {
  /** 진행 중인 갱신. 없으면 undefined */
  activeRun(): Promise<KnowledgeRefreshRun | undefined>;
  latestCommit(repository: string): Promise<KnowledgeRefreshSourceCommit>;
  dispatch(
    request: KnowledgeRefreshRequest,
  ): Promise<KnowledgeRefreshDispatchResult>;
}
