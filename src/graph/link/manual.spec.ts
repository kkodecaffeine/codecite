import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGraphConfig } from '../config.js';
import {
  ManualLinkError,
  parseManualLinks,
  readManualLinks,
} from './manual.js';

const valid = {
  relation: 'PUBLISHES_TO_QUEUE',
  from: {
    repository: 'shop-api',
    filePath: 'src/review/review.service.ts',
    symbol: 'ReviewService.post',
  },
  to: {
    repository: 'shop-worker',
    filePath: 'shop_worker/reviews.py',
    symbol: 'on_review',
  },
  evidence: 'queue name is read from settings; both sides use the review queue',
};

describe('parseManualLinks', () => {
  it('모양이 맞으면 그대로 돌려주고 빈 작성자는 뺀다', () => {
    expect(
      parseManualLinks([{ ...valid, author: ' ' }], 'graph.links.json'),
    ).toEqual([valid]);
  });

  it('틀린 모양은 파일과 순번, 까닭을 밝혀 멈춘다', () => {
    const cases: Array<[unknown, string]> = [
      [{}, 'graph.links.json: must be a JSON array of links'],
      [[valid, 'x'], 'graph.links.json[1]: must be an object'],
      [
        [{ ...valid, relation: 'CALLS' }],
        'graph.links.json[0]: relation must be one of',
      ],
      [[{ ...valid, note: 'x' }], 'graph.links.json[0]: unknown field note'],
      [
        [{ ...valid, to: { ...valid.to, symbol: '' } }],
        'graph.links.json[0]: to.symbol must be a non-empty string',
      ],
      [
        [
          {
            ...valid,
            from: { ...valid.from, filePath: '../shop-api/src/x.ts' },
          },
        ],
        'graph.links.json[0]: from.filePath must be a path inside the repository',
      ],
      [
        [{ ...valid, to: { ...valid.to, repository: 'shop-api' } }],
        'graph.links.json[0]: both ends are in shop-api',
      ],
      [
        [{ ...valid, evidence: '  ' }],
        'graph.links.json[0]: evidence must be a non-empty string',
      ],
    ];
    for (const [value, message] of cases) {
      expect(() => parseManualLinks(value, 'graph.links.json')).toThrow(
        ManualLinkError,
      );
      expect(() => parseManualLinks(value, 'graph.links.json')).toThrow(
        message,
      );
    }
  });
});

describe('readManualLinks', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'codecite-links-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const config = (manualLinks?: string) =>
    parseGraphConfig(
      {
        repositories: [
          { name: 'shop-api', url: 'https://example.com/shop-api.git' },
        ],
        ...(manualLinks ? { manualLinks } : {}),
      },
      root,
    );

  it('설정에 없으면 undefined, 있으면 설정 폴더 기준 상대 경로와 함께 읽는다', async () => {
    expect(await readManualLinks(config())).toBeUndefined();
    await writeFile(join(root, 'graph.links.json'), JSON.stringify([valid]));
    expect(await readManualLinks(config('graph.links.json'))).toEqual({
      file: 'graph.links.json',
      links: [valid],
    });
  });

  it('파일이 없거나 JSON 이 아니면 절대 경로 없이 멈춘다', async () => {
    await expect(readManualLinks(config('missing.json'))).rejects.toThrow(
      'missing.json: cannot be read (ENOENT)',
    );
    await writeFile(join(root, 'broken.json'), '[{');
    await expect(readManualLinks(config('broken.json'))).rejects.toThrow(
      /^broken\.json: not valid JSON$/,
    );
  });
});
