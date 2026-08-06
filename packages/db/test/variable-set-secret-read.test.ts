import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createVariableSet,
  decryptVariableSetValue,
  encryptVariableSetValue,
  initializeSessionStartAtomically,
  readVariableSetSecretAtomically,
  VariableSetSecretReadAuthorityError,
  type DbClient,
} from "../src";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const encryptionKey = new Uint8Array(32).fill(41);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

setDefaultTimeout(60_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("variable-set-secret-read");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("OPENGENI_REQUIRE_REAL_DB=1 but the PostgreSQL harness is unavailable");
    }
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function fixture(label: string) {
  if (!client) throw new Error("database unavailable");
  const suffix = crypto.randomUUID();
  const subjectId = `subject-${label}-${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "variable-set-secret-read-test",
    accountExternalId: `account-${label}-${suffix}`,
    accountName: `Secret read ${label}`,
    workspaceExternalSource: "variable-set-secret-read-test",
    workspaceExternalId: `workspace-${label}-${suffix}`,
    workspaceName: `Secret read ${label}`,
    subjectId,
  });
  const grant = access.workspaceGrants[0]!;
  return { grant, subjectId };
}

describe("permissioned variable-set plaintext reads", () => {
  test("returns exact plaintext only after a metadata-only audit commits under FORCE RLS", async () => {
    if (!shared || !client) return;
    const { grant, subjectId } = await fixture("roundtrip");
    const exact =
      `ordinary source: const tokenized = "ghp_not_a_credential";\n` +
      `shell: printf '%s\\n' "$VALUE"\n` +
      `unicode:${String.fromCharCode(0)}:${String.fromCharCode(0xd800)}:${String.fromCharCode(0xdc00)}`;
    const variableSet = await createVariableSet(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "roundtrip",
      variables: [
        {
          name: "EXACT_VALUE",
          valueEncrypted: encryptVariableSetValue(encryptionKey, exact),
        },
      ],
    });

    const secret = await readVariableSetSecretAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId,
      variableSetId: variableSet.id,
      name: "EXACT_VALUE",
      actor: { kind: "subject" },
      decrypt: (valueEncrypted) => decryptVariableSetValue(encryptionKey, valueEncrypted),
    });

    expect(secret).toEqual({
      variableSetId: variableSet.id,
      name: "EXACT_VALUE",
      version: 1,
      value: exact,
    });
    const [audit] = await shared.admin<
      Array<{
        action: string;
        actorKind: string | null;
        name: string | null;
        version: number | null;
        serialized: string;
      }>
    >`
      select action,
             metadata ->> 'actorKind' as "actorKind",
             metadata ->> 'name' as name,
             (metadata ->> 'version')::int as version,
             metadata::text as serialized
      from audit_events
      where workspace_id = ${grant.workspaceId}
        and action = 'variable_set.variable.read'
      order by occurred_at desc
      limit 1
    `;
    expect(audit).toMatchObject({
      action: "variable_set.variable.read",
      actorKind: "subject",
      name: "EXACT_VALUE",
      version: 1,
    });
    expect(audit?.serialized).not.toContain(exact);
    expect(audit?.serialized).not.toContain("valueEncrypted");
    expect(audit?.serialized).not.toContain("digest");
  });

  test("fails closed when the audit insert cannot commit", async () => {
    if (!shared || !client) return;
    const { grant, subjectId } = await fixture("audit-failure");
    const variableSet = await createVariableSet(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "audit-failure",
      variables: [
        {
          name: "BLOCKED_VALUE",
          valueEncrypted: encryptVariableSetValue(encryptionKey, "must-not-return"),
        },
      ],
    });

    await shared.admin.unsafe(`
      create or replace function opengeni_test_fail_secret_read_audit()
      returns trigger language plpgsql as $$
      begin
        if new.action = 'variable_set.variable.read' then
          raise exception 'synthetic secret read audit failure';
        end if;
        return new;
      end
      $$;
      create trigger opengeni_test_fail_secret_read_audit
      before insert on audit_events
      for each row execute function opengeni_test_fail_secret_read_audit();
    `);
    try {
      let returned: unknown;
      let failure: unknown;
      try {
        returned = await readVariableSetSecretAtomically(client.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId,
          variableSetId: variableSet.id,
          name: "BLOCKED_VALUE",
          actor: { kind: "subject" },
          decrypt: (valueEncrypted) => decryptVariableSetValue(encryptionKey, valueEncrypted),
        });
      } catch (error) {
        failure = error;
      }
      expect(returned).toBeUndefined();
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('insert into "audit_events"');
      expect((failure as Error).message).not.toContain("must-not-return");
    } finally {
      await shared.admin.unsafe(`
        drop trigger if exists opengeni_test_fail_secret_read_audit on audit_events;
        drop function if exists opengeni_test_fail_secret_read_audit();
      `);
    }
  });

  test("RLS makes a cross-workspace variable set indistinguishable from missing", async () => {
    if (!client) return;
    const owner = await fixture("owner");
    const other = await fixture("other");
    const variableSet = await createVariableSet(client.db, {
      accountId: owner.grant.accountId,
      workspaceId: owner.grant.workspaceId,
      name: "owner-only",
      variables: [
        {
          name: "OWNER_VALUE",
          valueEncrypted: encryptVariableSetValue(encryptionKey, "owner-secret"),
        },
      ],
    });

    expect(
      await readVariableSetSecretAtomically(client.db, {
        accountId: other.grant.accountId,
        workspaceId: other.grant.workspaceId,
        subjectId: other.subjectId,
        variableSetId: variableSet.id,
        name: "OWNER_VALUE",
        actor: { kind: "subject" },
        decrypt: (valueEncrypted) => decryptVariableSetValue(encryptionKey, valueEncrypted),
      }),
    ).toBeNull();
  });

  test("rejects a settled agent attempt inside the same transaction as the plaintext read", async () => {
    if (!shared || !client) return;
    const { grant, subjectId } = await fixture("stale-attempt");
    const variableSet = await createVariableSet(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      name: "stale-attempt",
      variables: [
        {
          name: "FENCED_VALUE",
          valueEncrypted: encryptVariableSetValue(encryptionKey, "must-not-return"),
        },
      ],
    });
    const session = await createSession(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      initialMessage: "read one configured value",
      resources: [],
      tools: [],
      metadata: {},
      model: "secret-read-test",
      sandboxBackend: "none",
      subjectId,
    });
    await initializeSessionStartAtomically(client.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId: session.id,
      clientEventId: `initial:${session.id}`,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(client.db, grant.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      attemptId,
      dispatchId: `dispatch-${crypto.randomUUID()}`,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") {
      throw new Error(`failed to claim secret-read fixture: ${claimed.reason}`);
    }
    await applySessionTurnSettlement(client.db, grant.workspaceId, {
      sessionId: session.id,
      turnId: claimed.turn.id,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId,
      turnStatus: "failed",
      sessionStatus: "failed",
      activeTurnId: null,
      events: [{ type: "turn.failed", payload: { error: "test settlement" } }],
    });

    let returned: unknown;
    let failure: unknown;
    try {
      returned = await readVariableSetSecretAtomically(client.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId,
        variableSetId: variableSet.id,
        name: "FENCED_VALUE",
        actor: {
          kind: "agent_attempt",
          sessionId: session.id,
          turnId: claimed.turn.id,
          attemptId,
          executionGeneration: claimed.turn.executionGeneration,
        },
        decrypt: (valueEncrypted) => decryptVariableSetValue(encryptionKey, valueEncrypted),
      });
    } catch (error) {
      failure = error;
    }
    expect(returned).toBeUndefined();
    expect(failure).toBeInstanceOf(VariableSetSecretReadAuthorityError);
    expect((failure as Error).message).not.toContain("must-not-return");

    const [audit] = await shared.admin<Array<{ count: string }>>`
      select count(*)::text as count
        from audit_events
       where workspace_id = ${grant.workspaceId}
         and target_id = ${variableSet.id}
         and action = 'variable_set.variable.read'`;
    expect(audit?.count).toBe("0");
  });
});
