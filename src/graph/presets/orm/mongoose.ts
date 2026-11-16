// Mongoose 문서 저장소: `new Schema({...}, { collection })`, NestJS `@Schema`·`@Prop` 클래스, `model('이름', 스키마)` 를 선언으로,
// 모델 호출(`OrderModel.updateOne`, `this.orderModel.find`)을 읽기·쓰기로, 갱신 연산자(`$set`, `$inc` …) 안의 키를 필드 쓰기로 찾는다
// 컬렉션 이름을 적지 않았으면 모델 이름을 그대로 표 이름으로 쓴다(복수형으로 바꾸는 일은 연결 단계 정규화에 맡긴다)
import type { EntityColumn } from '../../../extensions/code-knowledge.js';
import type {
  CodeSite,
  CodeSiteArgument,
  Detection,
  DetectionPreset,
  EntityDeclarationDetection,
  ExtractedSymbol,
  PresetContext,
} from '../../types.js';
import { SCRIPT_LANGUAGES } from '../messaging/constants.js';
import {
  derivedIndex,
  detectionBase,
  findDecorator,
  importsModule,
  leafName,
  memberDecorator,
  readStaticText,
  receiverMember,
  receiverOf,
  resolveLocalSymbol,
  siteLabel,
  typeArgument,
  typeLeaf,
} from '../messaging/support.js';
import {
  CLASS_NAME_PROPERTY,
  DOCUMENT_STORE,
  LOCAL_NAME_PATTERN,
  MONGOOSE_COLLECTION_OPTION,
  MONGOOSE_CONFIDENCE,
  MONGOOSE_ENUM_KEY,
  MONGOOSE_INJECT_MODEL_DECORATOR,
  MONGOOSE_MAX_FIELD_DEPTH,
  MONGOOSE_MODEL_FUNCTION,
  MONGOOSE_MODEL_TYPES,
  MONGOOSE_MODULE,
  MONGOOSE_PRESET_NAME,
  MONGOOSE_PROP_DECORATOR,
  MONGOOSE_READ_METHODS,
  MONGOOSE_REF_KEY,
  MONGOOSE_SCHEMA_CONSTRUCTOR,
  MONGOOSE_SCHEMA_DECORATOR,
  MONGOOSE_TYPE_KEY,
  MONGOOSE_UPDATE_ARGUMENT,
  MONGOOSE_WRITE_METHODS,
  MONGO_UPDATE_OPERATORS,
  NESTJS_MONGOOSE_MODULE,
} from './constants.js';
import { accessDetections, fieldWriteDetections } from './support.js';
import type {
  EntityAccess,
  EntityBinding,
  EntityRelationDraft,
  FieldWriteSource,
} from './types.js';

export const mongoosePreset: DetectionPreset = {
  name: MONGOOSE_PRESET_NAME,
  languages: SCRIPT_LANGUAGES,
  detect(symbol, context) {
    const found: Detection[] = [];
    const schemaClass = classDeclaration(symbol, context);
    if (schemaClass) {
      found.push(schemaClass);
    }
    if (importsModule(symbol, MONGOOSE_MODULE)) {
      for (const site of symbol.sites ?? []) {
        if (
          site.kind === 'new' &&
          leafName(site.name) === MONGOOSE_SCHEMA_CONSTRUCTOR
        ) {
          found.push(schemaDeclaration(symbol, site, context));
        }
      }
    }
    found.push(...modelDetections(symbol, context));
    return found;
  },
};

// ── 선언 ──

