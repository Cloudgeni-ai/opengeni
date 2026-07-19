import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  admitRecoveryArtifact,
  bootstrapWorkspace,
  createDb,
  createSession,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  persistRecoveryArtifact,
  precomputeRecoveryArtifact,
  RecoveryAdmissionConflictError,
  RecoveryArtifactValidationError,
  sha256Canonical,
  type Database,
  type DbClient,
  type RecoveryArtifact,
  type RecoveryArtifactObservability,
  withWorkspaceRls,
} from "../src/index";
import * as schema from "../src/schema";

let shared: SharedTestDatabase;
let client: DbClient;

type Fixture = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  rootSessionId: string;
};

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function namedAppUrl(applicationName: string): string {
  const url = new URL(shared.appUrl);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

function namedAdminUrl(applicationName: string): string {
  const url = new URL(shared.adminUrl);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
}

async function withAppTransaction<T>(
  sql: postgres.Sql,
  context: Pick<Fixture, "accountId" | "workspaceId">,
  callback: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${context.accountId}, true)`;
    await tx`select set_config('opengeni.workspace_id', ${context.workspaceId}, true)`;
    return await callback(tx);
  })) as T;
}

async function fixture(initialMessage = "recovery fixture"): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "ope62-test",
    accountExternalId: `account-${suffix}`,
    accountName: "OPE-62 recovery artifact test",
    workspaceExternalSource: "ope62-test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "OPE-62 recovery artifact test",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const root = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage,
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    rootSessionId: root.id,
  };
}

async function precomputeAndPersist(
  value: Fixture,
  observability?: RecoveryArtifactObservability,
): Promise<RecoveryArtifact> {
  const artifact = await precomputeRecoveryArtifact(client.db, {
    ...value,
    ...(observability ? { observability } : {}),
    sessionPageSize: 2,
    eventPageSize: 2,
    partitionSize: 2,
  });
  await persistRecoveryArtifact(client.db, {
    accountId: value.accountId,
    artifact,
  });
  return artifact;
}

async function recoveryRevision(value: Fixture, sessionId = value.rootSessionId): Promise<number> {
  const [row] = await shared.admin<{ revision: string }[]>`
    select revision::text as revision
    from recovery_session_revisions
    where workspace_id = ${value.workspaceId} and session_id = ${sessionId}`;
  if (!row) throw new Error("missing recovery session revision");
  return Number(row.revision);
}

async function treeRevisionSignature(
  value: Fixture,
): Promise<Array<{ session_id: string; revision: string }>> {
  return await shared.admin<{ session_id: string; revision: string }[]>`
    select session_id::text as session_id, revision::text as revision
    from recovery_session_revisions
    where workspace_id = ${value.workspaceId} and root_session_id = ${value.rootSessionId}
    order by session_id`;
}

async function expectSessionTreeRetry(value: Fixture, artifact: RecoveryArtifact): Promise<void> {
  expect(
    await admitRecoveryArtifact(client.db, {
      accountId: value.accountId,
      artifact,
      idempotencyKey: crypto.randomUUID(),
    }),
  ).toEqual({ kind: "retry", reason: "session_tree_changed" });
}

async function waitForDatabaseLock(applicationName: string, waitEvent?: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await shared.admin<
      { wait_event_type: string | null; wait_event: string | null }[]
    >`
      select wait_event_type, wait_event
      from pg_stat_activity
      where datname = current_database() and application_name = ${applicationName}
      order by backend_start desc
      limit 1`;
    if (
      row?.wait_event_type === "Lock" &&
      (waitEvent === undefined || row.wait_event === waitEvent)
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${applicationName} did not reach database lock wait (last=${row?.wait_event_type}/${row?.wait_event})`,
      );
    }
    await Bun.sleep(10);
  }
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("recovery-artifacts");
  if (acquired) {
    shared = acquired;
  } else {
    const adminUrl = process.env.OPENGENI_TEST_DATABASE_ADMIN_URL;
    const appUrl = process.env.OPENGENI_TEST_DATABASE_URL;
    if (!adminUrl || !appUrl) {
      throw new Error(
        "PostgreSQL test database unavailable (set OPENGENI_TEST_DATABASE_ADMIN_URL and OPENGENI_TEST_DATABASE_URL when Docker is unavailable)",
      );
    }
    const admin = postgres(adminUrl, { max: 4 });
    shared = {
      admin,
      adminUrl,
      appUrl,
      release: async () => await admin.end(),
    };
  }
  client = createDb(shared.appUrl);
  await shared.admin.unsafe(`
    CREATE OR REPLACE FUNCTION public.ope62_admission_test_gate()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('application_name', true) = 'ope62-gated-admit' THEN
        PERFORM pg_advisory_xact_lock(620062);
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS ope62_admission_test_gate ON recovery_history_admissions;
    CREATE TRIGGER ope62_admission_test_gate
      BEFORE INSERT ON recovery_history_admissions
      FOR EACH ROW EXECUTE FUNCTION public.ope62_admission_test_gate();
  `);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

