// Prisma 모델 선언(스키마 심볼)과 클라이언트 호출(`prisma.order.update({ data })`)의 엔티티 읽기·쓰기, 필드 쓰기를 찾는다
// 클라이언트 접근자(`order`)는 같은 저장소 스키마의 모델 표로 모델 이름(`Order`)에 잇는다
// 저장소에 스키마가 없으면 받는 쪽 이름이 Prisma 클라이언트로 보일 때만 접근자 첫 글자를 대문자로 바꿔 모델 이름으로 쓴다(Prisma 의 접근자 규칙을 거꾸로 적용)
import type { EntityColumn } from '../../../extensions/code-knowledge.js';
import type {
  CodeSite,
  Detection,
  DetectionPreset,
  EntityDeclarationDetection,
  ExtractedSymbol,
  PresetContext,
} from '../../types.js';
import { SCRIPT_LANGUAGES } from '../messaging/constants.js';
import { derivedIndex, detectionBase, leafName } from '../messaging/support.js';
import {
  PRISMA_CLIENT_HINT,
  PRISMA_CONFIDENCE,
  PRISMA_DATA_KEYS,
  PRISMA_LANGUAGE,
  PRISMA_MAP_ATTRIBUTE,
  PRISMA_PRESET_NAME,
  PRISMA_READ_METHODS,
  PRISMA_RELATION_ATTRIBUTE,
  PRISMA_RELATION_FIELDS,
  PRISMA_SCALAR_TYPES,
  PRISMA_WRITE_METHODS,
} from './constants.js';
import {
  parsePrismaSchema,
  prismaAttribute,
  prismaList,
  prismaString,
} from './prisma-schema.js';
import { accessDetections, fieldWriteDetections } from './support.js';
import type {
  EntityAccess,
  FieldWriteSource,
  PrismaBlock,
  PrismaCatalog,
  PrismaField,
} from './types.js';

export const prismaPreset: DetectionPreset = {
  name: PRISMA_PRESET_NAME,
  languages: [PRISMA_LANGUAGE, ...SCRIPT_LANGUAGES],
  detect(symbol, context) {
    if (symbol.language === PRISMA_LANGUAGE) {
      const declaration = modelDeclaration(symbol, context);
      return declaration ? [declaration] : [];
    }
    return clientDetections(symbol, context);
  },
};

// ── 선언 ──

function blockOf(symbol: ExtractedSymbol): PrismaBlock | undefined {
  const [block] = parsePrismaSchema(symbol.content).blocks;
  return block?.name === symbol.symbol ? block : undefined;
}

/** 같은 저장소의 Prisma 모델·열거형 표 */
function catalog(context: PresetContext): PrismaCatalog | undefined {
  return derivedIndex(context, 'prisma.catalog', (index) => {
    const models = new Map<string, PrismaBlock>();
    const enums = new Set<string>();
    const accessors = new Map<string, string>();
    for (const symbol of index.all) {
      if (symbol.language !== PRISMA_LANGUAGE) {
        continue;
      }
      const block = blockOf(symbol);
      if (block?.keyword === 'enum') {
        enums.add(block.name);
      } else if (block?.keyword === 'model' || block?.keyword === 'view') {
        models.set(block.name, block);
        accessors.set(
          block.name.charAt(0).toLowerCase() + block.name.slice(1),
          block.name,
        );
      }
    }
    return { models, enums, accessors };
  });
}

function modelDeclaration(
  symbol: ExtractedSymbol,
  context: PresetContext,
): EntityDeclarationDetection | undefined {
  const block = blockOf(symbol);
  if (!block || (block.keyword !== 'model' && block.keyword !== 'view')) {
    return undefined;
  }
  const known = catalog(context);
  const mapped = prismaString(
    prismaAttribute(block.attributes, PRISMA_MAP_ATTRIBUTE)?.positional[0],
  );
  const columns: EntityColumn[] = [];
  const relations: EntityDeclarationDetection['relations'] = [];
  for (const field of block.fields) {
    if (isRelationField(field, known)) {
      relations.push(relationOf(block, field, known));
    } else {
      columns.push(columnOf(field, known));
    }
  }
  return {
    ...detectionBase(
      symbol,
      context,
      PRISMA_PRESET_NAME,
      PRISMA_CONFIDENCE.entity,
      symbol.lineStart,
      `${block.keyword} ${block.name}${mapped ? ` @@map(${mapped})` : ''}`,
    ),
    kind: 'entity-declaration',
    table: mapped ?? block.name,
    className: block.name,
    columns,
    relations,
  };
}

/** 다른 모델을 가리키는 필드. 표가 없으면 relation 속성이 있거나 기본 자료형이 아닌 목록일 때만 관계로 본다 */
function isRelationField(
  field: PrismaField,
  known: PrismaCatalog | undefined,
): boolean {
  if (PRISMA_SCALAR_TYPES.includes(field.type)) {
    return false;
  }
  if (known) {
    return known.models.has(field.type);
  }
  return (
    prismaAttribute(field.attributes, PRISMA_RELATION_ATTRIBUTE) !==
      undefined || field.list
  );
}