/** NestJS `@Schema({ collection })` 클래스와 `@Prop` 필드 */
function classDeclaration(
  symbol: ExtractedSymbol,
  context: PresetContext,
): EntityDeclarationDetection | undefined {
  const decorator = findDecorator(symbol.sites, [MONGOOSE_SCHEMA_DECORATOR]);
  const members = symbol.members;
  if (!decorator || !members) {
    return undefined;
  }
  const props = members.filter((member) =>
    memberDecorator(member, [MONGOOSE_PROP_DECORATOR]),
  );
  if (props.length === 0 && !importsModule(symbol, NESTJS_MONGOOSE_MODULE)) {
    return undefined;
  }
  const collection = readStaticText(
    decorator.args[0]?.properties?.[MONGOOSE_COLLECTION_OPTION],
    context,
  );
  const columns: EntityColumn[] = [];
  const relations: EntityRelationDraft[] = [];
  for (const member of props) {
    const prop = memberDecorator(member, [MONGOOSE_PROP_DECORATOR]) as CodeSite;
    describeField(
      member.name,
      prop.args[0],
      member.type,
      true,
      0,
      columns,
      relations,
    );
  }
  return {
    ...detectionBase(
      symbol,
      context,
      MONGOOSE_PRESET_NAME,
      MONGOOSE_CONFIDENCE.schema,
      decorator.line,
      `${siteLabel(decorator)} class ${symbol.symbol}`,
    ),
    kind: 'entity-declaration',
    table: collection ?? symbol.symbol,
    className: symbol.symbol,
    store: DOCUMENT_STORE,
    columns,
    relations,
  };
}

/** `new Schema({...}, { collection })`. 모델 이름은 같은 저장소의 `model('이름', 스키마)` 에서 찾는다 */
function schemaDeclaration(
  symbol: ExtractedSymbol,
  site: CodeSite,
  context: PresetContext,
): EntityDeclarationDetection {
  const collection = readStaticText(
    site.args[1]?.properties?.[MONGOOSE_COLLECTION_OPTION],
    context,
  );
  const inline = (symbol.sites ?? []).find(
    (candidate) =>
      isModelCall(candidate) &&
      candidate.line <= site.line &&
      candidate.args[1]?.identifier === undefined,
  );
  const model =
    inline?.args[0]?.literal ??
    modelIndex(context)?.bySchema.get(symbol.symbol);
  const className = model ?? symbol.symbol;
  const columns: EntityColumn[] = [];
  const relations: EntityRelationDraft[] = [];
  for (const [name, value] of Object.entries(site.args[0]?.properties ?? {})) {
    describeField(name, value, undefined, false, 0, columns, relations);
  }
  return {
    ...detectionBase(
      symbol,
      context,
      MONGOOSE_PRESET_NAME,
      MONGOOSE_CONFIDENCE.schema,
      site.line,
      `new ${site.name}(…)${model ? ` model ${model}` : ''}`,
    ),
    kind: 'entity-declaration',
    table: collection ?? className,
    className,
    store: DOCUMENT_STORE,
    columns,
    relations,
  };
}

/**
 * 스키마 필드 하나. 이름 하나(`String`)는 자료형, `{ type, enum, ref }` 는 정의, 배열은 원소 정의의 목록,
 * 정의 키가 없는 객체는 하위 문서라 `부모.자식` 으로 펼친다. definition 이 참이면(Prop 인자) 객체를 늘 정의로 본다
 */
