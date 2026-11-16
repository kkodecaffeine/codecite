import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseGraphConfig } from '../config.js';
import type { DetectionPreset, GraphDetectorRule } from '../types.js';
import { isDetectionPreset, resolvePresets } from './registry.js';

const preset = (name: string, languages?: string[]): DetectionPreset => ({
  name,
  ...(languages ? { languages } : {}),
  detect: () => [],
});

const configWith = (extra: Record<string, unknown>, cwd = '/work/dotori') =>
  parseGraphConfig(
    {
      repositories: [{ name: 'shop-api', url: 'https://example.com/a.git' }],
      ...extra,
    },
    cwd,
  );

describe('resolvePresets', () => {
  const routes = preset('acorn-web', ['typescript']);
  const messaging = preset('acorn-web', ['typescript', 'python']);
  const fetchCalls = preset('acorn-fetch');
  const available = [routes, fetchCalls, messaging];

  it('설정 이름 순서로 고르고, 같은 이름의 프리셋은 모두 켠다', async () => {
    const selected = await resolvePresets(
      configWith({ presets: ['acorn-fetch', 'acorn-web', 'acorn-fetch'] }),
      available,
    );
    expect(selected).toEqual([fetchCalls, routes, messaging]);
    expect(await resolvePresets(configWith({}), available)).toEqual([]);
  });

  it('모르는 이름이면 아는 이름을 모두 보여 주며 멈춘다', async () => {
    await expect(
      resolvePresets(configWith({ presets: ['acorn-mail'] }), available),
    ).rejects.toThrow(
      'unknown preset "acorn-mail" in presets. Known presets: acorn-fetch, acorn-web',
    );
    await expect(
      resolvePresets(configWith({ presets: ['acorn-mail'] }), []),
    ).rejects.toThrow('Known presets: (none)');
  });

  it('detectors 규칙은 규칙 프리셋 하나로 더하고, 만들 함수가 없으면 멈춘다', async () => {
    const detectors = [
      { kind: 'queue-publisher', call: 'acornQueue.send', nameArgument: 0 },
    ];
    let given: readonly GraphDetectorRule[] = [];
    const rules = (list: readonly GraphDetectorRule[]) => {
      given = list;
      return preset('rules');
    };
    const selected = await resolvePresets(
      configWith({ presets: ['acorn-fetch'], detectors }),
      available,
      { rules },
    );
    expect(selected.map((item) => item.name)).toEqual(['acorn-fetch', 'rules']);
    expect(given).toEqual(detectors);
    await expect(
      resolvePresets(configWith({ detectors }), available),
    ).rejects.toThrow(/detectors are set in the graph config/);
  });

  it('고를 수 있는 목록에 프리셋 모양이 아닌 값이 있으면 멈춘다', async () => {
    await expect(
      resolvePresets(configWith({}), [
        { name: 'no-detect' } as unknown as DetectionPreset,
      ]),
    ).rejects.toThrow(/must provide a DetectionPreset/);
    expect(isDetectionPreset(preset('ok', ['python']))).toBe(true);
    expect(isDetectionPreset({ ...preset('bad'), languages: [3] })).toBe(false);
  });

  describe('presetModules', () => {
    let folder: string;

    beforeEach(async () => {
      folder = await mkdtemp(join(tmpdir(), 'codecite-presets-'));
    });

    afterEach(async () => {
      await rm(folder, { recursive: true, force: true });
    });

    it('모듈의 기본 내보내기(하나나 배열)를 늘 켜고, 그 이름도 presets 에 적을 수 있다', async () => {
      await writeFile(
        join(folder, 'acorn-presets.mjs'),
        [
          'const detect = () => [];',
          "export default [{ name: 'acorn-cron', detect }, { name: 'acorn-cache', languages: ['python'], detect }];",
          '',
        ].join('\n'),
      );
      await writeFile(
        join(folder, 'single.mjs'),
        "export default { name: 'acorn-mail', detect: () => [] };\n",
      );
      const selected = await resolvePresets(
        configWith(
          {
            presets: ['acorn-cron'],
            presetModules: ['./acorn-presets.mjs', './single.mjs'],
          },
          folder,
        ),
        [],
      );
      expect(selected.map((item) => item.name)).toEqual([
        'acorn-cron',
        'acorn-cache',
        'acorn-mail',
      ]);
    });

    it('읽지 못하거나 프리셋이 아닌 모듈은 설정 폴더 기준 경로를 밝혀 멈춘다', async () => {
      await writeFile(join(folder, 'empty.mjs'), 'export default 42;\n');
      await expect(
        resolvePresets(
          configWith({ presetModules: ['./empty.mjs'] }, folder),
          [],
        ),
      ).rejects.toThrow(
        /^preset module empty\.mjs must provide a DetectionPreset/,
      );
      const error = await resolvePresets(
        configWith({ presetModules: ['./missing.mjs'] }, folder),
        [],
      ).catch((caught: Error) => caught);
      expect((error as Error).message).toMatch(
        /^preset module missing\.mjs could not be loaded/,
      );
    });

    it('importModule 을 바꿔 읽을 수 있다', async () => {
      const loaded: string[] = [];
      const selected = await resolvePresets(
        configWith({ presetModules: ['./virtual.mjs'] }, folder),
        [],
        {
          importModule: async (path) => {
            loaded.push(path);
            return { presets: [preset('acorn-virtual')] };
          },
        },
      );
      expect(loaded).toEqual([join(folder, 'virtual.mjs')]);
      expect(selected.map((item) => item.name)).toEqual(['acorn-virtual']);
    });
  });
});
