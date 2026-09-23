import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  mutateSessionControlInTransaction,
  registerPendingSessionToolCall,
  recordPendingSessionToolCallResult,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls,
  type PendingSessionToolCallInput,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  // Optional pre-migrated, disposable native fixture for Docker-less sandboxes.
  // CI uses the canonical shared pgvector fixture. Never accept a remote DB.
  const nativeAdmin = process.env.OPENGENI_PENDING_RECEIPT_TEST_ADMIN_URL;
  const nativeApp = process.env.OPENGENI_PENDING_RECEIPT_TEST_APP_URL;
  if (nativeAdmin || nativeApp) {
    if (!nativeAdmin || !nativeApp) throw new Error("Both native fixture URLs are required");
    const adminUrl = new URL(nativeAdmin);
    const appUrl = new URL(nativeApp);
    if (
      adminUrl.hostname !== "127.0.0.1" ||
      appUrl.hostname !== adminUrl.hostname ||
      appUrl.port !== adminUrl.port ||
      appUrl.pathname !== adminUrl.pathname ||
      !/^\/pending_receipt_test_[a-z0-9_]+$/.test(adminUrl.pathname) ||
      appUrl.username !== "opengeni_app"
    )
      throw new Error("Native fixture must be a dedicated loopback pending_receipt_test database");
    const admin = postgres(nativeAdmin, { max: 4 });
    shared = { admin, adminUrl: nativeAdmin, appUrl: nativeApp, release: () => admin.end() };
  } else {
    const acquired = await acquireSharedTestDatabase("pending-tool-registration");
    if (!acquired) throw new Error("Real PostgreSQL is required for receipt retry tests");
    shared = acquired;
  }
  client = createDb(shared.appUrl);
  await shared.admin.unsafe(`
    CREATE SEQUENCE pending_receipt_registration_attempt;
    CREATE SEQUENCE pending_receipt_registration_first_xid;
    CREATE SEQUENCE pending_receipt_registration_last_xid;
    CREATE TABLE pending_receipt_registration_fault (call_id text PRIMARY KEY, failures int NOT NULL, code text NOT NULL, delay_seconds double precision NOT NULL DEFAULT 0);
    CREATE FUNCTION pending_receipt_registration_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE fault pending_receipt_registration_fault%ROWTYPE; attempt bigint;
    BEGIN
      SELECT * INTO fault FROM pending_receipt_registration_fault WHERE call_id = NEW.call_id;
      IF FOUND THEN
        attempt := nextval('pending_receipt_registration_attempt');
        IF attempt = 1 THEN
          PERFORM setval('pending_receipt_registration_first_xid', txid_current());
        END IF;
        PERFORM setval('pending_receipt_registration_last_xid', txid_current());
        IF attempt <= fault.failures THEN
          PERFORM pg_sleep(fault.delay_seconds);
          RAISE EXCEPTION USING ERRCODE = fault.code, MESSAGE = 'sensitive synthetic fixture detail';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER pending_receipt_registration_fault BEFORE INSERT ON session_pending_tool_calls
      FOR EACH ROW EXECUTE FUNCTION pending_receipt_registration_fault();
  `);
}, 180_000);

afterAll(async () => {
  await client?.close();
  if (shared) {
    await shared.admin.unsafe(`
      DROP TRIGGER IF EXISTS pending_receipt_registration_fault ON session_pending_tool_calls;
      DROP FUNCTION IF EXISTS pending_receipt_registration_fault();
      DROP TABLE IF EXISTS pending_receipt_registration_fault;
      DROP SEQUENCE IF EXISTS pending_receipt_registration_attempt;
      DROP SEQUENCE IF EXISTS pending_receipt_registration_first_xid;
      DROP SEQUENCE IF EXISTS pending_receipt_registration_last_xid;
    `);
    await shared.release();
  }
}, 60_000);

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "receipt",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "receipt",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium",
    latencyMode: "standard",
    sandboxBackend: "none",
  });
  await withWorkspaceSubjectSessionActivityRls(client.db, workspaceId, grant.subjectId, (db) =>
    submitHumanPromptInTransaction(db, {
      accountId: grant.accountId,
      workspaceId,
      sessionId: session.id,
      subjectId: grant.subjectId,
      actor: { type: "human", subjectId: grant.subjectId },
      operationKey: crypto.randomUUID(),
      delivery: "send",
      text: "One effect only",
      resources: [],
      reasoningEffortFallback: "medium",
      source: "user",
    }),
  );
  const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error("Fixture turn not claimed");
  const callId = crypto.randomUUID();
  const input: PendingSessionToolCallInput = {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    turnId: claim.turn.id,
    executionGeneration: claim.turn.executionGeneration,
    attemptId: claim.turn.activeAttemptId!,
    callId,
    callType: "function_call",
    callItem: { type: "function_call", callId, name: "effect", arguments: '{"value":"a\\u0000b"}' },
  };
  return { input, grant, triggerEventId: claim.turn.triggerEventId };
}