function describeField(
  name: string,
  value: CodeSiteArgument | undefined,
  fallbackType: string | undefined,
  definition: boolean,
  depth: number,
  columns: EntityColumn[],
  relations: EntityRelationDraft[],
): void {
  if (value?.elements) {
    const inner = value.elements[0];
    const nested: EntityColumn[] = [];
    const innerRelations: EntityRelationDraft[] = [];
    describeField(name, inner, undefined, true, depth, nested, innerRelations);
    const itemType = nested[0]?.dataType;
    columns.push({ name, ...(itemType ? { dataType: `[${itemType}]` } : {}) });
    relations.push(
      ...innerRelations.map((relation) => ({
        ...relation,
        kind: 'one-to-many' as const,
      })),
    );
    return;
  }
  const properties = value?.properties;
  const isDefinition =
    definition ||
    (properties !== undefined &&
      [MONGOOSE_TYPE_KEY, MONGOOSE_REF_KEY, MONGOOSE_ENUM_KEY].some(
        (key) => key in properties,
      ));
  if (properties && !isDefinition) {
    if (depth + 1 >= MONGOOSE_MAX_FIELD_DEPTH) {
      columns.push({ name });
      return;
    }
    for (const [child, inner] of Object.entries(properties)) {
      describeField(
        `${name}.${child}`,
        inner,
        undefined,
        false,
        depth + 1,
        columns,
        relations,
      );
    }
    return;
  }
  const typeValue = properties ? properties[MONGOOSE_TYPE_KEY] : value;
  const dataType =
    typeValue?.elements !== undefined
      ? `[${typeValue.elements[0]?.identifier ?? typeValue.elements[0]?.text ?? ''}]`
      : (typeValue?.identifier ?? typeValue?.literal ?? fallbackType);
  const enumName = properties?.[MONGOOSE_ENUM_KEY]?.identifier;
  const ref = refTarget(properties?.[MONGOOSE_REF_KEY]);
  columns.push({
    name,
    ...(dataType !== undefined ? { dataType } : {}),
    ...(enumName !== undefined ? { enumName } : {}),
  });
  if (ref) {
    relations.push({
      targetClass: ref,
      kind: 'many-to-one',
      property: name,
      column: name,
    });
  }
}

/** ref 값(`'Member'`, `Member.name`) */
function refTarget(value: CodeSiteArgument | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value.literal !== undefined) {
    return value.literal || undefined;
  }
  return value.identifier?.endsWith(CLASS_NAME_PROPERTY)
    ? value.identifier.slice(0, -CLASS_NAME_PROPERTY.length)
    : undefined;
}

function isModelCall(site: CodeSite): boolean {
  return (
    site.kind === 'call' &&
    leafName(site.name) === MONGOOSE_MODEL_FUNCTION &&
    site.args[0]?.literal !== undefined &&
    site.args[1] !== undefined
  );
}

/** 같은 저장소의 `model('이름', 스키마)` 호출: 스키마 변수 → 모델 이름, 모델을 담은 상수 → 모델 이름 */
function modelIndex(context: PresetContext):
  | {
      bySchema: ReadonlyMap<string, string>;
      byVariable: ReadonlyMap<string, string>;
    }
  | undefined {
  return derivedIndex(context, 'mongoose.models', (index) => {
    const bySchema = new Map<string, string>();
    const byVariable = new Map<string, string>();
    for (const symbol of index.all) {
      if (
        !importsModule(symbol, MONGOOSE_MODULE) &&
        !(symbol.sites ?? []).some(isModelCall)
      ) {
        continue;
      }
      for (const site of symbol.sites ?? []) {
        if (!isModelCall(site)) {
          continue;
        }
        const model = site.args[0].literal as string;
        const schema = site.args[1].identifier;
        if (schema && !bySchema.has(schema)) {
          bySchema.set(schema, model);
        }
        if (
          symbol.kind === 'constant' &&
          !byVariable.has(`${symbol.filePath}\u0000${symbol.symbol}`)
        ) {
          byVariable.set(`${symbol.filePath}\u0000${symbol.symbol}`, model);
        }
      }
    }
    return { bySchema, byVariable };
  });
}

// ── 읽기·쓰기 ──

