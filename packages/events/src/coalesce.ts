import type { SessionEvent } from "@opengeni/contracts";

const COALESCIBLE_DELTA_TYPES = new Set([
  "agent.message.delta",
  "agent.reasoning.delta",
  "sandbox.command.output.delta",
]);

type DeltaRun = {
  first: SessionEvent;
  lastSequence: number;
  text: string;
  sandboxName: string | undefined;
};

export function coalesceSessionEventDeltas(events: SessionEvent[]): SessionEvent[] {
  const coalesced: SessionEvent[] = [];
  let run: DeltaRun | null = null;

  const flush = () => {
    if (!run) {
      return;
    }
    coalesced.push({
      ...run.first,
      payload: {
        text: run.text,
        coalescedUntil: run.lastSequence,
        ...(run.first.type === "sandbox.command.output.delta" && run.sandboxName !== undefined
          ? { name: run.sandboxName }
          : {}),
      },
    });
    run = null;
  };

  for (const event of events) {
    if (!isCoalescibleDelta(event)) {
      flush();
      coalesced.push(event);
      continue;
    }

    const sandboxName = event.type === "sandbox.command.output.delta" ? sandboxDeltaName(event.payload) : undefined;
    if (run && sameDeltaRun(run.first, event, run.sandboxName, sandboxName)) {
      run.text += deltaText(event);
      run.lastSequence = event.sequence;
      continue;
    }

    flush();
    run = {
      first: event,
      lastSequence: event.sequence,
      text: deltaText(event),
      sandboxName,
    };
  }

  flush();
  return coalesced;
}

function isCoalescibleDelta(event: SessionEvent): boolean {
  return COALESCIBLE_DELTA_TYPES.has(event.type);
}

function sameDeltaRun(
  first: SessionEvent,
  next: SessionEvent,
  firstSandboxName: string | undefined,
  nextSandboxName: string | undefined,
): boolean {
  if (first.type !== next.type) {
    return false;
  }
  if ((first.turnId ?? null) !== (next.turnId ?? null)) {
    return false;
  }
  return first.type !== "sandbox.command.output.delta" || firstSandboxName === nextSandboxName;
}

function deltaText(event: SessionEvent): string {
  if (event.type === "agent.reasoning.delta") {
    return reasoningText(event.payload);
  }
  const payload = asRecord(event.payload);
  if (event.type === "sandbox.command.output.delta") {
    return typeof payload.text === "string" ? payload.text : typeof payload.output === "string" ? payload.output : "";
  }
  return typeof payload.text === "string" ? payload.text : "";
}

function reasoningText(payload: unknown): string {
  const record = asRecord(payload);
  if (typeof record.text === "string") {
    return record.text;
  }
  const content = asRecord(asRecord(record.item).rawItem).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const text = asRecord(part).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function sandboxDeltaName(payload: unknown): string | undefined {
  const name = asRecord(payload).name;
  return typeof name === "string" ? name : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
