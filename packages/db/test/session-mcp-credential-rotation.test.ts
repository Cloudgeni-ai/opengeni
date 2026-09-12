import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as database from "../src/index";
import type { Database, DbClient } from "../src/index";
import {
  rotateSessionMcpCredentialsAtomically,
  type AtomicSessionMcpCredentialRotationInput as RotationInput,
} from "../src/session-mcp-credential-rotation";

const externalAdminUrl = process.env.OPENGENI_TEST_THROWAWAY_DATABASE_ADMIN_URL?.trim();
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let first: DbClient;
let second: DbClient;
let available = true;
const encryptionKey = new Uint8Array(32).fill(7);
const serverUrl = "https://tools.example.test/mcp";

async function rotate(db: Database, input: RotationInput): Promise<unknown> {
  return rotateSessionMcpCredentialsAtomically(db, input);
}

beforeAll(async () => {
  let appUrl: string;
  if (externalAdminUrl) {
    await database.migrate(externalAdminUrl);
    await database.provisionRoles(externalAdminUrl, {
      targetSchema: "public",
      rlsStrategy: "force",
      appRole: "opengeni_app",
      appPassword: "rotation_test_app",
    });
    admin = postgres(externalAdminUrl, { max: 4 });
    const url = new URL(externalAdminUrl);
    url.username = "opengeni_app";
    url.password = "rotation_test_app";
    appUrl = url.toString();
  } else {
    shared = await acquireSharedTestDatabase("session-mcp-credential-rotation");
    if (!shared) {
      if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
      available = false;
      return;
    }
    admin = shared.admin;
    appUrl = shared.appUrl;
  }
  first = database.createDb(appUrl);
  second = database.createDb(appUrl);
}, 180_000);

afterAll(async () => {
  await Promise.all([first?.close(), second?.close()]);
  if (shared) await shared.release();
  else await admin?.end();
}, 180_000);

