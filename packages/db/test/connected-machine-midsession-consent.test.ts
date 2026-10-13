import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { createDb, createSession, initializeSessionStartAtomically } from "../src";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

describe("moving a chat onto a personal Connected Machine mid-session", () => {
  let blank: BlankTestDatabase | null = null;
  let admin: postgres.Sql | null = null;
  let app: postgres.Sql | null = null;

  beforeAll(async () => {
    blank = await acquireBlankTestDatabase("connected-machine-midsession-consent");
    if (!blank) {
      if (requireRealDatabase) throw new Error("[machine-midsession] PostgreSQL is required");
      return;
    }
    await migrate(blank.databaseUrl);
    await provisionRoles(blank.databaseUrl, { appPassword: "apppw", rlsStrategy: "force" });
    admin = postgres(blank.databaseUrl, { max: 2, prepare: false, onnotice: () => undefined });
    const appUrl = new URL(blank.databaseUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = "apppw";
    app = postgres(appUrl.toString(), { max: 1, prepare: false, onnotice: () => undefined });
  }, 900_000);

  afterAll(async () => {
    await app?.end({ timeout: 5 }).catch(() => undefined);
    await admin?.end({ timeout: 5 }).catch(() => undefined);
    await blank?.release();
  }, 180_000);

  test("the owner's consent with the move admits turns that were refused without it", async () => {
    if (!blank || !admin || !app) return;
    const accountId = crypto.randomUUID();
    const personalWorkspaceId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const subjectId = `human:${crypto.randomUUID()}`;
    const sessionId = crypto.randomUUID();

    await admin`insert into managed_accounts (id, name) values (${accountId}, 'machine move')`;
    await admin`
      insert into workspaces (id, account_id, name) values
        (${personalWorkspaceId}, ${accountId}, 'personal'),
        (${workspaceId}, ${accountId}, 'shared')`;
    await admin`
      insert into workspace_inference_controls (workspace_id, account_id) values
        (${personalWorkspaceId}, ${accountId}), (${workspaceId}, ${accountId})`;
    await admin`
      insert into organization_memberships (
        account_id, subject_id, status, personal_workspace_id, authorization_revision
      ) values (${accountId}, ${subjectId}, 'active', ${personalWorkspaceId}, 7)`;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${accountId}, ${workspaceId}, ${subjectId})`;
    await admin`
      insert into session_tenancy_activations (
        account_id, activation_version, inventory_digest, parity_digest, activated_by
      ) values (${accountId}, 1, ${"a".repeat(64)}, ${"b".repeat(64)}, 'machine-midsession')`;

    const [machine] = await app.begin(async (sql) => {
      await sql`select set_config('opengeni.account_id', ${accountId}, true)`;
      await sql`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
      await sql`select set_config('opengeni.subject_id', ${subjectId}, true)`;
      return await sql<Array<{ enrollmentId: string; sandboxId: string }>>`
        select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
        from finalize_scoped_enrollment(
          ${accountId}::uuid, ${workspaceId}::uuid, 'user',
          ${`pubkey-${crypto.randomUUID()}`}, true, false, 'macos', 'arm64',
          'Owner machine', false
        )`;
    });
    if (!machine) throw new Error("personal machine fixture missing");

    const client = createDb(blank.databaseUrl, { max: 1 });
    try {
      // The chat starts on its own cloud sandbox, with no personal resources.
      await createSession(client.db, {
        requestedSessionId: sessionId,
        accountId,
        workspaceId,
        initialMessage: "run the simulations",
        resources: [],
        metadata: {},
        createdBy: { kind: "subject", subjectId },
        subjectId,
        model: "test-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "modal",
        firstPartyMcpTools: [],
      });
      const started = await initializeSessionStartAtomically(client.db, {
        accountId,
        workspaceId,
        sessionId,
        reasoningEffortFallback: "medium",
        createdEventPayload: {},
      });
      if (!started.turn) throw new Error("turn fixture missing");
      const turnId = started.turn.id;

      // "Runs on" moves the chat onto the owner's machine mid-session.
      await admin`
        update sessions set active_sandbox_id = ${machine.sandboxId},
          active_epoch = active_epoch + 1
        where id = ${sessionId} and account_id = ${accountId}`;

      const [sessionAuthority] = await admin<
        Array<{ visibility: string; authorityEpoch: number; ownerMembershipId: string }>
      >`
        select visibility, authority_epoch::int as "authorityEpoch",
          owner_organization_membership_id as "ownerMembershipId"
        from sessions where id = ${sessionId}`;
      if (!sessionAuthority) throw new Error("session authority fixture missing");

      // An ordinary turn (no personal-resource intent, protocol 0), as every
      // goal continuation or plain message is.
      const admitAttempt = async (attemptId: string) => {
        await admin!.begin(async (sql) => {
          await sql.unsafe("set local opengeni.session_inference_claim = '1'");
          await sql`
            update sessions set active_turn_id = ${turnId}, status = 'running'
            where id = ${sessionId}`;
          await sql`
            update session_turns set active_attempt_id = ${attemptId},
              execution_generation = 1, status = 'running'
            where id = ${turnId}`;
          await sql`
            insert into session_turn_attempts (
              id, account_id, workspace_id, session_id, turn_id, execution_generation,
              state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
              verified_control_revision, authority_epoch, authority_visibility,
              authority_owner_organization_membership_id, mcp_approval_policies,
              connector_action_policies, personal_resource_protocol_version
            ) values (
              ${attemptId}, ${accountId}, ${workspaceId}, ${sessionId}, ${turnId}, 1,
              'running', 'workflow', 'run-1', 'activity-1', 0,
              ${sessionAuthority.authorityEpoch}, ${sessionAuthority.visibility},
              ${sessionAuthority.ownerMembershipId}, '{}'::jsonb, '[]'::jsonb, 0
            )`;
        });
      };

      // Before the fix: the move alone grants nothing, so the turn is refused.
      let refused: unknown = null;
      await admitAttempt(crypto.randomUUID()).catch((error: unknown) => {
        refused = error;
      });
      expect(refused).toMatchObject({
        code: "42501",
        message: "personal machine use requires explicit grant",
      });

      // The message sent with the move carries the owner's session consent.
      await app.begin(async (sql) => {
        await sql`select set_config('opengeni.account_id', ${accountId}, true)`;
        await sql`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
        await sql`select set_config('opengeni.subject_id', ${subjectId}, true)`;
        const [accepted] = await sql<Array<{ mode: string; kinds: string[] }>>`
          select grant_mode as mode, resource_kinds as kinds
          from accept_turn_personal_resource_attachment(
            ${accountId}::uuid, ${workspaceId}::uuid, ${sessionId}::uuid, ${turnId}::uuid,
            'session', ${sessionAuthority.authorityEpoch}::integer,
            ${sessionAuthority.visibility === "workspace_shared"}, 1
          )`;
        expect(accepted).toEqual({ mode: "session", kinds: ["connected_machine"] });
      });

      // Ordinary turns in this chat are now admitted on the machine.
      const admittedAttemptId = crypto.randomUUID();
      await admitAttempt(admittedAttemptId);
      const [authorization] = await admin<Array<{ enrollmentId: string; grantMode: string }>>`
        select enrollment_id as "enrollmentId", grant_mode as "grantMode"
        from session_attempt_connected_machine_authorizations
        where attempt_id = ${admittedAttemptId}`;
      expect(authorization).toEqual({ enrollmentId: machine.enrollmentId, grantMode: "session" });
    } finally {
      await client.close();
    }
  }, 900_000);
});
