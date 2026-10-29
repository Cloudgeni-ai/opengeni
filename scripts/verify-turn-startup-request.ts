#!/usr/bin/env bun
/** Differential first-request proof against an immutable baseline checkout.
 * Both production workers receive clones of the SAME admitted database state.
 * Compares raw serialized SDK ModelRequest bytes: no content normalization.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
} from "@opengeni/db";
import { resolveTurnExecutionPolicyV1 } from "@opengeni/config";
import { acquireSharedTestDatabase, quoteIdent } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";

type Fixture = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  attemptId: string;
  workflowRunId: string;
};
if (process.argv[2] === "--run") {
  const root = resolve(process.argv[3]!);
  const fixture = JSON.parse(await readFile(process.argv[4]!, "utf8")) as Fixture;
  const output = process.argv[5]!;
  const load = (path: string) => import(pathToFileURL(join(root, path)).href);
  const [
    { createDb: createReplayDb },
    { testSettings: replaySettings },
    { createTurnActivities },
    { createProductionAgentRuntime },
    { ScriptedModel },
    { MemoryEventBus },
    { recordModelTransportStarted, recordModelTransportDispatched },
  ] = await Promise.all([
    load("packages/db/src/index.ts"),
    load("packages/testing/src/settings.ts"),
    load("apps/worker/src/activities-turn.ts"),
    load("packages/runtime/src/index.ts"),
    load("packages/testing/src/scripted-model.ts"),
    load("packages/testing/src/fakes.ts"),
    load("packages/runtime/src/model-preparation-diagnostics.ts"),
  ]);
  const databaseUrl = process.env.OPENGENI_REPLAY_DATABASE_URL!;
  const client = createReplayDb(databaseUrl);
  const model = new ScriptedModel("OK");
  const stream = model.getStreamedResponse.bind(model);
  let captured = false;
  model.getStreamedResponse = async function* (request: unknown) {
    await recordModelTransportStarted();
    recordModelTransportDispatched(performance.now());
    if (captured) throw new Error("Unexpected second request");
    captured = true;
    await writeFile(output, JSON.stringify(request));
    yield* stream(request);
  };
  const runtime = createProductionAgentRuntime({ model });
  runtime.generateSessionTitle = async () => ({ title: null, usage: null });
  try {
    const activities = createTurnActivities({
      settings: replaySettings({ databaseUrl, sandboxBackend: "none" }),
      db: client.db,
      bus: new MemoryEventBus(),
      runtime,
      requestWorkerDrain: () => {
        throw new Error("Unexpected drain");
      },
    });
    const result = await activities.runAgentTurn({
      ...fixture,
      trigger: { kind: "next" },
      workflowId: `session-${fixture.sessionId}`,
    });
    if (!captured || result.status !== "idle")
      throw new Error(`Replay failed: ${JSON.stringify(result)}`);
  } finally {
    await client.close();
  }
} else {
  const baseline = resolve(process.argv[2]!);
  const output = resolve(process.argv[3] ?? ".startup/request-proof");
  await mkdir(output, { recursive: true });
  const shared = await acquireSharedTestDatabase("startup-request-proof");
  if (!shared) throw new Error("Real PostgreSQL required");
  const client = createDb(shared.appUrl);
  const settings = testSettings({ databaseUrl: shared.appUrl, sandboxBackend: "none" });
  const maintenanceUrl = new URL(shared.adminUrl);
  const sourceDatabase = decodeURIComponent(maintenanceUrl.pathname.slice(1));
  if (!sourceDatabase.startsWith("og_")) throw new Error("Only an owned fixture may be cloned");
  maintenanceUrl.pathname = "/postgres";
  const admin = postgres(maintenanceUrl.toString(), { max: 1 });
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const clones = [`og_request_before_${suffix}`, `og_request_after_${suffix}`];
  const created: string[] = [];
  try {
    const access = await bootstrapWorkspace(client.db, {
      accountExternalSource: "benchmark",
      accountExternalId: crypto.randomUUID(),
      accountName: "Startup proof",
      workspaceExternalSource: "benchmark",
      workspaceExternalId: crypto.randomUUID(),
      workspaceName: "Startup proof",
      subjectId: "benchmark:startup",
    });
    const grant = access.workspaceGrants[0]!;
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "Reply with OK.",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      grant.workspaceId,
      grant.subjectId,
      (tx) =>
        submitHumanPromptInTransaction(tx, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId: session.id,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "Reply with OK.",
          resources: [],
          reasoningEffortFallback: "medium",
          connectionAccountIntent: {
            version: 1,
            principal: { kind: "subject", subjectId: grant.subjectId },
            selections: [],
          },
          turnExecutionPolicy: resolveTurnExecutionPolicyV1(settings, {
            modelId: "scripted-model",
            requestedModelId: "scripted-model",
            modelSource: "explicit",
            reasoningEffort: "medium",
            reasoningSource: "explicit",
            latencyMode: "standard",
          }),
          source: "user",
        }),
    );
    const fixture: Fixture = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      attemptId: crypto.randomUUID(),
      workflowRunId: crypto.randomUUID(),
    };
    const fixturePath = join(output, "fixture.json");
    await writeFile(fixturePath, JSON.stringify(fixture));
    await client.close();
    await shared.admin.end();
    for (const database of clones) {
      await admin.unsafe(
        `create database ${quoteIdent(database)} template ${quoteIdent(sourceDatabase)}`,
      );
      created.push(database);
    }
    for (const [index, root] of [baseline, resolve(import.meta.dir, "..")].entries()) {
      const url = new URL(shared.appUrl);
      url.pathname = `/${clones[index]}`;
      const child = Bun.spawn(
        [
          process.execPath,
          import.meta.path,
          "--run",
          root,
          fixturePath,
          join(output, `${index === 0 ? "before" : "after"}.json`),
        ],
        {
          cwd: root,
          env: { ...process.env, OPENGENI_REPLAY_DATABASE_URL: url.toString() },
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      if ((await child.exited) !== 0) throw new Error(`Replay ${index} failed`);
    }
    const before = await readFile(join(output, "before.json"));
    const after = await readFile(join(output, "after.json"));
    const proof = {
      byteIdentical: before.equals(after),
      bytes: before.length,
      beforeSha256: new Bun.CryptoHasher("sha256").update(before).digest("hex"),
      afterSha256: new Bun.CryptoHasher("sha256").update(after).digest("hex"),
      normalization: "none",
    };
    await writeFile(join(output, "proof.json"), JSON.stringify(proof, null, 2));
    console.log(JSON.stringify(proof, null, 2));
    if (!proof.byteIdentical) throw new Error("First model request changed; inspect raw captures");
  } finally {
    await client.close();
    for (const database of created) await admin.unsafe(`drop database ${quoteIdent(database)}`);
    await admin.end();
    await shared.release();
  }
}
