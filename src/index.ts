/** 패키지 버전. 공개 API 가 채워지기 전까지 빌드와 배포 경로를 확인하는 데 쓴다 */
export const version = '0.0.0';

export type * from './extensions/index.js';
export {
  DEFAULT_RESEARCH_BUDGET,
  DEFAULT_RESEARCH_PACKING,
  RESEARCH_FINISH_TOOL_NAME,
  RESEARCH_TOOL_NAMES,
} from './extensions/index.js';
