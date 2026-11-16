import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { SystemTopologyGraph } from '../../../extensions/code-knowledge.js';
import { parseGraphConfig } from '../../config.js';
import { defaultSymbolExtractors } from '../../extractors/index.js';
import { buildCodeGraph } from '../../pipeline.js';
import type { Detection, DetectionsArtifact } from '../../types.js';
import { GRAPHQL_PRESETS, graphqlDocumentExtractor } from '../graphql/index.js';
import { HTTP_PRESETS } from './index.js';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Dotori Dev',
  GIT_AUTHOR_EMAIL: 'dev@dotori.test',
  GIT_COMMITTER_NAME: 'Dotori Dev',
  GIT_COMMITTER_EMAIL: 'dev@dotori.test',
  GIT_AUTHOR_DATE: '2026-11-02T10:00:00Z',
  GIT_COMMITTER_DATE: '2026-11-02T10:00:00Z',
};

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...IDENTITY },
  });
}

/** 파일을 커밋한 작업 저장소를 만들고, 그 bare 복제본 경로를 돌려준다 */
async function remote(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const work = join(root, `${name}-work`);
  git(root, ['init', '-q', '-b', 'main', work]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'init']);
  const bare = join(root, `${name}.git`);
  git(root, ['clone', '-q', '--bare', work, bare]);
  return bare;
}

let root: string;

beforeAll(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('HTTP·GraphQL 프리셋을 그래프 만들기에 넣으면', () => {
  it('두 저장소의 라우트·호출·리졸버·연산이 탐지 결과와 토폴로지에 남는다', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'codecite-presets-')));
    const api = await remote(root, 'shop-api', {
      'src/orders/order.controller.ts': `import { Controller, Get, Param } from '@nestjs/common';

@Controller('orders')
export class OrderController {
  @Get(':orderId')
  find(@Param('orderId') orderId: string) {
    return orderId;
  }
}
`,
      'src/orders/order.resolver.ts': `import { Args, Query, Resolver } from '@nestjs/graphql';

@Resolver(() => Order)
export class OrderResolver {
  @Query(() => Order, { name: 'order' })
  findOrder(@Args('id') id: string) {
    return id;
  }
}
`,
    });
    const web = await remote(root, 'shop-web', {
      'src/graphql/orders.graphql':
        'query GetOrder($id: ID!) {\n  order(id: $id) { id }\n}\n',
      'src/orders/order.page.tsx': `import { useGetOrderQuery } from '../generated/graphql';

export function OrderPage({ id }) {
  const { data } = useGetOrderQuery({ variables: { id } });
  return data;
}

export function loadOrder(id: string) {
  return fetch(\`/orders/\${id}\`);
}
`,
    });
    await mkdir(join(root, 'graph'));
    const config = parseGraphConfig(
      {
        repositories: [
          { name: 'shop-api', url: api },
          { name: 'shop-web', url: web },
        ],
        presets: ['nestjs', 'fetch', 'graphql-codegen'],
      },
      join(root, 'graph'),
    );

    const result = await buildCodeGraph(config, {
      presets: [...HTTP_PRESETS, ...GRAPHQL_PRESETS],
      extractors: [...defaultSymbolExtractors(), graphqlDocumentExtractor()],
    });
    const detections = JSON.parse(
      await readFile(join(result.output, 'detections.json'), 'utf8'),
    ) as DetectionsArtifact;
    const summary = (items: readonly Detection[]) =>
      items.map((item) => {
        switch (item.kind) {
          case 'http-route':
            return `${item.kind} ${item.symbol} ${item.method} ${item.path}`;
          case 'http-call':
            return `${item.kind} ${item.symbol} ${item.method} ${item.path ?? ''}`;
          case 'graphql-resolver':
            return `${item.kind} ${item.symbol} ${item.operationType} ${item.field}`;
          case 'graphql-document':
          case 'graphql-client-call':
            return `${item.kind} ${item.symbol} ${item.operationName}`;
          default:
            return item.kind;
        }
      });

    expect(
      summary(detections.repositories['shop-api']?.detections ?? []),
    ).toEqual([
      'http-route OrderController.find GET /orders/:param',
      'graphql-resolver OrderResolver.findOrder query order',
    ]);
    expect(
      summary(detections.repositories['shop-web']?.detections ?? []),
    ).toEqual([
      'graphql-document GetOrder GetOrder',
      'graphql-client-call OrderPage GetOrder',
      'http-call loadOrder GET /orders/:param',
    ]);

    const topology = JSON.parse(
      await readFile(join(result.output, 'topology.json'), 'utf8'),
    ) as SystemTopologyGraph;
    const names = topology.nodes
      .filter((node) => node.type === 'API' || node.type === 'GraphQLOperation')
      .map((node) => `${node.type} ${node.name}`);
    expect(names).toEqual(
      expect.arrayContaining([
        'API GET /orders/:param',
        'GraphQLOperation Query:order',
      ]),
    );
  });
});
