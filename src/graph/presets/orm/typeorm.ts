// TypeORM 엔티티 선언, 저장소·매니저·쿼리 빌더로 엔티티를 읽고 쓰는 자리, 필드 쓰기를 찾는다
// 읽기·쓰기는 엔티티 클래스 이름을 열쇠로 낸다. 연결 단계가 선언의 표 이름과 클래스 이름을 한 노드로 묶는다
// 받는 쪽은 클래스 멤버(InjectRepository 데코레이터나 Repository<X> 타입), getRepository(X), 그 값을 담은 지역 변수·상수로만 잇는다
import type { EntityColumn } from '../../../extensions/code-knowledge.js';
import type {
  ClassMember,
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
  arrowTarget,
  derivedIndex,
  detectionBase,
  findDecorator,
  leafName,
  memberDecorator,
  readStaticText,
  receiverMember,
  receiverOf,
  resolveLocalSymbol,
  siteLabel,
  thisMemberName,
  typeArgument,
  typeLeaf,
} from '../messaging/support.js';
import {
  LOCAL_NAME_PATTERN,
  TYPEORM_BUILDER_ENTITY_STEPS,
  TYPEORM_BUILDER_FIELD_STEPS,
  TYPEORM_BUILDER_WRITE_STEPS,
  TYPEORM_COLUMN_DECORATORS,
  TYPEORM_CONFIDENCE,
  TYPEORM_COUNTER_METHODS,
  TYPEORM_CREATE_METHOD,
  TYPEORM_DEFAULT_TABLE_NOTE,
  TYPEORM_ENTITY_DECORATOR,
  TYPEORM_ENTITY_MANAGER_TYPE,
  TYPEORM_ENTITY_REPOSITORY_DECORATOR,
  TYPEORM_FIELD_ARGUMENT,
  TYPEORM_GENERATED_COLUMN_DECORATOR,
  TYPEORM_GET_REPOSITORY,
  TYPEORM_INJECT_REPOSITORY_DECORATOR,
  TYPEORM_LOCAL_BUILDER_WRITE,
  TYPEORM_JOIN_COLUMN_DECORATOR,
  TYPEORM_MANAGER_RECEIVERS,
  TYPEORM_PRESET_NAME,
  TYPEORM_QUERY_BUILDER,
  TYPEORM_READ_METHODS,
  TYPEORM_REPOSITORY_NAME_PATTERN,
  TYPEORM_RELATION_DECORATORS,
  TYPEORM_REPOSITORY_TYPES,
  TYPEORM_SINGLE_RESULT_METHODS,
  TYPEORM_TABLE_NAME_PATTERN,
  TYPEORM_WRITE_METHODS,
} from './constants.js';
import {
  accessDetections,
  assignmentWrites,
  chainStep,
  entityArgument,
  fieldWriteDetections,
  isClassName,
  singleEntityLocals,
  stripCallArguments,
} from './support.js';
import type { EntityAccess, EntityBinding, FieldWriteSource } from './types.js';

export const typeormPreset: DetectionPreset = {
  name: TYPEORM_PRESET_NAME,
  languages: SCRIPT_LANGUAGES,
  detect(symbol, context) {
    const found: Detection[] = [];
    const declaration = entityDeclaration(symbol, context);
    if (declaration) {
      found.push(declaration);
    }
    const { accesses, writes } = collect(symbol, context);
    found.push(
      ...accessDetections(
        symbol,
        context,
        TYPEORM_PRESET_NAME,
        accesses.filter((access) => access.operation !== TYPEORM_CREATE_METHOD),
      ),
      ...fieldWriteDetections(symbol, context, TYPEORM_PRESET_NAME, writes),
      ...assignmentWrites(
        symbol,
        context,
        TYPEORM_PRESET_NAME,
        singleEntityLocals(symbol, accesses, (access) =>
          TYPEORM_SINGLE_RESULT_METHODS.includes(access.operation),
        ),
        TYPEORM_CONFIDENCE.assignment,
      ),
    );
    return found;
  },
};

// ── 선언 ──

