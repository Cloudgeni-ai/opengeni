import type { SessionEvent } from "@opengeni/sdk";

const SITE_MUTATION_TOOL_NAMES = new Set(["artifacts_create", "artifacts_publish"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolLeaf(name: string): string {
  const separator = name.indexOf("__");
  return separator >= 0 ? name.slice(separator + 2) : name;
}

/**
 * Return the latest settled Site create/publish sequence in one routed session.
 * The rail uses this compact primitive as a refresh key instead of fetching
 * after every unrelated tool output.
 */
export function latestSiteMutationSequence(events: readonly SessionEvent[]): number {
  const siteCalls = new Set<string>();
  let latest = 0;
  for (const event of events) {
    const payload = record(event.payload);
    const callId = typeof payload?.id === "string" ? payload.id : null;
    if (event.type === "agent.toolCall.created" && callId) {
      const name = typeof payload?.name === "string" ? payload.name : "";
      if (SITE_MUTATION_TOOL_NAMES.has(toolLeaf(name))) siteCalls.add(callId);
      continue;
    }
    if (event.type === "agent.toolCall.output" && callId && siteCalls.has(callId)) {
      latest = event.sequence;
    }
  }
  return latest;
}
