// 추출기가 남긴 IMPORTS 관계(`<가져온 꼴> from <모듈 지정자>`)를 읽고, 모듈 지정자를 같은 저장소의 파일로 푼다
// 상수 값 풀기와 저장소 안 호출 잇기가 같은 규칙을 쓴다. 다른 저장소의 패키지는 여기서 풀지 않는다(저장소 간 연결의 몫)
import { posix } from 'node:path';
import type { CodeSymbolRelation } from '../extensions/code-knowledge.js';
import { MODULE_ALIAS_PREFIXES } from './constants.js';
import {
  IMPORT_TARGET_SEPARATOR,
  JAVASCRIPT_SOURCE_EXTENSIONS,
  PYTHON_SOURCE_EXTENSIONS,
  TYPESCRIPT_SOURCE_EXTENSIONS,
  WHOLE_MODULE_IMPORT,
} from './extractors/constants.js';
import { compareText } from './files.js';
import type { ImportedBinding } from './types.js';

/** 긴 확장자부터 본다(`.mts` 를 `.ts` 로 잘못 떼지 않게) */
const SOURCE_EXTENSIONS = longestFirst([
  ...TYPESCRIPT_SOURCE_EXTENSIONS,
  ...JAVASCRIPT_SOURCE_EXTENSIONS,
  ...PYTHON_SOURCE_EXTENSIONS,
]);
const RUNTIME_EXTENSIONS = longestFirst(JAVASCRIPT_SOURCE_EXTENSIONS);
const NAMESPACE_PREFIX = `${WHOLE_MODULE_IMPORT} as `;
const DEFAULT_PREFIX = 'default as ';
const ALIAS_SEPARATOR = ' as ';

/**
 * IMPORTS 대상 원문 하나를 푼다. 이름 없이 모듈만 읽은 것(`* from ./point-rules`)은 묶는 이름이 없어 undefined
 * - `refundOrder from ../refund` → refundOrder 를 refundOrder 로
 * - `refundOrder as refund from ../refund` → refundOrder 를 refund 로
 * - `default as OrderPage from ./order-page` → 기본 내보내기를 OrderPage 로
 * - `* as points from ../points` → 모듈 전체를 points 로
 */
export function parseImportTarget(text: string): ImportedBinding | undefined {
  const separator = text.indexOf(IMPORT_TARGET_SEPARATOR);
  if (separator <= 0) {
    return undefined;
  }
  const imported = text.slice(0, separator).trim();
  const specifier = text.slice(separator + IMPORT_TARGET_SEPARATOR.length);
  if (!specifier || imported === WHOLE_MODULE_IMPORT) {
    return undefined;
  }
  if (imported.startsWith(NAMESPACE_PREFIX)) {
    const local = imported.slice(NAMESPACE_PREFIX.length).trim();
    return local
      ? { local, imported: WHOLE_MODULE_IMPORT, specifier }
      : undefined;
  }
  if (imported.startsWith(DEFAULT_PREFIX)) {
    const local = imported.slice(DEFAULT_PREFIX.length).trim();
    return local ? { local, imported: 'default', specifier } : undefined;
  }
  const alias = imported.indexOf(ALIAS_SEPARATOR);
  if (alias > 0) {
    const name = imported.slice(0, alias).trim();
    const local = imported.slice(alias + ALIAS_SEPARATOR.length).trim();
    return name && local ? { local, imported: name, specifier } : undefined;
  }
  return { local: imported, imported, specifier };
}

/** 심볼의 IMPORTS 관계에서 local 이름이 가리키는 것. 같은 이름이 둘이면 앞의 것 */
export function importedBinding(
  relations: readonly CodeSymbolRelation[],
  local: string,
): ImportedBinding | undefined {
  for (const relation of relations) {
    if (relation.type !== 'IMPORTS' || !relation.target.symbol) {
      continue;
    }
    const binding = parseImportTarget(relation.target.symbol);
    if (binding?.local === local) {
      return binding;
    }
  }
  return undefined;
}

