// ORM 프리셋의 이름표와 신뢰도
// 신뢰도는 탐지기마다 정한 고정값이다. 선언 데코레이터·스키마 문서처럼 자리 하나로 확정되는 것이 가장 높고,
// 주입 멤버·지역 변수·쿼리 빌더 연쇄를 거쳐 엔티티를 알아낸 것은 거친 단계만큼 낮춘다

/** 값 요약 글 길이 한도 */
export const MAX_VALUE_SUMMARY_LENGTH = 120;

/** 지역 변수·필드 이름 하나(점 없는 이름) */
export const LOCAL_NAME_PATTERN = /^[A-Za-z_$][\w$]*$/;

/** 관계형이 아닌 저장소 종류 */
export const DOCUMENT_STORE = 'document';

// ── TypeORM ──

export const TYPEORM_PRESET_NAME = 'typeorm';
export const TYPEORM_ENTITY_DECORATOR = 'Entity';
export const TYPEORM_COLUMN_DECORATORS: readonly string[] = [
  'Column',
  'PrimaryColumn',
  'PrimaryGeneratedColumn',
  'CreateDateColumn',
  'UpdateDateColumn',
  'DeleteDateColumn',
  'VersionColumn',
  'ObjectIdColumn',
];
/** 첫 문자열 인자가 자료형이 아니라 생성 방식(`uuid`, `increment`)인 컬럼 데코레이터 */
export const TYPEORM_GENERATED_COLUMN_DECORATOR = 'PrimaryGeneratedColumn';
export const TYPEORM_RELATION_DECORATORS = {
  ManyToOne: 'many-to-one',
  OneToOne: 'one-to-one',
  OneToMany: 'one-to-many',
  ManyToMany: 'many-to-many',
} as const;
export const TYPEORM_JOIN_COLUMN_DECORATOR = 'JoinColumn';
export const TYPEORM_INJECT_REPOSITORY_DECORATOR = 'InjectRepository';
/** 엔티티를 타입 인자로 받는 저장소 타입 */
export const TYPEORM_REPOSITORY_TYPES: readonly string[] = [
  'Repository',
  'MongoRepository',
  'TreeRepository',
];
export const TYPEORM_ENTITY_MANAGER_TYPE = 'EntityManager';
/** 엔티티 클래스를 첫 인자로 받는 매니저를 흔히 부르는 이름. 첫 인자가 대문자 이름일 때만 함께 본다 */
export const TYPEORM_MANAGER_RECEIVERS: readonly string[] = [
  'manager',
  'entityManager',
];
export const TYPEORM_GET_REPOSITORY = 'getRepository';
export const TYPEORM_QUERY_BUILDER = 'createQueryBuilder';
export const TYPEORM_READ_METHODS: readonly string[] = [
  'find',
  'findBy',
  'findOne',
  'findOneBy',
  'findOneOrFail',
  'findOneByOrFail',
  'findAndCount',
  'findAndCountBy',
  'count',
  'countBy',
  'exist',
  'exists',
  'existsBy',
  'sum',
  'average',
  'minimum',
  'maximum',
  'preload',
];
export const TYPEORM_WRITE_METHODS: readonly string[] = [
  'save',
  'insert',
  'update',
  'upsert',
  'delete',
  'remove',
  'softDelete',
  'softRemove',
  'restore',
  'recover',
  'increment',
  'decrement',
  'clear',
];
/** 엔티티를 만들기만 하고 저장하지 않는 메서드. 읽기·쓰기로 세지 않지만 필드 값과 지역 변수는 남긴다 */
export const TYPEORM_CREATE_METHOD = 'create';
/** 바꿀 필드 묶음을 받는 메서드와 그 인자 순번(저장소 기준. 매니저는 엔티티 인자 하나만큼 뒤로 민다) */
export const TYPEORM_FIELD_ARGUMENT: Readonly<Record<string, number>> = {
  update: 1,
  save: 0,
  insert: 0,
  upsert: 0,
  create: 0,
};
/** 필드 하나를 더하고 빼는 메서드. 필드 이름은 둘째 인자, 값은 셋째 인자 */
export const TYPEORM_COUNTER_METHODS: Readonly<Record<string, string>> = {
  increment: '+=',
  decrement: '-=',
};
/** 하나만 돌려줘 지역 변수가 엔티티 하나를 가리키게 되는 메서드 */
export const TYPEORM_SINGLE_RESULT_METHODS: readonly string[] = [
  'findOne',
  'findOneBy',
  'findOneOrFail',
  'findOneByOrFail',
  'preload',
  'create',
  'getOne',
  'getOneOrFail',
];
/** 쿼리 빌더 연쇄에서 쓰기를 뜻하는 단계와 엔티티를 받는 단계 */
export const TYPEORM_BUILDER_WRITE_STEPS: readonly string[] = [
  'update',
  'insert',
  'delete',
  'softDelete',
  'restore',
];
export const TYPEORM_BUILDER_ENTITY_STEPS: readonly string[] = [
  'update',
  'into',
  'from',
];
/** 쿼리 빌더 단계에 문자열로 준 테이블 이름(`update('members')`)으로 볼 글자 */
export const TYPEORM_TABLE_NAME_PATTERN = /^[A-Za-z_][\w.]*$/;
/** 연결을 못 찾은 받는 쪽이라도 이 이름으로 끝나면 저장소로 본다(`goodsRepository.update(…)`). 대상 엔티티는 타입 표기가 있을 때만 읽는다 */
export const TYPEORM_REPOSITORY_NAME_PATTERN = /(?:^|[a-z_])repository$/i;
/** 쿼리 빌더를 담은 지역 변수에서 이어지는 쓰기 단계(`queryBuilder.update(X).set({…})`) */
export const TYPEORM_LOCAL_BUILDER_WRITE =
  /^([A-Za-z_$][\w$]*)\.(update|insert)\(\)\.(set|values)$/;
