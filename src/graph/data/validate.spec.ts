import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CrossRepositoryGraph,
  EntityRelationGraph,
  EntityRelationKind,
  ExecutionFact,
  FieldWriterIndex,
  SystemTopologyGraph,
} from '../../extensions/code-knowledge.js';
import { parseGraphConfig } from '../config.js';
import { detectionsArtifact, sortDetections } from '../detect.js';
import {
  formatJson,
  latestCommittedAt,
  symbolsFilePath,
  writeGraphOutputs,
} from '../output.js';
import { buildRepositoryRecords } from '../records.js';
import { buildSystemTopology } from '../topology.js';
import type {
  Detection,
  ExtractedSymbol,
  GraphBuildState,
  GraphConfig,
  GraphManifest,
  ManualLink,
  RepositoryBuild,
} from '../types.js';
import { buildDataGraphArtifacts } from './index.js';
import type { GraphValidationCheck, GraphValidationResult } from './types.js';
import { validateGraphOutput } from './validate.js';

const COMMITS: Record<string, [string, string]> = {
  'shop-api': ['e'.repeat(40), '2026-11-10T01:00:00.000Z'],
  'shop-web': ['f'.repeat(40), '2026-11-11T02:30:00.000Z'],
};

/** 비밀값 모양은 소스에 글자 그대로 두지 않고 실행할 때 만든다(비밀값 검사 도구가 소스를 훑는다) */
function fakeGithubToken(): string {
  const pool = 'AbCdEfGhJkMnPqRsTuVwXyZ23456789';
  let body = '';
  for (let index = 0; index < 36; index += 1) {
    body += pool[(index * 7 + 3) % pool.length];
  }
  return ['gh', 'p_', body].join('');
}

function symbol(
  filePath: string,
  name: string,
  kind: string,
  line: number,
  facts?: ExecutionFact[],
): ExtractedSymbol {
  return {
    filePath,
    language: 'typescript',
    symbol: name,
    kind,
    content: `// ${name}`,
    lineStart: line,
    lineEnd: line + 6,
    relations: [],
    ...(facts ? { executionFacts: facts } : {}),
  };
}

const SYMBOLS: Record<string, ExtractedSymbol[]> = {
  'shop-api': [
    symbol('src/coupon/coupon.entity.ts', 'Coupon', 'entity', 2),
    symbol(
      'src/order/order.controller.ts',
      'OrderController.cancel',
      'method',
      8,
    ),
    symbol('src/order/order.entity.ts', 'Order', 'entity', 3),
    symbol('src/order/order.entity.ts', 'Order.cancel', 'method', 12, [
      { line: 13, kind: 'assigns', subject: 'this.status', value: '<literal>' },
    ]),
  ],
  'shop-web': [symbol('src/order/cancel.ts', 'cancelOrder', 'function', 1)],
};

function detectionBase(filePath: string, name: string, line: number) {
  return {
    repository: 'shop-api',
    filePath,
    symbol: name,
    line,
    detector: 'typeorm',
    confidence: 0.95,
    evidence: `@Entity ${name}`,
  };
}

const DETECTIONS: Detection[] = sortDetections([
  {
    ...detectionBase('src/order/order.entity.ts', 'Order', 3),
    kind: 'entity-declaration',
    table: 'orders',
    className: 'Order',
    columns: [{ name: 'status' }, { name: 'couponId' }],
    relations: [],
  },
  {
    ...detectionBase('src/coupon/coupon.entity.ts', 'Coupon', 2),
    kind: 'entity-declaration',
    table: 'coupons',
    className: 'Coupon',
    columns: [{ name: 'discount' }],
    relations: [],
  },
]);

function build(name: string): RepositoryBuild {
  const [commitSha, committedAt] = COMMITS[name];
  const { records } = buildRepositoryRecords(SYMBOLS[name], {
    repository: name,
    commitSha,
    committedAt,
    groups: {},
  });
  return {
    snapshot: {
      repository: name,
      branch: 'main',
      commitSha,
      committedAt,
      reused: false,
    },
    manifest: {
      name,
      branch: 'main',
      commitSha,
      committedAt,
      inputFingerprint: 'sha256:0',
      symbolsFile: symbolsFilePath(name),
      symbolCount: records.length,
      fileCount: SYMBOLS[name].length,
      skippedFiles: {
        floor: 0,
        defaultExcludes: 0,
        exclude: 0,
        notIncluded: 0,
        unsupported: 0,
        binary: 0,
        tooLarge: 0,
      },
      failures: [],
    },
    records,
    extracted: SYMBOLS[name],
  };
}

