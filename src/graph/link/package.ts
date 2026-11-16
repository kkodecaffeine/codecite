// DEPENDS_ON_PACKAGE: hints.packages 의 공유 패키지를 가져오는 심볼 → 그 패키지를 내는 저장소의 심볼
// - 가져온 이름과 같은 심볼이 내는 저장소에 정확히 하나면 그 심볼(high)
// - 아니면 패키지 진입 파일(맨 위·src·lib 의 index, Python 은 패키지 폴더의 __init__)의 모듈 심볼(medium)
// - 둘 다 못 찾으면 못 이은 항목으로 남긴다. 패키지 의존은 코드 의존이라 실행 사실을 달지 않는다
import type { CurrentSymbolRecord } from '../../extensions/code-knowledge.js';
import {
  IMPORT_TARGET_SEPARATOR,
  MODULE_SYMBOL_KIND,
  PYTHON_SOURCE_EXTENSIONS,
  WHOLE_MODULE_IMPORT,
} from '../extractors/constants.js';
import { compareText } from '../files.js';
import { ModuleIndex, parseImportTarget } from '../imports.js';
import { PACKAGE_ENTRY_FOLDERS } from './constants.js';
import {
  type LinkContext,
  recordLabel,
  unresolvedForRecord,
} from './context.js';
import type { LinkResult, PackageMatch } from './types.js';

export function linkPackages(context: LinkContext): LinkResult {
  const result: LinkResult = { drafts: [], unresolved: [] };
  const packages = context.config.hints.packages ?? {};
  if (Object.keys(packages).length === 0) {
    return result;
  }
  const modules = new Map<string, ModuleIndex>();
  const moduleIndex = (repository: string) => {
    let index = modules.get(repository);
    if (!index) {
      index = new ModuleIndex(
        (context.recordsByRepository.get(repository) ?? []).map(
          (record) => record.filePath,
        ),
      );
      modules.set(repository, index);
    }
    return index;
  };

  for (const repository of context.repositories) {
    for (const caller of context.recordsByRepository.get(repository) ?? []) {
      for (const relation of caller.relations) {
        const text = relation.target.symbol;
        if (relation.type !== 'IMPORTS' || !text) {
          continue;
        }
        const separator = text.indexOf(IMPORT_TARGET_SEPARATOR);
        if (separator <= 0) {
          continue;
        }
        const specifier = text.slice(
          separator + IMPORT_TARGET_SEPARATOR.length,
        );
        const match = matchPackage(specifier, packages);
        if (!match || match.repository === caller.repository) {
          continue;
        }
        const binding = parseImportTarget(text);
        const name =
          binding &&
          binding.imported !== WHOLE_MODULE_IMPORT &&
          binding.imported !== 'default'
            ? binding.imported
            : undefined;
        const provided =
          context.recordsByRepository.get(match.repository) ?? [];
        const named = name
          ? provided.filter(
              (record) =>
                record.kind !== MODULE_SYMBOL_KIND && record.symbol === name,
            )
          : [];
        const value = name ? `${match.packageName}#${name}` : specifier;
        const locator = `${caller.filePath}:${caller.lineStart ?? 1}`;
        const evidence = [
          `imports ${name ?? WHOLE_MODULE_IMPORT} from ${specifier}`,
          `hints.packages ${match.key} points to ${match.repository}`,
        ];
        if (named.length === 1) {
          result.drafts.push({
            relation: 'DEPENDS_ON_PACKAGE',
            source: caller,
            target: named[0],
            extraction: { kind: 'package', locator, value },
            confidence: 'high',
            evidence: [
              ...evidence,
              `only symbol named ${name} in ${match.repository}`,
            ],
          });
          continue;
        }
        const entry = entryRecord(
          context,
          moduleIndex(match.repository),
          match,
          caller.filePath,
          specifier,
        );
        if (entry) {
          result.drafts.push({
            relation: 'DEPENDS_ON_PACKAGE',
            source: caller,
            target: entry,
            extraction: { kind: 'package', locator, value },
            confidence: 'medium',
            evidence: [...evidence, `package entry ${recordLabel(entry)}`],
          });
          continue;
        }
        result.unresolved.push(
          unresolvedForRecord(
            caller,
            'DEPENDS_ON_PACKAGE',
            named.length > 1 ? 'ambiguous-provider' : 'no-provider',
            value,
            named,
          ),
        );
      }
    }
  }
  return result;
}

/**
 * 모듈 지정자가 hints.packages 의 어느 항목인지. 항목은 패키지 이름(`@dotori/shared`)이나 범위(`@dotori`, `@dotori/*`)이고,
 * 지정자가 그 이름과 같거나 이름 뒤에 경로 구분자(`/`, 파이썬 모듈이면 `.`)로 이어지면 맞는다. 긴 항목이 먼저다
 */
export function matchPackage(
  specifier: string,
  packages: Readonly<Record<string, string>>,
): PackageMatch | undefined {
  const entries = Object.entries(packages).sort(
    ([left], [right]) => right.length - left.length || compareText(left, right),
  );
  for (const [key, repository] of entries) {
    const prefix = key.replace(/\/\*$/, '');
    if (
      specifier !== prefix &&
      !specifier.startsWith(`${prefix}/`) &&
      !specifier.startsWith(`${prefix}.`)
    ) {
      continue;
    }
    const python = !specifier.includes('/') && !specifier.startsWith('@');
    const segments = python ? specifier.split('.') : specifier.split('/');
    const nameLength = !python && specifier.startsWith('@') ? 2 : 1;
    const packageName = segments.slice(0, nameLength).join(python ? '.' : '/');
    const subpath = segments.slice(nameLength).join('/');
    return {
      key,
      repository,
      packageName,
      ...(subpath ? { subpath } : {}),
    };
  }
  return undefined;
}

/** 패키지 진입 파일의 모듈 심볼. 진입 파일이 하나로 정해지고 그 파일에 모듈 심볼이 있을 때만 */
function entryRecord(
  context: LinkContext,
  modules: ModuleIndex,
  match: PackageMatch,
  callerFile: string,
  specifier: string,
): CurrentSymbolRecord | undefined {
  const python = PYTHON_SOURCE_EXTENSIONS.some((extension) =>
    callerFile.toLowerCase().endsWith(extension),
  );
  const candidates = python
    ? [modules.resolve(callerFile, specifier)]
    : PACKAGE_ENTRY_FOLDERS.map((folder) => {
        // 맨 위 폴더는 빈 경로로 찾는다(`.` 은 부르는 파일 기준 상대 경로로 읽힌다)
        const base = folder === '.' ? '' : folder;
        const path = match.subpath
          ? [base, match.subpath].filter(Boolean).join('/')
          : base;
        return modules.resolve(callerFile, path);
      });
  const files = candidates.find((found) => found.length > 0) ?? [];
  return files.length === 1
    ? context.moduleOf(match.repository, files[0])
    : undefined;
}