/** 사용자 저장소 클래스를 표시하는 데코레이터(`@EntityRepository(Order)`) */
export const TYPEORM_ENTITY_REPOSITORY_DECORATOR = 'EntityRepository';
/** 바꿀 필드 묶음을 받는 쿼리 빌더 단계 */
export const TYPEORM_BUILDER_FIELD_STEPS: readonly string[] = ['set', 'values'];

/** 엔티티 이름을 정하지 않았을 때 TypeORM 기본 명명 규칙(클래스 이름의 snake_case)으로 만든 표 이름임을 알리는 말 */
export const TYPEORM_DEFAULT_TABLE_NOTE = 'default table name';

export const TYPEORM_CONFIDENCE = {
  entity: 0.95,
  /** InjectRepository·Repository<X>·getRepository(X) 로 이은 저장소 호출 */
  boundAccess: 0.9,
  /** 매니저 호출의 엔티티 인자 */
  managerAccess: 0.85,
  /** 쿼리 빌더 연쇄 */
  builderAccess: 0.85,
  fieldWrite: 0.85,
  /** 읽어 온 엔티티 변수의 필드 대입 */
  assignment: 0.75,
} as const;

// ── Prisma ──

export const PRISMA_PRESET_NAME = 'prisma';
export const PRISMA_EXTRACTOR_NAME = 'prisma';
export const PRISMA_LANGUAGE = 'prisma';
export const PRISMA_SCHEMA_EXTENSIONS: readonly string[] = ['.prisma'];
/** 블록 종류 → 심볼 종류 */
export const PRISMA_SYMBOL_KINDS = {
  model: 'entity',
  view: 'entity',
  enum: 'enum',
  type: 'class',
} as const;
/** 읽는 블록의 머리 줄과, 읽지 않고 건너뛰는 블록(datasource·generator)의 머리 줄 */
export const PRISMA_BLOCK_HEADER =
  /^(model|view|enum|type)\s+([A-Za-z_]\w*)\s*\{$/;
export const PRISMA_OTHER_BLOCK_HEADER = /^[A-Za-z_]\w*\s+[A-Za-z_]\w*\s*\{$/;
/** 필드 줄: 이름, 타입(`Unsupported("…")` 포함), 목록 `[]`, 선택 `?`, 나머지 속성 */
export const PRISMA_FIELD_HEAD =
  /^([A-Za-z_]\w*)(?:\s+([A-Za-z_][\w.]*(?:\([^)]*\))?)(\[\])?(\?)?)?\s*(.*)$/;
/** 기본 자료형. 이 밖의 타입은 같은 스키마의 모델이나 열거형이다 */
export const PRISMA_SCALAR_TYPES: readonly string[] = [
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
  'Unsupported',
];
export const PRISMA_MAP_ATTRIBUTE = 'map';
export const PRISMA_RELATION_ATTRIBUTE = 'relation';
export const PRISMA_RELATION_FIELDS = 'fields';
/** 클라이언트 호출 가운데 읽기와 쓰기 */
export const PRISMA_READ_METHODS: readonly string[] = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
];
export const PRISMA_WRITE_METHODS: readonly string[] = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
];
/** 쓰기 호출의 옵션 객체에서 바꿀 필드 묶음이 든 키 */
export const PRISMA_DATA_KEYS: readonly string[] = ['data', 'create', 'update'];
/** 저장소에 Prisma 스키마가 없을 때 클라이언트로 볼 받는 쪽 이름에 든 말 */
export const PRISMA_CLIENT_HINT = 'prisma';

