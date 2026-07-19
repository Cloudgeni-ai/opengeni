import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  createDb,
  createSession,
  listSandboxGitCredentialBindings,
  markSandboxGitCredentialBindingStatus,
  markSandboxGitCredentialBindingsStatus,
  upsertSandboxGitCredentialBinding,
  withActiveSandboxGitCredentialBindings,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  const externalAdminUrl = process.env.OPENGENI_TEST_DATABASE_ADMIN_URL?.trim();
  const externalAppUrl = process.env.OPENGENI_TEST_DATABASE_APP_URL?.trim();
  if (externalAdminUrl || externalAppUrl) {
    if (!externalAdminUrl || !externalAppUrl) {
      throw new Error(
        "OPENGENI_TEST_DATABASE_ADMIN_URL and OPENGENI_TEST_DATABASE_APP_URL must be set together",
      );
    }
    admin = postgres(externalAdminUrl, { max: 4 });
    client = createDb(externalAppUrl);
    db = client.db;
    return;
  }
  shared = await acquireSharedTestDatabase("sandbox-git-credential-bindings");
  if (!shared) {
    available = false;
    console.warn("[sandbox-git-credential-bindings] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  if (shared) {
    await shared.release();
  } else {
    await admin?.end().catch(() => undefined);
  }
});

async function fixture() {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('binding account') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'binding workspace') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  const scope = { accountId: account!.id, workspaceId: workspace!.id };
  const session = await createSession(db, {
    ...scope,
    initialMessage: "reuse the existing checkout",
    resources: [],
    metadata: {},
    model: "test-model",
    sandboxBackend: "modal",
  });
  return { ...scope, sessionId: session.id };
}

const githubRef = (repositoryId: number) => ({
  provider: "github" as const,
  uri: `https://github.com/acme/repo-${repositoryId}.git`,
  ref: "main",
  repositoryId,
  installationId: 42,
});

const gitlabRef = (repositoryId: number) => ({
  provider: "gitlab" as const,
  uri: `https://gitlab.example.com/acme/repo-${repositoryId}.git`,
  ref: "main",
  repositoryId,
  connectionId: "gitlab-connection",
});

