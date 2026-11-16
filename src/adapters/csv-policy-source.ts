import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { POLICY_CLAIM_FACETS } from '../domain/constants.js';
import { PolicyCode } from '../domain/policy-code.js';
import {
  createKnowledgeClaim,
  normalizePolicyGroup,
  stablePolicyClaimId,
} from '../domain/policy-claim.js';
import { PolicyStatus } from '../domain/policy-status.js';
import { Policy } from '../domain/policy.js';
import type {
  PolicyClaimConfidence,
  PolicyClaimFacet,
} from '../domain/types.js';
import type { PolicySource } from '../ports.js';
import { inferPolicyFacet } from '../text/facet-inference.js';
import {
  CLAIM_CSV_COLUMNS,
  CLAIM_CSV_CONFIDENCES,
  CLAIM_CSV_HEADINGS,
  CLAIM_CSV_REQUIRED_COLUMNS,
} from './constants.js';
import type {
  ClaimCsvColumn,
  CsvPolicySourceOptions,
  CsvRecord,
} from './types.js';

/** CSV 형식 오류. 파일, 기록 번호(머리 행이 1), 그 기록이 시작하는 줄을 함께 알려 준다 */
export class CsvFormatError extends Error {
  constructor(
    readonly file: string,
    readonly row: number,
    readonly line: number,
    detail: string,
  ) {
    super(
      `${file} row ${row}${line !== row ? ` (line ${line})` : ''}: ${detail}`,
    );
    this.name = 'CsvFormatError';
  }
}

/**
 * claim CSV 를 정책으로 읽는 소스. 한 행이 claim 하나다
 * 필수 열이 없거나, 필수 값이 비었거나, facet·확신도가 틀리거나, claim id 가 겹치면 행 번호와 함께 throw 한다
 * 틀린 행을 건너뛰면 claim 이 사라진 줄 모른 채 근거 부족 답만 늘어나기 때문이다
 */
export class CsvPolicySource implements PolicySource {
  readonly path: string;

  constructor(options: CsvPolicySourceOptions) {
    this.path = options.path;
  }

  async loadPolicies(): Promise<Policy[]> {
    const files = await this.csvFiles();
    const claimRows = new Map<string, string>();
    const policies: Policy[] = [];
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      policies.push(
        ...policiesFromClaimCsv(content, {
          file,
          label: basename(file),
          claimRows,
        }),
      );
    }
    return policies;
  }

  /** 파일이면 그 파일, 폴더면 바로 아래 `.csv` 파일을 이름 순서로 */
  private async csvFiles(): Promise<string[]> {
    const info = await stat(this.path);
    if (info.isFile()) {
      return [this.path];
    }
    if (!info.isDirectory()) {
      throw new Error(`Policy CSV path is not a file or folder: ${this.path}`);
    }
    const entries = await readdir(this.path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.csv$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .map((name) => join(this.path, name));
  }
}

/** claim CSV 소스를 만든다 */
export function csvPolicySource(
  options: CsvPolicySourceOptions,
): CsvPolicySource {
  return new CsvPolicySource(options);
}

/**
 * CSV 글 하나를 정책으로 바꾼다. 빈 행은 건너뛰되 행 번호는 그대로 센다
 * label 은 정책 출처(`label#row-N`)에 쓰고, file 은 오류 문장에 쓴다. claimRows 를 넘기면 여러 파일에 걸쳐 claim id 중복을 막는다
 */