function entityDeclaration(
  symbol: ExtractedSymbol,
  context: PresetContext,
): EntityDeclarationDetection | undefined {
  const decorator = findDecorator(symbol.sites, [TYPEORM_ENTITY_DECORATOR]);
  if (!decorator || symbol.members === undefined) {
    return undefined;
  }
  const argument = decorator.args[0];
  const declared = readStaticText(
    argument?.properties ? argument.properties.name : argument,
    context,
  );
  const table = declared ?? defaultTableName(symbol.symbol);
  const members = symbol.members.filter((member) => !member.parameter);
  const evidence = `${siteLabel(decorator)} class ${symbol.symbol}${declared === undefined ? ` (${TYPEORM_DEFAULT_TABLE_NOTE})` : ''}`;
  return {
    ...detectionBase(
      symbol,
      context,
      TYPEORM_PRESET_NAME,
      TYPEORM_CONFIDENCE.entity,
      decorator.line,
      evidence,
    ),
    kind: 'entity-declaration',
    table,
    className: symbol.symbol,
    columns: members.flatMap((member) => column(member, context)),
    relations: members.flatMap((member) => relation(member, context)),
  };
}

/** TypeORM 기본 명명 규칙: 클래스 이름의 snake_case(`OrderItem` → `order_item`) */
function defaultTableName(className: string): string {
  return className
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function column(member: ClassMember, context: PresetContext): EntityColumn[] {
  const decorator = memberDecorator(member, TYPEORM_COLUMN_DECORATORS);
  if (!decorator) {
    return [];
  }
  const options =
    decorator.args.find((argument) => argument.properties)?.properties ?? {};
  const generated =
    leafName(decorator.name) === TYPEORM_GENERATED_COLUMN_DECORATOR;
  const typeOption = options.type;
  const dataType =
    (generated ? undefined : decorator.args[0]?.literal) ??
    typeOption?.literal ??
    typeOption?.identifier ??
    member.type;
  const comment = options.comment?.literal;
  const enumName = options.enum?.identifier ?? options.enumName?.literal;
  return [
    {
      name: readStaticText(options.name, context) ?? member.name,
      ...(dataType !== undefined ? { dataType } : {}),
      ...(comment !== undefined ? { comment } : {}),
      ...(enumName !== undefined ? { enumName } : {}),
    },
  ];
}

function relation(
  member: ClassMember,
  context: PresetContext,
): EntityDeclarationDetection['relations'] {
  for (const [name, kind] of Object.entries(TYPEORM_RELATION_DECORATORS)) {
    const decorator = memberDecorator(member, [name]);
    if (!decorator) {
      continue;
    }
    const first = decorator.args[0];
    const targetClass =
      arrowTarget(first?.text) ??
      entityArgument(first) ??
      typeTarget(member.type);
    if (!targetClass) {
      return [];
    }
    const join = memberDecorator(member, [TYPEORM_JOIN_COLUMN_DECORATOR]);
    const columnName = readStaticText(join?.args[0]?.properties?.name, context);
    return [
      {
        targetClass,
        kind,
        property: member.name,
        ...(columnName !== undefined ? { column: columnName } : {}),
      },
    ];
  }
  return [];
}

/** 관계 멤버 타입에서 상대 클래스(`Member`, `Refund[]`, `Promise<Member>`) */
function typeTarget(type: string | undefined): string | undefined {
  if (!type) {
    return undefined;
  }
  const inner = typeArgument(type) ?? type;
  const name = inner
    .replace(/\[\]$/, '')
    .replace(/\s*\|\s*(?:null|undefined)$/, '')
    .trim();
  return isClassName(name) ? name : undefined;
}

// ── 읽기·쓰기 ──

function collect(
  symbol: ExtractedSymbol,
  context: PresetContext,
): { accesses: EntityAccess[]; writes: FieldWriteSource[] } {
  const sites = (symbol.sites ?? []).filter((site) => site.kind === 'call');
  const accesses: EntityAccess[] = [];
  const writes: FieldWriteSource[] = [];
  const locals = repositoryLocals(symbol, sites);
  for (const site of sites) {
    const operation = leafName(site.name);
    const receiver = receiverOf(site.name);
    const local = localBuilderWrite(symbol, sites, site);
    if (local) {
      writes.push(local.write);
      if (local.write.entity) {
        accesses.push({
          site: local.step,
          entity: local.write.entity,
          kind: 'entity-write',
          operation: leafName(local.step.name),
          via: `${TYPEORM_QUERY_BUILDER}(…)`,
          confidence: TYPEORM_CONFIDENCE.builderAccess,
        });
      }
      continue;
    }
    if (
      receiver === undefined ||
      site.name.includes(`${TYPEORM_QUERY_BUILDER}().`)
    ) {
      continue;
    }
    if (operation === TYPEORM_QUERY_BUILDER) {
      builderChain(symbol, sites, site, context, locals, accesses, writes);
      continue;
    }
    const repository = repositoryBinding(
      symbol,
      receiver,
      sites,
      site,
      context,
      locals,
    );
    const managed = repository
      ? undefined
      : managerBinding(symbol, receiver, site, context);
    const binding: LooseBinding | undefined =
      repository ?? managed ?? namedRepositoryBinding(symbol, receiver);
    if (!binding) {
      continue;
    }
    const read = TYPEORM_READ_METHODS.includes(operation);
    const write = TYPEORM_WRITE_METHODS.includes(operation);
    if (!read && !write && operation !== TYPEORM_CREATE_METHOD) {
      continue;
    }
    if (binding.entity) {
      accesses.push({
        site,
        entity: binding.entity,
        kind: read ? 'entity-read' : 'entity-write',
        operation,
        via: binding.via,
        confidence: binding.confidence,
      });
    }
    // 매니저 호출은 첫 인자가 엔티티라 필드 인자가 하나 뒤에 있다
    const shift = managed ? 1 : 0;
    const fieldIndex = TYPEORM_FIELD_ARGUMENT[operation];
    const fields =
      fieldIndex === undefined ? undefined : site.args[fieldIndex + shift];
    if (fields && (fields.properties || fields.elements)) {
      writes.push({
        site,
        ...(binding.entity ? { entity: binding.entity } : {}),
        fields,
        writeKind: 'update-call',
        confidence: TYPEORM_CONFIDENCE.fieldWrite,
      });
    }
    const counter = TYPEORM_COUNTER_METHODS[operation];
    const field = counter ? site.args[1 + shift]?.literal : undefined;
    const amount = site.args[2 + shift];
    if (counter && field && amount) {
      writes.push({
        site,
        ...(binding.entity ? { entity: binding.entity } : {}),
        fields: { text: amount.text, properties: { [field]: amount } },
        writeKind: 'update-call',
        confidence: TYPEORM_CONFIDENCE.fieldWrite,
        operator: counter,
      });
    }
  }
  return { accesses, writes };
}

/** 엔티티를 모를 수도 있는 저장소 연결. 이름으로만 저장소라고 본 받는 쪽은 엔티티를 비운다 */
type LooseBinding = Omit<EntityBinding, 'entity'> & { entity?: string };

/**
 * 연결을 못 찾은 받는 쪽이 저장소 이름(`goodsRepository`)이면 저장소로 본다
 * 같은 심볼 안에 `goodsRepository: Repository<Goods>` 타입 표기가 있으면 엔티티를 읽고, 없으면 비운다
 */
function namedRepositoryBinding(
  symbol: ExtractedSymbol,
  receiver: string,
): LooseBinding | undefined {
  const name = leafName(receiver);
  if (!TYPEORM_REPOSITORY_NAME_PATTERN.test(name)) {
    return undefined;
  }
  const typed = new RegExp(
    `\\b${name}\\s*\\??\\s*:\\s*(?:${TYPEORM_REPOSITORY_TYPES.join('|')})\\s*<\\s*([A-Z][\\w$]*)\\s*>`,
  ).exec(symbol.content);
  return {
    ...(typed ? { entity: typed[1] } : {}),
    via: typed ? `${name}: ${typed[0].split(/:\s*/)[1]}` : name,
    confidence: typed
      ? TYPEORM_CONFIDENCE.boundAccess
      : TYPEORM_CONFIDENCE.builderAccess,
  };
}

/**
 * 쿼리 빌더를 담은 지역 변수에서 이어지는 쓰기(`const qb = …createQueryBuilder(); qb.update(X).set({…})`)
 * 그 변수가 createQueryBuilder() 결과라는 대입 사실이 있을 때만 본다. 대상은 update(X)·insert().into(X) 인자에서 읽는다
 */
function localBuilderWrite(
  symbol: ExtractedSymbol,
  sites: readonly CodeSite[],
  site: CodeSite,
): { write: FieldWriteSource; step: CodeSite } | undefined {
  const match = TYPEORM_LOCAL_BUILDER_WRITE.exec(site.name);
  const fields = site.args[0];
  if (!match || !fields || !(fields.properties || fields.elements)) {
    return undefined;
  }
  const [, local, operation] = match;
  const builder = (symbol.executionFacts ?? []).some(
    (fact) =>
      fact.kind === 'assigns' &&
      fact.subject === local &&
      (fact.value ?? '').includes(`${TYPEORM_QUERY_BUILDER}(`),
  );
  const step = sites.find(
    (candidate) => candidate.name === `${local}.${operation}`,
  );
  if (!builder || !step) {
    return undefined;
  }
  const entity = builderEntityArgument(step.args[0]);
  return {
    step,
    write: {
      site,
      ...(entity ? { entity } : {}),
      fields,
      writeKind: 'update-builder',
      confidence: TYPEORM_CONFIDENCE.fieldWrite,
    },
  };
}

/** 받는 쪽이 가리키는 저장소의 엔티티 */
function repositoryBinding(
  symbol: ExtractedSymbol,
  receiver: string,
  sites: readonly CodeSite[],
  site: CodeSite,
  context: PresetContext,
  locals: ReadonlyMap<string, EntityBinding>,
): EntityBinding | undefined {
  if (receiver === 'this') {
    return ownRepositoryBinding(symbol, context);
  }
  const member = receiverMember(symbol, receiver, context);
  if (member) {
    const inject = memberDecorator(member, [
      TYPEORM_INJECT_REPOSITORY_DECORATOR,
    ]);
    const injected = entityArgument(inject?.args[0]);
    if (inject && injected) {
      return {
        entity: injected,
        via: siteLabel(inject),
        confidence: TYPEORM_CONFIDENCE.boundAccess,
      };
    }
    const typed = TYPEORM_REPOSITORY_TYPES.includes(typeLeaf(member.type) ?? '')
      ? typeArgument(member.type)
      : undefined;
    return typed
      ? {
          entity: typed,
          via: `${member.name}: ${member.type}`,
          confidence: TYPEORM_CONFIDENCE.boundAccess,
        }
      : undefined;
  }
  const getter = `${TYPEORM_GET_REPOSITORY}()`;
  if (receiver === getter || receiver.endsWith(`.${getter}`)) {
    const step = chainStep(sites, site, receiver.slice(0, -2));
    const entity = entityArgument(step?.args[0]);
    return entity
      ? {
          entity,
          via: `${TYPEORM_GET_REPOSITORY}(${entity})`,
          confidence: TYPEORM_CONFIDENCE.boundAccess,
        }
      : undefined;
  }
  const local = locals.get(receiver);
  if (local) {
    return local;
  }
  if (!LOCAL_NAME_PATTERN.test(receiver)) {
    return undefined;
  }
  const constant = resolveLocalSymbol(symbol, receiver, context);
  for (const candidate of constant?.sites ?? []) {
    const entity =
      candidate.kind === 'call' &&
      leafName(candidate.name) === TYPEORM_GET_REPOSITORY
        ? entityArgument(candidate.args[0])
        : undefined;
    if (entity) {
      return {
        entity,
        via: `${receiver} = ${TYPEORM_GET_REPOSITORY}(${entity})`,
        confidence: TYPEORM_CONFIDENCE.boundAccess,
      };
    }
  }
  return undefined;
}

/** `const orders = dataSource.getRepository(Order)` 꼴 지역 변수 → 엔티티 */
function repositoryLocals(
  symbol: ExtractedSymbol,
  sites: readonly CodeSite[],
): Map<string, EntityBinding> {
  const locals = new Map<string, EntityBinding>();
  const getters = sites.filter(
    (site) => leafName(site.name) === TYPEORM_GET_REPOSITORY,
  );
  for (const fact of symbol.executionFacts ?? []) {
    if (
      fact.kind !== 'assigns' ||
      !fact.subject ||
      !fact.value ||
      fact.subject.includes('.')
    ) {
      continue;
    }
    const stripped = stripCallArguments(fact.value);
    const getter = getters.find(
      (site) => site.line >= fact.line && stripped.endsWith(`${site.name}()`),
    );
    const entity = entityArgument(getter?.args[0]);
    if (entity) {
      locals.set(fact.subject, {
        entity,
        via: `${fact.subject} = ${TYPEORM_GET_REPOSITORY}(${entity})`,
        confidence: TYPEORM_CONFIDENCE.boundAccess,
      });
    }
  }
  return locals;
}

/** 엔티티 클래스를 첫 인자로 받는 매니저 호출(`manager.update(Order, …)`) */
function managerBinding(
  symbol: ExtractedSymbol,
  receiver: string,
  site: CodeSite,
  context: PresetContext,
): EntityBinding | undefined {
  const entity = site.args[0]?.identifier;
  if (!isClassName(entity)) {
    return undefined;
  }
  const known = entityClasses(context)?.has(entity) ?? false;
  // `this.<멤버>` 는 멤버 타입으로만 확인하고, 콜백 매개변수·연쇄(`queryRunner.manager`)는 흔히 쓰는 이름으로 본다
  const typed = thisMemberName(receiver)
    ? typeLeaf(receiverMember(symbol, receiver, context)?.type) ===
      TYPEORM_ENTITY_MANAGER_TYPE
    : TYPEORM_MANAGER_RECEIVERS.includes(leafName(receiver));
  return known || typed
    ? {
        entity,
        via: `${receiver}(${entity}, …)`,
        confidence: TYPEORM_CONFIDENCE.managerAccess,
      }
    : undefined;
}

/** 같은 저장소의 TypeORM 엔티티 클래스 이름 */
function entityClasses(
  context: PresetContext,
): ReadonlySet<string> | undefined {
  return derivedIndex(context, 'typeorm.entities', (index) => {
    const names = new Set<string>();
    for (const symbol of index.all) {
      if (
        symbol.members !== undefined &&
        findDecorator(symbol.sites, [TYPEORM_ENTITY_DECORATOR])
      ) {
        names.add(symbol.symbol);
      }
    }
    return names;
  });
}

/**
 * 쿼리 빌더 연쇄 하나. 엔티티는 저장소의 createQueryBuilder 면 그 저장소에서, 아니면 createQueryBuilder(X)·update(X)·into(X)·from(X) 에서 읽는다
 * update·insert·delete 단계가 있으면 쓰기, 아니면 읽기다. set·values 단계의 객체는 필드 쓰기다
 */
function builderChain(
  symbol: ExtractedSymbol,
  sites: readonly CodeSite[],
  root: CodeSite,
  context: PresetContext,
  locals: ReadonlyMap<string, EntityBinding>,
  accesses: EntityAccess[],
  writes: FieldWriteSource[],
): void {
  const prefix = `${root.name}().`;
  const chain = sites.filter(
    (site) =>
      site.name.startsWith(prefix) &&
      chainStep(sites, site, root.name) === root,
  );
  const receiver = receiverOf(root.name) as string;
  const bound = repositoryBinding(
    symbol,
    receiver,
    sites,
    root,
    context,
    locals,
  );
  const stepEntity = chain
    .filter((site) =>
      TYPEORM_BUILDER_ENTITY_STEPS.includes(leafName(site.name)),
    )
    .map((site) => builderEntityArgument(site.args[0]))
    .find((name) => name !== undefined);
  const rootEntity = isClassName(root.args[0]?.identifier)
    ? root.args[0]?.identifier
    : undefined;
  const entity = bound?.entity ?? rootEntity ?? stepEntity;
  const writeStep = chain.find((site) =>
    TYPEORM_BUILDER_WRITE_STEPS.includes(leafName(site.name)),
  );
  if (!entity) {
    // 대상(변수로 준 테이블 이름 등)을 못 읽어도 update·insert 단계의 set·values 는 틀림없는 필드 쓰기다. 엔티티 없이 남긴다
    if (writeStep) {
      writes.push(...builderFieldWrites(chain, undefined));
    }
    return;
  }
  const via = bound?.via ?? `${TYPEORM_QUERY_BUILDER}(…)`;
  const confidence = bound?.confidence ?? TYPEORM_CONFIDENCE.builderAccess;
  accesses.push({
    site: writeStep ?? root,
    entity,
    kind: writeStep ? 'entity-write' : 'entity-read',
    operation: writeStep ? leafName(writeStep.name) : TYPEORM_QUERY_BUILDER,
    via,
    confidence,
  });
  for (const site of chain) {
    const step = leafName(site.name);
    if (TYPEORM_SINGLE_RESULT_METHODS.includes(step)) {
      accesses.push({
        site,
        entity,
        kind: 'entity-read',
        operation: step,
        via,
        confidence,
      });
    }
  }
  writes.push(...builderFieldWrites(chain, entity));
}

/** 쿼리 빌더 연쇄의 set·values 단계 객체마다 필드 쓰기 출처 하나 */
function builderFieldWrites(
  chain: readonly CodeSite[],
  entity: string | undefined,
): FieldWriteSource[] {
  return chain.flatMap((site) => {
    const fields = site.args[0];
    return TYPEORM_BUILDER_FIELD_STEPS.includes(leafName(site.name)) &&
      fields &&
      (fields.properties || fields.elements)
      ? [
          {
            site,
            ...(entity ? { entity } : {}),
            fields,
            writeKind: 'update-builder' as const,
            confidence: TYPEORM_CONFIDENCE.fieldWrite,
          },
        ]
      : [];
  });
}

/** 쿼리 빌더 단계의 대상 인자. 엔티티 클래스 이름이나 문자열 테이블 이름 */
function builderEntityArgument(
  argument: CodeSiteArgument | undefined,
): string | undefined {
  if (isClassName(argument?.identifier)) {
    return argument?.identifier;
  }
  const literal = argument?.literal;
  return literal !== undefined && TYPEORM_TABLE_NAME_PATTERN.test(literal)
    ? literal
    : undefined;
}

/**
 * 사용자 저장소 클래스(`class X extends Repository<Order>`, `@EntityRepository(Order)`) 안의 `this.` 호출이 가리키는 엔티티
 * 같은 파일의 소유 클래스 심볼을 본다. 클래스를 못 찾으면 잇지 않는다
 */
function ownRepositoryBinding(
  symbol: ExtractedSymbol,
  context: PresetContext,
): EntityBinding | undefined {
  const owner = symbol.symbol.slice(0, symbol.symbol.indexOf('.'));
  if (!owner) {
    return undefined;
  }
  const declaration = context.symbols?.find(
    (candidate) =>
      candidate.filePath === symbol.filePath && candidate.symbol === owner,
  );
  if (!declaration) {
    return undefined;
  }
  const decorator = (declaration.sites ?? []).find(
    (site) =>
      site.kind === 'decorator' &&
      leafName(site.name) === TYPEORM_ENTITY_REPOSITORY_DECORATOR,
  );
  const decorated = entityArgument(decorator?.args[0]);
  if (decorator && decorated) {
    return {
      entity: decorated,
      via: siteLabel(decorator),
      confidence: TYPEORM_CONFIDENCE.boundAccess,
    };
  }
  const extended = new RegExp(
    `\\bclass\\s+${owner}\\b[^{]*?\\bextends\\s+(?:${TYPEORM_REPOSITORY_TYPES.join('|')})\\s*<\\s*([A-Z][\\w$]*)\\s*>`,
  ).exec(declaration.content);
  return extended
    ? {
        entity: extended[1],
        via: `${owner} extends ${extended[0].split(/extends\s+/)[1]}`,
        confidence: TYPEORM_CONFIDENCE.boundAccess,
      }
    : undefined;
}
