import type {
  TurnTimingAttempt,
  TurnTimingEvent,
  TurnTimingTurn,
} from "../src/turn-timing-profile";

export type TurnTimingFixture = {
  description: string;
  turn: { createdAt: string; startedAt: string | null; finishedAt: string; status: string };
  attempts: Array<{
    id: string;
    startedAt: string;
    closedAt: string | null;
    outcome: string | null;
  }>;
  events: Array<{
    type: string;
    sequence: number;
    occurredAt: string;
    attemptId: string | null;
    payload: Record<string, unknown>;
  }>;
};

export async function loadTurnTimingFixture(name: string): Promise<TurnTimingFixture> {
  return (await Bun.file(
    new URL(`./fixtures/turn-timing/${name}.json`, import.meta.url),
  ).json()) as TurnTimingFixture;
}

export function fixtureInput(fixture: TurnTimingFixture): {
  turn: TurnTimingTurn;
  attempts: TurnTimingAttempt[];
  events: TurnTimingEvent[];
} {
  return {
    turn: {
      createdAt: new Date(fixture.turn.createdAt),
      startedAt: fixture.turn.startedAt ? new Date(fixture.turn.startedAt) : null,
      finishedAt: new Date(fixture.turn.finishedAt),
    },
    attempts: fixture.attempts.map((attempt) => ({
      id: attempt.id,
      startedAt: new Date(attempt.startedAt),
      closedAt: attempt.closedAt ? new Date(attempt.closedAt) : null,
      outcome: attempt.outcome,
    })),
    events: fixture.events.map((event) => ({
      ...event,
      occurredAt: new Date(event.occurredAt),
    })),
  };
}

function pick(source: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!source || typeof source !== "object" || Array.isArray(source)) return out;
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== null && item !== undefined)
        .map(([key, item]) => [key, stripNulls(item)]),
    );
  }
  return value;
}

/**
 * The TypeScript mirror of the store's SQL projection. Fixtures hold
 * projected payloads; the Postgres test checks the SQL produces the same.
 */
export function projectTurnTimingPayload(
  type: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (type) {
    case "agent.model.request": {
      const out = pick(payload, [
        "phase",
        "requestId",
        "transportAttempt",
        "dispatchId",
        "durationMs",
        "dispatchDelayMs",
        "willRetry",
        "provider",
        "model",
      ]);
      const transport = payload.transport as Record<string, unknown> | undefined;
      if (transport && typeof transport === "object" && !Array.isArray(transport)) {
        out.transport = stripNulls({
          kind: transport.kind ?? null,
          timing: {
            server: (transport.timing as Record<string, unknown> | undefined)?.server ?? null,
          },
        });
      }
      return out;
    }
    case "agent.model.usage":
      return stripNulls(pick(payload, ["provider", "model", "purpose", "timing"])) as Record<
        string,
        unknown
      >;
    case "agent.toolCall.created": {
      const out = pick(payload, ["id", "name", "toolFamily"]);
      if (payload.name === "tool_invoke") {
        const args = payload.arguments;
        if (args && typeof args === "object" && !Array.isArray(args)) {
          out.arguments = pick(args, ["name"]);
        } else if (typeof args === "string") {
          const match = /"name"\s*:\s*"([^"]{1,255})"/.exec(args);
          out.arguments = match ? { name: match[1] } : {};
        }
      }
      return out;
    }
    case "agent.toolCall.output": {
      const out = pick(payload, ["id", "error", "failed"]);
      const output = payload.output;
      if (typeof output === "string") out.output = output.slice(0, 64);
      else if (output && typeof output === "object" && !Array.isArray(output)) {
        const record = output as Record<string, unknown>;
        out.output = stripNulls({
          isError: record.isError ?? null,
          text: typeof record.text === "string" ? record.text.slice(0, 64) : null,
        });
      }
      return out;
    }
    case "turn.startup.phase.completed":
      return pick(payload, ["phase", "durationMs"]);
    case "sandbox.operation.started":
    case "sandbox.operation.completed":
    case "sandbox.operation.failed":
      return pick(payload, ["name"]);
    case "session.context.compaction.started":
      return pick(payload, ["trigger"]);
    default:
      return {};
  }
}
