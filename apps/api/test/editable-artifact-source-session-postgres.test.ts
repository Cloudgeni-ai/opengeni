import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  EditableArtifactLiveServer,
  EditableArtifactService,
  InMemoryEditableArtifactLiveTicketStore,
  InMemoryEditableArtifactStableIdFactory,
  WebCryptoEditableArtifactLiveTokens,
  editableArtifactId,
  editableArtifactLiveReadPortFromPostgres,
  editableArtifactReplicaId,
  editableArtifactStorePortFromPostgres,
  ogatxEditableArtifactMutationIntentCodec,
  type ApiRouteDeps,
  type EditableArtifactLiveServerFrame,
  type EditableArtifactLiveTicketRecord,
} from "@opengeni/core";
import {
  bootstrapWorkspace,
  createDb,
  createSession,
  hasEditableArtifactSessionLink,
  PostgresEditableArtifactLiveReadStore,
  PostgresEditableArtifactStore,
  touchEditableArtifactSessionLink,
  withSessionRlsActorContext,
  type DbClient,
} from "@opengeni/db";
import { rawRows } from "../../../packages/db/src/database";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  TestAuthoritativeKernel,
  TestArtifactGenesis,
  TestArtifactSnapshotVerifier,
  transactionRequest,
} from "../../../packages/core/test/editable-artifacts/fixtures";
import { editableArtifactSourceSessionAuthorizer } from "../src/editable-artifact-source-session";
import { PostgresEditableArtifactAuthorization } from "../src/editable-artifact-production";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
let fixtureCounter = 0;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("editable-artifact-source-session-postgres");
  if (!shared) {
    if (requireRealDatabase) throw new Error("Source-session regression requires real PostgreSQL");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
  const [posture] = await rawRows<{ role: string; superuser: boolean; bypass: boolean }>(
    client.db,
    sql`select current_user as role, rolsuper as superuser, rolbypassrls as bypass
      from pg_roles where rolname = current_user`,
  );
  expect(posture).toEqual({ role: "opengeni_app", superuser: false, bypass: false });
  const [rls] = await shared.admin<Array<{ forced: boolean }>>`
    select bool_and(relrowsecurity and relforcerowsecurity) as forced
    from pg_class where relname in ('sessions', 'editable_artifacts', 'editable_artifact_session_links')`;
  expect(rls?.forced).toBe(true);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function fixture(modality: "document" | "presentation" | "spreadsheet" = "document") {
  if (!shared || !client) throw new Error("Source-session fixture requires PostgreSQL");
  const database = shared;
  const db = client.db;
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(db, {
    accountExternalSource: "live-source-commit-test",
    accountExternalId: suffix,
    accountName: "Live source commit",
    workspaceExternalSource: "live-source-commit-test",
    workspaceExternalId: suffix,
    workspaceName: "Live source commit",
    subjectId: `user:${suffix}`,
  });
  const grant = {
    ...access.workspaceGrants[0]!,
    principalKind: "human_session" as const,
    permissions: ["sessions:read", "artifacts:read", "artifacts:publish"] as const,
  };
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const actor = {
    kind: "human" as const,
    subjectId: grant.subjectId,
    replicaId: editableArtifactReplicaId("aaaaaaaaaaaaaaaa"),
  };
  const source = await createSession(db, {
    ...scope,
    initialMessage: "Live source commit fixture",
    resources: [],
    metadata: {},
    model: "fixture",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
    createdBy: { kind: "subject", subjectId: grant.subjectId },
    createdByContext: {},
  });
  const store = new PostgresEditableArtifactStore(db);
  const authorization = new PostgresEditableArtifactAuthorization(db);
  const kernel = new TestAuthoritativeKernel();
  const clock = { now: () => new Date() };
  const domain = new EditableArtifactService({
    store: editableArtifactStorePortFromPostgres(store),
    authorization,
    kernel,
    intentCodec: ogatxEditableArtifactMutationIntentCodec,
    snapshotVerifier: new TestArtifactSnapshotVerifier(),
    genesis: new TestArtifactGenesis(),
    ids: new InMemoryEditableArtifactStableIdFactory(BigInt(++fixtureCounter)),
    clock,
  });
  const created = await domain.createArtifact({
    scope,
    actor,
    request: { modality, title: "Live source commit", idempotencyKey: `create:${suffix}` as never },
  });
  const artifactId = editableArtifactId(created.artifact.id);
  await withSessionRlsActorContext({ subjectId: actor.subjectId }, () =>
    touchEditableArtifactSessionLink(db, scope, source.id, artifactId),
  );
  let hostAllowed = true;
  const deps = {
    db,
    sessionAuthorization: {
      authorizeSession: async () =>
        hostAllowed ? { allowed: true } : { allowed: false, reason: "revoked" },
      resolveListScope: async () => ({ kind: "all" as const }),
    },
  } as unknown as ApiRouteDeps;
  const authorizeSourceSession = editableArtifactSourceSessionAuthorizer(deps);
  const frames: EditableArtifactLiveServerFrame[] = [];
  const server = new EditableArtifactLiveServer({
    authorization,
    domain,
    tickets: new InMemoryEditableArtifactLiveTicketStore(),
    tokens: new WebCryptoEditableArtifactLiveTokens(),
    clock,
    scheduler: {
      sleep: async (_milliseconds, signal) =>
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("closed")), { once: true });
        }),
    },
    read: editableArtifactLiveReadPortFromPostgres(
      new PostgresEditableArtifactLiveReadStore(db, {
        snapshotBytes: { readSnapshotBytes: async () => new Uint8Array() },
      }),
    ),
    hints: { subscribe: async () => () => undefined },
    invalidations: { subscribe: async () => () => undefined },
  });
  const ticket = await server.mintTicket({
    scope,
    artifactId,
    modality,
    actor,
    allowEdit: true,
    sourceSessionAuthority: { sessionId: source.id, grant },
  });
  const session = await server.openLive({
    token: ticket.token,
    artifactId,
    protocolVersion: 2,
    resume:
      modality === "spreadsheet"
        ? {
            modality,
            localCursor: 0,
            localStateHash: created.artifact.stateHash,
            localCausalFrontier: [],
            requireSnapshot: false,
          }
        : {
            modality,
            localCursor: 0,
            localStateHash: created.artifact.stateHash,
            localNativeRevision: 0,
            requireSnapshot: false,
          },
    sink: {
      send: async (frame) => void frames.push(frame),
      bufferedBytes: () => 0,
      close: () => undefined,
    },
    authorizeSourceSession,
  });
  const request = await transactionRequest(domain, {
    artifactId,
    modality,
    actor,
    clientTransactionId: `source-commit:${suffix}` as never,
  });
  return {
    database,
    db,
    scope,
    source,
    actor,
    artifactId,
    initialStateHash: created.artifact.stateHash,
    domain,
    store,
    kernel,
    frames,
    session,
    request,
    authorizeSourceSession,
    ticketRecord: {
      scope,
      artifactId,
      actor,
      sourceSessionAuthority: { sessionId: source.id, grant },
    } as EditableArtifactLiveTicketRecord,
    revoke: () => {
      hostAllowed = false;
    },
    submit: () =>
      session.submitIntent({
        protocolVersion: 2,
        artifactId,
        streamEpoch: session.streamEpoch,
        ...request,
      }),
    async durableEffects() {
      const [row] = await database.admin<
        Array<{
          head: number;
          stateHash: string;
          transactions: number;
          receipts: number;
          operations: number;
          undo: number;
          outbox: number;
        }>
      >`select head_sequence::int as head, state_hash as "stateHash",
          (select count(*)::int from editable_artifact_transactions where artifact_id = ${artifactId}) as transactions,
          (select count(*)::int from editable_artifact_idempotency_receipts where artifact_id = ${artifactId} and operation_kind = 'edit') as receipts,
          (select count(*)::int from editable_artifact_operations where artifact_id = ${artifactId}) as operations,
          (select count(*)::int from editable_artifact_undo_claims where artifact_id = ${artifactId}) as undo,
          (select count(*)::int from editable_artifact_live_outbox where artifact_id = ${artifactId} and event->>'kind' = 'transaction_committed') as outbox
        from editable_artifacts where id = ${artifactId}`;
      return row!;
    },
  };
}

