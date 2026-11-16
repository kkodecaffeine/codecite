// 처리하는 쪽에서 저장소 안 호출을 따라가 실제로 처리하는 심볼과 그 조건·예외 실행 사실을 모은다
// 클래스 이름 끝말(Service 등)로 거르지 않는다. 대신 조건·예외 실행 사실이 있는 심볼을 먼저 남긴다
import type {
  CurrentSymbolRecord,
  ExecutionFact,
  SystemTopologyGraph,
} from '../../extensions/code-knowledge.js';
import {
  HANDLER_CHAIN_MAX_DEPTH,
  HANDLER_CHAIN_MAX_SYMBOLS,
} from './constants.js';
import type { ReachedSymbol } from './types.js';

/** 토폴로지 노드를 레코드로 푸는 데 필요한 것 */
interface RecordLookup {
  recordAt(
    repository: string,
    filePath: string,
    symbol: string,
  ): CurrentSymbolRecord | undefined;
  moduleOf(
    repository: string,
    filePath: string,
  ): CurrentSymbolRecord | undefined;
}

/** 심볼 노드 종류. File 노드는 그 파일의 모듈 심볼이 맡는다 */
const SYMBOL_NODE_TYPES = new Set(['Class', 'Function', 'Enum']);

/**
 * 토폴로지의 저장소 안 CALLS 간선을 레코드 사이의 호출로 읽는다
 * 노드 id 꼴에 기대지 않고 노드의 저장소·파일·심볼로 레코드를 찾는다
 */
export class CallGraph {
  private readonly nodeOfRecord = new Map<string, string>();
  private readonly recordOfNode = new Map<string, CurrentSymbolRecord>();
  private readonly callees = new Map<string, string[]>();

  constructor(topology: SystemTopologyGraph | undefined, lookup: RecordLookup) {
    if (!topology) {
      return;
    }
    for (const node of topology.nodes) {
      const record =
        node.type === 'File'
          ? lookup.moduleOf(node.repository, node.filePath)
          : SYMBOL_NODE_TYPES.has(node.type)
            ? lookup.recordAt(node.repository, node.filePath, node.symbol)
            : undefined;
      if (record && !this.nodeOfRecord.has(record.stableSymbolId)) {
        this.nodeOfRecord.set(record.stableSymbolId, node.id);
        this.recordOfNode.set(node.id, record);
      }
    }
    for (const edge of topology.edges) {
      if (edge.type !== 'CALLS') {
        continue;
      }
      const from = this.recordOfNode.get(edge.from);
      const to = this.recordOfNode.get(edge.to);
      if (!from || !to || from.repository !== to.repository) {
        continue;
      }
      const list = this.callees.get(edge.from) ?? [];
      list.push(edge.to);
      this.callees.set(edge.from, list);
    }
  }

  /** 출발 심볼에서 CALLS 를 따라 maxDepth 단계까지 닿은 심볼. 출발 심볼은 빼고, 깊이 순·같은 깊이는 간선 순서다 */
  reachable(start: CurrentSymbolRecord, maxDepth: number): ReachedSymbol[] {
    const startNode = this.nodeOfRecord.get(start.stableSymbolId);
    if (!startNode) {
      return [];
    }
    const visited = new Set([startNode]);
    const reached: ReachedSymbol[] = [];
    let frontier = [startNode];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const callee of this.callees.get(node) ?? []) {
          if (visited.has(callee)) {
            continue;
          }
          visited.add(callee);
          next.push(callee);
          const record = this.recordOfNode.get(callee);
          if (record) {
            reached.push({ record, depth });
          }
        }
      }
      frontier = next;
    }
    return reached;
  }
}

/**
 * 처리하는 쪽에서 CALLS 를 세 단계까지 따라간 심볼 가운데 handlerChain 에 남길 것
 * 조건·예외 실행 사실이 있는 심볼을 먼저 고르고, 남는 자리를 나머지로 채운 뒤 깊이 순서로 돌려준다
 */
export function handlerChain(
  calls: CallGraph,
  handler: CurrentSymbolRecord,
): CurrentSymbolRecord[] {
  const reached = calls.reachable(handler, HANDLER_CHAIN_MAX_DEPTH);
  const preferred = reached.filter((item) => hasBranchFacts(item.record));
  const others = reached.filter((item) => !hasBranchFacts(item.record));
  const kept = new Set(
    [...preferred, ...others]
      .slice(0, HANDLER_CHAIN_MAX_SYMBOLS)
      .map((item) => item.record.stableSymbolId),
  );
  return reached
    .filter((item) => kept.has(item.record.stableSymbolId))
    .map((item) => item.record);
}

/** 조건 실행 사실 */
export function conditionFacts(record: CurrentSymbolRecord): ExecutionFact[] {
  return (record.executionFacts ?? []).filter(
    (fact) => fact.kind === 'condition',
  );
}

/** 예외 실행 사실 */
export function exceptionFacts(record: CurrentSymbolRecord): ExecutionFact[] {
  return (record.executionFacts ?? []).filter((fact) => fact.kind === 'throws');
}

function hasBranchFacts(record: CurrentSymbolRecord): boolean {
  return (record.executionFacts ?? []).some(
    (fact) => fact.kind === 'condition' || fact.kind === 'throws',
  );
}
