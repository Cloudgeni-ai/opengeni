#!/usr/bin/env bun
import {
  deleteHumanQueuePrompt,
  editHumanQueuePrompt,
  moveHumanQueuePrompt,
  steerHumanQueuePrompt,
} from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  getSessionQueueSnapshot,
  withWorkspaceSessionActivityRls,
} from "@opengeni/db";
import { createNatsEventBus } from "@opengeni/events";
import { startTestServices } from "@opengeni/testing";
import { eq } from "drizzle-orm";
import * as schema from "../packages/db/src/schema";

const QUEUE_SIZE = Number(process.env.QUEUE_MUTATION_SIZE ?? "200");
const SAMPLES = Number(process.env.QUEUE_MUTATION_SAMPLES ?? "20");
const services = await startTestServices({ temporal: false });
const client = createDb(services.databaseUrl);
let bus: Awaited<ReturnType<typeof createNatsEventBus>> | null = null;

try {
  await migrateQuietly();
  bus = await createNatsEventBus(services.natsUrl);
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "bench:turn-queue-mutations",
    accountExternalId: `account:${suffix}`,
    accountName: "Turn queue mutation benchmark",
    workspaceExternalSource: "bench:turn-queue-mutations",
    workspaceExternalId: `workspace:${suffix}`,
    workspaceName: "Turn queue mutation benchmark",
    subjectId: `bench:turn-queue-mutations:${suffix}`,
  });
  const grant = access.workspaceGrants[0];
  if (!grant) throw new Error("benchmark workspace grant was not created");
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    initialMessage: "measure queue mutations",
    resources: [],
    tools: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  await withWorkspaceSessionActivityRls(client.db, grant.workspaceId, async (db) => {
    for (let offset = 0; offset < QUEUE_SIZE; offset += 500) {
      const length = Math.min(500, QUEUE_SIZE - offset);
      await db.insert(schema.sessionTurns).values(
        Array.from({ length }, (_, index) => ({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          triggerEventId: crypto.randomUUID(),
          temporalWorkflowId: `session-${session.id}`,
          status: "queued" as const,
          source: "user" as const,
          position: offset + index + 1,
          prompt: `queued prompt ${offset + index + 1}`,
          resources: [],
          tools: [],
          model: "scripted-model",
          reasoningEffort: "medium" as const,
          sandboxBackend: "none" as const,
          metadata: {},
        })),
      );
    }
    await db
      .update(schema.sessions)
      .set({
        queueVersion: 1,
        queueHeadPosition: 0,
        queueTailPosition: QUEUE_SIZE,
        status: "queued",
      })
      .where(eq(schema.sessions.id, session.id));
  });

  const deps = { db: client.db, bus };
  const context = {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    sessionId: session.id,
    subjectId: grant.subjectId,
  };
  let snapshot = await requiredSnapshot();
  const moveMs = await samples(async () => {
    const target = snapshot.items.at(-1)!;
    const before = snapshot.items[0]!;
    const result = await moveHumanQueuePrompt(deps, context, target.id, {
      clientEventId: crypto.randomUUID(),
      expectedQueueVersion: snapshot.version,
      beforeTurnId: before.id,
    });
    snapshot = result.snapshot;
  });
  const deleteMs = await samples(async () => {
    const target = snapshot.items.at(-1)!;
    const result = await deleteHumanQueuePrompt(deps, context, target.id, {
      clientEventId: crypto.randomUUID(),
      expectedTurnVersion: target.version,
      reason: "benchmark",
    });
    snapshot = result.snapshot;
  });
  let draftRevision = 0;
  const editMs = await samples(async (index) => {
    const target = snapshot.items.at(-1)!;
    const result = await editHumanQueuePrompt(deps, context, target.id, {
      clientEventId: crypto.randomUUID(),
      expectedTurnVersion: target.version,
      expectedDraftRevision: draftRevision,
      replaceDraft: index > 0,
    });
    if (!result.draft) throw new Error("queue edit did not return its durable draft");
    draftRevision = result.draft.revision;
    snapshot = result.snapshot;
  });
  const steerMs = await samples(async () => {
    const target = snapshot.items.at(-1)!;
    const result = await steerHumanQueuePrompt(deps, context, target.id, {
      clientEventId: crypto.randomUUID(),
      expectedTurnVersion: target.version,
      controlEtag: snapshot.effectiveControl.controlEtag,
    });
    snapshot = result.snapshot;
  });

  console.log(
    JSON.stringify(
      {
        queueSize: QUEUE_SIZE,
        samples: SAMPLES,
        finalQueueSize: snapshot.items.length,
        timingsMs: {
          move: distribution(moveMs),
          delete: distribution(deleteMs),
          edit: distribution(editMs),
          steer: distribution(steerMs),
        },
      },
      null,
      2,
    ),
  );

  async function requiredSnapshot() {
    const value = await getSessionQueueSnapshot(client.db, grant.workspaceId, session.id);
    if (!value) throw new Error("queue snapshot was not found");
    return value;
  }
} finally {
  await Promise.allSettled([bus?.close(), client.close()]);
  await services.down();
}
process.exit(0);

async function migrateQuietly(): Promise<void> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => undefined;
  console.warn = () => undefined;
  try {
    await services.migrate();
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

async function samples(operation: (index: number) => Promise<void>): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const startedAt = performance.now();
    await operation(index);
    values.push(performance.now() - startedAt);
  }
  return values;
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