async function fixture(): Promise<RotationInput> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('credential rotation test') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'rotation') returning id`;
  await admin`insert into workspace_inference_controls (account_id, workspace_id)
    values (${account!.id}, ${workspace!.id})`;
  const session = await database.createSession(first.db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    initialMessage: "",
    resources: [],
    tools: [{ kind: "mcp", id: "external" }],
    metadata: {},
    model: "test-model",
    reasoningEffort: "low",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await database.createSessionMcpServers(first.db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    sessionId: session.id,
    servers: [
      {
        id: "external",
        url: serverUrl,
        headersEncrypted: {
          authorization: database.encryptVariableSetValue(encryptionKey, "Bearer original"),
        },
      },
    ],
  });
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    sessionId: session.id,
    subjectId: "test-rotation-host",
    actorType: "human" as const,
    operationKey: crypto.randomUUID(),
    requestDigest: "a".repeat(64),
    digestKeyTag: "b".repeat(64),
    updates: [
      {
        id: "external",
        expectedCredentialVersion: 1,
        expectedServerUrl: serverUrl,
        headersEncrypted: {
          authorization: database.encryptVariableSetValue(encryptionKey, "Bearer replacement"),
        },
      },
    ],
    authorize: async () => {},
  };
}

async function state(input: RotationInput) {
  const [row] = await admin`
    select credential_version, headers_encrypted from session_mcp_servers
    where workspace_id = ${input.workspaceId} and session_id = ${input.sessionId}`;
  return row!;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForBlockedBackend(pid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await admin`select pid from pg_stat_activity
      where datname = current_database() and usename = 'opengeni_app'
      and state = 'active' and wait_event_type = 'Lock'
      and ${pid} = any(pg_blocking_pids(pid)) limit 1`;
    if (row) return;
    await Bun.sleep(10);
  }
  throw new Error("expected a real PostgreSQL lock wait");
}

describe("atomic standalone credential rotation (real PostgreSQL)", () => {
  test("exact replay retains the original receipt and performs no second write", async () => {
    if (!available) return;
    const input = await fixture();
    const receipt = await rotate(first.db, input);
    expect(await rotate(second.db, input)).toEqual(receipt);
    expect((await state(input)).credential_version).toBe(2);
    const facts = await admin`select * from session_command_receipts
      where target_session_id = ${input.sessionId}`;
    expect(facts).toHaveLength(1);
    expect(JSON.stringify(facts)).not.toContain("Bearer replacement");
    const turns = await admin`select id from session_turns where session_id = ${input.sessionId}`;
    expect(turns).toHaveLength(0);
  });

  test("revalidates authority before an exact replay", async () => {
    if (!available) return;
    const input = await fixture();
    await rotate(first.db, input);
    await expect(
      rotate(second.db, {
        ...input,
        authorize: async () => {
          throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect((await state(input)).credential_version).toBe(2);
  });

  test("concurrent exact replay has one durable write and identical receipts", async () => {
    if (!available) return;
    const input = await fixture();
    const [one, two] = await Promise.all([rotate(first.db, input), rotate(second.db, input)]);
    expect(one).toEqual(two);
    expect((await state(input)).credential_version).toBe(2);
    expect(
      await admin`select id from session_command_receipts where target_session_id = ${input.sessionId}`,
    ).toHaveLength(1);
  });

  test("historical failure alone permits rotation but a closed unquiesced interruption does not", async () => {
    if (!available) return;
    const input = await fixture();
    const start = await database.initializeSessionStartAtomically(first.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claim = await database.claimSessionWorkForAttempt(first.db, input.workspaceId, {
      sessionId: input.sessionId,
      workflowId: start.temporalWorkflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error("claim required");
    await database.applySessionTurnSettlement(first.db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId: claim.turn.id,
      triggerEventId: claim.turn.triggerEventId,
      attemptId,
      turnStatus: "failed",
      sessionStatus: "failed",
      activeTurnId: null,
      events: [],
    });
    // Settled turns retain provider snapshots and recorded tool results. These
    // receipts do not themselves own a live credential-consuming attempt.
    await admin`insert into agent_run_states
      (account_id, workspace_id, session_id, turn_id, state_version, serialized_run_state)
      values (${input.accountId}, ${input.workspaceId}, ${input.sessionId}, ${claim.turn.id}, 1, '{}')`;
    await admin`insert into session_pending_tool_calls
      (account_id, workspace_id, session_id, turn_id, execution_generation, attempt_id,
       call_id, call_type, call_item_ordered, result_recorded_at)
      values (${input.accountId}, ${input.workspaceId}, ${input.sessionId}, ${claim.turn.id},
        1, ${attemptId}, 'historical-call', 'function_call', '{}', now())`;
    await rotate(second.db, input);
    const [receipt] = await admin<
      { id: string }[]
    >`select id from session_command_receipts where target_session_id = ${input.sessionId}`;
    await admin`insert into session_attempt_interruptions
      (account_id, workspace_id, session_id, operation_id, attempt_id, kind, control_revision, state)
      values (${input.accountId}, ${input.workspaceId}, ${input.sessionId}, ${receipt!.id},
        ${attemptId}, 'steer', 1, 'settled')`;
    await admin`update session_turn_attempts set quiesced_at = null where id = ${attemptId}`;
    const fresh = {
      ...input,
      operationKey: crypto.randomUUID(),
      updates: [
        {
          ...input.updates[0]!,
          expectedCredentialVersion: 2,
        },
      ],
    };
    await expect(rotate(second.db, fresh)).rejects.toThrow("not_quiescent");
    await admin`update session_turn_attempts set quiesced_at = now() where id = ${attemptId}`;
    await rotate(second.db, fresh);
    expect((await state(input)).credential_version).toBe(3);
  });

  test("concurrent fresh operations with the same expected version have one winner", async () => {
    if (!available) return;
    const input = await fixture();
    const results = await Promise.allSettled([
      rotate(first.db, input),
      rotate(second.db, { ...input, operationKey: crypto.randomUUID() }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await state(input)).credential_version).toBe(2);
  });

  test("stale version, changed destination, and unknown IDs do not partially update", async () => {
    if (!available) return;
    for (const invalid of [
      { expectedCredentialVersion: 2 },
      { expectedServerUrl: "https://other.example.test/mcp" },
      { id: "unknown" },
    ]) {
      const input = await fixture();
      await expect(
        rotate(first.db, { ...input, updates: [{ ...input.updates[0]!, ...invalid }] }),
      ).rejects.toThrow();
      expect((await state(input)).credential_version).toBe(1);
    }
  });

  test("unknown server in a batch rolls back every server and the receipt", async () => {
    if (!available) return;
    const input = await fixture();
    await expect(
      rotate(first.db, {
        ...input,
        updates: [
          input.updates[0]!,
          {
            ...input.updates[0]!,
            id: "unknown",
          },
        ],
      }),
    ).rejects.toThrow("not_found");
    expect((await state(input)).credential_version).toBe(1);
    expect(
      await admin`select id from session_command_receipts where target_session_id = ${input.sessionId}`,
    ).toHaveLength(0);
  });

  test("brokered rows and changed payload reuse are rejected without replacing credentials", async () => {
    if (!available) return;
    const input = await fixture();
    await rotate(first.db, input);
    await expect(rotate(second.db, { ...input, requestDigest: "d".repeat(64) })).rejects.toThrow(
      "operation_reuse",
    );
    await admin`update session_mcp_servers set connection_ref = '{"providerDomain":"example.test","kind":"oauth2"}'::jsonb
      where session_id = ${input.sessionId}`;
    await expect(
      rotate(first.db, {
        ...input,
        operationKey: crypto.randomUUID(),
        updates: [{ ...input.updates[0]!, expectedCredentialVersion: 2 }],
      }),
    ).rejects.toThrow("brokered_server");
    expect((await state(input)).credential_version).toBe(2);
  });

  test("a wrong tenant or session cannot use another session's receipt", async () => {
    if (!available) return;
    const input = await fixture();
    const other = await fixture();
    await rotate(first.db, input);
    await expect(rotate(second.db, { ...input, workspaceId: other.workspaceId })).rejects.toThrow(
      "not_found",
    );
    await expect(rotate(second.db, { ...input, sessionId: other.sessionId })).rejects.toThrow(
      "not_found",
    );
    expect((await state(input)).credential_version).toBe(2);
    expect((await state(other)).credential_version).toBe(1);
  });

  test("rotation serializes concurrent prompt admission before any new claim", async () => {
    if (!available) return;
    const input = await fixture();
    const entered = deferred<number>();
    const release = deferred();
    const rotation = rotate(first.db, {
      ...input,
      authorize: async (tx) => {
        const rows = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        entered.resolve(rows[0]!.pid);
        await release.promise;
      },
    });
    const pid = await entered.promise;
    const admission = database.initializeSessionStartAtomically(second.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    try {
      await waitForBlockedBackend(pid);
    } finally {
      release.resolve();
    }
    await rotation;
    const start = await admission;
    expect(start.turn).toBeTruthy();
    const attemptId = crypto.randomUUID();
    const claim = await database.claimSessionWorkForAttempt(second.db, input.workspaceId, {
      sessionId: input.sessionId,
      workflowId: start.temporalWorkflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claim.action).toBe("claimed");
    const servers = await database.listSessionMcpServersForRun(
      second.db,
      input.workspaceId,
      input.sessionId,
      attemptId,
      encryptionKey,
    );
    expect(servers[0]!.credentialVersion).toBe(2);
    expect(servers[0]!.headers.authorization).toBe("Bearer replacement");
  });

  test("a concurrent claim wins serialization and rotation cannot alter its prepared credentials", async () => {
    if (!available) return;
    const input = await fixture();
    const start = await database.initializeSessionStartAtomically(first.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const entered = deferred<number>();
    const release = deferred();
    const attemptId = crypto.randomUUID();
    const claim = database.withSessionActivityRlsContext(
      first.db,
      input,
      async (tx) => {
        const result = await database.claimSessionWorkForAttempt(tx, input.workspaceId, {
          sessionId: input.sessionId,
          workflowId: start.temporalWorkflowId,
          workflowRunId: crypto.randomUUID(),
          attemptId,
          dispatchId: crypto.randomUUID(),
          trigger: { kind: "next" },
        });
        const rows = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        entered.resolve(rows[0]!.pid);
        await release.promise;
        return result;
      },
      undefined,
      "shared",
      true,
    );
    const pid = await entered.promise;
    const rotation = rotate(second.db, input).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await waitForBlockedBackend(pid);
    } finally {
      release.resolve();
    }
    expect((await claim).action).toBe("claimed");
    expect(await rotation).toMatchObject({ message: "not_quiescent" });
    const servers = await database.listSessionMcpServersForRun(
      first.db,
      input.workspaceId,
      input.sessionId,
      attemptId,
      encryptionKey,
    );
    expect(servers[0]!.credentialVersion).toBe(1);
    expect(servers[0]!.headers.authorization).toBe("Bearer original");
  });

  test("key replacement is unavailable, not payload conflict or second write", async () => {
    if (!available) return;
    const input = await fixture();
    await rotate(first.db, input);
    await expect(rotate(second.db, { ...input, digestKeyTag: "c".repeat(64) })).rejects.toThrow(
      "receipt_key_unavailable",
    );
    expect((await state(input)).credential_version).toBe(2);
  });

  test("queued and claimed work block fresh rotation, while a receipt still replays", async () => {
    if (!available) return;
    const input = await fixture();
    const receipt = await rotate(first.db, input);
    const start = await database.initializeSessionStartAtomically(first.db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    expect(await rotate(second.db, input)).toEqual(receipt);
    const fresh = {
      ...input,
      operationKey: crypto.randomUUID(),
      updates: [{ ...input.updates[0]!, expectedCredentialVersion: 2 }],
    };
    await expect(rotate(second.db, fresh)).rejects.toThrow("not_quiescent");
    const claim = await database.claimSessionWorkForAttempt(first.db, input.workspaceId, {
      sessionId: input.sessionId,
      workflowId: start.temporalWorkflowId,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    expect(claim.action).toBe("claimed");
    await expect(rotate(second.db, fresh)).rejects.toThrow("not_quiescent");
    expect((await state(input)).credential_version).toBe(2);
  });
});
