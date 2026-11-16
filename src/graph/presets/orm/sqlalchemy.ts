// SQLAlchemy 매핑 클래스(`__tablename__`, `Column(...)`, `ForeignKey('t.c')`, `relationship('X')`)와
// 세션·문장 생성 함수로 엔티티를 읽고 쓰는 자리, 필드 쓰기(쿼리 갱신, 생성자 키워드, 읽어 온 엔티티의 속성 대입)를 찾는다
// Python 클래스는 멤버 목록이 없어 같은 파일의 `<클래스>.<속성>` 심볼을 모아 매핑을 읽는다. 다른 심볼을 볼 수 없으면 선언은 내지 않는다
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
import { EXECUTABLE_KINDS, PYTHON_LANGUAGES } from '../messaging/constants.js';
import {
  classMemberSymbols,
  derivedIndex,
  detectionBase,
  leafName,
  moduleLocals,
  namedImportLocal,
  readStaticText,
  receiverOf,
  splitArguments,
} from '../messaging/support.js';
import {
  SQLALCHEMY_COLUMN_CALLS,
  SQLALCHEMY_CONFIDENCE,
  SQLALCHEMY_CONSTRUCT_OPERATION,
  SQLALCHEMY_ENUM_CALL,
  SQLALCHEMY_FOREIGN_KEY_CALL,
  SQLALCHEMY_GET_METHOD,
  SQLALCHEMY_PRESET_NAME,
  SQLALCHEMY_QUERY_METHOD,
  SQLALCHEMY_QUERY_WRITE_STEPS,
  SQLALCHEMY_RELATIONSHIP_CALL,
  SQLALCHEMY_SELECT_FUNCTION,
  SQLALCHEMY_SESSION_NAME,
  SQLALCHEMY_SESSION_WRITE_METHODS,
  SQLALCHEMY_SINGLE_RESULT_STEPS,
  SQLALCHEMY_STATEMENT_MODULES,
  SQLALCHEMY_STATEMENT_WRITE_FUNCTIONS,
  SQLALCHEMY_TABLE_ATTRIBUTE,
  SQLALCHEMY_TABLE_CONSTRUCTOR,
  SQLALCHEMY_TABLE_OBJECT_ATTRIBUTE,
  SQLALCHEMY_VALUES_STEP,
} from './constants.js';
import {
  accessDetections,
  assignmentWrites,
  chainStep,
  fieldWriteDetections,
  isClassName,
  singleEntityLocals,
} from './support.js';
import type {
  EntityAccess,
  EntityRelationDraft,
  FieldWriteSource,
  SqlAlchemyModel,
} from './types.js';

export const sqlalchemyPreset: DetectionPreset = {
  name: SQLALCHEMY_PRESET_NAME,
  languages: PYTHON_LANGUAGES,
  detect(symbol, context) {
    const found: Detection[] = [];
    const models = modelIndex(context);
    const model =
      symbol.kind === 'class' ? readModel(symbol, context) : undefined;
    if (model) {
      found.push(declaration(symbol, model, models ?? new Map(), context));
    }
    if (EXECUTABLE_KINDS.includes(symbol.kind) || symbol.kind === 'module') {
      found.push(...accessAndWrites(symbol, context, models));
    }
    return found;
  },
};

// ── 선언 ──

/** 같은 저장소의 매핑 클래스 이름 → 매핑 */
function modelIndex(
  context: PresetContext,
): ReadonlyMap<string, SqlAlchemyModel> | undefined {
  return derivedIndex(context, 'sqlalchemy.models', (index) => {
    const models = new Map<string, SqlAlchemyModel>();
    for (const symbol of index.all) {
      if (
        !PYTHON_LANGUAGES.includes(symbol.language) ||
        symbol.kind !== 'class' ||
        models.has(symbol.symbol)
      ) {
        continue;
      }
      const model = readModel(symbol, context);
      if (model) {
        models.set(symbol.symbol, model);
      }
    }
    return models;
  });
}

