// 큐·이벤트와 예약 작업의 저장소 간 연결
// 큐·이벤트는 정규화한 이름(normalizeMessageName)으로 맞추고 한 규칙을 함께 쓴다
// - PUBLISHES_TO_QUEUE·PUBLISHES_EVENT: source 는 발행하는 심볼, target 은 구독하는 심볼. 발행 쪽에서 본 다른 저장소 구독자가 하나뿐일 때
// - CONSUMES_FROM_QUEUE·HANDLES_EVENT: source 는 구독하는 심볼, target 은 발행하는 심볼. 다른 저장소 구독자가 여럿이라
//   발행 쪽에서 하나를 고를 수 없지만, 그 구독자가 본 다른 저장소 발행자가 하나뿐일 때
// - 어느 쪽에서도 하나로 정해지지 않는 짝은 ambiguous-provider 로 남긴다. 같은 저장소 안의 짝은 토폴로지의 몫이다
// - 이름이 일반 낱말 하나(`queue`, `events`)뿐이면 잇지 않는다
import type { CurrentSymbolRecord } from '../../extensions/code-knowledge.js';
import { normalizeMessageName } from '../topology.js';
import type { MessageDetection, ScheduleDetection } from '../types.js';
import {
  CRON_MAX_DEPTH,
  CRON_REACHABLE_RELATIONS,
  GENERIC_MESSAGE_NAMES,
} from './constants.js';
import {
  atMost,
  type LinkContext,
  recordLabel,
  relationConfidence,
  unresolvedAt,
  uniqueRecords,
} from './context.js';
import type { LinkDraft, LinkResult } from './types.js';

interface MessageEndpoint {
  detection: MessageDetection;
  record: CurrentSymbolRecord;
  key: string;
}

/** 큐와 이벤트. 발행·구독 탐지 종류와 두 방향의 관계 이름 */
const FAMILIES = [
  {
    noun: 'queue',
    publish: 'queue-publish',
    consume: 'queue-consume',
    forward: 'PUBLISHES_TO_QUEUE',
    backward: 'CONSUMES_FROM_QUEUE',
    kind: 'queue',
  },
  {
    noun: 'event',
    publish: 'event-publish',
    consume: 'event-handle',
    forward: 'PUBLISHES_EVENT',
    backward: 'HANDLES_EVENT',
    kind: 'event',
  },
] as const;

type Family = (typeof FAMILIES)[number];

export function linkMessaging(context: LinkContext): LinkResult {
  const result: LinkResult = { drafts: [], unresolved: [] };
  for (const family of FAMILIES) {
    linkFamily(context, family, result);
  }
  return result;
}

/** 정규화한 이름이 일반 낱말 하나뿐인지. 이런 이름으로는 어느 큐·이벤트인지 알 수 없다 */
export function isGenericMessageName(key: string): boolean {
  return GENERIC_MESSAGE_NAMES.includes(key);
}

function linkFamily(context: LinkContext, family: Family, result: LinkResult) {
  const publishers: MessageEndpoint[] = [];
  const consumers: MessageEndpoint[] = [];
  for (const detection of context.detectionsOf(
    family.publish,
    family.consume,
  )) {
    const record = context.recordFor(detection);
    if (!record) {
      continue;
    }
    const publishing = detection.kind === family.publish;
    const key = detection.dynamic ? '' : normalizeMessageName(detection.name);
    if (!key) {
      result.unresolved.push(
        unresolvedAt(
          detection,
          publishing ? family.forward : family.backward,
          'dynamic-target',
          detection.name,
        ),
      );
      continue;
    }
    (publishing ? publishers : consumers).push({ detection, record, key });
  }
  const consumersByKey = groupByKey(consumers);
  const publishersByKey = groupByKey(publishers);

  for (const publisher of publishers) {
    const all = consumersByKey.get(publisher.key) ?? [];
    const cross = crossRepository(all, publisher.record.repository);
    const handlers = uniqueRecords(cross.map((item) => item.record));
    if (handlers.length === 0) {
      if (all.length === 0) {
        result.unresolved.push(
          unresolvedAt(
            publisher.detection,
            family.forward,
            'no-provider',
            publisher.key,
          ),
        );
      }
      continue;
    }
    if (isGenericMessageName(publisher.key)) {
      result.unresolved.push(
        unresolvedAt(
          publisher.detection,
          family.forward,
          'ambiguous-provider',
          publisher.key,
          handlers,
        ),
      );
      continue;
    }
    if (handlers.length === 1) {
      const consumer = firstFor(cross, handlers[0]);
      result.drafts.push(
        messageDraft(
          family,
          'forward',
          publisher,
          consumer,
          'only cross-repository subscriber',
        ),
      );
      continue;
    }
    const unlinked: CurrentSymbolRecord[] = [];
    for (const handler of handlers) {
      const consumer = firstFor(cross, handler);
      const senders = uniqueRecords(
        crossRepository(
          publishersByKey.get(publisher.key) ?? [],
          handler.repository,
        ).map((item) => item.record),
      );
      if (
        senders.length === 1 &&
        senders[0].stableSymbolId === publisher.record.stableSymbolId
      ) {
        result.drafts.push(
          messageDraft(
            family,
            'backward',
            publisher,
            consumer,
            'several cross-repository subscribers; this publisher is the only cross-repository one',
          ),
        );
      } else {
        unlinked.push(handler);
      }
    }
    if (unlinked.length > 0) {
      result.unresolved.push(
        unresolvedAt(
          publisher.detection,
          family.forward,
          'ambiguous-provider',
          publisher.key,
          unlinked,
        ),
      );
    }
  }

  for (const consumer of consumers) {
    if ((publishersByKey.get(consumer.key) ?? []).length === 0) {
      result.unresolved.push(
        unresolvedAt(
          consumer.detection,
          family.backward,
          'no-caller',
          consumer.key,
        ),
      );
    }
  }
}

