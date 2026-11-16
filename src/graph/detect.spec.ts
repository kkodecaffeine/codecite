import { describe, expect, it } from 'vitest';
import { parseGraphConfig } from './config.js';
import {
  detectionsArtifact,
  parseDetectionsArtifact,
  runDetection,
  sortDetections,
} from './detect.js';
import type {
  Detection,
  DetectionPreset,
  ExtractedSymbol,
  GraphBuildState,
  MessageDetection,
  PresetContext,
  RepositoryBuild,
} from './types.js';

const config = parseGraphConfig(
  {
    repositories: [
      { name: 'shop-api', url: 'https://example.com/shop-api.git' },
      { name: 'shop-worker', url: 'https://example.com/shop-worker.git' },
    ],
  },
  '/work/dotori',
);

const symbol = (
  filePath: string,
  name: string,
  extra: Partial<ExtractedSymbol> = {},
): ExtractedSymbol => ({
  filePath,
  language: 'typescript',
  symbol: name,
  kind: 'function',
  content: '',
  lineStart: 1,
  lineEnd: 1,
  relations: [],
  ...extra,
});

function build(
  name: string,
  extracted: ExtractedSymbol[] | undefined,
  previous?: Detection[],
): RepositoryBuild {
  return {
    snapshot: {
      repository: name,
      branch: 'main',
      commitSha: 'a'.repeat(40),
      committedAt: '2026-11-01T09:00:00.000Z',
      reused: extracted === undefined,
    },
    manifest: {
      name,
      branch: 'main',
      commitSha: 'a'.repeat(40),
      committedAt: '2026-11-01T09:00:00.000Z',
      inputFingerprint: 'sha256:0',
      symbolsFile: `symbols/${name}.jsonl`,
      symbolCount: 0,
      fileCount: 0,
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
    records: [],
    ...(extracted ? { extracted } : {}),
    ...(previous ? { previousDetections: { detections: previous } } : {}),
  };
}

const stateOf = (...repositories: RepositoryBuild[]): GraphBuildState => ({
  config,
  repositories,
  records: [],
  detections: new Map(),
  artifacts: new Map(),
});

/** 큐 이름 인자를 받는 `publish(...)` 호출 자리를 발행 탐지로 바꾸는 가짜 프리셋 */
function publishPreset(seen: PresetContext[] = []): DetectionPreset {
  return {
    name: 'acorn-queue',
    languages: ['typescript'],
    detect(item, context) {
      seen.push(context);
      return (item.sites ?? [])
        .filter((site) => site.kind === 'call' && site.name === 'publish')
        .map((site): MessageDetection => {
          const argument = site.args[0];
          const name =
            argument?.literal ??
            (argument?.identifier
              ? context.resolveConstant(argument.identifier)
              : undefined);
          return {
            kind: 'queue-publish',
            repository: 'ignored',
            filePath: 'ignored.ts',
            symbol: item.symbol,
            line: site.line,
            detector: '',
            confidence: name ? 0.9 : 0.5,
            evidence: `publish(${argument?.text ?? ''})`,
            name: name ?? argument?.text ?? '',
            dynamic: name === undefined,
          };
        });
    },
  };
}

const publishSite = (line: number, identifier: string) => ({
  kind: 'call' as const,
  name: 'publish',
  line,
  args: [{ text: identifier, identifier }],
});

describe('runDetection', () => {
  it('언어가 맞는 프리셋을 심볼마다 부르고, 문맥의 symbols 는 저장소마다 같은 배열이다', async () => {
    const seen: PresetContext[] = [];
    const extracted = [
      symbol('src/order/order.queue.ts', 'ORDER_QUEUE', {
        kind: 'constant',
        sites: [
          {
            kind: 'assign',
            name: 'ORDER_QUEUE',
            line: 1,
            args: [{ text: '<literal>', literal: 'order-placed' }],
          },
        ],
      }),
      symbol('src/order/order.service.ts', 'OrderService.place', {
        lineStart: 4,
        sites: [publishSite(6, 'ORDER_QUEUE')],
      }),
      symbol('src/order/legacy.py', 'place_order', {
        language: 'python',
        sites: [publishSite(2, 'ORDER_QUEUE')],
      }),
    ];
    const result = await runDetection(stateOf(build('shop-api', extracted)), [
      publishPreset(seen),
    ]);

    expect(seen).toHaveLength(2);
    expect(seen.every((context) => context.symbols === extracted)).toBe(true);
    expect(seen.every((context) => context.repository === 'shop-api')).toBe(
      true,
    );
    expect(result.get('shop-api')).toEqual([
      {
        kind: 'queue-publish',
        repository: 'shop-api',
        filePath: 'src/order/order.service.ts',
        symbol: 'OrderService.place',
        line: 6,
        detector: 'acorn-queue',
        confidence: 0.9,
        evidence: 'publish(ORDER_QUEUE)',
        dynamic: false,
        name: 'order-placed',
      },
    ]);
  });

  it('resolveConstant 는 지금 보는 심볼의 파일을 먼저 본다', async () => {
    const constant = (filePath: string, value: string) =>
      symbol(filePath, 'QUEUE_NAME', {
        kind: 'constant',
        sites: [
          {
            kind: 'assign',
            name: 'QUEUE_NAME',
            line: 1,
            args: [{ text: '<literal>', literal: value }],
          },
        ],
      });
    const extracted = [
      constant('src/order/order.queue.ts', 'order-placed'),
      symbol('src/order/order.queue.ts', 'sendOrder', {
        lineStart: 3,
        sites: [publishSite(3, 'QUEUE_NAME')],
      }),
      constant('src/refund/refund.queue.ts', 'refund-requested'),
      symbol('src/refund/refund.queue.ts', 'sendRefund', {
        lineStart: 3,
        sites: [publishSite(3, 'QUEUE_NAME')],
      }),
      symbol('src/cart/cart.ts', 'sendCart', {
        sites: [publishSite(1, 'QUEUE_NAME')],
      }),
    ];
    const result = await runDetection(stateOf(build('shop-api', extracted)), [
      publishPreset(),
    ]);
    expect(
      result
        .get('shop-api')
        ?.map((item) => [item.symbol, (item as MessageDetection).name]),
    ).toEqual([
      ['sendCart', 'QUEUE_NAME'],
      ['sendOrder', 'order-placed'],
      ['sendRefund', 'refund-requested'],
    ]);
  });

  it('신뢰도를 0~1 로 자르고, 근거와 값의 비밀값 모양을 가리고, 같은 탐지는 하나로 합친다', async () => {
    const token = ['ghp', 'Acorn'.repeat(6)].join('_');
    const loud: DetectionPreset = {
      name: 'loud',
      detect: (item) => [
        {
          kind: 'schedule',
          repository: 'x',
          filePath: 'x',
          symbol: item.symbol,
          line: 0,
          detector: 'loud',
          confidence: 7,
          evidence: `token ${token}`,
          expression: `0 3 * * * ${token}`,
        },
      ],
    };
    const twin: DetectionPreset = { ...loud, name: 'twin' };
    const result = await runDetection(
      stateOf(
        build('shop-api', [
          symbol('src/points/expire.ts', 'expirePoints', { lineStart: 9 }),
        ]),
      ),
      [loud, twin],
    );
    const [detection] = result.get('shop-api') ?? [];
    expect(result.get('shop-api')).toHaveLength(1);
    expect(detection).toMatchObject({
      repository: 'shop-api',
      filePath: 'src/points/expire.ts',
      line: 9,
      confidence: 1,
    });
    expect(JSON.stringify(detection)).not.toContain(token);
  });

  it('재사용한 저장소는 프리셋을 부르지 않고 지난 탐지 결과를 쓴다', async () => {
    const previous: Detection[] = [
      {
        kind: 'event-handle',
        repository: 'shop-worker',
        filePath: 'shop_worker/review.py',
        symbol: 'on_review_posted',
        line: 4,
        detector: 'acorn-events',
        confidence: 0.9,
        evidence: 'handler',
        name: 'review-posted',
        dynamic: false,
      },
    ];
    const seen: PresetContext[] = [];
    const result = await runDetection(
      stateOf(build('shop-worker', undefined, previous)),
      [publishPreset(seen)],
    );
    expect(seen).toEqual([]);
    expect(result.get('shop-worker')).toEqual(previous);
  });

  it('프리셋이 throw 하거나, 모르는 종류나, 필요한 필드가 없는 결과를 내면 저장소·프리셋·심볼을 밝혀 멈춘다', async () => {
    const state = stateOf(
      build('shop-api', [symbol('src/cart/cart.ts', 'addToCart')]),
    );
    const failing: DetectionPreset = {
      name: 'broken',
      detect() {
        throw new Error('cannot read cart');
      },
    };
    await expect(runDetection(state, [failing])).rejects.toThrow(
      'Repository shop-api: preset broken on src/cart/cart.ts addToCart failed: cannot read cart',
    );
    const unknown: DetectionPreset = {
      name: 'odd',
      detect: () => [{ kind: 'sound' } as unknown as Detection],
    };
    await expect(runDetection(state, [unknown])).rejects.toThrow(
      /preset odd on src\/cart\/cart\.ts addToCart returned an unknown detection kind sound/,
    );
    const partial: DetectionPreset = {
      name: 'partial',
      detect: () => [
        {
          kind: 'http-route',
          confidence: 0.9,
          method: 'GET',
        } as unknown as Detection,
      ],
    };
    await expect(runDetection(state, [partial])).rejects.toThrow(
      /http-route needs path \(string\)/,
    );
    const notArray: DetectionPreset = {
      name: 'single',
      detect: () => ({}) as unknown as Detection[],
    };
    await expect(runDetection(state, [notArray])).rejects.toThrow(
      /must return an array of detections/,
    );
  });
});

describe('sortDetections', () => {
  it('파일 → 줄 → 심볼 → 종류 → 탐지기 순으로 정렬해 들어온 순서와 상관없이 같은 결과를 낸다', () => {
    const base = {
      repository: 'shop-api',
      confidence: 0.9,
      evidence: '',
      dynamic: false,
    };
    const items: Detection[] = [
      {
        ...base,
        kind: 'queue-publish',
        filePath: 'src/b.ts',
        symbol: 'b',
        line: 1,
        detector: 'x',
        name: 'q',
      },
      {
        ...base,
        kind: 'queue-consume',
        filePath: 'src/a.ts',
        symbol: 'a',
        line: 5,
        detector: 'x',
        name: 'q',
      },
      {
        ...base,
        kind: 'queue-consume',
        filePath: 'src/a.ts',
        symbol: 'a',
        line: 2,
        detector: 'x',
        name: 'q',
      },
    ];
    const forward = sortDetections(items);
    expect(forward.map((item) => `${item.filePath}:${item.line}`)).toEqual([
      'src/a.ts:2',
      'src/a.ts:5',
      'src/b.ts:1',
    ]);
    expect(sortDetections([...items].reverse())).toEqual(forward);
  });
});

describe('detections.json', () => {
  const detection: Detection = {
    kind: 'http-route',
    repository: 'shop-api',
    filePath: 'src/order/order.controller.ts',
    symbol: 'OrderController.cancel',
    line: 12,
    detector: 'acorn-http',
    confidence: 0.95,
    evidence: 'POST orders/:id/cancel',
    method: 'POST',
    path: '/orders/:id/cancel',
  };

  it('저장소 이름 순서로 쓰고 다시 읽으면 같다', () => {
    const state = stateOf(
      build('shop-worker', []),
      build('shop-api', [symbol('src/order/order.controller.ts', 'x')]),
    );
    state.detections = new Map([
      ['shop-worker', []],
      ['shop-api', [detection]],
    ]);
    const artifact = detectionsArtifact(state);
    expect(Object.keys(artifact.repositories)).toEqual([
      'shop-api',
      'shop-worker',
    ]);
    const parsed = parseDetectionsArtifact(
      JSON.parse(JSON.stringify(artifact)),
    );
    expect(parsed.get('shop-api')?.detections).toEqual([detection]);
    expect(parsed.get('shop-worker')?.detections).toEqual([]);
  });

  it('다른 저장소의 탐지나 모양이 틀린 파일은 거절한다', () => {
    expect(() =>
      parseDetectionsArtifact({
        schemaVersion: 1,
        repositories: { 'shop-web': { detections: [detection] } },
      }),
    ).toThrow(/belongs to shop-api/);
    expect(() => parseDetectionsArtifact({ schemaVersion: 2 })).toThrow(
      /schemaVersion must be 1/,
    );
    expect(() =>
      parseDetectionsArtifact({
        schemaVersion: 1,
        repositories: {
          'shop-api': { detections: [{ ...detection, path: 3 }] },
        },
      }),
    ).toThrow(/http-route needs path/);
  });
});