const location = (
  repository: string,
  filePath: string,
  name: string,
  line: number,
) => ({
  repository,
  filePath,
  symbol: name,
  lineStart: line,
  lineEnd: line + 6,
});

const crossGraph = (): CrossRepositoryGraph => ({
  schemaVersion: 1,
  generatedAt: COMMITS['shop-web'][1],
  repositories: ['shop-api', 'shop-web'],
  nodes: [
    {
      id: 'caller:shop-web:cancelOrder',
      repositories: ['shop-web'],
      symbols: ['cancelOrder'],
      recordTypes: ['current_symbol'],
    },
    {
      id: 'route:shop-api:POST /orders/:id/cancel',
      repositories: ['shop-api'],
      symbols: ['OrderController.cancel'],
      recordTypes: ['current_symbol'],
    },
  ],
  edges: [
    {
      id: 'manual:0',
      relation: 'HTTP_CALLS',
      source: 'caller:shop-web:cancelOrder',
      target: 'route:shop-api:POST /orders/:id/cancel',
      extraction: {
        kind: 'manual',
        locator: 'graph.links.json',
        value: 'POST /orders/:id/cancel',
      },
      confidence: 'medium',
      evidence: ['주소가 런타임 설정에서 오지만 이 경로만 쓴다'],
      sourceLocation: location(
        'shop-web',
        'src/order/cancel.ts',
        'cancelOrder',
        1,
      ),
      targetLocation: location(
        'shop-api',
        'src/order/order.controller.ts',
        'OrderController.cancel',
        8,
      ),
      handlerChain: [
        location('shop-api', 'src/order/order.entity.ts', 'Order.cancel', 12),
      ],
    },
  ],
});

let root: string;
let output: string;
let config: GraphConfig;

async function writeGoodOutput(): Promise<void> {
  const repositories = Object.keys(COMMITS).sort().map(build);
  const state: GraphBuildState = {
    config,
    repositories,
    records: repositories.flatMap((item) => item.records),
    detections: new Map([
      ['shop-api', DETECTIONS],
      ['shop-web', []],
    ]),
    artifacts: new Map(),
  };
  const artifacts = new Map<string, unknown>([
    ['detections.json', detectionsArtifact(state)],
    ['topology.json', buildSystemTopology(state, state.detections)],
    ['cross-repository.json', crossGraph()],
    ['report.json', { unresolved: [] }],
    ...Object.entries(buildDataGraphArtifacts(state)),
  ]);
  await writeGraphOutputs(output, {
    manifest: {
      schemaVersion: 1,
      generatedAt: latestCommittedAt(repositories.map((item) => item.manifest)),
      tool: { name: 'codecite', version: '0.0.0' },
      configFingerprint: 'sha256:12',
      repositories: repositories.map((item) => item.manifest),
    },
    symbols: new Map(
      repositories.map((item) => [item.manifest.name, item.records]),
    ),
    artifacts,
  });
  await writeFile(
    join(root, 'graph.links.json'),
    formatJson([
      {
        relation: 'HTTP_CALLS',
        from: {
          repository: 'shop-web',
          filePath: 'src/order/cancel.ts',
          symbol: 'cancelOrder',
        },
        to: {
          repository: 'shop-api',
          filePath: 'src/order/order.controller.ts',
          symbol: 'OrderController.cancel',
        },
        evidence: 'shop-web 의 취소 버튼은 이 경로만 부른다',
      },
    ]),
  );
}

/** 결과 파일 이름 → 그 파일의 계약 모양. 테스트가 결과 파일을 손으로 고쳐 볼 때 쓴다 */
interface EditableFiles {
  'entities.json': EntityRelationGraph;
  'topology.json': SystemTopologyGraph;
  'cross-repository.json': CrossRepositoryGraph;
  'field-writers.json': FieldWriterIndex;
  'manifest.json': GraphManifest;
  'graph.links.json': ManualLink[];
}

async function edit<Name extends keyof EditableFiles>(
  name: Name,
  change: (value: EditableFiles[Name]) => unknown,
): Promise<void> {
  const path =
    name === 'graph.links.json' ? join(root, name) : join(output, name);
  const value = JSON.parse(await readFile(path, 'utf8'));
  change(value);
  await writeFile(path, formatJson(value));
}

const checksOf = (
  result: GraphValidationResult,
  level: 'errors' | 'warnings' = 'errors',
) => [...new Set(result[level].map((issue) => issue.check))].sort();

