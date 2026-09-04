import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import {
  createDb,
  createSession,
  disconnectOrganizationCodexAccount,
  getWorkspaceCodexSubscriptionSource,
  setWorkspaceCodexSubscriptionMode,
  setWorkspaceCodexSubscriptionModeInTransaction,
  upsertCodexSubscriptionCredential,
  withSessionCodexCapacityMutation,
  type DbClient,
} from "../src";
import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0381_organization_codex_subscription_inheritance.sql",
);
const dbIndexPath = join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
const apiCodexRoutePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../apps/api/src/routes/codex.ts",
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let migration = "";
let dbIndexSource = "";
let apiCodexRouteSource = "";
let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof postgres> | null = null;
let client: DbClient | null = null;

async function setAppContext(input: {
  accountId: string;
  workspaceId: string | null;
  subjectId?: string | null;
}): Promise<void> {
  if (!app) throw new Error("application database unavailable");
  await app`select set_config('opengeni.account_id', ${input.accountId}, false)`;
  await app`select set_config('opengeni.workspace_id', ${input.workspaceId ?? ""}, false)`;
  await app`select set_config('opengeni.subject_id', ${input.subjectId ?? ""}, false)`;
}

async function expectSqlState(action: () => Promise<unknown>, state: string): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect((failure as { code?: string } | undefined)?.code).toBe(state);
}

