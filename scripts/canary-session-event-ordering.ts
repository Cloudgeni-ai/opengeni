type CanaryEvent = {
  id: string;
  sequence: number;
  type: string;
  turnId?: string | null;
  turnAttemptId?: string | null;
};

type CanarySession = {
  id: string;
  status: string;
  title?: string | null;
  lastSequence?: number;
};

export type CanaryEventProof = {
  eventCount: number;
  firstSequence: number;
  lastSequence: number;
  titleSequence: number;
  usageSequence: number;
  terminalSequence: number;
  turnId: string;
  attemptId: string;
};

export function proveFirstTurnEventOrdering(
  events: CanaryEvent[],
  sessionLastSequence: number,
): CanaryEventProof {
  if (events.length === 0) throw new Error("Canary session has no durable events");
  const sequences = events.map((event) => event.sequence);
  for (let index = 0; index < sequences.length; index += 1) {
    if (sequences[index] !== index + 1) {
      throw new Error("Canary event sequence is not unique and contiguous from one");
    }
  }
  if (new Set(events.map((event) => event.id)).size !== events.length) {
    throw new Error("Canary durable replay contains duplicate event IDs");
  }
  if (sessionLastSequence !== sequences.at(-1)) {
    throw new Error("Session lastSequence does not match durable replay");
  }

  const exactlyOne = (type: string): CanaryEvent => {
    const matches = events.filter((event) => event.type === type);
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one ${type} event, observed ${matches.length}`);
    }
    return matches[0]!;
  };
  const title = exactlyOne("session.title_set");
  const started = exactlyOne("turn.started");
  const usage = exactlyOne("agent.model.usage");
  const completed = exactlyOne("turn.completed");
  for (const forbidden of [
    "turn.failed",
    "session.failed",
    "turn.event.rejected_late",
    "turn.cancelled",
  ]) {
    if (events.some((event) => event.type === forbidden)) {
      throw new Error(`Canary replay contains forbidden terminal event ${forbidden}`);
    }
  }
  if (!started.turnId || started.turnId !== usage.turnId || started.turnId !== completed.turnId) {
    throw new Error("First-turn start, usage, and completion do not share one turn ID");
  }
  if (!usage.turnAttemptId || usage.turnAttemptId !== completed.turnAttemptId) {
    throw new Error("First-turn usage and completion do not share one attempt ID");
  }
  return {
    eventCount: events.length,
    firstSequence: sequences[0]!,
    lastSequence: sequences.at(-1)!,
    titleSequence: title.sequence,
    usageSequence: usage.sequence,
    terminalSequence: completed.sequence,
    turnId: started.turnId,
    attemptId: usage.turnAttemptId,
  };
}

if (import.meta.main) {
  await runCanary();
}

async function runCanary(): Promise<void> {
  if (process.env.OPENGENI_CANARY_EXECUTE !== "1") {
    console.log(
      JSON.stringify({
        ok: true,
        executed: false,
        canary: "session-event-ordering",
        enableWith: "OPENGENI_CANARY_EXECUTE=1",
        requiredEnvironment: [
          "OPENGENI_CANARY_API_BASE_URL",
          "OPENGENI_CANARY_WORKSPACE_ID",
          "exactly one of OPENGENI_CANARY_API_KEY or OPENGENI_CANARY_DEPLOYMENT_ACCESS_KEY",
        ],
      }),
    );
    return;
  }

  const baseUrl = requiredUrl("OPENGENI_CANARY_API_BASE_URL");
  const workspaceId = requiredUuid("OPENGENI_CANARY_WORKSPACE_ID");
  const apiKey = optionalNonEmpty("OPENGENI_CANARY_API_KEY");
  const deploymentKey = optionalNonEmpty("OPENGENI_CANARY_DEPLOYMENT_ACCESS_KEY");
  if (Boolean(apiKey) === Boolean(deploymentKey)) {
    throw new Error("Configure exactly one canary API credential");
  }
  const model = process.env.OPENGENI_CANARY_MODEL?.trim() || "codex/gpt-5.6-luna";
  if (!model.startsWith("codex/")) {
    throw new Error("OPENGENI_CANARY_MODEL must use a Codex subscription model");
  }
  const timeoutSeconds = positiveInteger("OPENGENI_CANARY_TIMEOUT_SECONDS", 180);
  const pollMilliseconds = positiveInteger("OPENGENI_CANARY_POLL_MS", 1_000);
  const runId = crypto.randomUUID();
  const title = `OPE-63 event-order canary ${runId.slice(0, 8)}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(deploymentKey ? { "x-opengeni-access-key": deploymentKey } : {}),
  };
  const sessionPath = `/v1/workspaces/${workspaceId}/sessions`;
  const session = await requestJson<CanarySession>(baseUrl, sessionPath, headers, {
    method: "POST",
    body: {
      initialMessage:
        "Return exactly OPE63_CANARY_OK in one response. Do not call tools and do not create external effects.",
      resources: [],
      tools: [],
      metadata: { ope63EventOrderingCanary: true, runId },
      model,
      reasoningEffort: "low",
      sandboxBackend: "none",
      idempotencyKey: `ope63-event-ordering-${runId}`,
    },
  });
  if (!isUuid(session.id)) throw new Error("Canary create response has no valid session ID");

  const titled = await requestJson<CanarySession>(
    baseUrl,
    `${sessionPath}/${session.id}`,
    headers,
    { method: "PATCH", body: { title } },
  );
  if (titled.title !== title) throw new Error("Canary title mutation was not acknowledged");

  const deadline = Date.now() + timeoutSeconds * 1_000;
  let current = titled;
  let events: CanaryEvent[] = [];
  while (Date.now() < deadline) {
    [current, events] = await Promise.all([
      requestJson<CanarySession>(baseUrl, `${sessionPath}/${session.id}`, headers),
      requestJson<CanaryEvent[]>(
        baseUrl,
        `${sessionPath}/${session.id}/events?after=0&limit=2000`,
        headers,
      ),
    ]);
    if (["idle", "failed", "cancelled"].includes(current.status)) break;
    await Bun.sleep(pollMilliseconds);
  }
  if (current.status !== "idle") {
    throw new Error(`Canary session reached non-success terminal status ${current.status}`);
  }
  if (!Number.isSafeInteger(current.lastSequence) || current.lastSequence! < 1) {
    throw new Error("Canary session did not expose a valid lastSequence");
  }
  const proof = proveFirstTurnEventOrdering(events, current.lastSequence!);
  console.log(
    JSON.stringify({
      ok: true,
      executed: true,
      canary: "session-event-ordering",
      runId,
      workspaceId,
      sessionId: session.id,
      status: current.status,
      model,
      ...proof,
    }),
  );
}

async function requestJson<T>(
  baseUrl: URL,
  path: string,
  headers: Record<string, string>,
  options: { method?: "GET" | "POST" | "PATCH"; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(new URL(path, baseUrl), {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Canary API ${options.method ?? "GET"} ${new URL(path, baseUrl).pathname} returned HTTP ${response.status}`,
      );
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function requiredUrl(name: string): URL {
  const value = optionalNonEmpty(name);
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${name} must use HTTPS outside loopback`);
  }
  return url;
}

function requiredUuid(name: string): string {
  const value = optionalNonEmpty(name);
  if (!value || !isUuid(value)) throw new Error(`${name} must be a UUID`);
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function optionalNonEmpty(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