function columnOf(
  field: PrismaField,
  known: PrismaCatalog | undefined,
): EntityColumn {
  const mapped = prismaString(
    prismaAttribute(field.attributes, PRISMA_MAP_ATTRIBUTE)?.positional[0],
  );
  const enumName = known?.enums.has(field.type) ? field.type : undefined;
  return {
    name: mapped ?? field.name,
    dataType: field.list ? `${field.type}[]` : field.type,
    ...(field.comment ? { comment: field.comment } : {}),
    ...(enumName ? { enumName } : {}),
  };
}

/**
 * 관계 필드. fields 로 이쪽 컬럼을 적은 쪽은 상대가 이쪽을 목록으로 들고 있으면 many-to-one, 하나로 들고 있으면 one-to-one
 * 목록 필드는 상대도 목록이면 many-to-many, 아니면 one-to-many. fields 없는 단일 필드는 상대가 들고 있는 one-to-one 의 반대쪽이다
 */
function relationOf(
  block: PrismaBlock,
  field: PrismaField,
  known: PrismaCatalog | undefined,
): EntityDeclarationDetection['relations'][number] {
  const relation = prismaAttribute(field.attributes, PRISMA_RELATION_ATTRIBUTE);
  const [local] = prismaList(relation?.named[PRISMA_RELATION_FIELDS]);
  const back = known?.models
    .get(field.type)
    ?.fields.find(
      (item) => item.type === block.name && item.name !== field.name,
    );
  let kind: EntityDeclarationDetection['relations'][number]['kind'];
  if (field.list) {
    kind = back?.list ? 'many-to-many' : 'one-to-many';
  } else if (local !== undefined) {
    kind = back && !back.list ? 'one-to-one' : 'many-to-one';
  } else {
    kind = 'one-to-one';
  }
  const columnField =
    local !== undefined
      ? block.fields.find((item) => item.name === local)
      : undefined;
  const column = columnField
    ? (prismaString(
        prismaAttribute(columnField.attributes, PRISMA_MAP_ATTRIBUTE)
          ?.positional[0],
      ) ?? columnField.name)
    : local;
  return {
    targetClass: field.type,
    kind,
    property: field.name,
    ...(column !== undefined ? { column } : {}),
  };
}

// ── 클라이언트 ──

function clientDetections(
  symbol: ExtractedSymbol,
  context: PresetContext,
): Detection[] {
  const known = catalog(context);
  const accesses: EntityAccess[] = [];
  const writes: FieldWriteSource[] = [];
  for (const site of symbol.sites ?? []) {
    if (site.kind !== 'call') {
      continue;
    }
    const target = modelOf(site, known);
    if (!target) {
      continue;
    }
    const operation = leafName(site.name);
    const read = PRISMA_READ_METHODS.includes(operation);
    accesses.push({
      site,
      entity: target.model,
      kind: read ? 'entity-read' : 'entity-write',
      operation,
      via: target.via,
      confidence: target.confidence,
    });
    if (read) {
      continue;
    }
    const options = site.args[0]?.properties ?? {};
    for (const key of PRISMA_DATA_KEYS) {
      const fields = options[key];
      if (fields && (fields.properties || fields.elements)) {
        writes.push({
          site,
          entity: target.model,
          fields,
          writeKind: 'update-call',
          confidence: PRISMA_CONFIDENCE.fieldWrite,
        });
      }
    }
  }
  return [
    ...accessDetections(symbol, context, PRISMA_PRESET_NAME, accesses),
    ...fieldWriteDetections(symbol, context, PRISMA_PRESET_NAME, writes),
  ];
}

/** `<클라이언트>.<접근자>.<메서드>` 호출의 모델 */
function modelOf(
  site: CodeSite,
  known: PrismaCatalog | undefined,
): { model: string; via: string; confidence: number } | undefined {
  const segments = site.name.split('.');
  const operation = segments[segments.length - 1];
  if (
    segments.length < 3 ||
    (!PRISMA_READ_METHODS.includes(operation) &&
      !PRISMA_WRITE_METHODS.includes(operation))
  ) {
    return undefined;
  }
  const accessor = segments[segments.length - 2];
  const client = segments.slice(0, -2).join('.');
  if (known && known.accessors.size > 0) {
    const model = known.accessors.get(accessor);
    return model
      ? {
          model,
          via: `${client}.${accessor}`,
          confidence: PRISMA_CONFIDENCE.modelAccess,
        }
      : undefined;
  }
  if (
    !leafName(client).toLowerCase().includes(PRISMA_CLIENT_HINT) ||
    !/^[a-z]\w*$/.test(accessor)
  ) {
    return undefined;
  }
  return {
    model: accessor.charAt(0).toUpperCase() + accessor.slice(1),
    via: `${client}.${accessor} (no schema in repository)`,
    confidence: PRISMA_CONFIDENCE.clientAccess,
  };
}
