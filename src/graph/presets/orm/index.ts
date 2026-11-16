// ORM 엔티티·데이터 접근·필드 쓰기 탐지 프리셋 묶음과 Prisma 스키마 추출기
import type { DetectionPreset } from '../../types.js';
import { mongoosePreset } from './mongoose.js';
import { prismaPreset } from './prisma.js';
import { sqlalchemyPreset } from './sqlalchemy.js';
import { typeormPreset } from './typeorm.js';

export { mongoosePreset } from './mongoose.js';
export { prismaPreset } from './prisma.js';
export { parsePrismaSchema, prismaSchemaExtractor } from './prisma-schema.js';
export { sqlalchemyPreset } from './sqlalchemy.js';
export { typeormPreset } from './typeorm.js';

/** 설정 presets 이름으로 켜는 ORM 프리셋 */
export const ORM_PRESETS: readonly DetectionPreset[] = [
  typeormPreset,
  prismaPreset,
  mongoosePreset,
  sqlalchemyPreset,
];