function readModel(
  symbol: ExtractedSymbol,
  context: PresetContext,
): SqlAlchemyModel | undefined {
  const attributes = new Map<string, readonly CodeSite[]>();
  for (const member of classMemberSymbols(context, symbol)) {
    const name = member.symbol.slice(symbol.symbol.length + 1);
    if (!name.includes('.')) {
      attributes.set(name, member.sites ?? []);
    }
  }
  const mapped = [...attributes.values()].some((sites) =>
    sites.some(
      (site) =>
        site.kind === 'call' &&
        [...SQLALCHEMY_COLUMN_CALLS, SQLALCHEMY_RELATIONSHIP_CALL].includes(
          leafName(site.name),
        ),
    ),
  );
  const tableSites = attributes.get(SQLALCHEMY_TABLE_ATTRIBUTE);
  if (!mapped && !tableSites) {
    return undefined;
  }
  const assigned = tableSites?.find((site) => site.kind === 'assign')?.args[0];
  const tableObject = attributes
    .get(SQLALCHEMY_TABLE_OBJECT_ATTRIBUTE)
    ?.find(
      (site) =>
        site.kind === 'call' &&
        leafName(site.name) === SQLALCHEMY_TABLE_CONSTRUCTOR,
    );
  const table =
    assigned?.literal ??
    context.resolveConstant(`${symbol.symbol}.${SQLALCHEMY_TABLE_ATTRIBUTE}`) ??
    tableObject?.args[0]?.literal;
  return {
    className: symbol.symbol,
    ...(table !== undefined ? { table } : {}),
    tableDeclared: table !== undefined,
    attributes,
  };
}

function declaration(
  symbol: ExtractedSymbol,
  model: SqlAlchemyModel,
  models: ReadonlyMap<string, SqlAlchemyModel>,
  context: PresetContext,
): EntityDeclarationDetection {
  const columns: EntityColumn[] = [];
  const foreignKeys: Array<{
    column: string;
    table?: string;
    targetClass?: string;
  }> = [];
  const relationships: Array<{ property: string; site: CodeSite }> = [];
  for (const [name, sites] of model.attributes) {
    if (name.startsWith('__')) {
      continue;
    }
    const relationship = sites.find(
      (site) =>
        site.kind === 'call' &&
        leafName(site.name) === SQLALCHEMY_RELATIONSHIP_CALL,
    );
    if (relationship) {
      relationships.push({ property: name, site: relationship });
      continue;
    }
    const column = sites.find(
      (site) =>
        site.kind === 'call' &&
        SQLALCHEMY_COLUMN_CALLS.includes(leafName(site.name)),
    );
    if (!column) {
      continue;
    }
    const described = describeColumn(name, column, sites, context);
    columns.push(described);
    const foreignKey = sites.find(
      (site) =>
        site.kind === 'call' &&
        leafName(site.name) === SQLALCHEMY_FOREIGN_KEY_CALL,
    );
    const target = foreignKey
      ? foreignKeyTarget(foreignKey.args[0], context)
      : undefined;
    if (target) {
      foreignKeys.push({ column: described.name, ...target });
    }
  }
  const classOfTable = (table: string | undefined): string | undefined =>
    table === undefined
      ? undefined
      : [...models.values()].find((item) => item.table === table)?.className;
  const tableOfClass = (className: string): string | undefined =>
    models.get(className)?.table;
  const relations: EntityRelationDraft[] = [];
  const usedColumns = new Set<string>();
  for (const { property, site } of relationships) {
    const { positional, keywords } = splitArguments(site, symbol.language);
    const target = relationshipTarget(positional[0] ?? keywords.argument);
    if (!target) {
      continue;
    }
    const targetTable = tableOfClass(target);
    const foreignKey = foreignKeys.find(
      (item) =>
        item.targetClass === target ||
        (targetTable !== undefined && item.table === targetTable),
    );
    let kind: EntityRelationDraft['kind'];
    if (keywords.secondary) {
      kind = 'many-to-many';
    } else if (keywords.uselist?.text === 'False') {
      kind = 'one-to-one';
    } else {
      kind = foreignKey ? 'many-to-one' : 'one-to-many';
    }
    if (foreignKey && kind !== 'many-to-many') {
      usedColumns.add(foreignKey.column);
    }
    relations.push({
      targetClass: target,
      kind,
      property,
      ...(foreignKey && kind !== 'many-to-many'
        ? { column: foreignKey.column }
        : {}),
    });
  }
  for (const foreignKey of foreignKeys) {
    if (usedColumns.has(foreignKey.column)) {
      continue;
    }
    const targetClass =
      foreignKey.targetClass ??
      classOfTable(foreignKey.table) ??
      foreignKey.table;
    if (targetClass) {
      relations.push({
        targetClass,
        kind: 'many-to-one',
        column: foreignKey.column,
      });
    }
  }
  const tableNote = model.tableDeclared ? '' : ' (table name not declared)';
  return {
    ...detectionBase(
      symbol,
      context,
      SQLALCHEMY_PRESET_NAME,
      SQLALCHEMY_CONFIDENCE.entity,
      symbol.lineStart,
      `class ${symbol.symbol}${model.table ? ` __tablename__=${model.table}` : tableNote}`,
    ),
    kind: 'entity-declaration',
    table: model.table ?? symbol.symbol,
    className: symbol.symbol,
    columns,
    relations,
  };
}