export function policiesFromClaimCsv(
  content: string,
  options: {
    file?: string;
    label?: string;
    claimRows?: Map<string, string>;
  } = {},
): Policy[] {
  const file = options.file ?? 'claims.csv';
  const label = options.label ?? basename(file);
  const claimRows = options.claimRows ?? new Map<string, string>();
  const [header, ...records] = parseCsvRecords(content, file);
  const columns = headerColumns(header, file);
  const headerWidth = header?.cells.length ?? 0;

  const policies: Policy[] = [];
  for (const record of records) {
    if (record.cells.every((cell) => !cell.trim())) {
      continue;
    }
    const fail = (detail: string) =>
      new CsvFormatError(file, record.row, record.line, detail);
    const extra = record.cells.slice(headerWidth).filter((cell) => cell.trim());
    if (extra.length > 0) {
      throw fail(
        `has ${record.cells.length} cells but the header has ${headerWidth}; quote cells that contain commas`,
      );
    }
    const cell = (column: ClaimCsvColumn): string => {
      const index = columns.get(column);
      return index === undefined ? '' : (record.cells[index] ?? '').trim();
    };
    for (const column of CLAIM_CSV_REQUIRED_COLUMNS) {
      if (!cell(column)) {
        throw fail(`${column} is empty`);
      }
    }

    const groupName = cell('policy_group');
    const policyGroup = normalizePolicyGroup(groupName);
    if (!policyGroup) {
      throw fail(`policy_group "${groupName}" has no letters or digits`);
    }
    const featureName = cell('feature_name');
    const statement = cell('claim_statement');
    const facet = claimFacet(cell('claim_facet'), statement, fail);
    const confidence = claimConfidence(cell('claim_confidence'), fail);
    const claimId =
      cell('claim_id') ||
      stablePolicyClaimId({ policyGroup, facet, statement });
    const location = `${label}#row-${record.row}`;
    const earlier = claimRows.get(claimId);
    if (earlier) {
      throw fail(`claim_id "${claimId}" is already used at ${earlier}`);
    }
    claimRows.set(claimId, location);

    const conditions = listCell(cell('claim_conditions'));
    const exceptions = listCell(cell('claim_exceptions'));
    const value = cell('claim_value');
    const questionExamples = listCell(cell('user_question_examples'));
    const searchAliases = listCell(cell('search_aliases'));
    const citedSource = cell('source');

    const claim = createKnowledgeClaim({
      claimId,
      policyGroup,
      facet,
      statement,
      confidence,
      provenanceChunkIds: [],
      sourceKind: 'policy',
      subject: featureName,
      predicate: facet,
      value: value || statement,
      conditions,
      exceptions,
      userQuestionExamples: questionExamples,
      searchAliases,
      status: 'active',
      // 인용에 내보내도 되는 것은 사람이 적은 source 열뿐이다. 행 위치는 내부 추적용이다
      provenance: [
        {
          sourceId: location,
          sourceKind: 'policy',
          sourceLabel: citedSource || location,
          publicAnswerSafe: Boolean(citedSource),
        },
      ],
      relations: [],
    });

    policies.push(
      Policy.create({
        name: featureName,
        decision: statement,
        status: PolicyStatus.of('Active'),
        section: groupName,
        code: PolicyCode.of(claimId),
        source: location,
        knowledgeText: claimKnowledgeText({
          statement,
          context: cell('context_text'),
          conditions,
          exceptions,
          value,
          featureName,
          questionExamples,
          searchAliases,
        }),
        policyGroup,
        policyClaims: [claim],
      }),
    );
  }
  return policies;
}

/**
 * RFC 4180 CSV 를 기록 목록으로 읽는다. 앞의 BOM 을 떼고, CRLF·LF·CR 줄바꿈과 따옴표 안의 쉼표·줄바꿈·`""` 를 다룬다
 * 따옴표로 시작하지 않은 칸 안의 따옴표는 글자로 읽는다. 닫히지 않은 따옴표와 닫는 따옴표 뒤의 글자는 throw 한다
 */
export function parseCsvRecords(content: string, file = 'CSV'): CsvRecord[] {
  const text = content.startsWith('﻿') ? content.slice(1) : content;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedFieldClosed = false;
  let row = 1;
  let line = 1;
  let recordLine = 1;

  const endField = () => {
    cells.push(field);
    field = '';
    quotedFieldClosed = false;
  };
  const endRecord = () => {
    endField();
    records.push({ cells, row, line: recordLine });
    cells = [];
    row += 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = false;
        quotedFieldClosed = true;
      } else {
        if (char === '\n' || (char === '\r' && next !== '\n')) {
          line += 1;
        }
        field += char;
      }
      continue;
    }
    if (char === ',') {
      endField();
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      endRecord();
      line += 1;
      recordLine = line;
      continue;
    }
    if (quotedFieldClosed) {
      throw new CsvFormatError(
        file,
        row,
        recordLine,
        `unexpected text after a closing quote at line ${line}`,
      );
    }
    if (char === '"' && field === '') {
      inQuotes = true;
      continue;
    }
    field += char;
  }

  if (inQuotes) {
    throw new CsvFormatError(
      file,
      row,
      recordLine,
      'a quoted cell is not closed',
    );
  }
  if (field !== '' || cells.length > 0 || quotedFieldClosed) {
    endRecord();
  }
  return records;
}