const issuesOf = (result: GraphValidationResult, check: GraphValidationCheck) =>
  result.errors.filter((issue) => issue.check === check);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codecite-validate-'));
  output = join(root, 'graph');
  config = parseGraphConfig(
    {
      output: 'graph',
      repositories: Object.keys(COMMITS).map((name) => ({
        name,
        url: `https://example.com/${name}.git`,
      })),
      manualLinks: 'graph.links.json',
    },
    root,
  );
  await writeGoodOutput();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('validateGraphOutput: 통과', () => {
  it('만든 그대로의 결과 폴더는 오류도 경고도 없다', async () => {
    const result = await validateGraphOutput(output, { config });

    expect(result).toEqual({ ok: true, errors: [], warnings: [] });
  });

  it('설정 없이도 결과 폴더만으로 검사한다', async () => {
    expect((await validateGraphOutput(output)).ok).toBe(true);
  });
});

describe('validateGraphOutput: 실패', () => {
  it('manifest 가 없으면 결과 폴더가 아니다', async () => {
    await rm(join(output, 'manifest.json'));
    const result = await validateGraphOutput(output);

    expect(result.ok).toBe(false);
    expect(checksOf(result)).toEqual(['missing']);
  });

  it('심볼 파일이 없으면 오류, 뒤 단계 결과 파일이 없으면 경고다', async () => {
    await rm(join(output, 'symbols/shop-web.jsonl'));
    await rm(join(output, 'field-writers.json'));
    const result = await validateGraphOutput(output);

    expect(issuesOf(result, 'missing')).toEqual([
      {
        check: 'missing',
        file: 'symbols/shop-web.jsonl',
        message: 'symbols of shop-web are missing',
      },
    ]);
    // 빠진 저장소의 심볼을 가리키던 노드와 수동 연결 끝도 함께 알린다
    expect(checksOf(result)).toEqual(['manual-link', 'missing', 'reference']);
    expect(checksOf(result, 'warnings')).toEqual(['missing']);
  });

  it('계약 모양과 다른 값을 자리와 함께 알린다', async () => {
    await edit('entities.json', (graph) => {
      graph.tables[0].relations = [
        {
          targetTable: 'coupons',
          kind: 'sideways' as EntityRelationKind,
          source: 'naming',
        },
      ];
    });
    await edit('topology.json', (graph) => {
      Reflect.deleteProperty(graph.nodes[0], 'name');
    });
    const result = await validateGraphOutput(output);
    const messages = issuesOf(result, 'shape').map(
      (issue) => `${issue.file} ${issue.message}`,
    );

    expect(messages).toContain(
      'entities.json tables[0].relations[0].kind: must be one of many-to-one, one-to-one, one-to-many, many-to-many',
    );
    expect(
      messages.some((message) =>
        message.startsWith('topology.json nodes[0].name'),
      ),
    ).toBe(true);
  });

  it('간선 끝, 코드 자리, 필드 쓰기의 심볼 id 가 가리키는 것이 없으면 참조 오류다', async () => {
    await edit('topology.json', (graph) => {
      graph.edges[0].to =
        'symbol:shop-api:src/order/order.entity.ts#Order.refund';
    });
    await edit('cross-repository.json', (graph) => {
      graph.edges[0].target = 'route:shop-api:DELETE /orders';
      graph.edges[0].handlerChain![0].filePath = 'src/order/refund.ts';
    });
    await edit('field-writers.json', (index) => {
      index.writers['shop-api:status'][0].symbolId = '0'.repeat(64);
    });
    const result = await validateGraphOutput(output);
    const messages = issuesOf(result, 'reference').map(
      (issue) => `${issue.file} ${issue.message}`,
    );

    expect(messages).toEqual(
      expect.arrayContaining([
        'topology.json edges[0] points to missing node symbol:shop-api:src/order/order.entity.ts#Order.refund',
        'cross-repository.json edges[0] points to route:shop-api:DELETE /orders, which is neither a node nor a symbol record',
        'cross-repository.json edges[0].handlerChain[0]: shop-api src/order/refund.ts is not in the graph',
        'field-writers.json writers.shop-api:status[0] symbolId does not match a symbol record',
      ]),
    );
  });

  it('수동 연결의 끝 심볼이 없으면 실패한다', async () => {
    await edit('cross-repository.json', (graph) => {
      graph.edges[0].sourceLocation!.symbol = 'cancelOrderLater';
    });
    await edit('graph.links.json', (links) => {
      links[0].to.symbol = 'OrderController.remove';
    });
    const result = await validateGraphOutput(output, { config });

    expect(issuesOf(result, 'manual-link').map((issue) => issue.file)).toEqual([
      'cross-repository.json',
      'graph.links.json',
    ]);
  });

  it('절대 경로를 찾는다: 경로 필드의 POSIX 뿌리, 집 폴더, 윈도 드라이브, 이 컴퓨터의 임시 폴더', async () => {
    await edit('manifest.json', (manifest) => {
      manifest.repositories[0].failures = [
        { filePath: '/srv/shop-api/src/a.ts', message: 'parse failed' },
        {
          filePath: 'src/b.ts',
          message: 'see /Users/dotori/work/shop-api/src/b.ts',
        },
      ];
    });
    await edit('topology.json', (graph) => {
      graph.sources = [
        { kind: 'extractor:typescript', artifact: 'C:\\dotori\\graph.json' },
      ];
      graph.nodes[0].evidence = [
        `cached at ${join(tmpdir(), 'codecite-graph-x', 'a.ts')}`,
      ];
    });
    const result = await validateGraphOutput(output);
    const paths = issuesOf(result, 'absolute-path').map(
      (issue) => `${issue.file} ${issue.message.split(':')[0]}`,
    );

    expect(paths).toEqual(
      expect.arrayContaining([
        'manifest.json repositories[0].failures[0].filePath',
        'manifest.json repositories[0].failures[1].message',
        'topology.json sources[0].artifact',
        'topology.json nodes[0].evidence[0]',
      ]),
    );
  });

  it('라우트 경로와 저장소 원문의 흔한 경로 글은 절대 경로로 보지 않는다', async () => {
    await edit('cross-repository.json', (graph) => {
      graph.edges[0].extraction.value = 'GET /home/banner/list';
    });
    const result = await validateGraphOutput(output);

    expect(issuesOf(result, 'absolute-path')).toEqual([]);
  });

  it('비밀값 모양을 찾고 메시지에는 값을 싣지 않는다', async () => {
    const token = fakeGithubToken();
    await edit('field-writers.json', (index) => {
      index.writers['shop-api:status'][0].valueSummary = token;
    });
    await edit('topology.json', (graph) => {
      graph.nodes[1].evidence = [
        'GET https://shop:hunter-two@api.example.com/orders',
      ];
    });
    const result = await validateGraphOutput(output);
    const secrets = issuesOf(result, 'secret');

    expect(secrets.map((issue) => issue.file)).toEqual([
      'topology.json',
      'field-writers.json',
    ]);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('hunter-two');
  });

  it('이미 가린 표시와 해시 값은 비밀값으로 보지 않는다', async () => {
    await edit('field-writers.json', (index) => {
      index.writers['shop-api:status'][0].valueSummary =
        'sign(<redacted>, [REDACTED]) + https://shop:<redacted>@api.example.com';
    });
    const result = await validateGraphOutput(output);

    expect(issuesOf(result, 'secret')).toEqual([]);
  });

  it('정한 순서·형식과 다르면 첫 차이 자리를 알린다', async () => {
    await edit('entities.json', (graph) => {
      graph.tables.reverse();
    });
    const topology = await readFile(join(output, 'topology.json'), 'utf8');
    await writeFile(
      join(output, 'topology.json'),
      JSON.stringify(JSON.parse(topology)),
    );
    const symbols = await readFile(
      join(output, 'symbols/shop-api.jsonl'),
      'utf8',
    );
    await writeFile(
      join(output, 'symbols/shop-api.jsonl'),
      symbols.trim().split('\n').reverse().join('\n') + '\n',
    );
    const result = await validateGraphOutput(output);

    expect(
      issuesOf(result, 'order').map(
        (issue) => `${issue.file} ${issue.message}`,
      ),
    ).toEqual([
      'symbols/shop-api.jsonl line 1 is not in the fixed order or format; build again instead of editing it by hand',
      'topology.json is not in the fixed JSON format (two-space indent, trailing newline); build again',
      'entities.json is not in the fixed order (first difference at tables[0].table); build again instead of editing it by hand',
    ]);
  });

  it('파일 사이 값이 맞지 않으면 알린다', async () => {
    await edit('manifest.json', (manifest) => {
      manifest.repositories[1].symbolCount = 3;
    });
    await edit('entities.json', (graph) => {
      graph.generatedAt = '2026-01-01T00:00:00.000Z';
    });
    const result = await validateGraphOutput(output);

    expect(issuesOf(result, 'consistency')).toEqual([
      {
        check: 'consistency',
        file: 'symbols/shop-web.jsonl',
        message: 'has 1 records but manifest.json says 3',
      },
    ]);
    expect(
      result.warnings.map((issue) => `${issue.check} ${issue.file}`),
    ).toEqual(['consistency entities.json']);
  });
});
