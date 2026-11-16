// Prisma 스키마(.prisma) 문서 읽기. 스키마 언어는 구문이 작아 줄 단위로 읽는다
// model·view·enum·type 블록을 심볼 하나씩으로 내고, 프리셋은 같은 읽기 함수로 블록 원문을 다시 풀어 필드·속성을 본다
// 주석(`//`)은 문자열 밖에서만 떼고, `///` 는 다음 블록·필드의 설명으로 남긴다
import {
  errorMessage,
  finalizeExtraction,
  hasExtension,
} from '../../extractors/normalize.js';
import type {
  ExtractedSymbol,
  ExtractionFailure,
  SymbolExtractor,
} from '../../types.js';
import {
  PRISMA_BLOCK_HEADER,
  PRISMA_EXTRACTOR_NAME,
  PRISMA_FIELD_HEAD,
  PRISMA_OTHER_BLOCK_HEADER,
  PRISMA_LANGUAGE,
  PRISMA_SCHEMA_EXTENSIONS,
  PRISMA_SYMBOL_KINDS,
} from './constants.js';
import type {
  PrismaAttribute,
  PrismaBlock,
  PrismaBlockKeyword,
  PrismaField,
  PrismaParseResult,
} from './types.js';

/** `.prisma` 파일에서 model·view·enum·type 블록을 심볼로 뽑는 추출기 */
export function prismaSchemaExtractor(): SymbolExtractor {
  return {
    name: PRISMA_EXTRACTOR_NAME,
    extensions: PRISMA_SCHEMA_EXTENSIONS,
    async extract(files, context) {
      const symbols: ExtractedSymbol[] = [];
      const failures: ExtractionFailure[] = [];
      for (const file of files) {
        if (!hasExtension(file.filePath, PRISMA_SCHEMA_EXTENSIONS)) {
          continue;
        }
        try {
          const parsed = parsePrismaSchema(file.content);
          if (parsed.error) {
            failures.push({ filePath: file.filePath, message: parsed.error });
            continue;
          }
          symbols.push(
            ...parsed.blocks.map((block) => toSymbol(file.filePath, block)),
          );
        } catch (error) {
          failures.push({
            filePath: file.filePath,
            message: `extraction failed: ${errorMessage(error)}`,
          });
        }
      }
      context.logger.debug('prisma extraction finished', {
        repository: context.repository,
        files: files.length,
        symbols: symbols.length,
        failures: failures.length,
      });
      return finalizeExtraction({ symbols, failures });
    },
  };
}

function toSymbol(filePath: string, block: PrismaBlock): ExtractedSymbol {
  return {
    filePath,
    language: PRISMA_LANGUAGE,
    symbol: block.name,
    kind: PRISMA_SYMBOL_KINDS[block.keyword],
    content: block.content,
    lineStart: block.lineStart,
    lineEnd: block.lineEnd,
    ...(block.description ? { description: block.description } : {}),
    relations: [],
  };
}

/** 스키마 글을 블록으로 읽는다. 줄 번호는 글의 첫 줄을 1 로 센다 */
export function parsePrismaSchema(content: string): PrismaParseResult {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const blocks: PrismaBlock[] = [];
  let docs: string[] = [];
  let open:
    | {
        keyword: PrismaBlockKeyword;
        name: string;
        start: number;
        description?: string;
        fields: PrismaField[];
        attributes: PrismaAttribute[];
      }
    | { keyword: 'other'; start: number }
    | undefined;
  let pending: { text: string; line: number; comment?: string } | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const { code, doc } = splitComment(lines[index]);
    let text = code.trim();
    if (pending) {
      text = `${pending.text} ${text}`;
    }
    if (!open) {
      if (doc !== undefined && !text) {
        docs.push(doc);
        continue;
      }
      if (!text) {
        docs = [];
        continue;
      }
      const header = PRISMA_BLOCK_HEADER.exec(text);
      if (header) {
        open = {
          keyword: header[1] as PrismaBlockKeyword,
          name: header[2],
          start: lineNumber,
          ...(docs.length > 0 ? { description: docs.join('\n') } : {}),
          fields: [],
          attributes: [],
        };
      } else if (PRISMA_OTHER_BLOCK_HEADER.test(text)) {
        open = { keyword: 'other', start: lineNumber };
      } else {
        return {
          blocks,
          error: `line ${lineNumber}: unexpected text outside a block`,
        };
      }
      docs = [];
      continue;
    }
    if (text === '}') {
      if (open.keyword !== 'other') {
        blocks.push({
          keyword: open.keyword,
          name: open.name,
          lineStart: open.start,
          lineEnd: lineNumber,
          content: lines.slice(open.start - 1, lineNumber).join('\n'),
          ...(open.description ? { description: open.description } : {}),
          fields: open.fields,
          attributes: open.attributes,
        });
      }
      open = undefined;
      pending = undefined;
      docs = [];
      continue;
    }
    if (open.keyword === 'other') {
      continue;
    }
    if (!text) {
      if (doc !== undefined) {
        docs.push(doc);
      }
      continue;
    }
    // 괄호가 닫히지 않은 속성은 다음 줄과 이어 읽는다
    if (depthOf(text) > 0) {
      pending = { text, line: pending?.line ?? lineNumber };
      continue;
    }
    const line = pending?.line ?? lineNumber;
    pending = undefined;
    if (text.startsWith('@@')) {
      open.attributes.push(...parseAttributes(text.slice(1)));
    } else {
      const field = parseField(text, line, open.keyword, docs);
      if (field) {
        open.fields.push(field);
      }
    }
    docs = [];
  }
  if (open) {
    return { blocks, error: `line ${open.start}: block is not closed` };
  }
  return { blocks };
}

