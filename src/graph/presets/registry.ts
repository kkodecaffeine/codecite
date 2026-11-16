// 설정으로 켤 탐지 프리셋을 고른다
// presets 의 이름으로 고르고(같은 이름의 프리셋이 여럿이면 모두), presetModules 의 자체 프리셋과 detectors 규칙 프리셋을 더한다
import { pathToFileURL } from 'node:url';
import { portablePath } from '../files.js';
import type {
  DetectionPreset,
  GraphConfig,
  ResolvePresetsOptions,
} from '../types.js';

/**
 * 켤 프리셋 목록. 순서는 설정 presets 의 이름 순서(같은 이름 안에서는 available 순서) → presetModules 순서 → detectors 규칙 프리셋
 * - 이름 하나가 여러 묶음에 걸칠 수 있다(`nestjs` 는 HTTP 와 메시지 묶음이 함께 낸다). 그 이름의 프리셋을 모두 켠다
 * - presetModules 의 프리셋은 늘 켠다. 그 이름도 presets 에 적을 수 있다
 * - 모르는 이름이면 아는 이름을 모두 보여 주며 멈춘다
 * - 같은 프리셋 객체는 한 번만 넣는다
 */
export async function resolvePresets(
  config: GraphConfig,
  available: readonly DetectionPreset[],
  options: ResolvePresetsOptions = {},
): Promise<DetectionPreset[]> {
  for (const preset of available) {
    assertPreset(preset, 'available presets');
  }
  const modules = await loadPresetModules(config, options);
  const known = new Set(
    [...available, ...modules].map((preset) => preset.name),
  );
  const selected: DetectionPreset[] = [];
  for (const name of new Set(config.presets)) {
    if (!known.has(name)) {
      const names = [...known].sort();
      throw new Error(
        `unknown preset "${name}" in presets. Known presets: ${names.length > 0 ? names.join(', ') : '(none)'}`,
      );
    }
    selected.push(...available.filter((preset) => preset.name === name));
  }
  selected.push(...modules);
  if (config.detectors.length > 0) {
    if (!options.rules) {
      throw new Error(
        'detectors are set in the graph config, but no rules preset was given to turn them into a detection preset',
      );
    }
    const rules = options.rules(config.detectors);
    assertPreset(rules, 'detectors rules preset');
    selected.push(rules);
  }
  return [...new Set(selected)];
}

/** 값이 DetectionPreset 모양인지(이름, detect 함수, 언어 목록) */
export function isDetectionPreset(value: unknown): value is DetectionPreset {
  const candidate = value as Partial<DetectionPreset> | undefined;
  return (
    typeof candidate?.name === 'string' &&
    candidate.name.trim() !== '' &&
    typeof candidate.detect === 'function' &&
    (candidate.languages === undefined ||
      (Array.isArray(candidate.languages) &&
        candidate.languages.every(
          (language) => typeof language === 'string' && language !== '',
        )))
  );
}

/** presetModules 의 모듈마다 기본 내보내기(프리셋 하나나 배열)를 읽는다. presets·preset 이름 내보내기도 받는다 */
async function loadPresetModules(
  config: GraphConfig,
  options: ResolvePresetsOptions,
): Promise<DetectionPreset[]> {
  const importModule =
    options.importModule ??
    ((path: string) => import(pathToFileURL(path).href));
  const presets: DetectionPreset[] = [];
  for (const modulePath of config.presetModules) {
    const display = portablePath(config.cwd, modulePath);
    let loaded: Record<string, unknown>;
    try {
      loaded = (await importModule(modulePath)) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `preset module ${display} could not be loaded: ${(error as Error).message}`,
        { cause: error },
      );
    }
    const exported = loaded?.default ?? loaded?.presets ?? loaded?.preset;
    const list = Array.isArray(exported) ? exported : [exported];
    if (list.length === 0) {
      throw new Error(`preset module ${display} exports no presets`);
    }
    for (const candidate of list) {
      assertPreset(candidate, `preset module ${display}`);
      presets.push(candidate);
    }
  }
  return presets;
}

function assertPreset(
  value: unknown,
  label: string,
): asserts value is DetectionPreset {
  if (!isDetectionPreset(value)) {
    throw new Error(
      `${label} must provide a DetectionPreset (name, detect(), optional languages)`,
    );
  }
}