function messageDraft(
  family: Family,
  direction: 'forward' | 'backward',
  publisher: MessageEndpoint,
  consumer: MessageEndpoint,
  note: string,
): LinkDraft {
  const forward = direction === 'forward';
  const sourceSide = forward ? publisher : consumer;
  return {
    relation: forward ? family.forward : family.backward,
    source: forward ? publisher.record : consumer.record,
    target: forward ? consumer.record : publisher.record,
    extraction: {
      kind: family.kind,
      locator: `${sourceSide.detection.filePath}:${sourceSide.detection.line}`,
      value: publisher.key,
    },
    confidence: relationConfidence(false, [
      publisher.detection.confidence,
      consumer.detection.confidence,
    ]),
    evidence: [
      `${family.noun} ${publisher.key}`,
      `publish ${publisher.detection.name} at ${recordLabel(publisher.record)} (${publisher.detection.detector})`,
      `subscribe ${consumer.detection.name} at ${recordLabel(consumer.record)} (${consumer.detection.detector})`,
      note,
    ],
    roles: { caller: publisher.record, handler: consumer.record },
  };
}

/**
 * CRON_TRIGGERS: 예약 작업 심볼(source)에서 저장소 안 CALLS 를 세 단계까지 따라가 닿은 심볼이 저장소 간 호출·발행의 부르는 쪽이면,
 * 그 호출이 닿는 처리 심볼(target)과 잇는다. 예약 작업이 직접 부르면 그 호출의 신뢰도, 거쳐 부르면 medium 을 넘지 않는다
 */
export function linkCronTriggers(
  context: LinkContext,
  drafts: readonly LinkDraft[],
): LinkDraft[] {
  const byCaller = new Map<string, LinkDraft[]>();
  for (const draft of drafts) {
    if (!draft.roles || !CRON_REACHABLE_RELATIONS.includes(draft.relation)) {
      continue;
    }
    const id = draft.roles.caller.stableSymbolId;
    byCaller.set(id, [...(byCaller.get(id) ?? []), draft]);
  }
  const result: LinkDraft[] = [];
  for (const schedule of context.detectionsOf('schedule')) {
    const scheduled = context.recordFor(schedule);
    if (!scheduled) {
      continue;
    }
    const reached = [
      { record: scheduled, depth: 0 },
      ...context.calls.reachable(scheduled, CRON_MAX_DEPTH),
    ];
    for (const { record, depth } of reached) {
      for (const via of byCaller.get(record.stableSymbolId) ?? []) {
        const handler = (via.roles as NonNullable<LinkDraft['roles']>).handler;
        if (handler.repository === scheduled.repository) {
          continue;
        }
        result.push(
          cronDraft(schedule, scheduled, record, depth, via, handler),
        );
      }
    }
  }
  return result;
}

function cronDraft(
  schedule: ScheduleDetection,
  scheduled: CurrentSymbolRecord,
  reached: CurrentSymbolRecord,
  depth: number,
  via: LinkDraft,
  handler: CurrentSymbolRecord,
): LinkDraft {
  return {
    relation: 'CRON_TRIGGERS',
    source: scheduled,
    target: handler,
    extraction: {
      kind: 'cron',
      locator: `${schedule.filePath}:${schedule.line}`,
      value: `${schedule.expression} → ${via.relation} ${via.extraction.value}`,
    },
    confidence: depth === 0 ? via.confidence : atMost(via.confidence, 'medium'),
    evidence: [
      `schedule ${schedule.expression} runs ${scheduled.symbol} (${schedule.detector})`,
      depth === 0
        ? `${scheduled.symbol} makes the call itself`
        : `${scheduled.symbol} reaches ${reached.symbol} in ${depth} call(s)`,
      `${via.relation} ${via.extraction.value} → ${recordLabel(handler)}`,
    ],
    roles: { caller: scheduled, handler },
  };
}

function groupByKey(endpoints: readonly MessageEndpoint[]) {
  const groups = new Map<string, MessageEndpoint[]>();
  for (const endpoint of endpoints) {
    groups.set(endpoint.key, [...(groups.get(endpoint.key) ?? []), endpoint]);
  }
  return groups;
}

function crossRepository(
  endpoints: readonly MessageEndpoint[],
  repository: string,
): MessageEndpoint[] {
  return endpoints.filter((item) => item.record.repository !== repository);
}

function firstFor(
  endpoints: readonly MessageEndpoint[],
  record: CurrentSymbolRecord,
): MessageEndpoint {
  return endpoints.find(
    (item) => item.record.stableSymbolId === record.stableSymbolId,
  ) as MessageEndpoint;
}
