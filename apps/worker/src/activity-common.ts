import type { ReasoningEffort, ResourceRef, ToolRef } from "@infra-agents/contracts";

export function scheduledUserMessagePayload(prompt: string, resources: ResourceRef[], tools: ToolRef[], taskId: string, runId: string): Record<string, unknown> {
  return {
    text: prompt,
    scheduledTaskId: taskId,
    scheduledTaskRunId: runId,
    ...(resources.length ? { resources } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

export function workflowIdForSession(sessionId: string): string {
  return `session-${sessionId}`;
}

export function mergeToolRefs(existing: ToolRef[], additions: ToolRef[]): ToolRef[] {
  const seen = new Set<string>();
  const out: ToolRef[] = [];
  for (const tool of [...existing, ...additions]) {
    const key = `${tool.kind}:${tool.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(tool);
  }
  return out;
}

export function mergeResourceRefs(existing: ResourceRef[], additions: ResourceRef[]): ResourceRef[] {
  const out = [...existing];
  const exact = new Set(existing.map(stableJson));
  for (const resource of additions) {
    const serialized = stableJson(resource);
    if (!exact.has(serialized)) {
      out.push(resource);
      exact.add(serialized);
    }
  }
  return out;
}

export function reasoningEffortForSession(metadata: Record<string, unknown>, fallback: ReasoningEffort): ReasoningEffort {
  const value = metadata.reasoningEffort;
  return value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : fallback;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sortJson(nested)]));
  }
  return value;
}
