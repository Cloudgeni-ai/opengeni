import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  acceptOrganizationInvitation,
  claimSessionWorkForAttempt,
  createDb,
  createOrganizationInvitation,
  createSession,
  ensureManagedAccessForUser,
  getSandbox,
  getSandboxForAttempt,
  initializeSessionStartAtomically,
  recoverSessionDispatch,
  resolvePersonalMachineConnectionForAttempt,
  setActiveSandbox,
  withRlsContext,
  type DbClient,
} from "../src/index";

// This suite must exercise the production posture: a non-superuser migration
// owner, FORCE RLS, a named schema, and the restricted runtime login.
let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
let app: postgres.Sql;
beforeAll(async () => {
  const acquired = await acquireRestrictedRuntimeTestDatabase("live-machine-consent");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl, { max: 4, searchPath: shared.schema });
  app = postgres(shared.appUrl, {
    max: 2,
    prepare: false,
    connection: { search_path: shared.schema },
    onnotice: () => undefined,
  });
}, 900_000);
afterAll(async () => {
  await app?.end({ timeout: 1 }).catch(() => undefined);
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

async function fixture() {
  const ownerUser = `machine-owner-${crypto.randomUUID()}`;
  const memberUser = `machine-member-${crypto.randomUUID()}`;
  const owner = `user:${ownerUser}`;
  const member = `user:${memberUser}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId: ownerUser,
    email: `${ownerUser}@example.test`,
    name: "Machine owner",
  });
  await ensureManagedAccessForUser(client.db, {
    userId: memberUser,
    email: `${memberUser}@example.test`,
    name: "Workspace member",
  });
  const grant = access.workspaceGrants.find(
    (value) => value.workspaceId === access.defaultWorkspaceId,
  )!;
  const { accountId, workspaceId } = grant;
  const invitation = await createOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: owner,
    operationId: crypto.randomUUID(),
    targetSubjectId: member,
    targetEmail: `${memberUser}@example.test`,
    role: "member",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await acceptOrganizationInvitation(client.db, {
    organizationId: accountId,
    actorSubjectId: member,
    operationId: crypto.randomUUID(),
    invitationId: invitation.id,
    expectedRevision: invitation.revision,
  });
  await shared.admin`insert into workspace_memberships(account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${workspaceId}, ${member}, 'member', '["sessions:read","sessions:create","sessions:control"]'::jsonb)`;
  await shared.admin`insert into session_tenancy_activations(account_id, activation_version, inventory_digest, parity_digest, activated_by)
    values (${accountId}, 1, ${"3".repeat(64)}, ${"4".repeat(64)}, 'machine-consent-test')`;
  const machines = await app.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true), set_config('opengeni.subject_id', ${owner}, true)`;
    return await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
      select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
      from finalize_scoped_enrollment(${accountId}::uuid, ${workspaceId}::uuid, 'user',
        ${`ed25519:consent-${crypto.randomUUID()}`}, true, false, 'linux', 'x86_64', 'Build machine', false)`;
  });
  const machine = machines[0]!;
  await shared.admin`update enrollments set connection_instance_id = 'connection-1',
    connection_generation = 1, connection_lease_expires_at = now() + interval '1 hour',
    workspace_root = '/srv/build' where id = ${machine.enrollmentId}`;
  return { accountId, workspaceId, owner, member, ...machine };
}

async function claim(workspaceId: string, sessionId: string) {
  const attemptId = crypto.randomUUID();
  const result = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId,
    workflowId: `session-${sessionId}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (result.action !== "claimed") throw new Error(`turn was not claimed: ${result.reason}`);
  return {
    turnId: result.turn.id,
    attemptId,
    executionGeneration: result.turn.executionGeneration,
  };
}

describe("live personal machine consent under FORCE RLS", () => {
  for (const starter of ["owner", "member", "service"] as const) {
    test(`owner click admits the ${starter} turn and replacement attempt without borrowing identity`, async () => {
      const f = await fixture();
      const subjectId = starter === "service" ? null : f[starter];
      const session = await createSession(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        initialMessage: "Continue on the selected machine",
        resources: [],
        metadata: {},
        createdBy: subjectId
          ? { kind: "subject", subjectId }
          : { kind: "service", subjectId: "service:machine-consent-test" },
        subjectId: subjectId ?? f.owner,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        visibility: "workspace_shared",
      } as never);
      await initializeSessionStartAtomically(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: session.id,
        reasoningEffortFallback: "medium",
        createdEventPayload: {},
      } as never);
      const first = await claim(f.workspaceId, session.id);
      const move = (clicker: string, expectedEpoch = session.activeEpoch) =>
        setActiveSandbox(client.db, {
          accountId: f.accountId,
          workspaceId: f.workspaceId,
          sessionId: session.id,
          subjectId: clicker,
          expectedEpoch,
          targetSandboxId: f.sandboxId,
          consentToCurrentTurn: true,
        });
      expect(await move(f.member)).toMatchObject({ swapped: false, refusal: "not_permitted" });
      expect(await move(f.owner, session.activeEpoch + 2)).toMatchObject({
        swapped: false,
        refusal: "epoch_changed",
      });
      expect(
        await shared.admin`select id from session_turn_machine_consents where turn_id = ${first.turnId}`,
      ).toHaveLength(0);
      const moved = await move(f.owner);
      expect(moved).toMatchObject({
        swapped: true,
        pointer: { activeSandboxId: f.sandboxId },
      });
      const runtime = {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        sessionId: session.id,
        subjectId,
        ...first,
      };
      expect(await getSandboxForAttempt(client.db, runtime, f.sandboxId)).toMatchObject({
        id: f.sandboxId,
        scope: "user",
      });
      const uses = () => shared.admin`select id from audit_events
        where action = 'connected_machine.used' and metadata->>'attemptId' = ${first.attemptId}`;
      expect(await uses()).toHaveLength(0);
      expect(
        await resolvePersonalMachineConnectionForAttempt(client.db, {
          ...runtime,
          enrollmentId: f.enrollmentId,
        }),
      ).toMatchObject({ id: f.enrollmentId, connectionInstanceId: "connection-1" });
      expect(await uses()).toHaveLength(1);
      await withRlsContext(client.db, { accountId: f.accountId, workspaceId: f.workspaceId }, async (tx) => {
        await tx.execute(sql`select
          set_config('opengeni.subject_id', ${subjectId ?? ""}, true),
          set_config('opengeni.initiating_human_subject_id', ${subjectId ?? ""}, true)`);
        await tx.execute(sql`select get_session_attempt_machine(${f.accountId}::uuid, ${f.workspaceId}::uuid,
          ${session.id}::uuid, ${first.turnId}::uuid, ${first.attemptId}::uuid,
          ${first.executionGeneration}::integer, ${f.sandboxId}::uuid, null, false, true)`);
        const [actor] = await tx.execute(sql`select current_setting('opengeni.subject_id') as subject,
          current_setting('opengeni.initiating_human_subject_id') as initiator`);
        expect(actor).toEqual({ subject: subjectId ?? "", initiator: subjectId ?? "" });
      });
      expect(await uses()).toHaveLength(1);
      expect(await getSandbox(client.db, { ...f, subjectId: f.member }, f.sandboxId)).toBeNull();
      await expect(
        resolvePersonalMachineConnectionForAttempt(client.db, {
          ...runtime,
          subjectId: subjectId === f.owner ? f.member : f.owner,
          enrollmentId: f.enrollmentId,
        }),
      ).rejects.toThrow();
      const [identity] =
        await shared.admin`select initiating_human_subject_id from session_turns where id = ${first.turnId}`;
      expect(identity?.initiating_human_subject_id).toBe(subjectId);
      expect(
        (
          await recoverSessionDispatch(client.db, f.workspaceId, {
            sessionId: session.id,
            attemptId: first.attemptId,
            timeoutType: "HEARTBEAT",
            maxRedispatches: 3,
          })
        ).action,
      ).toBe("recovering");
      if (starter === "service") {
        // The owner's click also works between attempts, when active_turn_id is
        // temporarily empty. It must bind to this recovering turn, not future work.
        expect(await move(f.owner, session.activeEpoch + 1)).toMatchObject({ swapped: true });
      }
      const second = await claim(f.workspaceId, session.id);
      expect(second.turnId).toBe(first.turnId);
      expect(second.attemptId).not.toBe(first.attemptId);
      expect(
        await getSandboxForAttempt(client.db, { ...runtime, ...second }, f.sandboxId),
      ).toMatchObject({ id: f.sandboxId });
      expect(
        await resolvePersonalMachineConnectionForAttempt(client.db, {
          ...runtime,
          ...second,
          enrollmentId: f.enrollmentId,
        }),
      ).toMatchObject({ id: f.enrollmentId });
      await expect(
        resolvePersonalMachineConnectionForAttempt(client.db, {
          ...runtime,
          enrollmentId: f.enrollmentId,
        }),
      ).rejects.toThrow();
      const bindings =
        await shared.admin`select binding.attempt_id from session_attempt_machine_consents binding
        join session_turn_machine_consents consent on consent.id = binding.consent_id where consent.turn_id = ${first.turnId}`;
      expect(bindings.map((value) => value.attempt_id).sort()).toEqual(
        [first.attemptId, second.attemptId].sort(),
      );
      await shared.admin`update organization_memberships set authorization_revision = authorization_revision + 1
        where account_id = ${f.accountId} and subject_id = ${f.owner}`;
      expect(
        await resolvePersonalMachineConnectionForAttempt(client.db, {
          ...runtime,
          ...second,
          enrollmentId: f.enrollmentId,
        }),
      ).toBeNull();
    }, 120_000);
  }

  test("runtime cannot write consent or execute internal helpers", async () => {
    const [privileges] = await app`select
      has_table_privilege(current_user, 'session_turn_machine_consents', 'INSERT') as turn_insert,
      has_table_privilege(current_user, 'session_attempt_machine_consents', 'INSERT') as attempt_insert,
      has_function_privilege(current_user, 'bind_session_attempt_machine_consent(uuid,uuid,uuid)', 'EXECUTE') as bind,
      has_function_privilege(current_user, 'live_session_turn_machine_consent(uuid)', 'EXECUTE') as validate`;
    expect(privileges).toEqual({
      turn_insert: false,
      attempt_insert: false,
      bind: false,
      validate: false,
    });
  });
});
