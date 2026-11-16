// ORM 프리셋이 주고받는 모양
import type { FieldWriteKind } from '../../../extensions/code-knowledge.js';
import type {
  CodeSite,
  CodeSiteArgument,
  EntityDeclarationDetection,
} from '../../types.js';

/** 엔티티 선언에 담는 관계 하나 */
export type EntityRelationDraft =
  EntityDeclarationDetection['relations'][number];

/** 엔티티를 읽거나 쓰는 호출 하나와 그 엔티티를 알아낸 길 */
export interface EntityAccess {
  site: CodeSite;
  entity: string;
  kind: 'entity-read' | 'entity-write';
  /** 호출 끝 이름(`update`, `findOneBy`) */
  operation: string;
  /** 엔티티를 알아낸 길(`@InjectRepository(Order)`, `Repository<Order>`, `getRepository(Order)`) */
  via: string;
  confidence: number;
}

/** 필드 쓰기 하나를 만드는 재료 */
export interface FieldWriteSource {
  site: CodeSite;
  entity: string;
  /** 바꿀 필드 묶음(객체 인자) */
  fields: CodeSiteArgument;
  writeKind: FieldWriteKind;
  confidence: number;
  /** 값 앞에 붙이는 연산 이름(`$inc`) */
  operator?: string;
}

/** 받는 쪽 이름 하나가 가리키는 엔티티 */
export interface EntityBinding {
  entity: string;
  via: string;
  confidence: number;
}

// ── Prisma 스키마 ──

/** Prisma 블록의 속성 하나(`@map("member_id")`, `@@map("orders")`). 이름에는 `@` 를 붙이지 않는다 */
export interface PrismaAttribute {
  name: string;
  /** 위치 인자 원문 */
  positional: string[];
  /** 이름 붙은 인자(`fields: [memberId]`) 원문 */
  named: Record<string, string>;
}

export interface PrismaField {
  name: string;
  /** `?`·`[]` 를 뗀 타입 이름 */
  type: string;
  list: boolean;
  optional: boolean;
  line: number;
  attributes: PrismaAttribute[];
  /** 바로 위 `///` 설명 */
  comment?: string;
}

export type PrismaBlockKeyword = 'model' | 'view' | 'enum' | 'type';

/** 스키마 파일의 model·view·enum·type 블록 하나 */
export interface PrismaBlock {
  keyword: PrismaBlockKeyword;
  name: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  description?: string;
  fields: PrismaField[];
  /** 블록 속성(`@@map`, `@@index`) */
  attributes: PrismaAttribute[];
}

export interface PrismaParseResult {
  blocks: PrismaBlock[];
  /** 블록을 닫지 못한 줄 같은 문법 오류. 있으면 그 파일을 건너뛴다 */
  error?: string;
}

/** 저장소의 Prisma 모델·열거형 표. 클라이언트 접근자(`order`)로 모델 이름(`Order`)을 찾는다 */
export interface PrismaCatalog {
  models: ReadonlyMap<string, PrismaBlock>;
  enums: ReadonlySet<string>;
  /** 접근자 → 모델 이름 */
  accessors: ReadonlyMap<string, string>;
}

// ── SQLAlchemy ──

/** SQLAlchemy 매핑 클래스 하나를 같은 파일의 속성 심볼로 모은 것 */
export interface SqlAlchemyModel {
  className: string;
  table?: string;
  /** 표 이름을 코드에서 읽었는지(아니면 클래스 이름을 그대로 쓴다) */
  tableDeclared: boolean;
  /** 속성 이름 → 그 속성 심볼의 자리 */
  attributes: ReadonlyMap<string, readonly CodeSite[]>;
}