describe("sandbox Git credential binding generations", () => {
  test("identical validation is stable; identity and status changes advance once", async () => {
    if (!available) return;
    const scope = await fixture();
    const first = await upsertSandboxGitCredentialBinding(db, {
      ...scope,
      provider: "github",
      source: "observed_checkout",
      repositoryRefs: [githubRef(1)],
    });
    expect(first.generation).toBe(1);
    expect(first.status).toBe("active");

    const identical = await upsertSandboxGitCredentialBinding(db, {
      ...scope,
      provider: "github",
      source: "observed_checkout",
      repositoryRefs: [githubRef(1)],
    });
    expect(identical.generation).toBe(1);

    const rebound = await upsertSandboxGitCredentialBinding(db, {
      ...scope,
      provider: "github",
      source: "observed_checkout",
      repositoryRefs: [githubRef(2)],
    });
    expect(rebound.generation).toBe(2);

    const revoked = await markSandboxGitCredentialBindingStatus(db, {
      ...scope,
      provider: "github",
      status: "revoked",
      reasonCode: "authorization_revoked",
    });
    expect(revoked?.generation).toBe(3);
    const retry = await markSandboxGitCredentialBindingStatus(db, {
      ...scope,
      provider: "github",
      status: "revoked",
      reasonCode: "authorization_revoked",
    });
    expect(retry?.generation).toBe(3);
  });

  test("final mutation runs only for an exact active generation", async () => {
    if (!available) return;
    const scope = await fixture();
    const binding = await upsertSandboxGitCredentialBinding(db, {
      ...scope,
      provider: "github",
      source: "observed_checkout",
      repositoryRefs: [githubRef(1)],
    });
    let writes = 0;
    expect(
      await withActiveSandboxGitCredentialBindings(
        db,
        { ...scope, expectedGenerations: { github: binding.generation } },
        async () => {
          writes += 1;
        },
      ),
    ).toEqual({ applied: true });
    expect(writes).toBe(1);

    await markSandboxGitCredentialBindingStatus(db, {
      ...scope,
      provider: "github",
      status: "revoked",
      reasonCode: "authorization_revoked",
    });
    expect(
      await withActiveSandboxGitCredentialBindings(
        db,
        { ...scope, expectedGenerations: { github: binding.generation } },
        async () => {
          writes += 1;
        },
      ),
    ).toEqual({ applied: false, reason: "not_active" });
    expect(writes).toBe(1);
  });

  test("a held final write and concurrent revocation serialize on one row lock", async () => {
    if (!available) return;
    const scope = await fixture();
    const binding = await upsertSandboxGitCredentialBinding(db, {
      ...scope,
      provider: "github",
      source: "observed_checkout",
      repositoryRefs: [githubRef(1)],
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => (entered = resolve));
    const write = withActiveSandboxGitCredentialBindings(
      db,
      { ...scope, expectedGenerations: { github: binding.generation } },
      async () => {
        entered();
        await held;
      },
    );
    await didEnter;
    const revoke = markSandboxGitCredentialBindingStatus(db, {
      ...scope,
      provider: "github",
      status: "revoked",
      reasonCode: "authorization_revoked",
    });
    release();
    expect(await write).toEqual({ applied: true });
    expect((await revoke)?.generation).toBe(binding.generation + 1);
  });

  test("multi-provider revocation locks the full set and invalidates once", async () => {
    if (!available) return;
    const scope = await fixture();
    const github = await upsertSandboxGitCredentialBinding(db, {
      ...scope,
      provider: "github",
      source: "observed_checkout",
      repositoryRefs: [githubRef(1)],
    });
    const gitlab = await upsertSandboxGitCredentialBinding(db, {
      ...scope,
      provider: "gitlab",
      source: "observed_checkout",
      repositoryRefs: [gitlabRef(1)],
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => (entered = resolve));
    const write = withActiveSandboxGitCredentialBindings(
      db,
      {
        ...scope,
        expectedGenerations: {
          github: github.generation,
          gitlab: gitlab.generation,
        },
      },
      async () => {
        entered();
        await held;
      },
    );
    await didEnter;
    let invalidations = 0;
    const revoke = markSandboxGitCredentialBindingsStatus(db, {
      ...scope,
      providers: ["gitlab", "github", "gitlab"],
      status: "rebind_required",
      reasonCode: "provider_set_changed",
      mutateSandbox: async () => {
        invalidations += 1;
      },
    });
    release();
    expect(await write).toEqual({ applied: true });
    const revoked = await revoke;
    expect(invalidations).toBe(1);
    expect(revoked.map((binding) => binding.provider)).toEqual(["github", "gitlab"]);
    expect(revoked.map((binding) => binding.generation)).toEqual([
      github.generation + 1,
      gitlab.generation + 1,
    ]);
    expect(revoked.every((binding) => binding.status === "rebind_required")).toBe(true);
  });

  test("FORCE RLS hides another workspace's binding", async () => {
    if (!available) return;
    const a = await fixture();
    const b = await fixture();
    await upsertSandboxGitCredentialBinding(db, {
      ...a,
      provider: "github",
      source: "observed_checkout",
      repositoryRefs: [githubRef(1)],
    });
    expect(await listSandboxGitCredentialBindings(db, a.workspaceId, a.sessionId)).toHaveLength(1);
    expect(await listSandboxGitCredentialBindings(db, b.workspaceId, a.sessionId)).toEqual([]);
  });

  test("migration created a forced workspace policy and checked domains", async () => {
    if (!available) return;
    const [table] = await admin<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select c.relrowsecurity, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema() and c.relname = 'sandbox_git_credential_bindings'`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await admin<{ policyname: string }[]>`
      select policyname from pg_policies
      where schemaname = current_schema() and tablename = 'sandbox_git_credential_bindings'`;
    expect(policies.map((row) => row.policyname)).toContain("workspace_isolation");
  });

  test("migration rejects cross-workspace sessions and empty repository refs", async () => {
    if (!available) return;
    const a = await fixture();
    const b = await fixture();
    let crossWorkspaceError: unknown;
    try {
      await admin`
        insert into sandbox_git_credential_bindings
          (account_id, workspace_id, session_id, provider, source, repository_refs)
        values
          (${a.accountId}, ${a.workspaceId}, ${b.sessionId}, 'github', 'observed_checkout', ${admin.json([githubRef(1)])})
      `;
    } catch (error) {
      crossWorkspaceError = error;
    }
    expect(crossWorkspaceError).toMatchObject({
      constraint_name: "sandbox_git_credential_bindings_workspace_session_fk",
    });

    let emptyRefsError: unknown;
    try {
      await admin`
        insert into sandbox_git_credential_bindings
          (account_id, workspace_id, session_id, provider, source, repository_refs)
        values
          (${a.accountId}, ${a.workspaceId}, ${a.sessionId}, 'github', 'observed_checkout', '[]'::jsonb)
      `;
    } catch (error) {
      emptyRefsError = error;
    }
    expect(emptyRefsError).toMatchObject({
      constraint_name: "sandbox_git_credential_bindings_repository_refs_check",
    });
  });
});
