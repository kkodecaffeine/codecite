// 데이터 그래프(엔티티 관계, 필드 쓰기 색인)와 결과 검사가 주고받는 모양
import type {
  EntityRelationGraph,
  FieldWriterIndex,
} from '../../extensions/code-knowledge.js';
import type { DataAccessDetection, GraphConfig } from '../types.js';

/** buildDataGraphArtifacts 가 돌려주는 결과 파일 이름 → 값 */
export interface DataGraphArtifacts {
  'entities.json': EntityRelationGraph;
  'field-writers.json': FieldWriterIndex;
}

/**
 * 엔티티 클래스 이름과 테이블 이름을 entities.json 의 테이블 이름(노드 이름)으로 푼다
 * 클래스 이름과 테이블 이름이 한 노드를 가리키게 해, 같은 테이블이 두 노드로 갈라지지 않게 한다
 */
export interface EntityTableResolver {
  /**
   * 엔티티 클래스 이름 → 테이블 이름. 같은 파일(주면), 같은 저장소, 모든 저장소 순서로 찾고
   * 처음 후보가 나온 범위에서 테이블이 정확히 하나일 때만 돌려준다. 없거나 여럿이면 undefined
   */
  resolveClass(
    repository: string,
    className: string,
    filePath?: string,
  ): string | undefined;
  /** 테이블 이름(대소문자 무시) → 노드의 테이블 이름. 저장소 종류가 달라 노드가 여럿이면 undefined */
  resolveTable(name: string): string | undefined;
  /**
   * 엔티티 읽기·쓰기 대상 → 테이블 이름. 토폴로지와 같은 규칙이다
   * - class: 선언한 테이블. 선언이 없으면 클래스 이름 그대로, 후보가 여럿이면 undefined
   * - table: 선언한 노드의 표기, 없으면 그대로
   * - key: 캐시 키라 엔티티가 아니다(undefined)
   */
  resolveTarget(
    repository: string,
    target: string,
    targetType: DataAccessDetection['targetType'],
  ): string | undefined;
}

/**
 * 결과 검사 종류
 * - missing: 있어야 할 파일이 없음
 * - shape: 계약 모양과 다름
 * - reference: 간선 끝·위치·심볼 id 가 가리키는 것이 없음
 * - manual-link: 수동 연결의 끝 심볼이 없음
 * - absolute-path: 만든 컴퓨터의 절대 경로가 남음
 * - secret: 비밀값 모양이 남음
 * - order: 정해진 순서·형식과 다름(손으로 고쳤거나 만든 도구가 결정적이지 않음)
 * - consistency: 파일 사이 값이 서로 맞지 않음(만든 시각, 저장소 목록)
 */
export type GraphValidationCheck =
  | 'missing'
  | 'shape'
  | 'reference'
  | 'manual-link'
  | 'absolute-path'
  | 'secret'
  | 'order'
  | 'consistency';

/** 검사에서 찾은 문제 하나. 메시지에 비밀값이나 절대 경로 원문을 싣지 않는다 */
export interface GraphValidationIssue {
  check: GraphValidationCheck;
  /** 결과 폴더 기준 파일 경로 */
  file: string;
  message: string;
}

export interface GraphValidationResult {
  /** errors 가 비었는지 */
  ok: boolean;
  errors: GraphValidationIssue[];
  warnings: GraphValidationIssue[];
}

export interface ValidateGraphOutputOptions {
  /** 주면 수동 연결 파일의 끝 심볼, 설정의 저장소 목록, 설정 폴더 경로가 결과에 남았는지도 본다 */
  config?: GraphConfig;
}

/** 코드 자리가 결과 안에 있는지. exact 는 레코드나 토폴로지 노드, file 은 같은 파일의 레코드만 있음 */
export type LocationPresence = 'exact' | 'file' | 'missing';