/** `Column('coupon_code', String(20), ForeignKey(...), comment=...)`, `mapped_column(Enum(CouponKind))` */
function describeColumn(
  name: string,
  column: CodeSite,
  sites: readonly CodeSite[],
  context: PresetContext,
): EntityColumn {
  const { positional, keywords } = splitArguments(column, 'python');
  const columnName =
    positional[0]?.literal ?? readStaticText(keywords.name, context) ?? name;
  const typeArgument = positional.find(
    (argument) =>
      argument.literal === undefined &&
      !argument.text.startsWith(`${SQLALCHEMY_FOREIGN_KEY_CALL}(`),
  );
  const enumSite = sites.find(
    (site) =>
      site.kind === 'call' && leafName(site.name) === SQLALCHEMY_ENUM_CALL,
  );
  const enumName = enumSite?.args[0]?.identifier;
  const comment = keywords.comment?.literal ?? keywords.doc?.literal;
  const dataType = typeArgument
    ? (typeArgument.identifier ?? typeArgument.text)
    : undefined;
  return {
    name: columnName,
    ...(dataType !== undefined ? { dataType } : {}),
    ...(comment !== undefined ? { comment } : {}),
    ...(enumName !== undefined ? { enumName } : {}),
  };
}

/** ForeignKey 인자: `'orders.id'` 는 표 이름, `Order.id` 는 클래스 이름 */
function foreignKeyTarget(
  argument: CodeSiteArgument | undefined,
  context: PresetContext,
): { table?: string; targetClass?: string } | undefined {
  const text = readStaticText(argument, context);
  if (text !== undefined) {
    const dot = text.lastIndexOf('.');
    return dot > 0 ? { table: text.slice(0, dot) } : undefined;
  }
  const head = argument?.identifier?.split('.')[0];
  return isClassName(head) ? { targetClass: head } : undefined;
}

/** relationship 의 상대(`'Order'`, `'shop.models.Order'`, `Order`) */
function relationshipTarget(
  argument: CodeSiteArgument | undefined,
): string | undefined {
  const raw = argument?.literal ?? argument?.identifier;
  const name = raw === undefined ? undefined : leafName(raw);
  return isClassName(name) ? name : undefined;
}

// ── 읽기·쓰기 ──

