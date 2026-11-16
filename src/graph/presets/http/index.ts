// HTTP 탐지 프리셋 묶음. 설정 presets 의 이름으로 켠다. nestjs 는 GraphQL 쪽 nestjs 프리셋과 이름이 같아 레지스트리가 함께 켠다
import type { DetectionPreset } from '../../types.js';
import { AXIOS_PRESET } from './axios.js';
import { EXPRESS_PRESET } from './express.js';
import { FASTAPI_PRESET } from './fastapi.js';
import { FASTIFY_PRESET } from './fastify.js';
import { FETCH_PRESET } from './fetch.js';
import { FLASK_PRESET } from './flask.js';
import { NESTJS_HTTP_PRESET } from './nestjs.js';
import { NEXTJS_PRESET } from './nextjs.js';
import { PYTHON_REQUESTS_PRESET } from './python-requests.js';

export const HTTP_PRESETS: readonly DetectionPreset[] = [
  NESTJS_HTTP_PRESET,
  EXPRESS_PRESET,
  FASTIFY_PRESET,
  NEXTJS_PRESET,
  FASTAPI_PRESET,
  FLASK_PRESET,
  FETCH_PRESET,
  AXIOS_PRESET,
  PYTHON_REQUESTS_PRESET,
];

export { hostOf, joinHttpPaths, normalizeHttpPath } from './paths.js';
