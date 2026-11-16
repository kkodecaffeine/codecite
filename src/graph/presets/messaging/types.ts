// 큐·이벤트·예약 작업 프리셋과 ORM 프리셋이 함께 쓰는 모양
import type { CodeSiteArgument, ExtractedSymbol } from '../../types.js';

/** 자리 인자에서 읽은 큐·이벤트 이름. 정적으로 못 읽었으면 dynamic 이고 name 은 코드에 적힌 식 그대로다 */
export interface NameReading {
  name: string;
  dynamic: boolean;
}

/** 언어와 상관없이 나눈 호출 인자. Python 은 맨 뒤 키워드 인자 묶음을 keywords 로 푼다 */
export interface SiteArguments {
  positional: CodeSiteArgument[];
  keywords: Record<string, CodeSiteArgument>;
}

/**
 * 저장소 심볼 색인. PresetContext.symbols 배열마다 한 번 만들고 탐지기끼리 함께 쓴다
 * derived 는 프리셋마다 더 만드는 색인(셀러리 작업 표, Prisma 모델 표 등)을 열쇠 이름으로 담아 두는 자리다
 */
export interface SymbolIndex {
  all: readonly ExtractedSymbol[];
  /** 파일 경로 → 심볼 이름 → 심볼 */
  byFile: ReadonlyMap<string, ReadonlyMap<string, ExtractedSymbol>>;
  /** 심볼 이름 → 그 이름을 가진 심볼들(파일 경로 순서) */
  byName: ReadonlyMap<string, readonly ExtractedSymbol[]>;
  derived: Map<string, unknown>;
}

/** Celery 작업 하나. 이름은 name= 으로 적은 값이거나 모듈 경로로 만든 기본 이름이다 */
export interface CeleryTask {
  symbol: ExtractedSymbol;
  name: NameReading;
  /** name= 없이 모듈 경로와 함수 이름으로 만든 이름인지 */
  defaultName: boolean;
  queue?: NameReading;
  line: number;
  confidence: number;
}
