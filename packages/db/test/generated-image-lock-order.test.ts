import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  prepareGeneratedImageArtifact,
  prepareImageGenerationOperation,
  withRlsContext,
  type DbClient,
} from "../src";
import { lockSessionEventWriteRows } from "../src/session-control";

let shared: SharedTestDatabase | null = null;
let lifecycle: DbClient;
let image: DbClient;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("generated-image-lock-order");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL is required");
    return;
  }
  lifecycle = createDb(shared.appUrl, { max: 1 });
  image = createDb(shared.appUrl, { max: 1 });
  // FK trigger order depends on catalog history, not the source declaration.
  // Recreate the turn FK after the attempt FK to exercise the valid catalog
  // ordering that locks attempts first (also possible after dump/restore).
  // Keep every constraint and action intact; only creation order changes.
  for (const table of ["image_generation_operations", "generated_image_artifacts"]) {
    await shared.admin.unsafe(`
      ALTER TABLE "${table}" DROP CONSTRAINT "${table}_workspace_turn_fk";
      ALTER TABLE "${table}" ADD CONSTRAINT "${table}_workspace_turn_fk"
        FOREIGN KEY (workspace_id, turn_id)
        REFERENCES session_turns (workspace_id, id) ON DELETE SET NULL (turn_id);
    `);
  }
}, 180_000);

afterAll(async () => {
  await image?.close();
  await lifecycle?.close();
  await shared?.release();
});

for (const kind of ["operation", "artifact"] as const) {
  test(`generated image ${kind} prepare respects lifecycle turn-before-attempt locks`, async () => {
    if (!shared) return;
    const suffix = crypto.randomUUID();
    const access = await bootstrapWorkspace(lifecycle.db, {
      accountExternalSource: "test",
      accountExternalId: `image-lock-${suffix}`,
      accountName: "Image lock test",
      workspaceExternalSource: "test",
      workspaceExternalId: `image-lock-${suffix}`,
      workspaceName: "Image lock test",
      subjectId: `image-lock-${suffix}`,
    });
    const { accountId, workspaceId } = access.workspaceGrants[0]!;
    const session = await createSession(lifecycle.db, {
      accountId,
      workspaceId,
      initialMessage: "Generate an image",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await initializeSessionStartAtomically(lifecycle.db, {
      accountId,
      workspaceId,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claim = await claimSessionWorkForAttempt(lifecycle.db, workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: suffix,
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error("Could not claim image lock fixture");
    const artifactId = crypto.randomUUID();
    const identity = {
      accountId,
      workspaceId,
      sessionId: session.id,
      turnId: claim.turn.id,
      attemptId,
    };
    const common = {
      ...identity,
      toolCallId: "image-lock-test",
      providerId: "test-provider",
      providerBindingHash: "a".repeat(64),
    };
    const prepare = () =>
      kind === "operation"
        ? prepareImageGenerationOperation(image.db, {
            ...common,
            id: crypto.randomUUID(),
            operationKey: "b".repeat(64),
            modelId: "test-image",
            requestDigest: "c".repeat(64),
            expectedArtifactId: artifactId,
          })
        : prepareGeneratedImageArtifact(image.db, {
            ...common,
            artifactId,
            uploadId: crypto.randomUUID(),
            settlementKey: "d".repeat(64),
            sourceStrategy: "provider_adapter",
            providerItemId: null,
            mediaType: "image/png",
            sizeBytes: 10,
            sha256: "e".repeat(64),
            width: 1,
            height: 1,
            sandboxPath: `/workspace/generated-images/generated-image-${artifactId}.png`,
            filename: "image.png",
            safeFilename: "image.png",
            bucket: "test",
            objectKey: artifactId,
            uploadExpiresAt: new Date(Date.now() + 60_000),
          });
    const [imageBackend] = await image.db.execute<{ pid: number }>(
      sql`select pg_backend_pid() as pid`,
    );
    await image.db.execute(sql`set statement_timeout = '15s'`);
    let preparation: Promise<PromiseSettledResult<unknown>> | undefined;
    const settlement = await withRlsContext(
      lifecycle.db,
      { accountId, workspaceId },
      async (tx) => {
        await tx.execute(sql`set local statement_timeout = '15s'`);
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        // Real lifecycle writers take this prefix before locking exact attempts.
        await lockSessionEventWriteRows(tx, {
          workspaceId,
          controlLock: "none",
          sessionIds: [session.id],
          turnIds: [claim.turn.id],
        });
        preparation = prepare().then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
        // Observe the exact image backend blocked by our lifecycle transaction.
        // Before the fix its INSERT already owns the attempt FK KEY SHARE; after
        // the fix it waits on the canonical prefix without holding the attempt.
        let blocked = false;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const [row] = await shared!.admin<{ blocked: boolean }[]>`
          select ${backend!.pid}::integer = any(pg_blocking_pids(${imageBackend!.pid})) as blocked`;
          if (row?.blocked) {
            blocked = true;
            break;
          }
          await Bun.sleep(10);
        }
        expect(blocked).toBe(true);
        await lockSessionEventWriteRows(tx, {
          workspaceId,
          controlLock: "none",
          workspaceLock: "already_locked",
          attemptIds: [attemptId],
        });
      },
    ).then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    const prepared = await preparation;
    if (settlement.status === "rejected") throw settlement.reason;
    if (prepared?.status === "rejected") throw prepared.reason;
    expect(settlement).toEqual({ status: "fulfilled" });
    expect(prepared?.status).toBe("fulfilled");
    if (prepared?.status === "fulfilled") expect(prepared.value).toMatchObject({ created: true });
  }, 30_000);
}
