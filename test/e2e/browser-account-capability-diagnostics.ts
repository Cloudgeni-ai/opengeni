import type {
  CapabilityResumeDecision,
  CapabilityResumeExpected,
} from "./browser-account-capability-resume";

const MAX_EVENTS = 512;
const MAX_BYTES = 96 * 1024;
const endpointPattern =
  /^\/v1\/workspaces\/[0-9a-f-]{36}\/sessions\/[0-9a-f-]{36}\/stream-capabilities$/i;
function endpoint(value: string) {
  try {
    const url = new URL(value);
    return endpointPattern.test(url.pathname)
      ? { pathname: url.pathname, queryPresent: url.search !== "" }
      : null;
  } catch {
    return null;
  }
}
const actor = (value: string | null) => (value !== null && /^\d{1,16}$/.test(value) ? value : null);
const hash = (value: string | null) =>
  value !== null && /^[0-9a-f]{64}$/.test(value) ? value : null;
const status = (value: number) =>
  Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
type EventFields = {
  kind:
    | "request"
    | "authority"
    | "response"
    | "finished"
    | "failed"
    | "console"
    | "boundary"
    | "gate";
  requestId?: number;
  consoleId?: number;
  gateId?: number;
  consoleIds?: number[];
  pathname?: string;
  queryPresent?: boolean;
  method?: string;
  actorEpoch?: string | null;
  authorityState?: "pending" | "unavailable" | "resolved";
  authorityHash?: string | null;
  status?: number | null;
  boundary?: string;
};
type DiagnosticEvent = EventFields & { sequence: number; runnerMs: number; phase: string };

/** Observational only. Console IDs are NOT network request IDs or causal claims. */
export function createCapabilityDiagnostics(now = () => performance.now()) {
  const events: DiagnosticEvent[] = [];
  const requests = new WeakMap<object, number>();
  let sequence = 0,
    requestId = 0,
    consoleId = 0,
    gateId = 0,
    bytes = 0;
  let droppedEvents = 0,
    droppedBytes = 0,
    droppedConsoleIds = 0;
  let pendingConsoleIds: number[] = [];
  const record = (phase: string, fields: EventFields) => {
    const entry = { ...fields, sequence: ++sequence, runnerMs: now(), phase: phase.slice(0, 120) };
    const size = Buffer.byteLength(JSON.stringify(entry));
    // Reserve space for the snapshot envelope, separators and overflow counters.
    if (events.length >= MAX_EVENTS || bytes + size + 2_048 > MAX_BYTES) {
      droppedEvents++;
      droppedBytes += size;
      return;
    }
    events.push(entry);
    bytes += size;
  };
  return {
    request(key: object, phase: string, url: string, method: string, actorEpoch: string | null) {
      const identity = endpoint(url);
      if (!identity) return;
      const id = requests.get(key) ?? ++requestId;
      requests.set(key, id);
      record(phase, {
        kind: "request",
        requestId: id,
        ...identity,
        method: /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)$/.test(method) ? method : "OTHER",
        actorEpoch: actor(actorEpoch),
        authorityState: "pending",
      });
    },
    authority(key: object, phase: string, authorityHash: string | null) {
      const id = requests.get(key);
      if (id === undefined) return;
      const safeHash = hash(authorityHash);
      record(phase, {
        kind: "authority",
        requestId: id,
        authorityHash: safeHash,
        authorityState: safeHash === null ? "unavailable" : "resolved",
      });
    },
    response(key: object, phase: string, code: number) {
      const id = requests.get(key);
      if (id !== undefined)
        record(phase, { kind: "response", requestId: id, status: status(code) });
    },
    terminal(key: object, phase: string, kind: "finished" | "failed") {
      const id = requests.get(key);
      if (id !== undefined) record(phase, { kind, requestId: id });
    },
    console(phase: string, sourceUrl: string, message: string) {
      const identity = endpoint(sourceUrl);
      if (!identity) return;
      const id = ++consoleId;
      if (pendingConsoleIds.length < MAX_EVENTS) pendingConsoleIds.push(id);
      else droppedConsoleIds++;
      const match =
        /^Failed to load resource: the server responded with a status of (\d{3})(?:\s|$)/.exec(
          message,
        );
      // Never retain arbitrary console text, headers, query values or URL credentials.
      record(phase, {
        kind: "console",
        consoleId: id,
        ...identity,
        status: match ? status(Number(match[1])) : null,
      });
    },
    boundary(
      phase: string,
      boundary:
        | "phase"
        | "resume-arm-begin"
        | "resume-arm-end"
        | "resume-seal-begin"
        | "resume-seal-end",
    ) {
      record(phase, { kind: "boundary", boundary });
    },
    beginGate(phase: string) {
      const id = ++gateId;
      record(phase, { kind: "gate", gateId: id, boundary: "begin" });
      return id;
    },
    countedGate(phase: string, id: number) {
      record(phase, {
        kind: "gate",
        gateId: id,
        boundary: "counted",
        consoleIds: [...pendingConsoleIds],
      });
    },
    clearedGate(phase: string, id: number) {
      record(phase, {
        kind: "gate",
        gateId: id,
        boundary: "cleared",
        consoleIds: [...pendingConsoleIds],
      });
      pendingConsoleIds = [];
    },
    snapshot() {
      return {
        clock: "runner-performance.now-ms",
        correlation: "console-and-request-ids-are-independent",
        limits: { events: MAX_EVENTS, bytes: MAX_BYTES },
        dropped: { events: droppedEvents, bytes: droppedBytes, consoleIds: droppedConsoleIds },
        complete: droppedEvents === 0 && droppedConsoleIds === 0,
        events: events.map((entry) => ({
          ...entry,
          ...(entry.consoleIds ? { consoleIds: [...entry.consoleIds] } : {}),
        })),
      };
    },
  };
}

export function capabilityMatcherDiagnostics(
  expected: CapabilityResumeExpected,
  decision: CapabilityResumeDecision,
) {
  return {
    expected: {
      endpoint: endpoint(expected.url),
      actorEpoch: actor(expected.actorEpoch),
      authorityHash: hash(expected.authorityHash),
      phase: expected.phase.slice(0, 120),
    },
    decision: { requestId: decision.requestId, reason: decision.reason },
  };
}