/**
 * 저장소 안 모듈 경로 → 파일. 확장자를 뗀 경로로 찾고, 폴더를 가리키면 `index`·`__init__` 파일로 찾는다
 * 경로 별칭 설정(tsconfig paths 등)은 읽지 않는다. 흔한 앞머리(`@/`, `~/`, `#/`)만 떼어 저장소 안 경로 끝과 맞춰 본다
 */
export class ModuleIndex {
  private readonly modules = new Map<string, string[]>();

  constructor(files: Iterable<string>) {
    for (const file of new Set(files)) {
      const extension = SOURCE_EXTENSIONS.find((candidate) =>
        file.toLowerCase().endsWith(candidate),
      );
      if (!extension) {
        continue;
      }
      const base = file.slice(0, -extension.length);
      this.add(base, file);
      const name = posix.basename(base);
      if (name === 'index' || name === '__init__') {
        this.add(posix.dirname(base), file);
      }
    }
  }

  /**
   * 모듈 지정자를 저장소 안 파일로 푼다. 못 풀면 빈 배열. 부르는 파일과 같은 언어 묶음의 파일만 돌려준다
   * - TypeScript·JavaScript: `./x`, `../x` 는 부르는 파일 기준. `./x.js` 처럼 실행 파일 확장자를 적어도 원본 파일로 찾는다
   *   별칭 앞머리를 뗀 경로는 저장소 안 경로 끝과 맞추고, 그 밖의 지정자는 저장소 맨 위 기준 경로로만 맞춘다(패키지는 풀리지 않는다)
   * - Python: `.x`, `..x` 는 부르는 파일의 패키지 기준. `shop.points` 는 저장소 안 경로 끝과 맞춘다(src 폴더 배치 포함)
   */
  resolve(fromFile: string, specifier: string): string[] {
    const python = isPythonFile(fromFile);
    const candidates = python
      ? this.resolvePython(fromFile, specifier)
      : this.resolveScript(fromFile, specifier);
    return [...new Set(candidates)]
      .filter((file) => isPythonFile(file) === python)
      .sort(compareText);
  }

  private resolveScript(fromFile: string, specifier: string): string[] {
    if (isRelative(specifier)) {
      const target = posix.normalize(
        posix.join(posix.dirname(fromFile), specifier),
      );
      const runtime = RUNTIME_EXTENSIONS.find((extension) =>
        target.toLowerCase().endsWith(extension),
      );
      return [
        ...this.exact(target),
        ...(runtime ? this.exact(target.slice(0, -runtime.length)) : []),
      ];
    }
    const alias = MODULE_ALIAS_PREFIXES.find((prefix) =>
      specifier.startsWith(prefix),
    );
    if (alias) {
      return this.suffix(specifier.slice(alias.length));
    }
    return this.exact(specifier);
  }

  private resolvePython(fromFile: string, specifier: string): string[] {
    const level = /^\.*/.exec(specifier)?.[0].length ?? 0;
    const rest = specifier.slice(level).split('.').filter(Boolean).join('/');
    if (level === 0) {
      return rest ? this.suffix(rest) : [];
    }
    let folder = posix.dirname(fromFile);
    for (let step = 1; step < level; step += 1) {
      folder = posix.dirname(folder);
    }
    return this.exact(rest ? posix.join(folder, rest) : folder);
  }

  private exact(path: string): string[] {
    return this.modules.get(path === '' ? '.' : path) ?? [];
  }

  private suffix(path: string): string[] {
    if (!path) {
      return [];
    }
    const found: string[] = [...this.exact(path)];
    for (const [module, files] of this.modules) {
      if (module.endsWith(`/${path}`)) {
        found.push(...files);
      }
    }
    return found;
  }

  private add(module: string, file: string): void {
    const key = module === '' ? '.' : module;
    this.modules.set(key, [...(this.modules.get(key) ?? []), file]);
  }
}

function isRelative(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

function isPythonFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return PYTHON_SOURCE_EXTENSIONS.some((extension) =>
    lower.endsWith(extension),
  );
}

function longestFirst(extensions: readonly string[]): string[] {
  return [...extensions].sort((left, right) => right.length - left.length);
}
