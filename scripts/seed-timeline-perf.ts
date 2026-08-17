#!/usr/bin/env bun
import { appendSessionEvents, createDb, createSession, type AppendEventInput } from "@opengeni/db";

const eventCount = integerArgument("--events", 10_000);
const payloadChars = integerArgument("--payload-chars", 384);
const shape = stringArgument("--shape") ?? "messages";
const baseUrl = stringArgument("--base-url") ?? "http://127.0.0.1:8000";
const databaseUrl = process.env.OPENGENI_DATABASE_URL;

if (!databaseUrl) throw new Error("OPENGENI_DATABASE_URL is required");
if (eventCount < 1 || eventCount > 10_000) throw new Error("--events must be between 1 and 10000");
if (payloadChars < 32 || payloadChars > 4_096) {
  throw new Error("--payload-chars must be between 32 and 4096");
}
if (shape !== "messages" && shape !== "turns") {
  throw new Error('--shape must be "messages" or "turns"');
}

const accessResponse = await fetch(new URL("/v1/access/me", baseUrl));
if (!accessResponse.ok) throw new Error(`local access lookup failed with ${accessResponse.status}`);
const access = (await accessResponse.json()) as {
  accountGrants: Array<{ accountId: string }>;
  defaultWorkspaceId: string;
};
const accountId = access.accountGrants[0]?.accountId;
const workspaceId = access.defaultWorkspaceId;
if (!accountId || !workspaceId)
  throw new Error("local access returned no default account/workspace");

const client = createDb(databaseUrl);
try {
  const session = await createSession(client.db, {
    accountId,
    workspaceId,
    initialMessage: `Timeline performance fixture — ${eventCount} ${shape} events`,
    resources: [],
    tools: [],
    metadata: {
      origin: "timeline-performance-lab",
      eventCount,
      payloadChars,
      shape,
    },
    model: "scripted-model",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: "dev", label: "Performance lab" },
  });

  const padding = " lossless-content".repeat(Math.ceil(payloadChars / 17)).slice(0, payloadChars);
  for (let offset = 0; offset < eventCount; offset += 100) {
    const length = Math.min(100, eventCount - offset);
    const events: AppendEventInput[] = Array.from({ length }, (_, index) => {
      const position = offset + index;
      const turnNumber = Math.floor(position / 4) + 1;
      const turnId =
        shape === "turns"
          ? `00000000-0000-4000-8000-${String(turnNumber).padStart(12, "0")}`
          : null;
      if (shape === "turns") {
        switch (position % 4) {
          case 0:
            return {
              type: "user.message",
              payload: {
                text: `Turn ${turnNumber} request. **Marker U${String(turnNumber).padStart(5, "0")}**.${padding}`,
              },
              turnId,
            };
          case 1:
            return {
              type: "agent.message.delta",
              payload: {
                text: `Turn ${turnNumber} answer. **Marker A${String(turnNumber).padStart(5, "0")}**.${padding}`,
              },
              turnId,
            };
          case 2:
            return {
              type: "agent.message.completed",
              payload: {},
              turnId,
            };
          default:
            return {
              type: "turn.completed",
              payload: {},
              turnId,
            };
        }
      }
      return {
        type: "user.message",
        payload: {
          text: `Complete history event ${position + 1} of ${eventCount}. **Marker ${String(position + 1).padStart(5, "0")}**.${padding}`,
        },
        turnId: null,
      };
    });
    await appendSessionEvents(client.db, workspaceId, session.id, events);
  }

  process.stdout.write(
    `${JSON.stringify({
      eventCount,
      shape,
      sessionId: session.id,
      url: `http://127.0.0.1:3000/workspaces/${workspaceId}/sessions/${session.id}`,
      workspaceId,
    })}\n`,
  );
} finally {
  await client.close();
}

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  const parsed = Number.parseInt(index < 0 ? "" : (process.argv[index + 1] ?? ""), 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function stringArgument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}
