// SHARES_ENTITY·SHARES_CACHE_KEY: 여러 저장소가 같은 테이블·같은 캐시 키를 쓴다는 간접 관계. 호출 관계가 아니다
// 토폴로지의 DatabaseTable·CacheKey 노드를 이름(대소문자 무시)으로 저장소를 건너 묶는다. 테이블은 엔티티 클래스 이름도 선언한 테이블 이름으로 풀어 묶는다
// 짝마다 잇지 않고(저장소 n 개면 n(n-1)/2 개) 저장소 이름 순서로 늘어놓은 이웃끼리만 잇는다(n-1 개)
// 사슬을 따라가면 같은 자원을 쓰는 저장소를 모두 알 수 있다. 각 저장소의 끝은 그 노드의 위치(선언한 심볼, 없으면 처음 쓴 심볼)다
import type {
  CurrentSymbolRecord,
  TopologyNode,
} from '../../extensions/code-knowledge.js';
import { createEntityTableResolver } from '../data/entities.js';
import type { EntityTableResolver } from '../data/types.js';
import { compareText } from '../files.js';
import type { LinkContext } from './context.js';
import type { LinkResult } from './types.js';

const SHARED_RESOURCES = [
  {
    type: 'DatabaseTable',
    relation: 'SHARES_ENTITY',
    kind: 'entity',
    noun: 'table',
  },
  {
    type: 'CacheKey',
    relation: 'SHARES_CACHE_KEY',
    kind: 'cache-key',
    noun: 'cache key',
  },
] as const;

export function linkShares(context: LinkContext): LinkResult {
  const result: LinkResult = { drafts: [], unresolved: [] };
  const topology = context.state.topology;
  if (!topology) {
    return result;
  }
  const tables = createEntityTableResolver(context.state);
  const usage = new Map<string, { reads: number; writes: number }>();
  for (const edge of topology.edges) {
    if (edge.type === 'READS' || edge.type === 'WRITES') {
      const counts = usage.get(edge.to) ?? { reads: 0, writes: 0 };
      counts[edge.type === 'READS' ? 'reads' : 'writes'] += 1;
      usage.set(edge.to, counts);
    }
  }
  for (const resource of SHARED_RESOURCES) {
    const groups = new Map<string, Map<string, TopologyNode>>();
    const nodes = topology.nodes
      .filter((node) => node.type === resource.type)
      .sort((left, right) => compareText(left.id, right.id));
    for (const node of nodes) {
      const key = resourceName(node, tables).toLowerCase();
      const byRepository = groups.get(key) ?? new Map<string, TopologyNode>();
      if (!byRepository.has(node.repository)) {
        byRepository.set(node.repository, node);
      }
      groups.set(key, byRepository);
    }
    for (const key of [...groups.keys()].sort(compareText)) {
      const ends = [...(groups.get(key) as Map<string, TopologyNode>).entries()]
        .sort(([left], [right]) => compareText(left, right))
        .flatMap(([, node]) => {
          const record = endRecord(context, node);
          return record ? [{ node, record }] : [];
        });
      for (let index = 0; index + 1 < ends.length; index += 1) {
        const left = ends[index];
        const right = ends[index + 1];
        result.drafts.push({
          relation: resource.relation,
          source: left.record,
          target: right.record,
          extraction: {
            kind: resource.kind,
            locator: `${left.node.id} ~ ${right.node.id}`,
            value: resourceName(left.node, tables),
          },
          confidence: 'medium',
          evidence: [
            `${resource.noun} ${left.node.name} is used in ${left.node.repository} and ${right.node.repository}`,
            usageNote(left.node, usage),
            usageNote(right.node, usage),
            'same name only; an indirect relation, not a call',
          ],
        });
      }
    }
  }
  return result;
}

/**
 * 노드를 묶는 자원 이름. 테이블은 엔티티 선언 색인으로 표기를 맞춘다
 * 선언한 테이블 이름이면 그 표기, 아니면 클래스 이름으로 선언한 테이블, 둘 다 아니면 노드 이름이다
 * 그래서 선언이 없는 저장소가 클래스 이름(`Order`)으로 쓴 노드와 선언한 저장소의 테이블(`orders`) 노드가 한 자원으로 묶인다
 */
function resourceName(node: TopologyNode, tables: EntityTableResolver): string {
  if (node.type !== 'DatabaseTable') {
    return node.name;
  }
  return (
    tables.resolveTable(node.name) ??
    tables.resolveClass(node.repository, node.name) ??
    node.name
  );
}

function endRecord(
  context: LinkContext,
  node: TopologyNode,
): CurrentSymbolRecord | undefined {
  return (
    context.recordAt(node.repository, node.filePath, node.symbol) ??
    context.moduleOf(node.repository, node.filePath)
  );
}

function usageNote(
  node: TopologyNode,
  usage: ReadonlyMap<string, { reads: number; writes: number }>,
): string {
  const counts = usage.get(node.id) ?? { reads: 0, writes: 0 };
  return `${node.repository}: ${counts.reads} read(s), ${counts.writes} write(s)`;
}
