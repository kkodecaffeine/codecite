// 수동 연결(설정 manualLinks 파일). 사람이나 에이전트가 근거와 함께 적은 연결을 결정적 연결과 따로 표시해 넣는다
// 모양이 틀리거나 양 끝 심볼이 그래프에 없으면 파일·순번·까닭을 밝혀 멈춘다
import { readFile } from 'node:fs/promises';
import type { CrossRepositoryRelation } from '../../extensions/code-knowledge.js';
import { portablePath } from '../files.js';
import { redactSecretLiterals } from '../redaction.js';
import type { GraphConfig, ManualLink } from '../types.js';
import { CROSS_REPOSITORY_RELATIONS } from '../data/constants.js';
import { MANUAL_LINK_END_KEYS, MANUAL_LINK_KEYS } from './constants.js';
import { type LinkContext, rolesFor } from './context.js';
import type { LinkDraft, ManualLinkSet } from './types.js';

/** 수동 연결 오류. 파일(설정 폴더 기준), 순번(파일 전체 오류면 비움), 까닭 */
export class ManualLinkError extends Error {
  constructor(
    readonly file: string,
    readonly index: number | undefined,
    readonly reason: string,
  ) {
    super(`${file}${index === undefined ? '' : `[${index}]`}: ${reason}`);
    this.name = 'ManualLinkError';
  }
}

/** 설정 manualLinks 파일을 읽고 모양을 검사한다. 설정에 없으면 undefined */
export async function readManualLinks(
  config: GraphConfig,
): Promise<ManualLinkSet | undefined> {
  if (!config.manualLinks) {
    return undefined;
  }
  const file = portablePath(config.cwd, config.manualLinks);
  let text: string;
  try {
    text = await readFile(config.manualLinks, 'utf8');
  } catch (error) {
    throw new ManualLinkError(
      file,
      undefined,
      `cannot be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ManualLinkError(file, undefined, 'not valid JSON');
  }
  return { file, links: parseManualLinks(value, file) };
}

/** 수동 연결 목록의 모양을 검사한다 */
export function parseManualLinks(value: unknown, file: string): ManualLink[] {
  if (!Array.isArray(value)) {
    throw new ManualLinkError(file, undefined, 'must be a JSON array of links');
  }
  return value.map((item, index) => {
    const fail = (reason: string): never => {
      throw new ManualLinkError(file, index, reason);
    };
    const link = objectOf(item) ?? fail('must be an object');
    const unknown = Object.keys(link).filter(
      (key) => !MANUAL_LINK_KEYS.includes(key),
    );
    if (unknown.length > 0) {
      fail(`unknown field ${unknown.join(', ')}`);
    }
    if (
      !CROSS_REPOSITORY_RELATIONS.includes(
        link.relation as CrossRepositoryRelation,
      )
    ) {
      fail(`relation must be one of ${CROSS_REPOSITORY_RELATIONS.join(', ')}`);
    }
    const from = linkEnd(link.from, 'from', fail);
    const to = linkEnd(link.to, 'to', fail);
    if (from.repository === to.repository) {
      fail(
        `both ends are in ${from.repository}; a cross-repository link needs two repositories`,
      );
    }
    if (typeof link.evidence !== 'string' || link.evidence.trim() === '') {
      fail('evidence must be a non-empty string that says why the link holds');
    }
    if (link.author !== undefined && typeof link.author !== 'string') {
      fail('author must be a string');
    }
    return {
      relation: link.relation as CrossRepositoryRelation,
      from,
      to,
      evidence: link.evidence as string,
      ...(typeof link.author === 'string' && link.author.trim() !== ''
        ? { author: link.author }
        : {}),
    };
  });
}

/** 수동 연결을 간선 초안으로 바꾼다. 양 끝이 레코드에 없으면 멈춘다. 신뢰도는 high, extraction.kind 는 manual 이다 */
export function manualLinkDrafts(
  context: LinkContext,
  set: ManualLinkSet,
): LinkDraft[] {
  return set.links.map((link, index) => {
    const end = (side: 'from' | 'to') => {
      const place = link[side];
      if (!context.repositories.includes(place.repository)) {
        throw new ManualLinkError(
          set.file,
          index,
          `${side} repository ${place.repository} is not in the graph`,
        );
      }
      const record = context.recordAt(
        place.repository,
        place.filePath,
        place.symbol,
      );
      if (!record) {
        throw new ManualLinkError(
          set.file,
          index,
          `${side} ${place.repository} ${place.filePath} ${place.symbol} is not a symbol in the graph`,
        );
      }
      return record;
    };
    const source = end('from');
    const target = end('to');
    const roles = rolesFor(link.relation, source, target);
    return {
      relation: link.relation,
      source,
      target,
      extraction: {
        kind: 'manual',
        locator: `${set.file}[${index}]`,
        value: `${source.symbol} → ${target.symbol}`,
      },
      confidence: 'high',
      evidence: [
        redactSecretLiterals(link.evidence.trim()),
        ...(link.author ? [`written by ${link.author}`] : []),
      ],
      ...(roles ? { roles } : {}),
    };
  });
}

function linkEnd(
  value: unknown,
  side: string,
  fail: (reason: string) => never,
): ManualLink['from'] {
  const end = objectOf(value) ?? fail(`${side} must be an object`);
  const unknown = Object.keys(end).filter(
    (key) => !MANUAL_LINK_END_KEYS.includes(key),
  );
  if (unknown.length > 0) {
    fail(`unknown field ${side}.${unknown.join(`, ${side}.`)}`);
  }
  for (const key of MANUAL_LINK_END_KEYS) {
    if (typeof end[key] !== 'string' || end[key].trim() === '') {
      fail(`${side}.${key} must be a non-empty string`);
    }
  }
  const filePath = end.filePath as string;
  if (
    filePath.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(filePath) ||
    filePath.split(/[\\/]/).includes('..')
  ) {
    fail(`${side}.filePath must be a path inside the repository`);
  }
  return {
    repository: end.repository as string,
    filePath,
    symbol: end.symbol as string,
  };
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
