// 목록·공식 문서 계약. "어떤 것들이 있나요?" 같은 질문은 검색 순위로 답하면 한도 안에 걸린 몇 개만 말하고 "그 밖에는 없다"로 끝나기 쉽다.
// 그래서 사람이 정한 목록을 코드 심볼과 맞춰 미리 만들고, 전체 항목과 개수로 답한다.
// 코드에서 출처를 찾지 못한 항목은 답의 근거에서 뺀다. 규칙에 맞는데 목록에 없는 새 후보는 숨기지 않고 알린다.
// 공식 정책 문서는 사람이 확정한 원문이다. 여기서 돌려준 근거도 다른 근거와 같은 묶기·답변 검사·정제를 지난다.
import type { PolicyEvidence } from '../generation/types.js';

/** 항목의 출처가 되는 코드 자리. 줄 번호 같은 위치는 목록을 만든 커밋 기준이다 */
export interface InventorySourceLocation {
  repository: string;
  filePath: string;
  symbol: string;
  lineStart?: number;
  /** 현재 심볼 산출물에 이 심볼이 아직 있는지. 사라졌다면 코드가 바뀐 것이니 근거로 쓰지 않는다 */
  resolved: boolean;
}

/** 목록 안의 묶음 */
export interface InventoryGroup {
  id: string;
  label: string;
}

export interface InventoryCategoryMember {
  name: string;
  label: string;
}

/** 고객이 직접 고르는 분류(예: 관심 카테고리). 코드의 열거형 정의에서 읽는다 */
export interface InventoryCategory {
  title: string;
  source: InventorySourceLocation;
  members: InventoryCategoryMember[];
}

/** 목록 항목 하나 */
export interface InventoryEntry {
  id: string;
  /** InventoryGroup 의 id */
  group: string;
  label: string;
  /** 고객에게 닿는 방식(화면 안내, 메일 등). 고객에게 닿는 항목이 아니면 비운다 */
  channel?: string;
  /** 항목이 생기거나 쓰이는 계기 */
  trigger: string;
  /** 항목이 나타나는 곳(서비스나 클라이언트 이름) */
  surface: string;
  /** categories 의 멤버와 짝지어지면 그 name */
  categoryMember?: string;
  sources: InventorySourceLocation[];
  /** sources 가운데 resolved 인 것이 하나라도 있는지 */
  resolved: boolean;
}

/** 규칙에는 맞는데 목록에도 무시 목록에도 없는 코드 자리. 새로 생긴 항목일 수 있다 */
export interface InventoryUncoveredCandidate {
  repository: string;
  filePath: string;
  symbol: string;
}

/** 주제 하나의 전체 목록 */
export interface Inventory {
  id: string;
  title: string;
  /** 이 목록을 꺼낼 질문인지 판단하는 정규식. 직렬화하려고 문자열로 둔다 */
  subjectPattern: string;
  /** 목록이 덮는 범위와 덮지 않는 범위 설명 */
  scopeNote: string;
  /** 답에서 항목을 부르는 이름 */
  itemNoun?: string;
  commitSha?: string;
  groups: InventoryGroup[];
  categories: InventoryCategory[];
  entries: InventoryEntry[];
  uncoveredCandidates: InventoryUncoveredCandidate[];
}

/** 목록 카탈로그 산출물 */
export interface InventoryCatalog {
  schemaVersion: 1;
  generatedAt: string;
  inventories: Inventory[];
}

/** 목록 카탈로그를 읽는다. 산출물이 없거나 읽지 못하면 undefined */
export interface InventoryCatalogSource {
  load(): Promise<InventoryCatalog | undefined>;
}

/** 질문에 맞는 공식 정책 문서 구절을 v0 근거 모양으로 찾는다. 맞는 구절이 없으면 빈 배열이다 */
export interface OfficialPolicyDocumentSource {
  lookup(question: string): Promise<PolicyEvidence[]>;
}
