// 데이터 그래프 단계. 탐지 결과와 레코드로 entities.json(엔티티 관계)과 field-writers.json(필드 쓰기 색인)을 만들고,
// 결과 폴더 검사(validateGraphOutput)를 함께 내보낸다
import type { GraphBuildState } from '../types.js';
import { GRAPH_ENTITIES_FILE, GRAPH_FIELD_WRITERS_FILE } from './constants.js';
import { buildEntityRelationGraph } from './entities.js';
import { buildFieldWriterIndex } from './field-writers.js';
import type { DataGraphArtifacts } from './types.js';

/** 파이프라인이 저장소 안 토폴로지 뒤에 부른다. 돌려준 값을 이름 그대로 state.artifacts 에 넣는다 */
export function buildDataGraphArtifacts(
  state: GraphBuildState,
): DataGraphArtifacts {
  return {
    [GRAPH_ENTITIES_FILE]: buildEntityRelationGraph(state),
    [GRAPH_FIELD_WRITERS_FILE]: buildFieldWriterIndex(state),
  } as DataGraphArtifacts;
}

export {
  GRAPH_CROSS_REPOSITORY_FILE,
  GRAPH_ENTITIES_FILE,
  GRAPH_FIELD_WRITERS_FILE,
  GRAPH_REPORT_FILE,
  MAX_WRITERS_PER_FIELD,
} from './constants.js';
export {
  buildEntityRelationGraph,
  createEntityTableResolver,
  sortEntityGraph,
} from './entities.js';
export {
  buildFieldWriterIndex,
  pickAcrossModules,
  sortFieldWriterIndex,
} from './field-writers.js';
export { pluralize } from './naming.js';
export { validateGraphOutput } from './validate.js';
