import type { TimelineGroup, TimelineItem } from "../../src/timeline";

export type SerializedTimeline = ReturnType<typeof serializeTimeline>;

export function serializeTimeline(items: TimelineItem[], groups: TimelineGroup[]) {
  return {
    items: items.map(serializeItem),
    groups: groups.map(serializeGroup),
    facets: {
      itemKinds: countBy(items.map((item) => item.kind)),
      groupKinds: countGroupKinds(groups),
      activityItemKinds: countActivityItemKinds(groups),
      turnOutcomes: countTurnOutcomes(groups),
    },
  };
}

function serializeItem(item: TimelineItem): Record<string, unknown> {
  switch (item.kind) {
    case "user-message":
      return {
        kind: item.kind,
        id: item.id,
        occurredAt: item.occurredAt,
        text: item.text,
        resources: stableValue(item.resources),
        tools: stableValue(item.tools),
      };
    case "agent-message":
    case "reasoning":
      return {
        kind: item.kind,
        id: item.id,
        turnId: item.turnId,
        occurredAt: item.occurredAt,
        text: item.text,
        streaming: item.streaming,
      };
    case "tool-call":
      return {
        kind: item.kind,
        id: item.id,
        turnId: item.turnId,
        callId: item.callId,
        occurredAt: item.occurredAt,
        name: item.name,
        status: item.status,
        arguments: stableValue(item.arguments),
        output: stableValue(item.output),
        raw: stableValue(item.raw),
      };
    case "worker":
      return {
        kind: item.kind,
        id: item.id,
        turnId: item.turnId,
        callId: item.callId,
        occurredAt: item.occurredAt,
        action: item.action,
        status: item.status,
        prompt: item.prompt,
        workerSessionId: item.workerSessionId,
      };
    case "worker-completion":
      return {
        kind: item.kind,
        id: item.id,
        turnId: item.turnId,
        occurredAt: item.occurredAt,
        childSessionId: item.childSessionId,
        childStatus: item.childStatus,
        goalStatus: item.goalStatus,
        goalText: item.goalText,
        evidence: item.evidence,
        pausedReason: item.pausedReason,
        text: item.text,
      };
    case "sandbox":
      return {
        kind: item.kind,
        id: item.id,
        turnId: item.turnId,
        occurredAt: item.occurredAt,
        name: item.name,
        command: item.command,
        status: item.status,
        output: item.output,
      };
    case "session-status":
      return {
        kind: item.kind,
        id: item.id,
        occurredAt: item.occurredAt,
        status: item.status,
      };
    case "goal":
      return {
        kind: item.kind,
        id: item.id,
        occurredAt: item.occurredAt,
        action: item.action,
        text: item.text,
      };
    case "memory":
      return {
        kind: item.kind,
        id: item.id,
        turnId: item.turnId,
        occurredAt: item.occurredAt,
        variant: item.variant,
        memoryKind: item.memoryKind,
        preview: item.preview,
        deduped: item.deduped === true,
        replacementPreview: item.replacementPreview ?? null,
        action: item.action ?? null,
        memoryId: item.memoryId,
        replacementMemoryId: item.replacementMemoryId ?? null,
      };
    case "fleet-decision":
      return {
        kind: item.kind,
        id: item.id,
        turnId: item.turnId,
        occurredAt: item.occurredAt,
        policyVersion: item.policyVersion,
        actualOutcome: item.actualOutcome,
        actualCandidateKey: item.actualCandidateKey,
        actualReason: item.actualReason,
        shadowOutcome: item.shadowOutcome,
        shadowCandidateKey: item.shadowCandidateKey,
        shadowReason: item.shadowReason,
        comparison: item.comparison,
        confidence: item.confidence,
        admissionOutcome: item.admissionOutcome,
        admissionReason: item.admissionReason,
        borrowedIdleCapacity: item.borrowedIdleCapacity,
        borrowedOverlayCapacity: item.borrowedOverlayCapacity,
        strandedEligibleCount: item.strandedEligibleCount,
        candidateCount: item.candidateCount,
        truncatedCandidateCount: item.truncatedCandidateCount,
        scoreRowsTruncatedCount: item.scoreRowsTruncatedCount,
        scores: stableValue(item.scores),
      };
    case "notice":
      return {
        kind: item.kind,
        id: item.id,
        occurredAt: item.occurredAt,
        tone: item.tone,
        text: item.text,
      };
    case "auth-needed":
      return {
        kind: item.kind,
        id: item.id,
        turnId: item.turnId,
        occurredAt: item.occurredAt,
        providerDomain: item.providerDomain,
        connectionId: item.connectionId,
        reason: item.reason,
        scopes: stableValue(item.scopes),
        resource: item.resource,
        toolName: item.toolName,
        authorizationUrl: item.authorizationUrl,
      };
    case "turn-end":
      return {
        kind: item.kind,
        id: item.id,
        turnId: item.turnId,
        occurredAt: item.occurredAt,
        outcome: item.outcome,
        failureText: item.failureText,
      };
  }
}

function serializeGroup(group: TimelineGroup): Record<string, unknown> {
  switch (group.kind) {
    case "item":
      return {
        kind: group.kind,
        item: serializeItem(group.item),
      };
    case "activity":
      return {
        kind: group.kind,
        id: group.id,
        itemCount: group.items.length,
        itemKinds: countBy(group.items.map((item) => item.kind)),
        ...(group.outcome ? { outcome: group.outcome } : {}),
        ...(group.failureText ? { failureText: group.failureText } : {}),
        items: group.items.map(serializeItem),
      };
    case "turn":
      return {
        kind: group.kind,
        id: group.id,
        outcome: group.outcome,
        ...(group.failureText ? { failureText: group.failureText } : {}),
        startedAt: group.startedAt,
        endedAt: group.endedAt,
        groupCount: group.groups.length,
        groups: group.groups.map(serializeGroup),
      };
  }
}

function countGroupKinds(groups: TimelineGroup[]): Record<string, number> {
  const kinds: string[] = [];
  walkGroups(groups, (group) => kinds.push(group.kind));
  return countBy(kinds);
}

function countActivityItemKinds(groups: TimelineGroup[]): Record<string, number> {
  const kinds: string[] = [];
  walkGroups(groups, (group) => {
    if (group.kind === "activity") {
      kinds.push(...group.items.map((item) => item.kind));
    }
  });
  return countBy(kinds);
}

function countTurnOutcomes(groups: TimelineGroup[]): Record<string, number> {
  const outcomes: string[] = [];
  walkGroups(groups, (group) => {
    if (group.kind === "turn") {
      outcomes.push(group.outcome);
    }
  });
  return countBy(outcomes);
}

function walkGroups(groups: TimelineGroup[], visit: (group: TimelineGroup) => void): void {
  for (const group of groups) {
    visit(group);
    if (group.kind === "turn") {
      walkGroups(group.groups, visit);
    }
  }
}

function countBy(values: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

function stableValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = stableValue(record[key]);
    }
    return out;
  }
  return value;
}