beforeAll(async () => {
  [migration, dbIndexSource, apiCodexRouteSource] = await Promise.all([
    readFile(migrationPath, "utf8"),
    readFile(dbIndexPath, "utf8"),
    readFile(apiCodexRoutePath, "utf8"),
  ]);
  if (!requireRealDatabase) return;
  shared = await acquireSharedTestDatabase("migration-0381-organization-codex-inheritance");
  if (!shared) {
    throw new Error(
      "[migration-0381-organization-codex-inheritance] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (shared) {
    app = postgres(shared.appUrl, { max: 4 });
    client = createDb(shared.appUrl, { max: 4 });
  }
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await app?.end().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("migration 0381 organization Codex subscription inheritance", () => {
  test("declares one effective pool and preserves personal-workspace isolation", () => {
    expect(migration.split(/\r?\n/u, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(migration).toContain("organization_codex_rotation_settings");
    expect(migration).toContain("workspace_codex_subscription_preferences");
    expect(migration).toContain("resolve_workspace_codex_subscription_source");
    expect(migration).toContain("authority_scope = 'organization'");
    expect(migration).toContain("workspace_kind = 'personal'");
    expect(migration).toContain("Codex credential is outside the workspace effective pool");
    expect(migration).toContain("CREATE POLICY organization_scope_insert");
    expect(migration).toContain("codex_organization_admin_visible");
    expect(migration).toContain("CREATE POLICY organization_scope_update_admin");
    expect(migration).toContain("CREATE POLICY organization_scope_update_runtime");
    expect(migration).toContain("codex_credentials_organization_runtime_update_guard");
    expect(migration).toContain("codex_credentials_organization_live_lease_disconnect_guard");
    expect(migration).toContain("prevent_organization_codex_disconnect_with_live_leases");
    expect(migration).toContain("codex_organization_live_lease_count");
    expect(migration).toContain(
      "organization Codex credential management requires organization administration",
    );
    expect(migration).toContain(
      "organization Codex runtime token refresh has an invalid mutation shape",
    );
    expect(migration).not.toContain("credential_encrypted = NULL");
    expect(dbIndexSource).toMatch(
      /from\(schema\.organizationCodexRotationSettings\)[\s\S]*?\.for\("update"\)/u,
    );
    expect(dbIndexSource).toMatch(
      /from\(schema\.codexRotationSettings\)[\s\S]*?\.for\("update"\)/u,
    );
    expect(dbIndexSource).toMatch(
      /setActiveOrganizationCodexCredential[\s\S]*?from\(schema\.organizationCodexRotationSettings\)[\s\S]*?\.for\("update"\)[\s\S]*?from\(schema\.codexSubscriptionCredentials\)/u,
    );
    expect(dbIndexSource).toMatch(
      /setWorkspaceCodexSubscriptionMode[\s\S]*?lockWorkspaceCodexSubscriptionSource[\s\S]*?assertCodexSubscriptionSourceChangeAllowed/u,
    );
    expect(dbIndexSource).toMatch(
      /assertCodexSubscriptionSourceChangeAllowed[\s\S]*?waiting_capacity[\s\S]*?codexCredentialLeases\.leasedUntil[\s\S]*?CodexSubscriptionSourceChangeBlockedError/u,
    );
    expect(dbIndexSource).toMatch(
      /mutateCodexCapacityInTransaction[\s\S]*?sourceBefore[\s\S]*?sourceAfter[\s\S]*?assertCodexSubscriptionSourceChangeAllowed/u,
    );
    expect(dbIndexSource).toMatch(
      /lockOrganizationCodexSubscriptionSources[\s\S]*?list_organization_workspace_ids[\s\S]*?lockWorkspaceCodexSubscriptionSource/u,
    );
    expect(dbIndexSource).toMatch(
      /withOrganizationCodexAdministrator[\s\S]*?lockOrganizationMembershipLifecycle[\s\S]*?get_organization_administration_overview/u,
    );
    expect(dbIndexSource).toMatch(
      /acquireCodexCredentialLease[\s\S]*?lockWorkspaceCodexSubscriptionSource[\s\S]*?getWorkspaceCodexSubscriptionSourceScoped/u,
    );
    expect(dbIndexSource).toMatch(
      /input\.source === "organization"[\s\S]*?codex_organization_live_lease_count/u,
    );
    expect(dbIndexSource).toMatch(
      /wakeOrganizationCodexCapacityWaitersInTransaction[\s\S]*?list_organization_workspace_ids[\s\S]*?session-tenancy:/u,
    );
    expect(apiCodexRouteSource).toMatch(
      /withSessionCodexCapacityMutation[\s\S]*?sourceBeforeConnect = await getWorkspaceCodexSubscriptionSource[\s\S]*?upsertCodexSubscriptionCredential[\s\S]*?ensureCodexRotationSettings[\s\S]*?setInitialActiveCodexCredential[\s\S]*?setWorkspaceCodexSubscriptionModeInTransaction[\s\S]*?effectiveSourceBeforeMutation: sourceBeforeConnect\.effectiveSource/u,
    );
    expect(apiCodexRouteSource).toMatch(
      /organizations\/:organizationId\/codex\/connect\/poll[\s\S]*?upsertOrganizationCodexSubscriptionCredential[\s\S]*?active turns are using it[\s\S]*?HTTPException\(409/u,
    );
    for (const table of [
      "organization_codex_rotation_settings",
      "workspace_codex_subscription_preferences",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_FULL_DML_TABLES).toContain(table);
    }
  });

  test("inherits into shared workspaces, excludes personal workspaces, and honors overrides", async () => {
    if (!shared || !app || !client) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('organization-codex-inheritance') returning id`;
    const [personalWorkspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'personal') returning id`;
    const [sharedWorkspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'shared') returning id`;
    const ownerSubjectId = `user:${crypto.randomUUID()}`;
    await shared.admin`
      insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id
      ) values (
        ${account!.id}, ${ownerSubjectId}, 'owner', 'active', ${personalWorkspace!.id}
      )`;
    for (const workspaceId of [personalWorkspace!.id, sharedWorkspace!.id]) {
      await shared.admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}, ${account!.id})`;
    }

    await setAppContext({
      accountId: account!.id,
      workspaceId: null,
      subjectId: ownerSubjectId,
    });
    const [organizationCredential] = await app<{ id: string }[]>`
      insert into codex_subscription_credentials (
        account_id, workspace_id, organization_id, authority_scope,
        credential_encrypted, chatgpt_account_id, status
      ) values (
        ${account!.id}, null, ${account!.id}, 'organization',
        'ciphertext', 'organization-provider-account', 'active'
      ) returning id`;
    await app`
      insert into organization_codex_rotation_settings (account_id, active_credential_id)
      values (${account!.id}, ${organizationCredential!.id})`;

    await setAppContext({ accountId: account!.id, workspaceId: sharedWorkspace!.id });
    const [sharedSource] = await app<{ source: string }[]>`
      select resolve_workspace_codex_subscription_source(
        ${account!.id}, ${sharedWorkspace!.id}
      ) as source`;
    expect(sharedSource?.source).toBe("organization");

    await expectSqlState(
      () =>
        app!`
          update codex_subscription_credentials
          set label = 'workspace takeover'
          where id = ${organizationCredential!.id}`,
      "42501",
    );
    await app`
      update codex_subscription_credentials
      set status = 'error', last_error = 'runtime quarantine', updated_at = now()
      where id = ${organizationCredential!.id}`;
    await expectSqlState(
      () =>
        app!`
          update codex_subscription_credentials
          set credential_encrypted = 'invalid-overwrite'
          where id = ${organizationCredential!.id}`,
      "42501",
    );
    await app`
      update codex_subscription_credentials
      set credential_encrypted = 'rotated-ciphertext',
          expires_at = now() + interval '1 hour',
          last_refresh_at = now(),
          status = 'active',
          last_error = null,
          version = version + 1,
          updated_at = now()
      where id = ${organizationCredential!.id}`;
    const [runtimeUpdated] = await app<
      { credential_encrypted: string; label: string | null; status: string; version: number }[]
    >`
      select credential_encrypted, label, status, version
      from codex_subscription_credentials
      where id = ${organizationCredential!.id}`;
    expect(runtimeUpdated).toEqual({
      credential_encrypted: "rotated-ciphertext",
      label: null,
      status: "active",
      version: 2,
    });

    await setAppContext({ accountId: account!.id, workspaceId: personalWorkspace!.id });
    const [personalSource] = await app<{ source: string }[]>`
      select resolve_workspace_codex_subscription_source(
        ${account!.id}, ${personalWorkspace!.id}
      ) as source`;
    expect(personalSource?.source).toBe("workspace");

    await setAppContext({ accountId: account!.id, workspaceId: sharedWorkspace!.id });
    await app`
      insert into workspace_codex_subscription_preferences (
        account_id, workspace_id, mode
      ) values (${account!.id}, ${sharedWorkspace!.id}, 'disabled')`;
    const [disabledSource] = await app<{ source: string }[]>`
      select resolve_workspace_codex_subscription_source(
        ${account!.id}, ${sharedWorkspace!.id}
      ) as source`;
    expect(disabledSource?.source).toBe("disabled");

    await app`
      update workspace_codex_subscription_preferences
      set mode = 'organization'
      where workspace_id = ${sharedWorkspace!.id}`;
    const [organizationOverride] = await app<{ source: string }[]>`
      select resolve_workspace_codex_subscription_source(
        ${account!.id}, ${sharedWorkspace!.id}
      ) as source`;
    expect(organizationOverride?.source).toBe("organization");
  });

  test("allows an equivalent workspace-source preference while active work remains fenced", async () => {
    if (!shared || !app || !client) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('codex-equivalent-source-preference') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'shared') returning id`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;

    const session = await createSession(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      initialMessage: "keep the effective workspace source",
      resources: [],
      tools: [],
      metadata: {},
      model: "codex/gpt-5",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await shared.admin.begin(async (transaction) => {
      await transaction`set local session_replication_role = replica`;
      await transaction`
        insert into session_turns (
          account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
          status, position, prompt, model, reasoning_effort, sandbox_backend
        ) values (
          ${account!.id}, ${workspace!.id}, ${session.id}, ${crypto.randomUUID()},
          ${`migration-0381-equivalent-${crypto.randomUUID()}`}, 'running', 0,
          'keep the effective workspace source', 'codex/gpt-5', 'medium', 'none'
        )`;
    });

    const connected = await withSessionCodexCapacityMutation(
      client.db,
      { workspaceId: workspace!.id, reason: "codex_credential_connected" },
      async (transaction) => {
        const sourceBeforeConnect = await getWorkspaceCodexSubscriptionSource(
          transaction,
          workspace!.id,
        );
        const upserted = await upsertCodexSubscriptionCredential(transaction, {
          accountId: account!.id,
          workspaceId: workspace!.id,
          credentialEncrypted: "workspace-ciphertext",
          chatgptAccountId: "workspace-provider-account",
          scopes: null,
          planType: "pro",
          isFedramp: false,
          expiresAt: null,
          lastRefreshAt: new Date(),
          connectedBySubjectId: null,
        });
        if (upserted.kind !== "upserted") throw new Error("expected credential upsert");
        const pinned = await setWorkspaceCodexSubscriptionModeInTransaction(transaction, {
          accountId: account!.id,
          workspaceId: workspace!.id,
          subjectId: null,
          mode: "workspace",
          effectiveSourceBeforeMutation: sourceBeforeConnect.effectiveSource,
        });
        return { result: { pinned, sourceBeforeConnect, upserted }, changed: true };
      },
    );
    expect(connected.result.sourceBeforeConnect).toMatchObject({
      mode: "automatic",
      effectiveSource: "workspace",
      workspaceAvailable: false,
      organizationAvailable: false,
    });
    expect(connected.result.pinned).toMatchObject({
      mode: "workspace",
      effectiveSource: "workspace",
    });

    await expect(
      setWorkspaceCodexSubscriptionMode(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        subjectId: null,
        mode: "disabled",
      }),
    ).rejects.toThrow("Codex subscription source cannot change while active turns are using it");
    const [retainedPreference] = await shared.admin<{ mode: string }[]>`
      select mode from workspace_codex_subscription_preferences
      where workspace_id = ${workspace!.id}`;
    expect(retainedPreference?.mode).toBe("workspace");
  });

  test("fences a first workspace credential when the automatic source was organization", async () => {
    if (!shared || !app || !client) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('codex-pre-connect-source-fence') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'shared') returning id`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
    const [organizationCredential] = await shared.admin<{ id: string }[]>`
      insert into codex_subscription_credentials (
        account_id, workspace_id, organization_id, authority_scope,
        credential_encrypted, chatgpt_account_id, status
      ) values (
        ${account!.id}, null, ${account!.id}, 'organization',
        'organization-ciphertext', 'organization-provider-account', 'active'
      ) returning id`;
    await shared.admin`
      insert into organization_codex_rotation_settings (account_id, active_credential_id)
      values (${account!.id}, ${organizationCredential!.id})`;

    const session = await createSession(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      initialMessage: "keep the organization source",
      resources: [],
      tools: [],
      metadata: {},
      model: "codex/gpt-5",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    await shared.admin.begin(async (transaction) => {
      await transaction`set local session_replication_role = replica`;
      await transaction`
        insert into session_turns (
          account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
          status, position, prompt, model, reasoning_effort, sandbox_backend
        ) values (
          ${account!.id}, ${workspace!.id}, ${session.id}, ${crypto.randomUUID()},
          ${`migration-0381-pre-connect-${crypto.randomUUID()}`}, 'running', 0,
          'keep the organization source', 'codex/gpt-5', 'medium', 'none'
        )`;
    });

    let sourceBeforeConnect: Awaited<
      ReturnType<typeof getWorkspaceCodexSubscriptionSource>
    > | null = null;
    await expect(
      withSessionCodexCapacityMutation(
        client.db,
        { workspaceId: workspace!.id, reason: "codex_credential_connected" },
        async (transaction) => {
          const source = await getWorkspaceCodexSubscriptionSource(transaction, workspace!.id);
          sourceBeforeConnect = source;
          const upserted = await upsertCodexSubscriptionCredential(transaction, {
            accountId: account!.id,
            workspaceId: workspace!.id,
            credentialEncrypted: "workspace-ciphertext",
            chatgptAccountId: "first-workspace-provider-account",
            scopes: null,
            planType: "pro",
            isFedramp: false,
            expiresAt: null,
            lastRefreshAt: new Date(),
            connectedBySubjectId: null,
          });
          if (upserted.kind !== "upserted") throw new Error("expected credential upsert");
          await setWorkspaceCodexSubscriptionModeInTransaction(transaction, {
            accountId: account!.id,
            workspaceId: workspace!.id,
            subjectId: null,
            mode: "workspace",
            effectiveSourceBeforeMutation: source.effectiveSource,
          });
          return { result: upserted, changed: true };
        },
      ),
    ).rejects.toThrow("Codex subscription source cannot change while active turns are using it");
    expect(sourceBeforeConnect).toMatchObject({
      mode: "automatic",
      effectiveSource: "organization",
    });
    const [rolledBack] = await shared.admin<
      { workspace_credentials: number; preferences: number }[]
    >`
      select
        count(*) filter (
          where credential.workspace_id = ${workspace!.id}
            and credential.authority_scope in ('workspace', 'user')
        )::integer as workspace_credentials,
        (
          select count(*)::integer from workspace_codex_subscription_preferences preference
          where preference.workspace_id = ${workspace!.id}
        ) as preferences
      from codex_subscription_credentials credential
      where credential.account_id = ${account!.id}`;
    expect(rolledBack).toEqual({ workspace_credentials: 0, preferences: 0 });
  });

  test("fences an effective source change while a Codex turn waits for capacity", async () => {
    if (!shared || !app || !client) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('codex-waiting-source-fence') returning id`;
    const [workspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'shared') returning id`;
    await shared.admin`
      insert into workspace_inference_controls (workspace_id, account_id)
      values (${workspace!.id}, ${account!.id})`;
    const [organizationCredential] = await shared.admin<{ id: string }[]>`
      insert into codex_subscription_credentials (
        account_id, workspace_id, organization_id, authority_scope,
        credential_encrypted, chatgpt_account_id, status
      ) values (
        ${account!.id}, null, ${account!.id}, 'organization',
        'organization-ciphertext', 'waiting-source-provider-account', 'active'
      ) returning id`;
    await shared.admin`
      insert into organization_codex_rotation_settings (account_id, active_credential_id)
      values (${account!.id}, ${organizationCredential!.id})`;

    const session = await createSession(client.db, {
      accountId: account!.id,
      workspaceId: workspace!.id,
      initialMessage: "wait before changing source",
      resources: [],
      tools: [],
      metadata: {},
      model: "codex/gpt-5",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const turn = await shared.admin.begin(async (transaction) => {
      await transaction`set local session_replication_role = replica`;
      const [row] = await transaction<{ id: string }[]>`
        insert into session_turns (
          account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
          status, position, prompt, model, reasoning_effort, sandbox_backend
        ) values (
          ${account!.id}, ${workspace!.id}, ${session.id}, ${crypto.randomUUID()},
          ${`migration-0381-waiting-source-${crypto.randomUUID()}`}, 'waiting_capacity', 0,
          'wait before changing source', 'codex/gpt-5', 'medium', 'none'
        ) returning id`;
      await transaction`
        update sessions
        set status = 'waiting_capacity', active_turn_id = ${row!.id}
        where id = ${session.id}`;
      return row!;
    });

    await expect(
      setWorkspaceCodexSubscriptionMode(client.db, {
        accountId: account!.id,
        workspaceId: workspace!.id,
        subjectId: null,
        mode: "disabled",
      }),
    ).rejects.toThrow("Codex subscription source cannot change while active turns are using it");
    await setAppContext({ accountId: account!.id, workspaceId: workspace!.id });
    const [source] = await app<{ source: string }[]>`
      select resolve_workspace_codex_subscription_source(
        ${account!.id}, ${workspace!.id}
      ) as source`;
    expect(source?.source).toBe("organization");
    expect(turn.id).toBeString();
  });

  test("allows an organization credential lease only in an inheriting shared workspace", async () => {
    if (!shared || !app || !client) return;
    const dbClient = client;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('organization-codex-lease') returning id`;
    const [personalWorkspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'personal') returning id`;
    const [sharedWorkspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'shared') returning id`;
    const ownerSubjectId = `user:${crypto.randomUUID()}`;
    await shared.admin`
      insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id
      ) values (
        ${account!.id}, ${ownerSubjectId}, 'owner', 'active', ${personalWorkspace!.id}
      )`;
    for (const workspaceId of [personalWorkspace!.id, sharedWorkspace!.id]) {
      await shared.admin`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}, ${account!.id})`;
    }
    const [credential] = await shared.admin<{ id: string }[]>`
      insert into codex_subscription_credentials (
        account_id, workspace_id, organization_id, authority_scope,
        credential_encrypted, chatgpt_account_id, status
      ) values (
        ${account!.id}, null, ${account!.id}, 'organization',
        'ciphertext', 'lease-provider-account', 'active'
      ) returning id`;

    const sharedSession = await createSession(dbClient.db, {
      accountId: account!.id,
      workspaceId: sharedWorkspace!.id,
      initialMessage: "shared inherited Codex lease",
      resources: [],
      tools: [],
      metadata: {},
      model: "codex/gpt-5",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const sharedTurn = await shared.admin.begin(async (transaction) => {
      await transaction`set local session_replication_role = replica`;
      const [turn] = await transaction<{ id: string }[]>`
        insert into session_turns (
          account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
          status, position, prompt, model, reasoning_effort, sandbox_backend
        ) values (
          ${account!.id}, ${sharedWorkspace!.id}, ${sharedSession.id}, ${crypto.randomUUID()},
          ${`migration-0381-shared-${crypto.randomUUID()}`}, 'queued', 0,
          'shared inherited Codex lease', 'codex/gpt-5', 'medium', 'none'
        ) returning id`;
      return turn!;
    });
    await setAppContext({ accountId: account!.id, workspaceId: sharedWorkspace!.id });
    await app`
      insert into codex_credential_leases (
        account_id, workspace_id, credential_id, turn_id, holder_id, leased_until
      ) values (
        ${account!.id}, ${sharedWorkspace!.id}, ${credential!.id},
        ${sharedTurn.id}, 'shared-holder', now() + interval '5 minutes'
      )`;

    await expect(
      setWorkspaceCodexSubscriptionMode(dbClient.db, {
        accountId: account!.id,
        workspaceId: sharedWorkspace!.id,
        subjectId: null,
        mode: "disabled",
      }),
    ).rejects.toThrow("Codex subscription source cannot change while active turns are using it");
    const [sourceAfterRejectedChange] = await app<{ source: string }[]>`
      select resolve_workspace_codex_subscription_source(
        ${account!.id}, ${sharedWorkspace!.id}
      ) as source`;
    expect(sourceAfterRejectedChange?.source).toBe("organization");
    await app`delete from codex_credential_leases where id is not null`;
    await shared.admin.begin(async (transaction) => {
      await transaction`set local session_replication_role = replica`;
      await transaction`
        update session_turns set status = 'running' where id = ${sharedTurn.id}`;
    });
    await expect(
      setWorkspaceCodexSubscriptionMode(dbClient.db, {
        accountId: account!.id,
        workspaceId: sharedWorkspace!.id,
        subjectId: null,
        mode: "disabled",
      }),
    ).rejects.toThrow("Codex subscription source cannot change while active turns are using it");
    await shared.admin.begin(async (transaction) => {
      await transaction`set local session_replication_role = replica`;
      await transaction`
        update session_turns set status = 'queued' where id = ${sharedTurn.id}`;
    });
    await app`
      insert into codex_credential_leases (
        account_id, workspace_id, credential_id, turn_id, holder_id, leased_until
      ) values (
        ${account!.id}, ${sharedWorkspace!.id}, ${credential!.id},
        ${sharedTurn.id}, 'shared-holder-restored', now() + interval '5 minutes'
      )`;
    let disconnectError: unknown;
    try {
      await disconnectOrganizationCodexAccount(dbClient.db, {
        organizationId: account!.id,
        actorSubjectId: ownerSubjectId,
        credentialId: credential!.id,
      });
    } catch (error) {
      disconnectError = error;
    }
    const disconnectDatabaseError =
      (disconnectError as { cause?: unknown } | undefined)?.cause ?? disconnectError;
    expect((disconnectDatabaseError as { code?: string } | undefined)?.code).toBe("55006");
    expect(String(disconnectDatabaseError)).toContain(
      "Codex subscription cannot disconnect while active turns are using it",
    );
    const [credentialAfterRejectedDisconnect] = await app<{ id: string }[]>`
      select id from codex_subscription_credentials where id = ${credential!.id}`;
    expect(credentialAfterRejectedDisconnect?.id).toBe(credential!.id);

    const personalSession = await createSession(dbClient.db, {
      accountId: account!.id,
      workspaceId: personalWorkspace!.id,
      initialMessage: "personal Codex isolation",
      resources: [],
      tools: [],
      metadata: {},
      model: "codex/gpt-5",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
    const personalTurn = await shared.admin.begin(async (transaction) => {
      await transaction`set local session_replication_role = replica`;
      const [turn] = await transaction<{ id: string }[]>`
        insert into session_turns (
          account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
          status, position, prompt, model, reasoning_effort, sandbox_backend
        ) values (
          ${account!.id}, ${personalWorkspace!.id}, ${personalSession.id}, ${crypto.randomUUID()},
          ${`migration-0381-personal-${crypto.randomUUID()}`}, 'queued', 0,
          'personal Codex isolation', 'codex/gpt-5', 'medium', 'none'
        ) returning id`;
      return turn!;
    });
    await setAppContext({ accountId: account!.id, workspaceId: personalWorkspace!.id });
    await expectSqlState(
      () =>
        app!`
          insert into codex_credential_leases (
            account_id, workspace_id, credential_id, turn_id, holder_id, leased_until
          ) values (
            ${account!.id}, ${personalWorkspace!.id}, ${credential!.id},
            ${personalTurn.id}, 'personal-holder', now() + interval '5 minutes'
          )`,
      "23514",
    );
  });
});