function parseField(
  text: string,
  line: number,
  keyword: PrismaBlockKeyword,
  docs: string[],
): PrismaField | undefined {
  const match = PRISMA_FIELD_HEAD.exec(text);
  if (!match) {
    return undefined;
  }
  const [, name, type, list, optional, rest] = match;
  // 열거형 값 줄에는 타입이 없다
  const fieldType = keyword === 'enum' ? '' : (type ?? '');
  const attributeText = keyword === 'enum' && type ? `${type} ${rest}` : rest;
  return {
    name,
    type: fieldType.replace(/\(.*\)$/, ''),
    list: list !== undefined,
    optional: optional !== undefined,
    line,
    attributes: parseAttributes(attributeText.trim()),
    ...(docs.length > 0 ? { comment: docs.join('\n') } : {}),
  };
}

/** `@id @default(now()) @map("member_id")` 를 속성 목록으로 */
function parseAttributes(text: string): PrismaAttribute[] {
  const attributes: PrismaAttribute[] = [];
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf('@', index);
    if (at < 0) {
      break;
    }
    const name = /^@([A-Za-z_][\w.]*)/.exec(text.slice(at));
    if (!name) {
      index = at + 1;
      continue;
    }
    index = at + name[0].length;
    let inner = '';
    if (text[index] === '(') {
      const end = closingParenthesis(text, index);
      inner = text.slice(index + 1, end);
      index = end + 1;
    }
    attributes.push({ name: name[1], ...splitArguments(inner) });
  }
  return attributes;
}

function splitArguments(
  text: string,
): Pick<PrismaAttribute, 'positional' | 'named'> {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  for (const part of topLevelParts(text)) {
    const pair = /^([A-Za-z_]\w*)\s*:\s*([\s\S]*)$/.exec(part);
    if (pair) {
      named[pair[1]] = pair[2].trim();
    } else if (part) {
      positional.push(part);
    }
  }
  return { positional, named };
}

/** 쉼표로 나누되 괄호·대괄호·문자열 안의 쉼표는 지나친다 */
function topLevelParts(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      current += character;
      if (character === '\\') {
        current += text[index + 1] ?? '';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === '(' || character === '[') {
      depth += 1;
    } else if (character === ')' || character === ']') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function closingParenthesis(text: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return text.length;
}

/** 줄의 열린 괄호 수(문자열 밖) */
function depthOf(text: string): number {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        quoted = false;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    }
  }
  return depth;
}

/** 문자열 밖의 `//` 주석을 뗀다. `///` 는 설명 글로 돌려준다 */
function splitComment(line: string): { code: string; doc?: string } {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === '/' && line[index + 1] === '/') {
      const doc =
        line[index + 2] === '/' ? line.slice(index + 3).trim() : undefined;
      return {
        code: line.slice(0, index),
        ...(doc !== undefined ? { doc } : {}),
      };
    }
  }
  return { code: line };
}

/** 속성 인자의 문자열 값(`"orders"` → `orders`). 문자열이 아니면 undefined */
export function prismaString(value: string | undefined): string | undefined {
  const match = value ? /^"((?:[^"\\]|\\.)*)"$/.exec(value.trim()) : null;
  return match ? match[1].replace(/\\(.)/g, '$1') : undefined;
}

/** 속성 인자의 목록 값(`[memberId, couponId]` → 이름들) */
export function prismaList(value: string | undefined): string[] {
  const match = value ? /^\[([\s\S]*)\]$/.exec(value.trim()) : null;
  return match ? topLevelParts(match[1]).filter(Boolean) : [];
}

/** 이름이 맞는 속성 */
export function prismaAttribute(
  attributes: readonly PrismaAttribute[],
  name: string,
): PrismaAttribute | undefined {
  return attributes.find((attribute) => attribute.name === name);
}
