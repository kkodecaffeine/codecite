import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectPolicyChunks } from '../domain/chunk-projector.js';
import { stablePolicyClaimId } from '../domain/policy-claim.js';
import { publicPolicyEvidenceText } from '../generation/evidence.js';
import {
  CsvFormatError,
  csvPolicySource,
  parseCsvRecords,
  policiesFromClaimCsv,
} from './csv-policy-source.js';

const HEADER =
  'policy_group,feature_name,claim_statement,claim_facet,claim_id,claim_confidence,claim_conditions,claim_exceptions,claim_value,user_question_examples,search_aliases,context_text,source,memo';

const acornCsv = [
  HEADER,
  [
    'points',
    '적립금 소멸',
    '도토리 적립금은 쌓인 날부터 2 년이 지나면 소멸한다.',
    'expiration',
    '',
    '',
    '"[""구매 확정으로 쌓인 적립금""]"',
    '',
    '적립일부터 2 년',
    '"적립금 언제 없어져요?\n도토리 포인트 기한"',
    '도토리 포인트',
    '',
    'https://help.dotori.test/points#expire',
    '편집자 메모는 읽지 않는다',
  ].join(','),
  [
    'Coupon',
    '쿠폰 함께 쓰기',
    '상품 쿠폰과 장바구니 쿠폰은 한 주문에 하나씩 함께 쓸 수 있다.',
    'ELIGIBILITY',
    'coupon-stack',
    'low',
    '',
    '특가 상품에는 장바구니 쿠폰을 쓸 수 없다',
    '',
    '',
    '',
    '"쿠폰은 결제 화면에서 고른다.\n\n[처리 순서]\n1. 상품 쿠폰을 먼저 깎는다\n2. 남은 금액에 장바구니 쿠폰을 쓴다"',
    '',
    '',
  ].join(','),
].join('\n');

describe('parseCsvRecords', () => {
  it('BOM, CRLF, 따옴표 안 쉼표·줄바꿈·겹따옴표를 읽고 기록마다 시작 줄을 센다', () => {
    const records = parseCsvRecords(
      '﻿name,note\r\n"택배, 퀵","첫째 줄\r\n둘째 줄"\r\n"판매자가 ""당일 출고""라고 적음",x\r\nend,row',
    );

    expect(records).toEqual([
      { cells: ['name', 'note'], row: 1, line: 1 },
      { cells: ['택배, 퀵', '첫째 줄\r\n둘째 줄'], row: 2, line: 2 },
      { cells: ['판매자가 "당일 출고"라고 적음', 'x'], row: 3, line: 4 },
      { cells: ['end', 'row'], row: 4, line: 5 },
    ]);
  });

  it('CR 만 쓰는 줄바꿈, 빈 칸, 빈 따옴표 칸을 지킨다', () => {
    expect(
      parseCsvRecords('a,b,\r"",c,\n').map((record) => record.cells),
    ).toEqual([
      ['a', 'b', ''],
      ['', 'c', ''],
    ]);
  });

  it('따옴표로 시작하지 않은 칸 안의 따옴표는 글자로 읽는다', () => {
    expect(
      parseCsvRecords('5"x7" 액자,2').map((record) => record.cells),
    ).toEqual([['5"x7" 액자', '2']]);
  });

  it('닫히지 않은 따옴표는 그 기록의 행과 시작 줄을 알려 주며 throw 한다', () => {
    const parse = () =>
      parseCsvRecords('a,b\n"여러 줄\n칸",x\nc,"끝나지 않음\nd,e', 'acorn.csv');

    expect(parse).toThrow(CsvFormatError);
    expect(parse).toThrow(
      'acorn.csv row 3 (line 4): a quoted cell is not closed',
    );
  });

  it('닫는 따옴표 뒤에 글자가 오면 throw 한다', () => {
    expect(() => parseCsvRecords('a,b\n"상자" 두 개,x', 'acorn.csv')).toThrow(
      'acorn.csv row 2: unexpected text after a closing quote at line 2',
    );
  });
});