async function gatedMutation(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = f.kernel.applyTransaction.bind(f.kernel);
  f.kernel.applyTransaction = async (request) => {
    entered.resolve();
    await release.promise;
    return await original(request);
  };
  const mutation = f.submit();
  // Observe rejection immediately, rather than leave an unhandled promise.
  const outcome = mutation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await entered.promise;
  return { outcome, release: () => release.resolve() };
}

describe("transactional live source-session authority", () => {
  test.each(["document", "presentation", "spreadsheet"] as const)(
    "host revocation during %s domain computation leaves zero mutation effects",
    async (modality) => {
      if (!shared || !client) return;
      const f = await fixture(modality);
      try {
        const before = await f.durableEffects();
        const gated = await gatedMutation(f);
        f.revoke();
        gated.release();
        expect(await gated.outcome).toMatchObject({ error: { code: "permission_changed" } });
        expect(f.kernel.calls).toHaveLength(1);
        expect(await f.durableEffects()).toEqual(before);
        expect(before).toMatchObject({
          head: 0,
          transactions: 0,
          receipts: 0,
          operations: 0,
          undo: 0,
          outbox: 0,
        });
        expect(f.frames.filter((frame) => frame.type === "transaction")).toHaveLength(0);
      } finally {
        await f.session.close();
      }
    },
    30_000,
  );

  test("association removal during domain computation fences commit despite artifact edit authority", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    try {
      const before = await f.durableEffects();
      const gated = await gatedMutation(f);
      await f.database.admin`delete from editable_artifact_session_links
        where session_id = ${f.source.id} and artifact_id = ${f.artifactId}`;
      gated.release();
      expect(await gated.outcome).toMatchObject({ error: { code: "permission_changed" } });
      expect(f.kernel.calls).toHaveLength(1);
      expect(await f.durableEffects()).toEqual(before);
    } finally {
      await f.session.close();
    }
  }, 30_000);

  test("source-read membership revocation during domain computation denies despite retained artifact edit permission", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    try {
      const before = await f.durableEffects();
      const gated = await gatedMutation(f);
      await f.database.admin`update workspace_memberships
        set permissions = '["artifacts:read","artifacts:publish"]'::jsonb
        where workspace_id = ${f.scope.workspaceId} and subject_id = ${f.actor.subjectId}`;
      gated.release();
      expect(await gated.outcome).toMatchObject({ error: { code: "permission_changed" } });
      expect(f.kernel.calls).toHaveLength(1);
      expect(await f.durableEffects()).toEqual(before);
    } finally {
      await f.session.close();
    }
  }, 30_000);

  test("private source visibility revocation during domain computation leaves the artifact unchanged", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    try {
      const before = await f.durableEffects();
      const gated = await gatedMutation(f);
      const stranger = `user:${crypto.randomUUID()}`;
      const membershipId = crypto.randomUUID();
      const [personal] = await f.database.admin<Array<{ id: string }>>`
        insert into workspaces(account_id, name)
        values(${f.scope.accountId}, 'Source owner Personal') returning id`;
      await f.database.admin.begin(async (tx) => {
        // Only fixture lifecycle setup bypasses triggers; mutation and source
        // authorization still use the restricted FORCE-RLS application role.
        await tx`set local session_replication_role = replica`;
        await tx`insert into organization_memberships(
          id, account_id, subject_id, role, status, personal_workspace_id)
          values(${membershipId}, ${f.scope.accountId}, ${stranger}, 'owner', 'active', ${personal!.id})`;
        await tx`update sessions set visibility = 'user_private',
          owner_subject_id = ${stranger}, owner_organization_membership_id = ${membershipId}
          where id = ${f.source.id}`;
      });
      gated.release();
      expect(await gated.outcome).toMatchObject({ error: { code: "permission_changed" } });
      expect(f.kernel.calls).toHaveLength(1);
      expect(await f.durableEffects()).toEqual(before);
    } finally {
      await f.session.close();
    }
  }, 30_000);

  test("host revocation while waiting for the aggregate lock is rechecked at the final write fence", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const locked = Promise.withResolvers<void>();
    const releaseLock = Promise.withResolvers<void>();
    const admissionChecked = Promise.withResolvers<void>();
    const lock = f.database.admin.begin(async (peer) => {
      await peer`select id from editable_artifacts where id = ${f.artifactId} for update`;
      locked.resolve();
      await releaseLock.promise;
    });
    try {
      await locked.promise;
      const port = editableArtifactStorePortFromPostgres(f.store);
      const original = port.tryCommitAppliedTransaction.bind(port);
      port.tryCommitAppliedTransaction = async (request) =>
        await original({
          ...request,
          authorizeCommit: async (tx) => {
            await request.authorizeCommit!(tx);
            admissionChecked.resolve();
          },
        });
      const outcome = f.submit().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await admissionChecked.promise;
      f.revoke();
      releaseLock.resolve();
      await lock;
      expect(await outcome).toMatchObject({ error: { code: "permission_changed" } });
      expect(await f.durableEffects()).toMatchObject({
        head: 0,
        transactions: 0,
        receipts: 0,
        operations: 0,
        undo: 0,
        outbox: 0,
      });
    } finally {
      releaseLock.resolve();
      await lock;
      await f.session.close();
    }
  }, 30_000);

  test("source callback receives the commit backend and holds association/session locks until commit", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    try {
      const checkedBackends: number[] = [];
      const port = editableArtifactStorePortFromPostgres(f.store);
      const original = port.tryCommitAppliedTransaction.bind(port);
      let commitBackend: number | undefined;
      port.tryCommitAppliedTransaction = async (request) =>
        await original({
          ...request,
          authorizeCommit: async (tx) => {
            const [backend] = await rawRows<{ pid: number }>(
              tx,
              sql`select pg_backend_pid() as pid`,
            );
            commitBackend = backend!.pid;
            expect(tx).not.toBe(f.db);
            await request.authorizeCommit!(tx);
            const [scope] = await rawRows<{ account: string; workspace: string }>(
              tx,
              sql`select current_setting('opengeni.account_id') as account,
                current_setting('opengeni.workspace_id') as workspace`,
            );
            expect(scope).toEqual({ account: f.scope.accountId, workspace: f.scope.workspaceId });
            await expect(
              f.database.admin.begin(async (peer) => {
                await peer`set local lock_timeout = '100ms'`;
                await peer`delete from editable_artifact_session_links
                  where session_id = ${f.source.id} and artifact_id = ${f.artifactId}`;
              }),
            ).rejects.toMatchObject({ code: "55P03" });
            await expect(
              f.database.admin.begin(async (peer) => {
                await peer`select id from sessions where id = ${f.source.id} for update nowait`;
              }),
            ).rejects.toMatchObject({ code: "55P03" });
            const [after] = await rawRows<{ pid: number }>(tx, sql`select pg_backend_pid() as pid`);
            checkedBackends.push(after!.pid);
          },
        });
      const result = await f.submit();
      expect(checkedBackends).toEqual([commitBackend!, commitBackend!]);
      expect(result.transaction.transactionId).toMatch(/^[0-9a-f]{32}$/);
      expect(await f.durableEffects()).toMatchObject({
        head: 1,
        transactions: 1,
        receipts: 1,
        operations: 0,
        undo: 0,
        outbox: 1,
      });
      f.revoke();
      await expect(
        f.domain.applyTransaction({
          scope: f.scope,
          artifactId: f.artifactId,
          actor: f.actor,
          request: f.request,
          authorizeCommit: async (tx) => {
            if (!(await f.authorizeSourceSession(f.ticketRecord, "edit", tx))) {
              throw new Error("source revoked");
            }
          },
        }),
      ).rejects.toThrow("source revoked");
      expect(await hasEditableArtifactSessionLink(f.db, f.scope, f.source.id, f.artifactId)).toBe(
        true,
      );
    } finally {
      await f.session.close();
    }
  }, 30_000);

  test("concurrent exact retries cannot borrow another source's in-flight authority", async () => {
    if (!shared || !client) return;
    const f = await fixture();
    const firstEntered = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    let secondaryAllowed = true;
    let calls = 0;
    const original = f.kernel.applyTransaction.bind(f.kernel);
    f.kernel.applyTransaction = async (request) => {
      calls += 1;
      if (calls === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
      } else {
        secondEntered.resolve();
        await releaseSecond.promise;
      }
      return await original(request);
    };
    try {
      const first = f.submit();
      await firstEntered.promise;
      const second = f.domain
        .applyTransaction({
          scope: f.scope,
          artifactId: f.artifactId,
          actor: f.actor,
          request: f.request,
          authorizeCommit: async (tx) => {
            if (
              !secondaryAllowed ||
              !(await f.authorizeSourceSession(f.ticketRecord, "edit", tx))
            ) {
              throw new Error("secondary source revoked");
            }
          },
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      await secondEntered.promise;
      releaseFirst.resolve();
      await first;
      secondaryAllowed = false;
      releaseSecond.resolve();
      expect(await second).toMatchObject({ error: { message: "secondary source revoked" } });
      expect(f.kernel.calls).toHaveLength(2);
      expect(await f.durableEffects()).toMatchObject({
        head: 1,
        transactions: 1,
        receipts: 1,
        outbox: 1,
      });
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      await f.session.close();
    }
  }, 30_000);
});