describe("recovery artifact exact admission", () => {
  test("precompute, immutable persistence, admission, and idempotent retry are exact", async () => {
    const value = await fixture();
    const artifact = await precomputeAndPersist(value);
    expect(await precomputeAndPersist(value)).toEqual(artifact);

    const idempotencyKey = crypto.randomUUID();
    const first = await admitRecoveryArtifact(client.db, {
      accountId: value.accountId,
      artifact,
      idempotencyKey,
    });
    expect(first).toMatchObject({ kind: "admitted", reused: false });
    if (first.kind !== "admitted") throw new Error("first admission unexpectedly retried");
    const second = await admitRecoveryArtifact(client.db, {
      accountId: value.accountId,
      artifact,
      idempotencyKey,
    });
    expect(second).toEqual({ ...first, reused: true });

    const app = postgres(shared.appUrl, { max: 1 });
    await expect(
      withAppTransaction(app, value, async (tx) => {
        await tx`update recovery_history_artifacts
                 set canonical_bytes = canonical_bytes + 1
                 where workspace_id = ${value.workspaceId}`;
      }),
    ).rejects.toMatchObject({ code: "55000" });
    await app.end();
  }, 60_000);

  test("same idempotency key with different canonical input is a typed conflict", async () => {
    const value = await fixture();
    const first = await precomputeAndPersist(value);
    const key = crypto.randomUUID();
    await admitRecoveryArtifact(client.db, {
      accountId: value.accountId,
      artifact: first,
      idempotencyKey: key,
    });
    await withWorkspaceRls(client.db, value.workspaceId, (db) =>
      db
        .update(schema.sessions)
        .set({ title: "changed canonical input", updatedAt: new Date() })
        .where(eq(schema.sessions.id, value.rootSessionId)),
    );
    const second = await precomputeAndPersist(value);
    await expect(
      admitRecoveryArtifact(client.db, {
        accountId: value.accountId,
        artifact: second,
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(RecoveryAdmissionConflictError);
  }, 60_000);

  test("internally inconsistent manifests are rejected even when their top hash is recomputed", async () => {
    const value = await fixture();
    const artifact = await precomputeRecoveryArtifact(client.db, {
      ...value,
      partitionSize: 1,
    });

    const badAggregate = structuredClone(artifact);
    badAggregate.manifest.eventCount += 1;
    badAggregate.artifactHash = sha256Canonical(badAggregate.manifest);
    await expect(
      persistRecoveryArtifact(client.db, {
        accountId: value.accountId,
        artifact: badAggregate,
      }),
    ).rejects.toBeInstanceOf(RecoveryArtifactValidationError);

    const badPartition = structuredClone(artifact);
    badPartition.manifest.partitions[0]!.partitionHash = "0".repeat(64);
    badPartition.artifactHash = sha256Canonical(badPartition.manifest);
    await expect(
      persistRecoveryArtifact(client.db, {
        accountId: value.accountId,
        artifact: badPartition,
      }),
    ).rejects.toBeInstanceOf(RecoveryArtifactValidationError);
  }, 60_000);

  test("telemetry is bounded, useful, and contains no IDs, hashes, titles, or payloads", async () => {
    const secret = `secret-${crypto.randomUUID()}`;
    const value = await fixture(secret);
    const telemetry: unknown[] = [];
    const observability: RecoveryArtifactObservability = {
      incrementCounter: (input) => telemetry.push({ type: "counter", ...input }),
      observeHistogram: (input) => telemetry.push({ type: "histogram", ...input }),
      startSpan: (name, attributes) => ({
        end: (input) => telemetry.push({ type: "span", name, attributes, end: input }),
      }),
    };
    const artifact = await precomputeAndPersist(value, observability);
    const admission = await admitRecoveryArtifact(client.db, {
      accountId: value.accountId,
      artifact,
      idempotencyKey: crypto.randomUUID(),
      observability,
    });
    expect(admission.kind).toBe("admitted");
    const encoded = JSON.stringify(telemetry);
    for (const forbidden of [
      secret,
      value.accountId,
      value.workspaceId,
      value.rootSessionId,
      artifact.artifactHash,
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
    expect(encoded).toContain("opengeni_recovery_artifact_precompute_duration_seconds");
    expect(encoded).toContain("opengeni_recovery_artifact_final_lock_hold_seconds");
    const hold = telemetry.find(
      (entry) =>
        (entry as { name?: string }).name === "opengeni_recovery_artifact_final_lock_hold_seconds",
    ) as { value: number } | undefined;
    expect(hold?.value).toBeLessThan(2);
  }, 60_000);
});

describe("recovery revision fence mutation coverage", () => {
  test("title, usage, generic event, child creation, stop, steer, goal, and wake reject stale artifacts", async () => {
    const cases: Array<{
      name: string;
      mutate(value: Fixture, raw: postgres.Sql): Promise<void>;
    }> = [
      {
        name: "title",
        mutate: async (value, raw) => {
          await withAppTransaction(raw, value, async (tx) => {
            await tx`update sessions set title = 'new title', updated_at = now()
                     where id = ${value.rootSessionId}`;
          });
        },
      },
      {
        name: "agent.model.usage",
        mutate: async (value, raw) => {
          await withAppTransaction(raw, value, async (tx) => {
            await tx`insert into session_events
              (account_id, workspace_id, session_id, sequence, type, payload)
              values (${value.accountId}, ${value.workspaceId}, ${value.rootSessionId}, 1,
                      'agent.model.usage', '{"inputTokens":7}'::jsonb)`;
          });
        },
      },
      {
        name: "generic event",
        mutate: async (value, raw) => {
          await withAppTransaction(raw, value, async (tx) => {
            await tx`insert into session_events
              (account_id, workspace_id, session_id, sequence, type, payload)
              values (${value.accountId}, ${value.workspaceId}, ${value.rootSessionId}, 1,
                      'agent.output.delta', '{"redacted":true}'::jsonb)`;
          });
        },
      },
      {
        name: "child creation",
        mutate: async (value) => {
          await createSession(client.db, {
            accountId: value.accountId,
            workspaceId: value.workspaceId,
            initialMessage: "child",
            resources: [],
            metadata: {},
            model: "scripted-model",
            sandboxBackend: "none",
            parentSessionId: value.rootSessionId,
          });
        },
      },
      {
        name: "stop",
        mutate: async (value, raw) => {
          await withAppTransaction(raw, value, async (tx) => {
            await tx`update sessions set status = 'cancelled', updated_at = now()
                     where id = ${value.rootSessionId}`;
          });
        },
      },
      {
        name: "steer",
        mutate: async (value, raw) => {
          await withAppTransaction(raw, value, async (tx) => {
            await tx`insert into session_system_updates
              (account_id, workspace_id, session_id, kind, classification,
               source_id, dedupe_key, summary, payload, lineage)
              values (${value.accountId}, ${value.workspaceId}, ${value.rootSessionId},
                      'agent_steer_instruction', 'info', 'ope62-test',
                      ${crypto.randomUUID()}, 'steer instruction',
                      '{"type":"agent_steer_instruction","instruction":"turn"}'::jsonb,
                      '{}'::jsonb)`;
          });
        },
      },
      {
        name: "goal",
        mutate: async (value, raw) => {
          await withAppTransaction(raw, value, async (tx) => {
            await tx`insert into session_goals
              (account_id, workspace_id, session_id, status, text, created_by)
              values (${value.accountId}, ${value.workspaceId}, ${value.rootSessionId},
                      'active', 'bounded test goal', 'api')`;
          });
        },
      },
      {
        name: "goal wake",
        mutate: async (value, raw) => {
          await withAppTransaction(raw, value, async (tx) => {
            await tx`insert into session_workflow_wake_outbox
              (account_id, workspace_id, session_id, temporal_workflow_id,
               wake_revision, delivered_revision, reason)
              values (${value.accountId}, ${value.workspaceId}, ${value.rootSessionId},
                      'ope62-workflow', 1, 0, 'goal_continuation')`;
          });
        },
      },
    ];

    const raw = postgres(shared.appUrl, { max: 2 });
    try {
      for (const mutation of cases) {
        const value = await fixture();
        const artifact = await precomputeAndPersist(value);
        const before = await treeRevisionSignature(value);
        await mutation.mutate(value, raw);
        expect(await treeRevisionSignature(value), mutation.name).not.toEqual(before);
        await expectSessionTreeRetry(value, artifact);
      }
    } finally {
      await raw.end();
    }
  }, 120_000);

  test("pause and resume use their real control transaction and both reject stale artifacts", async () => {
    const value = await fixture();
    const mutate = async (action: "pause" | "resume") =>
      await withWorkspaceRls(client.db, value.workspaceId, (db) =>
        db.transaction((tx) =>
          mutateSessionControlInTransaction(tx as unknown as Database, {
            accountId: value.accountId,
            workspaceId: value.workspaceId,
            sessionId: value.rootSessionId,
            actor: { type: "human", subjectId: value.subjectId },
            operationKey: crypto.randomUUID(),
            action,
            reason: "OPE-62 deterministic race",
          }),
        ),
      );

    const beforePause = await precomputeAndPersist(value);
    await mutate("pause");
    expect(
      await admitRecoveryArtifact(client.db, {
        accountId: value.accountId,
        artifact: beforePause,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).toEqual({ kind: "retry", reason: "workspace_control_changed" });
    const beforeResume = await precomputeAndPersist(value);
    await mutate("resume");
    expect(
      await admitRecoveryArtifact(client.db, {
        accountId: value.accountId,
        artifact: beforeResume,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).toEqual({ kind: "retry", reason: "workspace_control_changed" });
  }, 60_000);

  test("workspace control changes are rejected by the dedicated control revision fence", async () => {
    const value = await fixture();
    const artifact = await precomputeAndPersist(value);
    await withWorkspaceRls(client.db, value.workspaceId, (db) =>
      db.transaction((tx) =>
        mutateWorkspaceControlInTransaction(tx as unknown as Database, {
          accountId: value.accountId,
          workspaceId: value.workspaceId,
          actor: { type: "human", subjectId: value.subjectId },
          operationKey: crypto.randomUUID(),
          action: "pause",
          reason: "OPE-62 workspace fence",
        }),
      ),
    );
    expect(
      await admitRecoveryArtifact(client.db, {
        accountId: value.accountId,
        artifact,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).toEqual({ kind: "retry", reason: "workspace_control_changed" });
  }, 60_000);

  test("rolled-back mutations do not poison a valid artifact", async () => {
    const value = await fixture();
    const artifact = await precomputeAndPersist(value);
    const before = await recoveryRevision(value);
    const raw = postgres(shared.appUrl, { max: 1 });
    await expect(
      withAppTransaction(raw, value, async (tx) => {
        await tx`update sessions set title = 'must roll back' where id = ${value.rootSessionId}`;
        throw new Error("fixture rollback");
      }),
    ).rejects.toThrow("fixture rollback");
    await raw.end();
    expect(await recoveryRevision(value)).toBe(before);
    expect(
      await admitRecoveryArtifact(client.db, {
        accountId: value.accountId,
        artifact,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).toMatchObject({ kind: "admitted", reused: false });
  }, 60_000);
});

describe("recovery artifact RLS and mutation guards", () => {
  test("FORCE RLS isolates artifacts and rejects internal fence tampering", async () => {
    const first = await fixture();
    const second = await fixture();
    await precomputeAndPersist(first);
    await precomputeAndPersist(second);
    const raw = postgres(shared.appUrl, { max: 1 });
    try {
      const visible = await withAppTransaction(
        raw,
        first,
        async (tx) =>
          tx<{ workspace_id: string }[]>`
          select workspace_id::text as workspace_id from recovery_history_artifacts`,
      );
      expect(visible.map((row) => row.workspace_id)).toEqual([first.workspaceId]);

      await expect(
        withAppTransaction(raw, first, async (tx) => {
          await tx`update recovery_session_revisions set revision = revision + 100
                   where session_id = ${first.rootSessionId}`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        withAppTransaction(raw, first, async (tx) => {
          await tx`delete from recovery_workspace_barriers
                   where workspace_id = ${first.workspaceId}`;
        }),
      ).rejects.toMatchObject({ code: "42501" });

      const artifact = await precomputeAndPersist(first);
      await expect(
        withAppTransaction(raw, first, async (tx) => {
          await tx`insert into recovery_history_admissions (
                     workspace_id, account_id, root_session_id, artifact_hash,
                     workspace_control_revision, idempotency_key
                   ) values (
                     ${first.workspaceId}, ${first.accountId}, ${first.rootSessionId},
                     ${artifact.artifactHash}, ${artifact.manifest.workspaceControlRevision},
                     ${crypto.randomUUID()}
                   )`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await raw.end();
    }

    const forceRows = await shared.admin<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class
      where relname in (
        'recovery_workspace_barriers', 'recovery_session_revisions',
        'recovery_history_artifacts', 'recovery_history_admissions'
      )
      order by relname`;
    expect(forceRows).toHaveLength(4);
    expect(forceRows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  }, 60_000);

  test("session parent mutation is rejected while legitimate session/workspace cascades succeed", async () => {
    const value = await fixture();
    const child = await createSession(client.db, {
      accountId: value.accountId,
      workspaceId: value.workspaceId,
      initialMessage: "child",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
      parentSessionId: value.rootSessionId,
    });
    const raw = postgres(shared.appUrl, { max: 1 });
    try {
      await expect(
        withAppTransaction(raw, value, async (tx) => {
          await tx`update sessions set parent_session_id = null where id = ${child.id}`;
        }),
      ).rejects.toMatchObject({ code: "23514" });
      await withAppTransaction(raw, value, async (tx) => {
        await tx`delete from sessions where id = ${child.id}`;
      });
    } finally {
      await raw.end();
    }
    expect(
      await shared.admin`select 1 from recovery_session_revisions where session_id = ${child.id}`,
    ).toHaveLength(0);

    const artifact = await precomputeAndPersist(value);
    await admitRecoveryArtifact(client.db, {
      accountId: value.accountId,
      artifact,
      idempotencyKey: crypto.randomUUID(),
    });
    await shared.admin`delete from workspaces where id = ${value.workspaceId}`;
    for (const table of [
      "recovery_workspace_barriers",
      "recovery_session_revisions",
      "recovery_history_artifacts",
      "recovery_history_admissions",
    ]) {
      const rows = await shared.admin.unsafe(`select 1 from ${table} where workspace_id = $1`, [
        value.workspaceId,
      ]);
      expect(rows, table).toHaveLength(0);
    }
  }, 60_000);
});

describe("recovery admission deterministic barrier races", () => {
  test("a committed writer holding the compatible barrier makes admission wait and reject stale input", async () => {
    const value = await fixture();
    const artifact = await precomputeAndPersist(value);
    const writer = postgres(namedAppUrl("ope62-held-writer"), { max: 1 });
    const admitClient = createDb(namedAppUrl("ope62-waiting-admit"));
    const writerReady = deferred();
    const releaseWriter = deferred();
    const writerRun = withAppTransaction(writer, value, async (tx) => {
      await tx`update sessions set title = 'committed writer' where id = ${value.rootSessionId}`;
      writerReady.resolve();
      await releaseWriter.promise;
    }).catch((error) => {
      writerReady.reject(error);
      throw error;
    });
    await writerReady.promise;

    const admission = admitRecoveryArtifact(admitClient.db, {
      accountId: value.accountId,
      artifact,
      idempotencyKey: crypto.randomUUID(),
    });
    await waitForDatabaseLock("ope62-waiting-admit");
    releaseWriter.resolve();
    await writerRun;
    expect(await admission).toEqual({ kind: "retry", reason: "session_tree_changed" });
    await admitClient.close();
    await writer.end();
  }, 60_000);

  test("a writer arriving after the final lock linearizes after one admission and invalidates reuse", async () => {
    const value = await fixture();
    const artifact = await precomputeAndPersist(value);
    const advisory = await shared.admin.reserve();
    await advisory`select pg_advisory_lock(620062)`;
    const admitClient = createDb(namedAppUrl("ope62-gated-admit"));
    const writer = postgres(namedAppUrl("ope62-late-writer"), { max: 1 });
    try {
      const admission = admitRecoveryArtifact(admitClient.db, {
        accountId: value.accountId,
        artifact,
        idempotencyKey: crypto.randomUUID(),
      });
      await waitForDatabaseLock("ope62-gated-admit", "advisory");

      let writerSettled = false;
      const writerRun = withAppTransaction(writer, value, async (tx) => {
        await tx`update sessions set title = 'late writer' where id = ${value.rootSessionId}`;
      }).finally(() => {
        writerSettled = true;
      });
      await waitForDatabaseLock("ope62-late-writer");
      expect(writerSettled).toBe(false);

      await advisory`select pg_advisory_unlock(620062)`;
      expect(await admission).toMatchObject({ kind: "admitted", reused: false });
      await writerRun;
      await expectSessionTreeRetry(value, artifact);
    } finally {
      await advisory`select pg_advisory_unlock_all()`;
      advisory.release();
      await admitClient.close();
      await writer.end();
    }
  }, 60_000);

  test("workspace deletion after the final lock cannot invert admission locks", async () => {
    const value = await fixture();
    const artifact = await precomputeAndPersist(value);
    const advisory = await shared.admin.reserve();
    await advisory`select pg_advisory_lock(620062)`;
    const admitClient = createDb(namedAppUrl("ope62-gated-admit"));
    const deletion = postgres(namedAdminUrl("ope62-delete-after-final-lock"), { max: 1 });
    try {
      const admission = admitRecoveryArtifact(admitClient.db, {
        accountId: value.accountId,
        artifact,
        idempotencyKey: crypto.randomUUID(),
      });
      await waitForDatabaseLock("ope62-gated-admit", "advisory");

      const deleteRun = Promise.resolve(
        deletion`delete from workspaces where id = ${value.workspaceId}`,
      );
      await waitForDatabaseLock("ope62-delete-after-final-lock");

      await advisory`select pg_advisory_unlock(620062)`;
      expect(await admission).toMatchObject({ kind: "admitted", reused: false });
      await deleteRun;
      expect(
        await shared.admin`select 1 from recovery_history_admissions
                           where workspace_id = ${value.workspaceId}`,
      ).toHaveLength(0);
    } finally {
      await advisory`select pg_advisory_unlock_all()`;
      advisory.release();
      await admitClient.close();
      await deletion.end();
    }
  }, 60_000);

  test("compatible writers do not serialize unrelated sessions or workspaces", async () => {
    const first = await fixture();
    const sibling = await createSession(client.db, {
      accountId: first.accountId,
      workspaceId: first.workspaceId,
      initialMessage: "sibling root",
      resources: [],
      metadata: {},
      model: "scripted-model",
      sandboxBackend: "none",
    });
    const second = await fixture();
    const holder = postgres(shared.appUrl, { max: 1 });
    const peer = postgres(shared.appUrl, { max: 2 });
    const held = deferred();
    const release = deferred();
    const heldRun = withAppTransaction(holder, first, async (tx) => {
      await tx`update sessions set title = 'held' where id = ${first.rootSessionId}`;
      held.resolve();
      await release.promise;
    }).catch((error) => {
      held.reject(error);
      throw error;
    });
    await held.promise;
    const started = performance.now();
    await Promise.all([
      withAppTransaction(peer, first, async (tx) => {
        await tx`update sessions set title = 'same workspace peer' where id = ${sibling.id}`;
      }),
      withAppTransaction(peer, second, async (tx) => {
        await tx`update sessions set title = 'other workspace peer'
                 where id = ${second.rootSessionId}`;
      }),
    ]);
    expect((performance.now() - started) / 1_000).toBeLessThan(2);
    release.resolve();
    await heldRun;
    await holder.end();
    await peer.end();
  }, 60_000);
});