function modelDetections(
  symbol: ExtractedSymbol,
  context: PresetContext,
): Detection[] {
  const accesses: EntityAccess[] = [];
  const writes: FieldWriteSource[] = [];
  for (const site of symbol.sites ?? []) {
    if (site.kind !== 'call') {
      continue;
    }
    const operation = leafName(site.name);
    const read = MONGOOSE_READ_METHODS.includes(operation);
    if (!read && !MONGOOSE_WRITE_METHODS.includes(operation)) {
      continue;
    }
    const binding = modelBinding(symbol, receiverOf(site.name), context);
    if (!binding) {
      continue;
    }
    accesses.push({
      site,
      entity: binding.entity,
      kind: read ? 'entity-read' : 'entity-write',
      operation,
      via: binding.via,
      confidence: binding.confidence,
    });
    const index = MONGOOSE_UPDATE_ARGUMENT[operation];
    const update = index === undefined ? undefined : site.args[index];
    if (update) {
      writes.push(...updateSources(site, binding.entity, update, index === 0));
    }
  }
  return [
    ...accessDetections(symbol, context, MONGOOSE_PRESET_NAME, accesses),
    ...fieldWriteDetections(symbol, context, MONGOOSE_PRESET_NAME, writes),
  ];
}

/** 받는 쪽이 가리키는 모델. 주입 멤버(InjectModel, Model<X>)나 model(...) 을 담은 상수만 잇는다 */
function modelBinding(
  symbol: ExtractedSymbol,
  receiver: string | undefined,
  context: PresetContext,
): EntityBinding | undefined {
  if (receiver === undefined) {
    return undefined;
  }
  const member = receiverMember(symbol, receiver, context);
  if (member) {
    const inject = memberDecorator(member, [MONGOOSE_INJECT_MODEL_DECORATOR]);
    const injected = inject ? modelName(inject.args[0], context) : undefined;
    if (inject && injected) {
      return {
        entity: injected,
        via: siteLabel(inject),
        confidence: MONGOOSE_CONFIDENCE.modelAccess,
      };
    }
    const typed = MONGOOSE_MODEL_TYPES.includes(typeLeaf(member.type) ?? '')
      ? typeArgument(member.type)
      : undefined;
    return typed
      ? {
          entity: typed,
          via: `${member.name}: ${member.type}`,
          confidence: MONGOOSE_CONFIDENCE.modelAccess,
        }
      : undefined;
  }
  if (!LOCAL_NAME_PATTERN.test(receiver)) {
    return undefined;
  }
  const variable = resolveLocalSymbol(symbol, receiver, context);
  const model = variable
    ? modelIndex(context)?.byVariable.get(
        `${variable.filePath}\u0000${variable.symbol}`,
      )
    : undefined;
  return model
    ? {
        entity: model,
        via: `${receiver} = ${MONGOOSE_MODEL_FUNCTION}(${model})`,
        confidence: MONGOOSE_CONFIDENCE.modelAccess,
      }
    : undefined;
}

/** InjectModel 인자(`'Order'`, `Order.name`, 상수) */
function modelName(
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
): string | undefined {
  const ref = refTarget(argument);
  return ref ?? readStaticText(argument, context);
}

/** 갱신 문서의 필드. 연산자 키는 그 안의 키가 필드이고, 연산자가 아닌 키는 바로 필드다($set 과 같다) */
function updateSources(
  site: CodeSite,
  entity: string,
  update: CodeSiteArgument,
  document: boolean,
): FieldWriteSource[] {
  const base = {
    site,
    entity,
    writeKind: 'document-set' as const,
    confidence: MONGOOSE_CONFIDENCE.fieldWrite,
  };
  if (document) {
    return update.properties || update.elements
      ? [{ ...base, fields: update }]
      : [];
  }
  const sources: FieldWriteSource[] = [];
  const plain: Record<string, CodeSiteArgument> = {};
  for (const [key, value] of Object.entries(update.properties ?? {})) {
    if (MONGO_UPDATE_OPERATORS.includes(key)) {
      if (value.properties) {
        sources.push({ ...base, fields: value, operator: key });
      }
    } else if (!key.startsWith('$')) {
      plain[key] = value;
    }
  }
  if (Object.keys(plain).length > 0) {
    sources.unshift({
      ...base,
      fields: { text: update.text, properties: plain },
    });
  }
  return sources;
}