export const PRISMA_CONFIDENCE = {
  entity: 0.95,
  /** 같은 저장소 스키마의 모델 접근자 */
  modelAccess: 0.9,
  /** 스키마 없이 클라이언트 이름으로만 본 접근 */
  clientAccess: 0.75,
  fieldWrite: 0.85,
} as const;

// ── Mongoose ──

export const MONGOOSE_PRESET_NAME = 'mongoose';
export const MONGOOSE_MODULE = 'mongoose';
export const NESTJS_MONGOOSE_MODULE = '@nestjs/mongoose';
export const MONGOOSE_SCHEMA_CONSTRUCTOR = 'Schema';
export const MONGOOSE_MODEL_FUNCTION = 'model';
export const MONGOOSE_SCHEMA_DECORATOR = 'Schema';
export const MONGOOSE_PROP_DECORATOR = 'Prop';
export const MONGOOSE_INJECT_MODEL_DECORATOR = 'InjectModel';
export const MONGOOSE_MODEL_TYPES: readonly string[] = ['Model'];
/** 클래스 이름을 글로 꺼내는 꼴(`Order.name`) */
export const CLASS_NAME_PROPERTY = '.name';
export const MONGOOSE_COLLECTION_OPTION = 'collection';
export const MONGOOSE_READ_METHODS: readonly string[] = [
  'find',
  'findOne',
  'findById',
  'countDocuments',
  'estimatedDocumentCount',
  'exists',
  'aggregate',
  'distinct',
];
export const MONGOOSE_WRITE_METHODS: readonly string[] = [
  'create',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'findOneAndUpdate',
  'findByIdAndUpdate',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'findByIdAndDelete',
  'bulkWrite',
];
/** 갱신 문서를 받는 메서드와 그 인자 순번 */
export const MONGOOSE_UPDATE_ARGUMENT: Readonly<Record<string, number>> = {
  updateOne: 1,
  updateMany: 1,
  replaceOne: 1,
  findOneAndUpdate: 1,
  findByIdAndUpdate: 1,
  findOneAndReplace: 1,
  create: 0,
  insertMany: 0,
};
/** 필드를 바꾸는 갱신 연산자. 안쪽 키가 필드다 */
export const MONGO_UPDATE_OPERATORS: readonly string[] = [
  '$set',
  '$setOnInsert',
  '$unset',
  '$inc',
  '$mul',
  '$min',
  '$max',
  '$rename',
  '$currentDate',
  '$push',
  '$pull',
  '$pullAll',
  '$addToSet',
  '$pop',
];
/** 스키마 필드 정의에서 읽는 키 */
export const MONGOOSE_TYPE_KEY = 'type';
export const MONGOOSE_ENUM_KEY = 'enum';
export const MONGOOSE_REF_KEY = 'ref';
/** 하위 문서 필드를 펼치는 깊이 */
export const MONGOOSE_MAX_FIELD_DEPTH = 3;

