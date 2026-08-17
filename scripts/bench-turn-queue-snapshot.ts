#!/usr/bin/env bun
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSessionQueueSnapshot,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import { startTestServices } from "@opengeni/testing";
import { eq } from "drizzle-orm";
import * as schema from "../packages/db/src/schema";

const CASES = [1, 100, 1_000, 5_000] as const;
const SAMPLES = 7;
const PROMPT_BYTES = 512;
const services = await startTestServices({ temporal: false });
const client = createDb(services.databaseUrl);

try {
  await services.migrate();
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "bench:turn-queue-snapshot",
    accountExternalId: `account:${suffix}`,
    accountName: "Turn queue snapshot benchmark",
    workspaceExternalSource: "bench:turn-queue-snapshot",
    workspaceExternalId: `workspace:${suffix}`,
    workspaceName: "Turn queue snapshot benchmark",
    subjectId: `bench:turn-queue-snapshot:${suffix}`,
  });
  const grant = access.workspaceGrants[0];
  if (!grant) throw new Error("benchmark workspace grant was not created");

  const receipts = [];
  for (const count of CASES) {
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: `measure ${count} queued prompts`,
      resources: [],
      tools: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, async (db) => {
      const prompt = "q".repeat(PROMPT_BYTES);
      for (let offset = 0; offset < count; offset += 500) {
        const length = Math.min(500, count - offset);
        await db.insert(schema.sessionTurns).values(
          Array.from({ length }, (_, index) => {
            const position = offset + index + 1;
            return {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId,
              sessionId: session.id,
              triggerEventId: crypto.randomUUID(),
              temporalWorkflowId: `session-${session.id}`,
              status: "queued" as const,
              source: "user" as const,
              position,
              prompt: `${String(position).padStart(5, "0")}:${prompt}`,
              resources: [],
              tools: [],
              model: "scripted-model",
              reasoningEffort: "medium" as const,
              sandboxBackend: "none" as const,
              metadata: {},
            };
          }),
        );
      }
      await db
        .update(schema.sessions)
        .set({
          queueVersion: 1,
          queueHeadPosition: 0,
          queueTailPosition: count,
          status: "queued",
        })
        .where(eq(schema.sessions.id, session.id));
    });

    await readAndAssert(count, session.id, grant.workspaceId);
    const timings: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const startedAt = performance.now();
      await readAndAssert(count, session.id, grant.workspaceId);
      timings.push(performance.now() - startedAt);
    }
    receipts.push({
      count,
      promptBytes: PROMPT_BYTES,
      responsePromptBytes: count * (PROMPT_BYTES + 6),
      timingsMs: distribution(timings),
      contentParity: "pass",
    });
  }
  console.log(JSON.stringify({ samples: SAMPLES, receipts }, null, 2));
} finally {
  await client.close();
  await services.down();
}
process.exit(0);

async function readAndAssert(
  expectedCount: number,
  sessionId: string,
  workspaceId: string,
): Promise<void> {
  const snapshot = await getSessionQueueSnapshot(client.db, workspaceId, sessionId);
  if (!snapshot) throw new Error("queue snapshot was not found");
  if (snapshot.items.length !== expectedCount) {
    throw new Error(`queue snapshot retained ${snapshot.items.length}/${expectedCount} prompts`);
  }
  if (snapshot.items[0]?.position !== 1 || snapshot.items.at(-1)?.position !== expectedCount) {
    throw new Error("queue snapshot order changed");
  }
}

function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
  };
}
