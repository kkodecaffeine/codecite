import { describe, expect, it } from 'vitest';
import { typescriptExtractor } from '../../extractors/typescript.js';
import type {
  ExtractedSymbol,
  GraphConfig,
  HttpCallDetection,
  PresetContext,
} from '../../types.js';
import { AXIOS_PRESET } from './axios.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const config = {
  cwd: '/',
  output: '/out',
  cache: '/cache',
  repositories: [],
  defaultExcludes: [],
  presets: ['axios'],
  hints: {},
  detectors: [],
  entities: { foreignKeySuffixes: [] },
  groups: {},
  extractorModules: [],
  presetModules: [],
} satisfies GraphConfig;

async function calls(
  files: Record<string, string>,
): Promise<HttpCallDetection[]> {
  const result = await typescriptExtractor().extract(
    Object.entries(files).map(([filePath, content]) => ({
      repository: 'shop-web',
      filePath,
      content,
    })),
    { repository: 'shop-web', logger },
  );
  expect(result.failures).toEqual([]);
  const symbols: readonly ExtractedSymbol[] = result.symbols;
  const context: PresetContext = {
    repository: 'shop-web',
    config,
    logger,
    resolveConstant: () => undefined,
    symbols,
  };
  return symbols
    .flatMap((symbol) => AXIOS_PRESET.detect(symbol, context))
    .filter((item): item is HttpCallDetection => item.kind === 'http-call');
}

const HTTP_MODULE = `import axios from 'axios';

export const shopApi = axios.create({
  baseURL: \`\${process.env.SHOP_API_URL}/v1\`,
});
`;

describe('AXIOS_PRESET', () => {
  it('다른 파일에서 axios.create 로 만든 인스턴스의 기준 주소를 붙이고, 파일로 못 푼 가져오기는 같은 이름 하나일 때 낮춰 잇는다', async () => {
    const found = await calls({
      'src/lib/http.ts': HTTP_MODULE,
      'src/orders/order.api.ts': `import { shopApi } from '../lib/http.js';

export async function listOrders() {
  return shopApi.get('/orders', { params: { page: 1 } });
}

export async function addPoints(memberId: string, amount: number) {
  return shopApi.post(\`/members/\${memberId}/points\`, { amount });
}

export function readCached(cache: Map<string, string>) {
  return cache.get('/orders');
}
`,
      'src/coupons/coupon.api.ts': `import { shopApi } from '@/lib/http';

export function removeCoupon() {
  return shopApi.delete('/coupons/welcome');
}
`,
      'src/points/point.api.ts': `import { shopApi } from '@dotori/http-kit';

export function syncPoints() {
  return shopApi.put('/points/sync');
}
`,
    });

    expect(
      found.map((call) => [
        call.symbol,
        call.method,
        call.path,
        call.baseIdentifiers,
        call.dynamic,
        call.confidence,
      ]),
    ).toEqual([
      [
        'removeCoupon',
        'DELETE',
        '/v1/coupons/welcome',
        ['process.env.SHOP_API_URL'],
        false,
        0.9,
      ],
      [
        'listOrders',
        'GET',
        '/v1/orders',
        ['process.env.SHOP_API_URL'],
        false,
        0.9,
      ],
      [
        'addPoints',
        'POST',
        '/v1/members/:param/points',
        ['process.env.SHOP_API_URL'],
        true,
        0.8,
      ],
      [
        'syncPoints',
        'PUT',
        '/v1/points/sync',
        ['process.env.SHOP_API_URL'],
        false,
        0.85,
      ],
    ]);
    expect(found[1]?.evidence).toBe(
      'shopApi.get at line 4; instance from axios.create in shopApi',
    );
  });

  it('axios 모듈 함수와 설정 객체 호출을 읽는다', async () => {
    const found = await calls({
      'src/refunds/refund.api.ts': `import client from 'axios';

export async function refundState(refundId: string) {
  return client.get(\`https://pay.example.com/refunds/\${refundId}\`);
}

export async function cancelOrder(orderId: string) {
  return client({
    url: \`/orders/\${orderId}/cancel\`,
    method: 'post',
    baseURL: process.env.SHOP_API_URL,
  });
}

export async function memo(refundId: string, body: unknown) {
  return client.request({ url: '/refunds/memo', method: body });
}
`,
    });

    expect(
      found.map((call) => [
        call.method,
        call.path,
        call.host,
        call.baseIdentifiers,
      ]),
    ).toEqual([
      ['GET', '/refunds/:param', 'pay.example.com', []],
      [
        'POST',
        '/orders/:param/cancel',
        undefined,
        ['process.env.SHOP_API_URL'],
      ],
      ['*', '/refunds/memo', undefined, []],
    ]);
  });

  it('클래스 필드·생성자 대입·주입 타입으로 인스턴스를 알아본다', async () => {
    const found = await calls({
      'src/coupons/coupon.client.ts': `import { HttpService } from '@nestjs/axios';
import axios, { AxiosInstance } from 'axios';

export class CouponClient {
  private readonly http = axios.create({ baseURL: 'https://shop-api.example.com/api' });
  private readonly backup: AxiosInstance;
  private readonly baseUrl = 'https://shop-worker.example.com';

  constructor(private readonly httpService: HttpService) {
    this.backup = axios.create();
  }

  list() {
    return this.http.get('/coupons');
  }

  issue(couponId: string) {
    return this.httpService.axiosRef.post(\`/coupons/\${couponId}/issue\`);
  }

  peek() {
    return this.httpService.get(\`\${this.baseUrl}/coupons/peek\`);
  }

  ping() {
    return this.backup.head('/ping');
  }
}
`,
    });

    expect(
      found.map((call) => [
        call.symbol,
        call.method,
        call.path,
        call.host,
        call.baseIdentifiers,
      ]),
    ).toEqual([
      ['CouponClient.list', 'GET', '/api/coupons', 'shop-api.example.com', []],
      ['CouponClient.issue', 'POST', '/coupons/:param/issue', undefined, []],
      [
        'CouponClient.peek',
        'GET',
        '/coupons/peek',
        undefined,
        ['this.baseUrl'],
      ],
      ['CouponClient.ping', 'HEAD', '/ping', undefined, []],
    ]);
    expect(found[1]?.evidence).toBe(
      'this.httpService.axiosRef.post at line 18; instance typed HttpService in CouponClient; path partly built at runtime',
    );
  });
});