function accessAndWrites(
  symbol: ExtractedSymbol,
  context: PresetContext,
  models: ReadonlyMap<string, SqlAlchemyModel> | undefined,
): Detection[] {
  const sites = (symbol.sites ?? []).filter((site) => site.kind === 'call');
  const accesses: EntityAccess[] = [];
  const writes: FieldWriteSource[] = [];
  const isModel = (name: string | undefined): name is string =>
    name !== undefined && (models?.has(name) ?? false);
  const statementLocals = statementFunctionNames(symbol);
  for (const site of sites) {
    const operation = leafName(site.name);
    const receiver = receiverOf(site.name);
    const { positional, keywords } = splitArguments(site, symbol.language);
    const first = positional[0]?.identifier;
    const sessionLike =
      receiver !== undefined && leafName(receiver) === SQLALCHEMY_SESSION_NAME;
    // session.query(Coupon) … 와 Coupon.query …
    if (
      operation === SQLALCHEMY_QUERY_METHOD &&
      receiver !== undefined &&
      (isModel(first) || (sessionLike && isClassName(first)))
    ) {
      queryChain(
        sites,
        site,
        first as string,
        `${site.name}(${first})`,
        accesses,
        writes,
      );
      continue;
    }
    const segments = site.name.split('.');
    if (
      segments.length >= 3 &&
      segments[1] === SQLALCHEMY_QUERY_METHOD &&
      isModel(segments[0]) &&
      !site.name.includes('()')
    ) {
      const write = SQLALCHEMY_QUERY_WRITE_STEPS.includes(operation);
      accesses.push(
        access(
          site,
          segments[0],
          write,
          operation,
          `${segments[0]}.${SQLALCHEMY_QUERY_METHOD}`,
        ),
      );
      continue;
    }
    if (
      operation === SQLALCHEMY_GET_METHOD &&
      receiver !== undefined &&
      (isModel(first) || (sessionLike && isClassName(first)))
    ) {
      accesses.push(
        access(
          site,
          first as string,
          false,
          operation,
          `${site.name}(${first})`,
        ),
      );
      continue;
    }
    // select(Coupon), update(Coupon).values(...), insert(Coupon), delete(Coupon)
    const statement = statementLocals.get(site.name);
    if (
      statement !== undefined &&
      (isModel(first) || (statementLocals.size > 0 && isClassName(first)))
    ) {
      const write = statement !== SQLALCHEMY_SELECT_FUNCTION;
      accesses.push(
        access(
          site,
          first as string,
          write,
          statement,
          `${statement}(${first})`,
        ),
      );
      const values = chainStepsOf(sites, site).find(
        (step) => leafName(step.name) === SQLALCHEMY_VALUES_STEP,
      );
      const fields = values ? valuesArgument(values) : undefined;
      if (values && fields) {
        writes.push({
          site: values,
          entity: first as string,
          fields,
          writeKind: 'update-builder',
          confidence: SQLALCHEMY_CONFIDENCE.fieldWrite,
        });
      }
      continue;
    }
    // Coupon(code=..., kind=...) 생성자
    if (receiver === undefined && isModel(site.name)) {
      accesses.push(
        access(
          site,
          site.name,
          true,
          SQLALCHEMY_CONSTRUCT_OPERATION,
          `${site.name}(…)`,
        ),
      );
      if (Object.keys(keywords).length > 0) {
        writes.push({
          site,
          entity: site.name,
          fields: {
            text: site.args[site.args.length - 1].text,
            properties: keywords,
          },
          writeKind: 'update-call',
          confidence: SQLALCHEMY_CONFIDENCE.fieldWrite,
        });
      }
    }
  }
  const locals = singleEntityLocals(
    symbol,
    accesses,
    (item) =>
      item.operation === SQLALCHEMY_CONSTRUCT_OPERATION ||
      item.operation === SQLALCHEMY_GET_METHOD ||
      SQLALCHEMY_SINGLE_RESULT_STEPS.includes(item.operation),
  );
  // session.add(coupon), session.delete(Coupon(...))
  for (const site of sites) {
    const receiver = receiverOf(site.name);
    if (
      !receiver ||
      leafName(receiver) !== SQLALCHEMY_SESSION_NAME ||
      !SQLALCHEMY_SESSION_WRITE_METHODS.includes(leafName(site.name))
    ) {
      continue;
    }
    const argument = site.args[0];
    const constructed = /^([A-Z]\w*)\(/.exec(argument?.text ?? '')?.[1];
    const entity =
      argument?.identifier !== undefined
        ? locals.get(argument.identifier)?.entity
        : isModel(constructed)
          ? constructed
          : undefined;
    if (entity) {
      accesses.push(
        access(
          site,
          entity,
          true,
          leafName(site.name),
          `${site.name}(${argument?.text ?? ''})`,
        ),
      );
    }
  }
  return [
    ...accessDetections(
      symbol,
      context,
      SQLALCHEMY_PRESET_NAME,
      accesses.filter(
        (item) => item.operation !== SQLALCHEMY_CONSTRUCT_OPERATION,
      ),
    ),
    ...fieldWriteDetections(symbol, context, SQLALCHEMY_PRESET_NAME, writes),
    ...assignmentWrites(
      symbol,
      context,
      SQLALCHEMY_PRESET_NAME,
      locals,
      SQLALCHEMY_CONFIDENCE.assignment,
    ),
  ];
}

function access(
  site: CodeSite,
  entity: string,
  write: boolean,
  operation: string,
  via: string,
): EntityAccess {
  return {
    site,
    entity,
    kind: write ? 'entity-write' : 'entity-read',
    operation,
    via,
    confidence: SQLALCHEMY_CONFIDENCE.access,
  };
}

/** 연쇄 호출에서 이 자리 뒤의 단계들(이 자리를 가장 가까운 앞 단계로 두는 것만) */
function chainStepsOf(sites: readonly CodeSite[], root: CodeSite): CodeSite[] {
  const prefix = `${root.name}().`;
  return sites.filter(
    (site) =>
      site.name.startsWith(prefix) &&
      chainStep(sites, site, root.name) === root,
  );
}

/** session.query(X) 연쇄: update·delete 단계가 있으면 쓰기, update 의 딕셔너리는 필드 쓰기 */
function queryChain(
  sites: readonly CodeSite[],
  root: CodeSite,
  entity: string,
  via: string,
  accesses: EntityAccess[],
  writes: FieldWriteSource[],
): void {
  const steps = chainStepsOf(sites, root);
  const writeStep = steps.find((step) =>
    SQLALCHEMY_QUERY_WRITE_STEPS.includes(leafName(step.name)),
  );
  accesses.push(
    access(
      writeStep ?? root,
      entity,
      writeStep !== undefined,
      writeStep ? leafName(writeStep.name) : SQLALCHEMY_QUERY_METHOD,
      via,
    ),
  );
  for (const step of steps) {
    const operation = leafName(step.name);
    if (SQLALCHEMY_SINGLE_RESULT_STEPS.includes(operation)) {
      accesses.push(access(step, entity, false, operation, via));
    }
  }
  const fields = writeStep?.args[0];
  if (
    writeStep &&
    leafName(writeStep.name) === 'update' &&
    fields?.properties
  ) {
    writes.push({
      site: writeStep,
      entity,
      fields,
      writeKind: 'update-builder',
      confidence: SQLALCHEMY_CONFIDENCE.fieldWrite,
    });
  }
}

/** values(status='x') 의 키워드나 values({'status': 'x'}) 의 딕셔너리 */
function valuesArgument(site: CodeSite): CodeSiteArgument | undefined {
  const { positional, keywords } = splitArguments(site, 'python');
  if (Object.keys(keywords).length > 0) {
    return { text: site.args[site.args.length - 1].text, properties: keywords };
  }
  return positional[0]?.properties || positional[0]?.elements
    ? positional[0]
    : undefined;
}

/** 이 심볼에서 SQLAlchemy 문장 생성 함수를 부르는 이름 → 함수 이름(`select`, `sa.update` → `update`) */
function statementFunctionNames(symbol: ExtractedSymbol): Map<string, string> {
  const names = new Map<string, string>();
  for (const module of SQLALCHEMY_STATEMENT_MODULES) {
    for (const name of [
      SQLALCHEMY_SELECT_FUNCTION,
      ...SQLALCHEMY_STATEMENT_WRITE_FUNCTIONS,
    ]) {
      const local = namedImportLocal(symbol, module, name);
      if (local) {
        names.set(local, name);
      }
      for (const alias of moduleLocals(symbol, module)) {
        names.set(`${alias}.${name}`, name);
      }
    }
  }
  return names;
}
