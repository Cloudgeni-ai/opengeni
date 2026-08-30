import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import { FORCE_RLS_TABLES, RUNTIME_FULL_DML_TABLES } from "../src/runtime-posture";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0381_organization_codex_subscription_inheritance.sql",
);
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let migration = "";
let shared: SharedTestDatabase | null = null;
let app: ReturnType<typeof postgres> | null = null;

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
  migration = await readFile(migrationPath, "utf8");
  if (!requireRealDatabase) return;
  shared = await acquireSharedTestDatabase("migration-0381-organization-codex-inheritance");
  if (!shared) {
    throw new Error(
      "[migration-0381-organization-codex-inheritance] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
    );
  }
  if (shared) app = postgres(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
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
    expect(migration).not.toContain("credential_encrypted = NULL");
    for (const table of [
      "organization_codex_rotation_settings",
      "workspace_codex_subscription_preferences",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_FULL_DML_TABLES).toContain(table);
    }
  });

  test("inherits into shared workspaces, excludes personal workspaces, and honors overrides", async () => {
    if (!shared || !app) return;
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

  test("allows an organization credential lease only in an inheriting shared workspace", async () => {
    if (!shared || !app) return;
    const [account] = await shared.admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('organization-codex-lease') returning id`;
    const [personalWorkspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'personal') returning id`;
    const [sharedWorkspace] = await shared.admin<{ id: string }[]>`
      insert into workspaces (account_id, name)
      values (${account!.id}, 'shared') returning id`;
    await shared.admin`
      insert into organization_memberships (
        account_id, subject_id, role, status, personal_workspace_id
      ) values (
        ${account!.id}, ${`user:${crypto.randomUUID()}`}, 'owner', 'active', ${personalWorkspace!.id}
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

    const sharedTurn = await shared.admin.begin(async (transaction) => {
      await transaction`set local session_replication_role = replica`;
      const [session] = await transaction<{ id: string }[]>`
        insert into sessions (account_id, workspace_id, status)
        values (${account!.id}, ${sharedWorkspace!.id}, 'idle') returning id`;
      const [turn] = await transaction<{ id: string }[]>`
        insert into session_turns (account_id, workspace_id, session_id, status, model)
        values (
          ${account!.id}, ${sharedWorkspace!.id}, ${session!.id}, 'queued', 'codex/gpt-5'
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

    const personalTurn = await shared.admin.begin(async (transaction) => {
      await transaction`set local session_replication_role = replica`;
      const [session] = await transaction<{ id: string }[]>`
        insert into sessions (account_id, workspace_id, status)
        values (${account!.id}, ${personalWorkspace!.id}, 'idle') returning id`;
      const [turn] = await transaction<{ id: string }[]>`
        insert into session_turns (account_id, workspace_id, session_id, status, model)
        values (
          ${account!.id}, ${personalWorkspace!.id}, ${session!.id}, 'queued', 'codex/gpt-5'
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