/** 머리 행의 열 이름 → 칸 위치. 필수 열이 없거나 읽는 열이 두 번 나오면 throw 한다 */
function headerColumns(
  header: CsvRecord | undefined,
  file: string,
): Map<ClaimCsvColumn, number> {
  const known = new Set<string>(CLAIM_CSV_COLUMNS);
  const columns = new Map<ClaimCsvColumn, number>();
  for (const [index, cell] of (header?.cells ?? []).entries()) {
    const name = cell.trim().toLowerCase();
    if (!known.has(name)) {
      continue;
    }
    if (columns.has(name as ClaimCsvColumn)) {
      throw new CsvFormatError(file, 1, 1, `column ${name} appears twice`);
    }
    columns.set(name as ClaimCsvColumn, index);
  }
  const missing = CLAIM_CSV_REQUIRED_COLUMNS.filter(
    (column) => !columns.has(column),
  );
  if (missing.length > 0) {
    throw new CsvFormatError(
      file,
      1,
      1,
      `missing required column(s): ${missing.join(', ')}`,
    );
  }
  return columns;
}

/** 비면 문장에서 추론하고, 적혀 있으면 정해진 값만 받는다 */
function claimFacet(
  value: string,
  statement: string,
  fail: (detail: string) => Error,
): PolicyClaimFacet {
  if (!value) {
    return inferPolicyFacet(statement);
  }
  const facet = POLICY_CLAIM_FACETS.find(
    (candidate) => candidate === value.toLowerCase(),
  );
  if (!facet) {
    throw fail(
      `unknown claim_facet "${value}"; use one of ${POLICY_CLAIM_FACETS.join(', ')}`,
    );
  }
  return facet;
}

/** 비면 high, 적혀 있으면 high·low 만 받는다 */
function claimConfidence(
  value: string,
  fail: (detail: string) => Error,
): PolicyClaimConfidence {
  if (!value) {
    return 'high';
  }
  const confidence = CLAIM_CSV_CONFIDENCES.find(
    (candidate) => candidate === value.toLowerCase(),
  );
  if (!confidence) {
    throw fail(
      `unknown claim_confidence "${value}"; use one of ${CLAIM_CSV_CONFIDENCES.join(', ')}`,
    );
  }
  return confidence;
}

/**
 * 여러 값을 담는 칸. 문자열 JSON 배열이면 그 배열을, 아니면 줄마다 값 하나로 읽는다
 * `[` 로 시작해도 JSON 배열이 아니면 그냥 글로 본다
 */
function listCell(value: string): string[] {
  if (!value) {
    return [];
  }
  if (value.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        Array.isArray(parsed) &&
        parsed.every((item) => typeof item === 'string')
      ) {
        return parsed.map((item) => item.trim()).filter(Boolean);
      }
    } catch {
      // JSON 이 아니면 아래에서 줄 단위로 읽는다
    }
  }
  return value
    .split(/\r\n|\r|\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 행 하나를 조각 투영기가 읽는 정책 글로 펼친다
 * claim 문장과 context_text 를 머리말 없는 앞 글로 두어 context_text 에 섹션이 있어도 그대로 살린다
 * 조건·예외·값은 근거 섹션, 기능은 조각 머리, 질문 예시·검색 표현은 검색 글에만 붙는 섹션으로 둔다
 */
function claimKnowledgeText(row: {
  statement: string;
  context: string;
  conditions: string[];
  exceptions: string[];
  value: string;
  featureName: string;
  questionExamples: string[];
  searchAliases: string[];
}): string {
  const section = (heading: string, lines: readonly string[]) =>
    lines.length > 0 ? `[${heading}]\n${lines.join('\n')}` : '';
  const bullets = (items: readonly string[]) =>
    items.map((item) => `- ${item}`);
  return [
    row.statement,
    row.context,
    section(CLAIM_CSV_HEADINGS.conditions, bullets(row.conditions)),
    section(CLAIM_CSV_HEADINGS.exceptions, bullets(row.exceptions)),
    section(CLAIM_CSV_HEADINGS.value, row.value ? [row.value] : []),
    section(CLAIM_CSV_HEADINGS.feature, [row.featureName]),
    section(CLAIM_CSV_HEADINGS.questionExamples, row.questionExamples),
    section(CLAIM_CSV_HEADINGS.searchAliases, row.searchAliases),
  ]
    .filter(Boolean)
    .join('\n\n');
}
