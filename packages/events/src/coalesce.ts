import { boundSessionEventPayload, type SessionEvent } from "@opengeni/contracts";

const COALESCIBLE_DELTA_TYPES = new Set([
  "agent.message.delta",
  "agent.reasoning.delta",
  "sandbox.command.output.delta",
]);

/** Flush long runs incrementally before concatenation can become unbounded. */
export const SESSION_EVENT_COALESCED_TEXT_TARGET_BYTES = 48 * 1024;
const encoder = new TextEncoder();

type DeltaRun = {
  first: SessionEvent;
  lastSequence: number;
  text: string;
  textBytes: number;
  sandboxName: string | undefined;
  sandboxStream: string | undefined;
  sandboxCommandId: string | undefined;
};

export function coalesceSessionEventDeltas(events: SessionEvent[]): SessionEvent[] {
  const coalesced: SessionEvent[] = [];
  let run: DeltaRun | null = null;

  const flush = () => {
    if (!run) {
      return;
    }
    const payload =
      run.first.type === "sandbox.command.output.delta"
        ? // Sandbox output keeps its CANONICAL field (`chunk` — the terminal and
          // projection read it) plus the stream/commandId identity of the run.
          {
            chunk: run.text,
            coalescedUntil: run.lastSequence,
            ...(run.sandboxStream !== undefined ? { stream: run.sandboxStream } : {}),
            ...(run.sandboxCommandId !== undefined ? { commandId: run.sandboxCommandId } : {}),
            ...(run.sandboxName !== undefined ? { name: run.sandboxName } : {}),
          }
        : {
            text: run.text,
            coalescedUntil: run.lastSequence,
          };
    coalesced.push({
      ...run.first,
      payload: boundSessionEventPayload(payload, {
        surface: "http_projection",
      }),
    });
    run = null;
  };

  for (const event of events) {
    if (!isCoalescibleDelta(event)) {
      flush();
      coalesced.push(event);
      continue;
    }

    const isSandbox = event.type === "sandbox.command.output.delta";
    const sandboxName = isSandbox ? sandboxDeltaName(event.payload) : undefined;
    const sandboxStream = isSandbox ? sandboxDeltaString(event.payload, "stream") : undefined;
    const sandboxCommandId = isSandbox ? sandboxDeltaString(event.payload, "commandId") : undefined;
    const text = deltaText(event);
    if (
      run &&
      sameDeltaRun(run.first, event, run.sandboxName, sandboxName) &&
      run.sandboxStream === sandboxStream &&
      run.sandboxCommandId === sandboxCommandId
    ) {
      const textBytes = encoder.encode(text).byteLength;
      if (
        run.textBytes === 0 ||
        run.textBytes + textBytes <= SESSION_EVENT_COALESCED_TEXT_TARGET_BYTES
      ) {
        run.text += text;
        run.textBytes += textBytes;
        run.lastSequence = event.sequence;
        continue;
      }
      // The current segment is already useful and bounded. Flush before adding
      // the next raw delta rather than building the full run and truncating it
      // only after a multi-megabyte intermediate allocation.
      flush();
    } else {
      flush();
    }

    run = {
      first: event,
      lastSequence: event.sequence,
      text,
      textBytes: encoder.encode(text).byteLength,
      sandboxName,
      sandboxStream,
      sandboxCommandId,
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
    // `chunk` is the canonical wire field (contracts SandboxCommandOutputDeltaPayload);
    // text/output are tolerated legacy shapes.
    for (const key of ["chunk", "text", "output"] as const) {
      if (typeof payload[key] === "string") {
        return payload[key] as string;
      }
    }
    return "";
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

function sandboxDeltaString(payload: unknown, key: "stream" | "commandId"): string | undefined {
  const value = asRecord(payload)[key];
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
