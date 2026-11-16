// GraphQL 탐지 프리셋과 연산 문서 추출기 안에서 주고받는 모양
import type { GraphqlOperationType } from '../../types.js';

/** 연산 문서 토큰 하나. 줄 번호는 문서 기준 1 부터 */
export interface GraphqlToken {
  kind: 'name' | 'punctuator' | 'string' | 'number';
  value: string;
  line: number;
  /** 문서 안 시작·끝 위치(끝은 다음 글자) */
  start: number;
  end: number;
}

/** 문서에서 읽은 이름 있는 연산 하나 */
export interface ParsedGraphqlOperation {
  operationType: GraphqlOperationType;
  operationName: string;
  /** 첫 선택 집합의 필드. 별칭은 실제 필드 이름으로 바꾸고 fragment·지시문은 뺀다 */
  rootFields: string[];
  lineStart: number;
  lineEnd: number;
  start: number;
  end: number;
  /** 선택 집합이 닫혔는지. 잘린 글이면 이름만 믿을 수 있다 */
  closed: boolean;
}

/** 문서 하나를 읽은 결과. 읽다가 막히면 그 앞까지의 연산과 막힌 자리를 함께 돌려준다 */
export interface GraphqlDocumentParse {
  operations: ParsedGraphqlOperation[];
  error?: { line: number; message: string };
}

/** 코드 안에 들어 있는 연산 문서(gql 태그 글, graphql() 호출 인자) */
export interface EmbeddedGraphqlDocument {
  text: string;
  /** 문서 첫 줄의 파일 줄 번호 */
  line: number;
  /** 어디서 읽었는지. 근거 문장에 쓴다 */
  origin: string;
}

/** 저장소 안 연산 문서 하나와 그 자리 */
export interface RepositoryGraphqlOperation {
  operation: ParsedGraphqlOperation;
  filePath: string;
  symbol: string;
}