export const MONGOOSE_CONFIDENCE = {
  schema: 0.9,
  modelAccess: 0.9,
  fieldWrite: 0.85,
} as const;

// ── SQLAlchemy ──

export const SQLALCHEMY_PRESET_NAME = 'sqlalchemy';
export const SQLALCHEMY_MODULE = 'sqlalchemy';
export const SQLALCHEMY_TABLE_ATTRIBUTE = '__tablename__';
export const SQLALCHEMY_TABLE_OBJECT_ATTRIBUTE = '__table__';
export const SQLALCHEMY_TABLE_CONSTRUCTOR = 'Table';
export const SQLALCHEMY_COLUMN_CALLS: readonly string[] = [
  'Column',
  'mapped_column',
];
export const SQLALCHEMY_FOREIGN_KEY_CALL = 'ForeignKey';
export const SQLALCHEMY_RELATIONSHIP_CALL = 'relationship';
export const SQLALCHEMY_ENUM_CALL = 'Enum';
/** 세션에서 엔티티를 읽는 호출과 그 결과를 하나로 줄이는 단계 */
export const SQLALCHEMY_QUERY_METHOD = 'query';
export const SQLALCHEMY_GET_METHOD = 'get';
export const SQLALCHEMY_SINGLE_RESULT_STEPS: readonly string[] = [
  'first',
  'one',
  'one_or_none',
  'scalar',
  'scalar_one',
  'scalar_one_or_none',
  'get',
];
/** query(...) 연쇄의 쓰기 단계 */
export const SQLALCHEMY_QUERY_WRITE_STEPS: readonly string[] = [
  'update',
  'delete',
];
/** 2.0 꼴 문장 생성 함수 */
export const SQLALCHEMY_SELECT_FUNCTION = 'select';
export const SQLALCHEMY_STATEMENT_WRITE_FUNCTIONS: readonly string[] = [
  'update',
  'insert',
  'delete',
];
export const SQLALCHEMY_VALUES_STEP = 'values';
/** 생성자 호출(`Coupon(...)`)로 만든 엔티티의 작업 이름. 읽기·쓰기로 세지 않고 필드 값과 지역 변수만 남긴다 */
export const SQLALCHEMY_CONSTRUCT_OPERATION = '<init>';
/** 세션에 엔티티를 넣고 빼는 메서드 */
export const SQLALCHEMY_SESSION_WRITE_METHODS: readonly string[] = [
  'add',
  'add_all',
  'merge',
  'delete',
];
/** 세션을 흔히 부르는 끝 이름(`session`, `db.session`, `self.session`). 엔티티 인자가 대문자 이름일 때만 함께 본다 */
export const SQLALCHEMY_SESSION_NAME = 'session';
/** 문장 생성 함수가 받는 엔티티가 SQLAlchemy 것인지 확인할 때 보는 모듈 */
export const SQLALCHEMY_STATEMENT_MODULES: readonly string[] = [
  'sqlalchemy',
  'sqlalchemy.orm',
  'sqlalchemy.future',
];

export const SQLALCHEMY_CONFIDENCE = {
  entity: 0.9,
  access: 0.85,
  fieldWrite: 0.85,
  assignment: 0.75,
} as const;