async function inject(
  input: PendingSessionToolCallInput,
  failures: number,
  code: string,
  delay = 0,
) {
  await shared.admin`ALTER SEQUENCE pending_receipt_registration_attempt RESTART WITH 1`;
  await shared.admin`INSERT INTO pending_receipt_registration_fault (call_id, failures, code, delay_seconds)
    VALUES (${input.callId}, ${failures}, ${code}, ${delay})`;
}

async function attemptCount() {
  const [row] =
    await shared.admin`SELECT last_value, is_called FROM pending_receipt_registration_attempt`;
  return row!.is_called ? Number(row!.last_value) : 0;
}

async function receipts(input: PendingSessionToolCallInput) {
  return await shared.admin`SELECT * FROM session_pending_tool_calls WHERE turn_id = ${input.turnId}`;
}

describe("pending tool registration rollback retries", () => {
  test("fixture enforces the non-owner FORCE-RLS application role", async () => {
    const rows = await client.db.execute(sql`
      SELECT current_user, r.rolsuper, r.rolbypassrls, c.relforcerowsecurity,
        pg_get_userbyid(c.relowner) AS owner
      FROM pg_roles r, pg_class c
      WHERE r.rolname = current_user AND c.oid = 'session_pending_tool_calls'::regclass
    `);
    expect(rows[0]).toMatchObject({
      current_user: "opengeni_app",
      rolsuper: false,
      rolbypassrls: false,
      relforcerowsecurity: true,
    });
    expect(rows[0]!.owner).not.toBe("opengeni_app");
  });

  for (const code of ["40P01", "40001"]) {
    test(`${code} retries a rolled-back transaction and admits one effect`, async () => {
      const { input } = await fixture();
      await inject(input, 1, code);
      let effects = 0;
      const result = await registerPendingSessionToolCall(client.db, input);
      if (result.accepted && result.registered) effects += 1;
      expect(result).toEqual({ accepted: true, registered: true });
      expect(await attemptCount()).toBe(2);
      const [transactions] = await shared.admin`SELECT
        (SELECT last_value FROM pending_receipt_registration_first_xid) AS first,
        (SELECT last_value FROM pending_receipt_registration_last_xid) AS last`;
      expect(Number(transactions!.last)).toBeGreaterThan(Number(transactions!.first));
      expect(await receipts(input)).toHaveLength(1);
      expect(effects).toBe(1);
    });

    test(`${code} exhausts three attempts without an effect or leaked SQL`, async () => {
      const { input } = await fixture();
      await inject(input, 10, code);
      let effects = 0;
      const error = await registerPendingSessionToolCall(client.db, input).then(
        (result) => {
          if (result.accepted && result.registered) effects += 1;
          return null;
        },
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        details: { sqlState: code, attempts: 3, retryOutcome: "exhausted" },
      });
      expect(String(error)).not.toContain("sensitive synthetic");
      expect(String(error)).not.toContain("insert into");
      expect(JSON.stringify((error as { details: unknown }).details)).not.toContain(
        "sensitive synthetic",
      );
      expect(await attemptCount()).toBe(3);
      expect(await receipts(input)).toHaveLength(0);
      expect(effects).toBe(0);
    });
  }

  test("42501 is never retried", async () => {
    const { input } = await fixture();
    await inject(input, 10, "42501");
    await expect(registerPendingSessionToolCall(client.db, input)).rejects.toMatchObject({
      details: { sqlState: "42501", attempts: 1, retryOutcome: "not_retryable" },
    });
    expect(await attemptCount()).toBe(1);
    expect(await receipts(input)).toHaveLength(0);
  });

  test("transport failures at transaction admission are not retried", async () => {
    const { input } = await fixture();
    for (const code of ["CONNECTION_CLOSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"]) {
      let attempts = 0;
      const unavailable = new Proxy(client.db, {
        get(target, key, receiver) {
          if (key === "transaction")
            return async () => {
              attempts += 1;
              throw Object.assign(new Error("transport failure"), { code });
            };
          return Reflect.get(target, key, receiver);
        },
      });
      await expect(registerPendingSessionToolCall(unavailable, input)).rejects.toMatchObject({
        details: { attempts: 1, retryOutcome: "not_retryable", sqlState: null },
      });
      expect(attempts).toBe(1);
    }
    expect(await receipts(input)).toHaveLength(0);
  });

  test("compatible reordered content acknowledges a duplicate without replacing origin", async () => {
    const { input } = await fixture();
    // Exercise actual lossless JSON decoding, not just SQL-safe strings.
    input.callItem = { ...input.callItem, special: "nul\0and\ud800", nested: { b: 2, a: 1 } };
    await registerPendingSessionToolCall(client.db, input);
    const before = await receipts(input);
    expect(
      await registerPendingSessionToolCall(client.db, {
        ...input,
        callItem: { ...input.callItem, nested: { a: 1, b: 2 } },
      }),
    ).toEqual({ accepted: true, registered: false });
    expect(await receipts(input)).toEqual(before);
  });

  test("exact composed/decomposed keys survive reordered duplicates and JSONB round trips", async () => {
    const { input } = await fixture();
    input.callItem = { ...input.callItem, metadata: { "\u00e9": 1, "e\u0301": 2 } };
    await registerPendingSessionToolCall(client.db, input);
    const before = await receipts(input);
    const [roundTrip] = await shared.admin`SELECT call_item_ordered::jsonb AS item
      FROM session_pending_tool_calls WHERE turn_id = ${input.turnId}`;
    for (const item of [
      { ...input.callItem, metadata: { "e\u0301": 2, "\u00e9": 1 } },
      roundTrip!.item as Record<string, unknown>,
    ]) {
      expect(await registerPendingSessionToolCall(client.db, { ...input, callItem: item })).toEqual(
        { accepted: true, registered: false },
      );
    }
    for (const metadata of [{ "\u00e9": 2, "e\u0301": 1 }, { "\u00e9": 1 }]) {
      await expect(
        registerPendingSessionToolCall(client.db, {
          ...input,
          callItem: { ...input.callItem, metadata },
        }),
      ).rejects.toThrow("Pending tool receipt conflicts with the registered call");
    }
    expect(await receipts(input)).toEqual(before);
  });

  test("transport evidence wins over nested rollback codes", async () => {
    const { input } = await fixture();
    for (const code of ["40P01", "40001"]) {
      let attempts = 0;
      const failure = Object.assign(new Error("transport outcome unknown"), {
        code: "ECONNRESET",
        cause: Object.assign(new Error("older rollback"), { code }),
      });
      const unavailable = new Proxy(client.db, {
        get(target, key, receiver) {
          if (key === "transaction")
            return async () => {
              attempts += 1;
              throw failure;
            };
          return Reflect.get(target, key, receiver);
        },
      });
      await expect(registerPendingSessionToolCall(unavailable, input)).rejects.toMatchObject({
        details: { attempts: 1, retryOutcome: "not_retryable", sqlState: null },
      });
      expect(attempts).toBe(1);
    }
    expect(await receipts(input)).toHaveLength(0);
  });

  test("mixed transport evidence stops after a prior rollback and under error arrays", async () => {
    const { input } = await fixture();
    let attempts = 0;
    const failure = Object.assign(new Error("mixed failure"), {
      code: "40001",
      errors: [{ driverError: { code: "EPIPE" } }],
    });
    const unavailable = new Proxy(client.db, {
      get(target, key, receiver) {
        if (key === "transaction")
          return async () => {
            attempts += 1;
            if (attempts === 1) throw Object.assign(new Error("rollback"), { code: "40P01" });
            throw failure;
          };
        return Reflect.get(target, key, receiver);
      },
    });
    await expect(registerPendingSessionToolCall(unavailable, input)).rejects.toMatchObject({
      details: { attempts: 2, retryOutcome: "not_retryable", sqlState: null },
      cause: failure,
    });
    expect(attempts).toBe(2);
    expect(await receipts(input)).toHaveLength(0);
  });

  test("same identity with different call type or content fails closed", async () => {
    const { input } = await fixture();
    await registerPendingSessionToolCall(client.db, input);
    const before = await receipts(input);
    for (const change of [
      { callType: "different" },
      { callItem: { ...input.callItem, name: "different" } },
    ]) {
      await expect(
        registerPendingSessionToolCall(client.db, { ...input, ...change }),
      ).rejects.toThrow("Pending tool receipt conflicts with the registered call");
    }
    expect(await receipts(input)).toEqual(before);
  });

  test("concurrent duplicate registrations admit at most one effect", async () => {
    const { input } = await fixture();
    let effects = 0;
    const results = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const result = await registerPendingSessionToolCall(client.db, input);
        if (result.accepted && result.registered) effects += 1;
        return result;
      }),
    );
    expect(results.every((result) => result.accepted)).toBe(true);
    expect(results.filter((result) => result.registered)).toHaveLength(1);
    expect(await receipts(input)).toHaveLength(1);
    expect(effects).toBe(1);
  });

  test("the same call ID on successive turns in one session remains independent", async () => {
    const first = await fixture();
    const { input, grant } = first;
    expect(await registerPendingSessionToolCall(client.db, input)).toEqual({
      accepted: true,
      registered: true,
    });
    await recordPendingSessionToolCallResult(client.db, {
      ...input,
      resultItem: {
        type: "function_call_result",
        callId: input.callId,
        name: "effect",
        output: "done",
      },
    });
    await applySessionTurnSettlement(client.db, input.workspaceId, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      triggerEventId: first.triggerEventId,
      attemptId: input.attemptId,
      turnStatus: "completed",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [{ type: "turn.completed", payload: { output: "done" } }],
    });
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      input.workspaceId,
      grant.subjectId,
      (db) =>
        submitHumanPromptInTransaction(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "Next independent turn",
          resources: [],
          reasoningEffortFallback: "medium",
          source: "user",
        }),
    );
    const claim = await claimSessionWorkForAttempt(client.db, input.workspaceId, {
      sessionId: input.sessionId,
      workflowId: `session-${input.sessionId}`,
      workflowRunId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      trigger: { kind: "next" },
    });
    if (claim.action !== "claimed") throw new Error("Second turn not claimed");
    const second = {
      ...input,
      turnId: claim.turn.id,
      executionGeneration: claim.turn.executionGeneration,
      attemptId: claim.turn.activeAttemptId!,
      callItem: { ...input.callItem, name: "second_effect" },
    };
    expect(second.turnId).not.toBe(input.turnId);
    expect(second.sessionId).toBe(input.sessionId);
    expect(await registerPendingSessionToolCall(client.db, second)).toEqual({
      accepted: true,
      registered: true,
    });
    expect(await receipts(second)).toHaveLength(1);
    expect(await registerPendingSessionToolCall(client.db, input)).toEqual({
      accepted: false,
      registered: false,
    });
  });

  test("Pause between rolled-back attempts fences the retry", async () => {
    const { input, grant } = await fixture();
    await inject(input, 1, "40001", 0.2);
    const registration = registerPendingSessionToolCall(client.db, input).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    // Sequence advances survive rollback, so the controller can race a real
    // transaction while it holds the attempt fence, not a mocked retry hook.
    const deadline = Date.now() + 2_000;
    while ((await attemptCount()) === 0 && Date.now() < deadline) await Bun.sleep(2);
    expect(await attemptCount()).toBe(1);
    await withWorkspaceSubjectSessionActivityRls(
      client.db,
      input.workspaceId,
      grant.subjectId,
      (db) =>
        mutateSessionControlInTransaction(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          actor: { type: "human", subjectId: grant.subjectId },
          action: "pause",
          operationKey: crypto.randomUUID(),
        }),
    );
    expect(await registration).toEqual({ result: { accepted: false, registered: false } });
    expect(await attemptCount()).toBe(1);
    expect(await receipts(input)).toHaveLength(0);
  });
});
