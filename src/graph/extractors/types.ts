// 언어 추출기 안에서 주고받는 모양. 공개 결과 모양은 ../types.ts 의 ExtractedSymbol 이다
import type TypeScript from 'typescript';
import type { ExecutionFact } from '../../extensions/code-knowledge.js';
import type {
  CONDITION_LABELS,
  EXTRACTED_RELATION_TYPES,
} from './constants.js';

/** 늦게 불러온 typescript 모듈 */
export type TypeScriptModule = typeof TypeScript;

export type ExtractedRelationType = (typeof EXTRACTED_RELATION_TYPES)[number];

/** 저장소 이름을 붙이기 전의 관계. 대상은 풀지 않은 원문이다(EXTRACTED_RELATION_TYPES 주석) */
export interface RawRelation {
  type: ExtractedRelationType;
  symbol: string;
}

/** 파일 맨 위의 import·require 가 묶은 이름 하나 */
export interface ImportBinding {
  /** 이 파일 안에서 쓰는 이름 */
  local: string;
  /** 모듈 지정자(`./refund.service`, `@dotori/shared`) */
  specifier: string;
  /** 가져온 꼴(`refundOrder as refund`, `* as points`) */
  imported: string;
}

/** 조건 칸에 적는 말 묶음 */
export type ConditionLabels = { [K in keyof typeof CONDITION_LABELS]: string };

export interface TypeScriptExtractorOptions {
  /** typescript 모듈을 읽는 함수. 기본은 `await import('typescript')`. 다른 판을 쓰거나 시험할 때 바꾼다 */
  loadTypeScript?: () => Promise<TypeScriptModule>;
}

/** 구문 트리에서 실행 사실과 비교용 글을 뽑는 도구. typescript 모듈을 늦게 받아 만든다 */
export interface TypeScriptFactProjector {
  /** 함수·메서드 본문의 실행 사실. 줄 번호는 파일 기준이다 */
  bodyFacts(
    sourceFile: TypeScript.SourceFile,
    body: TypeScript.ConciseBody,
  ): ExecutionFact[];
  /** 상수 선언의 대입 사실. 객체 리터럴은 속성마다 나눈다 */
  constantFacts(
    sourceFile: TypeScript.SourceFile,
    subject: string,
    initializer: TypeScript.Expression,
  ): ExecutionFact[];
  /** 열거형 멤버마다 대입 사실 하나 */
  enumFacts(
    sourceFile: TypeScript.SourceFile,
    declaration: TypeScript.EnumDeclaration,
  ): ExecutionFact[];
  /** 문자열을 `<literal>`, 환경 변수 읽기를 `<env>` 로 바꾸고 주석을 걷어 한 줄로 줄인 글 */
  text(sourceFile: TypeScript.SourceFile, node: TypeScript.Node): string;
  /** 호출식의 부르는 쪽 원문(`this.orderService.cancel`). 적을 수 없는 꼴이면 undefined */
  callee(expression: TypeScript.Expression): string | undefined;
}