describe('policiesFromClaimCsv', () => {
  it('행마다 claim 하나를 가진 활성 정책을 만들고 모르는 열은 무시한다', () => {
    const [points, coupon] = policiesFromClaimCsv(acornCsv, {
      file: '/data/acorn.csv',
    });

    expect(points.isActive()).toBe(true);
    expect(points.name).toBe('적립금 소멸');
    expect(points.decision).toBe(
      '도토리 적립금은 쌓인 날부터 2 년이 지나면 소멸한다.',
    );
    expect(points.section).toBe('points');
    expect(points.policyGroup).toBe('points');
    expect(points.source).toBe('acorn.csv#row-2');
    expect(points.policyClaims).toHaveLength(1);
    expect(points.policyClaims[0]).toMatchObject({
      schemaVersion: 2,
      policyGroup: 'points',
      facet: 'expiration',
      confidence: 'high',
      sourceKind: 'policy',
      knowledgeKind: 'user-policy',
      subject: '적립금 소멸',
      predicate: 'expiration',
      value: '적립일부터 2 년',
      conditions: ['구매 확정으로 쌓인 적립금'],
      exceptions: [],
      userQuestionExamples: ['적립금 언제 없어져요?', '도토리 포인트 기한'],
      searchAliases: ['도토리 포인트'],
    });
    expect(points.toKnowledgeText()).not.toContain('편집자 메모');

    expect(coupon.section).toBe('Coupon');
    expect(coupon.policyGroup).toBe('coupon');
    expect(coupon.policyClaims[0]).toMatchObject({
      claimId: 'coupon-stack',
      facet: 'eligibility',
      confidence: 'low',
      exceptions: ['특가 상품에는 장바구니 쿠폰을 쓸 수 없다'],
    });
    // 값을 비우면 claim 문장이 값이 된다
    expect(coupon.policyClaims[0].value).toBe(coupon.decision);
  });

  it('claim_id 를 비우면 묶음·종류·문장 해시로 만들어 행이 움직여도 같다', () => {
    const [header, first, second] = acornCsv.split(/\n(?=Coupon|points)/u);
    const moved = policiesFromClaimCsv([header, second, first].join('\n'));
    const original = policiesFromClaimCsv(acornCsv);

    const expected = stablePolicyClaimId({
      policyGroup: 'points',
      facet: 'expiration',
      statement: '도토리 적립금은 쌓인 날부터 2 년이 지나면 소멸한다.',
    });
    expect(original[0].policyClaims[0].claimId).toBe(expected);
    expect(moved[1].policyClaims[0].claimId).toBe(expected);
    expect(original[0].code.toString()).toBe(expected);
    // 행 위치는 내부 출처에만 남는다
    expect(moved[1].source).toBe('claims.csv#row-3');
  });

  it('claim_facet 을 비우면 claim 문장에서 추론한다', () => {
    const [policy] = policiesFromClaimCsv(
      [
        'policy_group,feature_name,claim_statement',
        'shipping,늦은 출고 보상,출고가 사흘 넘게 늦어지면 배송비를 되돌려준다.',
      ].join('\n'),
    );

    expect(policy.policyClaims[0].facet).toBe('reversal');
  });

  it('source 열이 있을 때만 인용해도 되는 출처로 표시한다', () => {
    const [points, coupon] = policiesFromClaimCsv(acornCsv);

    expect(points.policyClaims[0].provenance).toEqual([
      {
        sourceId: 'claims.csv#row-2',
        sourceKind: 'policy',
        sourceLabel: 'https://help.dotori.test/points#expire',
        publicAnswerSafe: true,
      },
    ]);
    expect(coupon.policyClaims[0].provenance).toEqual([
      {
        sourceId: 'claims.csv#row-3',
        sourceKind: 'policy',
        sourceLabel: 'claims.csv#row-3',
        publicAnswerSafe: false,
      },
    ]);
  });

  it('조각으로 나누면 문장·조건·예외는 근거 글에, 질문 예시·검색 표현은 검색 글에만 들어간다', () => {
    const [points, coupon] = policiesFromClaimCsv(acornCsv);
    const [chunk] = projectPolicyChunks(points);

    expect(chunk.text).toContain(
      '도토리 적립금은 쌓인 날부터 2 년이 지나면 소멸한다.',
    );
    expect(chunk.text).toContain('[적용 조건]\n- 구매 확정으로 쌓인 적립금');
    expect(chunk.text).toContain('[값]\n적립일부터 2 년');
    expect(chunk.text.startsWith('[기능]\n적립금 소멸')).toBe(true);
    expect(chunk.text).not.toContain('도토리 포인트 기한');
    expect(chunk.searchText).toContain('도토리 포인트 기한');
    expect(chunk.searchText).toContain('[검색 표현]\n도토리 포인트');
    expect(publicPolicyEvidenceText(chunk.text)).not.toContain('[기능]');
    expect(chunk.policyClaims[0].provenanceChunkIds).toEqual([chunk.id]);

    const [couponChunk] = projectPolicyChunks(coupon);
    expect(couponChunk.text).toContain('[예외]\n- 특가 상품에는');
    // context_text 의 처리 순서 섹션은 근거 글에 그대로 남는다
    expect(couponChunk.text).toContain(
      '[처리 순서]\n1. 상품 쿠폰을 먼저 깎는다',
    );
  });

  it('여러 값 칸은 문자열 JSON 배열이나 줄마다 값 하나로 읽는다', () => {
    const [policy] = policiesFromClaimCsv(
      [
        'policy_group,feature_name,claim_statement,claim_conditions,claim_exceptions,search_aliases',
        'membership,골드 등급,"골드 등급은 지난 분기 구매액이 40 만 원 이상인 회원이다.","[""구매 확정 금액만 센다"", ""취소한 주문은 뺀다""]","[참고] 직원 계정은 등급을 매기지 않는다","골드 회원\n\n우수 회원"',
      ].join('\n'),
    );

    expect(policy.policyClaims[0]).toMatchObject({
      conditions: ['구매 확정 금액만 센다', '취소한 주문은 뺀다'],
      exceptions: ['[참고] 직원 계정은 등급을 매기지 않는다'],
      searchAliases: ['골드 회원', '우수 회원'],
    });
  });

  it('빈 행은 건너뛰되 행 번호는 스프레드시트처럼 그대로 센다', () => {
    const csv = [
      'policy_group,feature_name,claim_statement',
      'refund,부분 환불,"묶음 주문은 상품별로 나눠 환불한다."',
      '',
      ',,',
      'refund,,환불 금액은 결제 수단으로 돌려준다.',
    ].join('\n');

    expect(() => policiesFromClaimCsv(csv, { file: 'refund.csv' })).toThrow(
      'refund.csv row 5: feature_name is empty',
    );
    expect(
      policiesFromClaimCsv(csv.split('\n').slice(0, 4).join('\n')),
    ).toHaveLength(1);
  });

  it('머리 행만 있으면 정책이 없다', () => {
    expect(policiesFromClaimCsv(`${HEADER}\n`)).toEqual([]);
  });

  it.each([
    [
      '필수 열이 없음',
      'policy_group,feature_name\nrefund,부분 환불',
      'row 1: missing required column(s): claim_statement',
    ],
    ['빈 파일', '', 'row 1: missing required column(s): policy_group'],
    [
      '읽는 열이 두 번 나옴',
      'policy_group,feature_name,claim_statement,Policy_Group\nrefund,a,b,c',
      'row 1: column policy_group appears twice',
    ],
    [
      '알 수 없는 facet',
      'policy_group,feature_name,claim_statement,claim_facet\nrefund,부분 환불,상품별로 환불한다.,refundable',
      'row 2: unknown claim_facet "refundable"; use one of outcome, eligibility',
    ],
    [
      '알 수 없는 확신도',
      'policy_group,feature_name,claim_statement,claim_confidence\nrefund,부분 환불,상품별로 환불한다.,medium',
      'row 2: unknown claim_confidence "medium"; use one of high, low',
    ],
    [
      '겹치는 claim_id',
      'policy_group,feature_name,claim_statement,claim_id\nrefund,a,상품별로 환불한다.,r-1\nrefund,b,배송비도 돌려준다.,r-1',
      'row 3: claim_id "r-1" is already used at claims.csv#row-2',
    ],
    [
      '머리보다 많은 칸',
      'policy_group,feature_name,claim_statement\nrefund,부분 환불,상품별로, 나눠 환불한다.',
      'row 2: has 4 cells but the header has 3',
    ],
    [
      '글자 없는 묶음 이름',
      'policy_group,feature_name,claim_statement\n---,부분 환불,상품별로 환불한다.',
      'row 2: policy_group "---" has no letters or digits',
    ],
    [
      '여러 줄 칸 뒤의 행',
      'policy_group,feature_name,claim_statement,context_text\nrefund,a,상품별로 환불한다.,"설명\n둘째 줄"\nrefund,b,,x',
      'row 3 (line 4): claim_statement is empty',
    ],
  ])('%s 은 행 번호와 함께 throw 한다', (_name, csv, message) => {
    expect(() => policiesFromClaimCsv(csv)).toThrow(CsvFormatError);
    expect(() => policiesFromClaimCsv(csv)).toThrow(`claims.csv ${message}`);
  });
});

