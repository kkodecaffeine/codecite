// 큐·이벤트·예약 작업 탐지 프리셋 묶음과 설정 규칙 탐지기
import type { DetectionPreset } from '../../types.js';
import { celeryPreset } from './celery.js';
import { nestjsMessagingPreset } from './nestjs.js';
import { nodeCronPreset } from './node-cron.js';

export { celeryPreset } from './celery.js';
export { nestjsMessagingPreset } from './nestjs.js';
export { nodeCronPreset } from './node-cron.js';
export { rulesPreset } from './rules.js';

/** 설정 presets 이름으로 켜는 큐·이벤트·예약 작업 프리셋. nestjs 는 같은 이름의 HTTP 프리셋과 등록표가 합친다 */
export const MESSAGING_PRESETS: readonly DetectionPreset[] = [
  nestjsMessagingPreset,
  nodeCronPreset,
  celeryPreset,
];