describe('csvPolicySource', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'codecite-csv-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('CSV 파일 하나를 읽고 출처에는 파일 이름만 남긴다', async () => {
    const file = join(folder, 'acorn.csv');
    await writeFile(file, acornCsv, 'utf8');

    const policies = await csvPolicySource({ path: file }).loadPolicies();

    expect(policies.map((policy) => policy.source)).toEqual([
      'acorn.csv#row-2',
      'acorn.csv#row-3',
    ]);
  });

  it('폴더면 바로 아래 .csv 파일을 이름 순서로 모두 읽는다', async () => {
    const rows = (group: string, statement: string) =>
      `policy_group,feature_name,claim_statement\n${group},안내,${statement}\n`;
    await writeFile(
      join(folder, 'b-shipping.csv'),
      rows('shipping', '제주는 배송비를 더 받는다.'),
    );
    await writeFile(
      join(folder, 'a-refund.CSV'),
      rows('refund', '환불은 결제 수단으로 돌려준다.'),
    );
    await writeFile(join(folder, 'notes.txt'), 'not a csv');
    await mkdir(join(folder, 'old.csv'));

    const policies = await csvPolicySource({ path: folder }).loadPolicies();

    expect(policies.map((policy) => policy.source)).toEqual([
      'a-refund.CSV#row-2',
      'b-shipping.csv#row-2',
    ]);
  });

  it('여러 파일에 걸쳐 claim_id 가 겹쳐도 throw 한다', async () => {
    const row =
      'policy_group,feature_name,claim_statement,claim_id\nrefund,a,상품별로 환불한다.,same-id\n';
    await writeFile(join(folder, 'one.csv'), row);
    await writeFile(join(folder, 'two.csv'), row);

    await expect(
      csvPolicySource({ path: folder }).loadPolicies(),
    ).rejects.toThrow(
      'row 2: claim_id "same-id" is already used at one.csv#row-2',
    );
  });

  it('형식 오류에는 사용자가 준 파일 경로를 붙인다', async () => {
    const file = join(folder, 'broken.csv');
    await writeFile(file, 'policy_group,feature_name\nrefund,a\n');

    await expect(
      csvPolicySource({ path: file }).loadPolicies(),
    ).rejects.toThrow(
      `${file} row 1: missing required column(s): claim_statement`,
    );
  });

  it('경로가 없으면 throw 한다', async () => {
    await expect(
      csvPolicySource({ path: join(folder, 'missing.csv') }).loadPolicies(),
    ).rejects.toThrow(/ENOENT/);
  });
});
