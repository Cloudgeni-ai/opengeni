// Vault REST routes (§10B.1.10) through the composed app: CRUD, the error
// envelope and statuses, Only-me privacy (AX-7) and reveal authority (AX-5):
// people need `secrets:use` and a human session, API keys need the literal
// `secrets:read`, agents are refused, and each reveal writes one audit row.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import {
  createApiKey,
  createDb,
  createSession,
  createWorkspace,
  ensureManagedAccessForUser,
  type DbClient,
} from "@opengeni/db";
import type { SessionWorkflowClient } from "@opengeni/core";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { Hono } from "hono";
import { createApp } from "../src/app";

const SECRET = "vault-routes-test-secret";
const ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

const settings = testSettings({
  productAccessMode: "managed",
  delegationSecret: SECRET,
  environmentsEncryptionKey: ENCRYPTION_KEY,
});

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient;

setDefaultTimeout(120_000);

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-vault-routes");
  if (!shared) {
    if (requireRealDatabase) {
      throw new Error("PostgreSQL test database unavailable while OPENGENI_REQUIRE_REAL_DB=1");
    }
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

let cachedApp: Hono | null = null;
function app(): Hono {
  const noop = async () => undefined;
  cachedApp ??= createApp({
    settings,
    db: client.db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
  });
  return cachedApp;
}

const PEOPLE_PERMISSIONS: Permission[] = [
  "sessions:read",
  "secrets:list",
  "secrets:write",
  "secrets:use",
];

type Grant = { accountId: string; workspaceId: string; subjectId: string };

async function bearer(
  grant: Grant,
  permissions: Permission[],
  principalKind: "human_session" | "service" = "human_session",
): Promise<string> {
  return `Bearer ${await signDelegatedAccessToken(SECRET, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    permissions,
    principalKind,
    exp: Math.floor(Date.now() / 1000) + 3_600,
  })}`;
}

async function fixture() {
  const admin = shared!.admin;
  const userId = `vault-routes-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(client.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Vault routes owner",
  });
  const accountId = access.workspaceGrants[0]!.accountId;
  const workspace = await createWorkspace(client.db, { accountId, name: "Vault routes" });
  const workspaceId = workspace.id;
  const person = async (label: string, role: "member" | "admin", permissions: Permission[]) => {
    const subjectId = `user:vault-routes-${label}-${crypto.randomUUID()}`;
    const [personal] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${accountId}::uuid, 'Personal')
      returning id::text as id`;
    await admin`
      insert into organization_memberships (account_id, subject_id, status, role, personal_workspace_id)
      values (${accountId}::uuid, ${subjectId}, 'active', ${role}, ${personal!.id}::uuid)`;
    await admin`
      insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
      values (${accountId}::uuid, ${workspaceId}::uuid, ${subjectId}, ${role === "admin" ? "admin" : "member"},
        ${JSON.stringify(permissions)}::text::jsonb)`;
    return { accountId, workspaceId, subjectId };
  };
  const member = await person("member", "member", PEOPLE_PERMISSIONS);
  const viewer = await person("viewer", "member", ["sessions:read", "secrets:list"]);
  const orgAdmin = await person("admin", "admin", PEOPLE_PERMISSIONS);
  return { accountId, workspaceId, member, viewer, orgAdmin };
}

async function call(
  method: string,
  path: string,
  authorization: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const response = await app().request(path, {
    method,
    headers: {
      Authorization: authorization,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

describe("vault routes", () => {
  test("CRUD, error envelope, Only-me privacy and reveal authority", async () => {
    if (!available) return;
    const f = await fixture();
    const base = `/v1/workspaces/${f.workspaceId}`;
    const asMember = await bearer(f.member, PEOPLE_PERMISSIONS);
    const asAdmin = await bearer(f.orgAdmin, PEOPLE_PERMISSIONS);
    const asViewer = await bearer(f.viewer, ["sessions:read", "secrets:list"]);

    // Create a workspace vault and an Only-me vault, each with one item.
    const team = await call("POST", `${base}/vaults`, asMember, {
      name: "Team",
      ownerKind: "workspace",
    });
    expect(team.status).toBe(201);
    expect(team.json).toMatchObject({ name: "Team", ownerKind: "workspace" });
    const mine = await call("POST", `${base}/vaults`, asMember, {
      name: "Mine",
      ownerKind: "user",
    });
    expect(mine.status).toBe(201);
    const conflict = await call("POST", `${base}/vaults`, asMember, {
      name: "team",
      ownerKind: "workspace",
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toMatchObject({ error: "vault_name_conflict" });
    // Organization vaults need account:admin.
    const orgDenied = await call("POST", `${base}/vaults`, asMember, {
      name: "Org",
      ownerKind: "organization",
    });
    expect(orgDenied.status).toBe(403);

    const created = await call("POST", `${base}/vaults/${team.json.id}/items`, asMember, {
      type: "api_key",
      name: "STRIPE_KEY",
      fields: [{ name: "value", value: "sk_test_route" }],
    });
    expect(created.status).toBe(201);
    const teamItem = created.json;
    const teamField = teamItem.fields[0];
    const privateItem = await call("POST", `${base}/vaults/${mine.json.id}/items`, asMember, {
      type: "api_key",
      name: "PRIVATE_KEY",
      fields: [{ name: "value", value: "only-me-value" }],
    });
    expect(privateItem.status).toBe(201);
    const privateField = privateItem.json.fields[0];

    // Lists and reads.
    const listed = await call("GET", `${base}/vaults`, asMember);
    expect(listed.status).toBe(200);
    expect(listed.json.vaults.map((vault: { name: string }) => vault.name).sort()).toEqual([
      "Mine",
      "Team",
    ]);
    const items = await call("GET", `${base}/vaults/${team.json.id}/items`, asMember);
    expect(items.status).toBe(200);
    expect(items.json.items.map((item: { name: string }) => item.name)).toEqual(["STRIPE_KEY"]);
    expect(JSON.stringify(items.json)).not.toContain("sk_test_route");

    // AX-7: the admin sees neither the Only-me vault nor its item.
    const adminList = await call("GET", `${base}/vaults`, asAdmin);
    expect(adminList.json.vaults.map((vault: { id: string }) => vault.id)).not.toContain(
      mine.json.id,
    );
    expect((await call("GET", `${base}/vaults/${mine.json.id}`, asAdmin)).status).toBe(404);
    expect((await call("GET", `${base}/vaults/${mine.json.id}/items`, asAdmin)).status).toBe(404);
    expect(
      (await call("GET", `${base}/vaults/${mine.json.id}/items/${privateItem.json.id}`, asAdmin))
        .status,
    ).toBe(404);

    const revealPath = (vaultId: string, itemId: string, fieldId: string) =>
      `${base}/vaults/${vaultId}/items/${itemId}/fields/${fieldId}/reveal`;
    const audits = async (itemId: string) =>
      (
        await shared!.admin<{ count: number }[]>`
          select count(*)::int as count from audit_events
          where action = 'vault.field.revealed' and target_id = ${itemId}`
      )[0]!.count;

    // AX-5: a member reveals (one audit row per reveal).
    const revealed = await call(
      "POST",
      revealPath(team.json.id, teamItem.id, teamField.id),
      asMember,
      {},
    );
    expect(revealed.status).toBe(200);
    expect(revealed.json).toMatchObject({ value: "sk_test_route", encoding: "utf8", totp: null });
    expect(await audits(teamItem.id)).toBe(1);
    await call("POST", revealPath(team.json.id, teamItem.id, teamField.id), asMember, {});
    expect(await audits(teamItem.id)).toBe(2);
    // The owner reveals their Only-me value; the admin cannot.
    const own = await call(
      "POST",
      revealPath(mine.json.id, privateItem.json.id, privateField.id),
      asMember,
      {},
    );
    expect(own.json.value).toBe("only-me-value");
    const adminReveal = await call(
      "POST",
      revealPath(mine.json.id, privateItem.json.id, privateField.id),
      asAdmin,
      {},
    );
    expect(adminReveal.status).toBe(404);
    expect(JSON.stringify(adminReveal.json)).not.toContain("only-me-value");
    // A viewer without secrets:use gets 403.
    const viewerReveal = await call(
      "POST",
      revealPath(team.json.id, teamItem.id, teamField.id),
      asViewer,
      {},
    );
    expect(viewerReveal.status).toBe(403);
    // A service token is refused, even with secrets:use (agents never reveal;
    // signing an agent_attempt token needs a live attempt, covered by E2E).
    const asAgent = await bearer(
      { ...f.member, subjectId: "service:vault-routes-test" },
      PEOPLE_PERMISSIONS,
      "service",
    );
    const agentReveal = await call(
      "POST",
      revealPath(team.json.id, teamItem.id, teamField.id),
      asAgent,
      {},
    );
    expect(agentReveal.status).toBe(403);
    expect(await audits(teamItem.id)).toBe(2);

    // API keys need the literal secrets:read; secrets:use is not enough.
    const apiKey = async (permissions: Permission[]) => {
      const token = `vault-routes-${crypto.randomUUID()}`;
      await createApiKey(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        name: "vault routes",
        prefix: "vault-routes",
        keyHash: createHash("sha256").update(token).digest("hex"),
        permissions,
      });
      return `Bearer ${token}`;
    };
    const withoutRead = await apiKey(["secrets:list", "secrets:use"]);
    expect(
      (await call("POST", revealPath(team.json.id, teamItem.id, teamField.id), withoutRead, {}))
        .status,
    ).toBe(403);
    const withRead = await apiKey(["secrets:list", "secrets:read"]);
    const keyReveal = await call(
      "POST",
      revealPath(team.json.id, teamItem.id, teamField.id),
      withRead,
      {},
    );
    expect(keyReveal.status).toBe(200);
    expect(keyReveal.json.value).toBe("sk_test_route");
    expect(await audits(teamItem.id)).toBe(3);
    // Legacy names still list (alias), and never reveal.
    const legacy = await apiKey(["variable-sets:read", "variable-sets:use"]);
    expect((await call("GET", `${base}/vaults`, legacy)).status).toBe(200);
    expect(
      (await call("POST", revealPath(team.json.id, teamItem.id, teamField.id), legacy, {})).status,
    ).toBe(403);

    // Update, history and restore of a field version.
    const updated = await call(
      "PATCH",
      `${base}/vaults/${team.json.id}/items/${teamItem.id}`,
      asMember,
      {
        expectedGeneration: teamItem.generation,
        fields: [{ fieldId: teamField.id, name: "value", value: "sk_test_rotated" }],
      },
    );
    expect(updated.status).toBe(200);
    const stale = await call(
      "PATCH",
      `${base}/vaults/${team.json.id}/items/${teamItem.id}`,
      asMember,
      {
        expectedGeneration: teamItem.generation,
        name: "STALE",
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe("vault_generation_conflict");
    const versions = await call(
      "GET",
      `${base}/vaults/${team.json.id}/items/${teamItem.id}/fields/${teamField.id}/versions`,
      asMember,
    );
    expect(versions.status).toBe(200);
    expect(versions.json.versions.map((row: { version: number }) => row.version).sort()).toEqual([
      1, 2,
    ]);
    const restored = await call(
      "POST",
      `${base}/vaults/${team.json.id}/items/${teamItem.id}/fields/${teamField.id}/restore`,
      asMember,
      { version: 1 },
    );
    expect(restored.status).toBe(200);
    const afterRestore = await call(
      "POST",
      revealPath(team.json.id, teamItem.id, teamField.id),
      asMember,
      {},
    );
    expect(afterRestore.json).toMatchObject({ value: "sk_test_route", version: 3 });

    // The item must live in the vault the path names.
    expect(
      (await call("GET", `${base}/vaults/${mine.json.id}/items/${teamItem.id}`, asMember)).status,
    ).toBe(404);

    // Archive, restore, delete; deleting a vault needs its exact name.
    expect(
      (await call("DELETE", `${base}/vaults/${team.json.id}/items/${teamItem.id}`, asMember))
        .status,
    ).toBe(204);
    expect(
      (await call("POST", `${base}/vaults/${team.json.id}/items/${teamItem.id}/restore`, asMember))
        .status,
    ).toBe(200);
    const wrongName = await call("DELETE", `${base}/vaults/${team.json.id}`, asMember, {
      confirmName: "nope",
    });
    expect(wrongName.status).toBe(422);
    expect(
      (await call("DELETE", `${base}/vaults/${team.json.id}`, asMember, { confirmName: "Team" }))
        .status,
    ).toBe(204);
    expect((await call("GET", `${base}/vaults/${team.json.id}`, asMember)).status).toBe(404);

    // Viewers list but cannot write.
    expect((await call("GET", `${base}/vaults`, asViewer)).status).toBe(200);
    expect(
      (await call("POST", `${base}/vaults`, asViewer, { name: "Viewer", ownerKind: "workspace" }))
        .status,
    ).toBe(403);
  });

  test("session vault policy: a child cannot widen its parent (422) and the view shows the narrowing", async () => {
    if (!available) return;
    const f = await fixture();
    const base = `/v1/workspaces/${f.workspaceId}`;
    const permissions: Permission[] = [
      ...PEOPLE_PERMISSIONS,
      "sessions:control",
      "sessions:create",
    ];
    await shared!.admin`
      update workspace_memberships set permissions = ${JSON.stringify(permissions)}::text::jsonb
      where workspace_id = ${f.workspaceId}::uuid and subject_id = ${f.member.subjectId}`;
    const asMember = await bearer(f.member, permissions);
    const a = await call("POST", `${base}/vaults`, asMember, { name: "A", ownerKind: "workspace" });
    const b = await call("POST", `${base}/vaults`, asMember, { name: "B", ownerKind: "workspace" });
    const session = (parentSessionId?: string) =>
      createSession(client.db, {
        accountId: f.accountId,
        workspaceId: f.workspaceId,
        initialMessage: "vault policy",
        resources: [],
        metadata: {},
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sandboxBackend: "none",
        createdBy: { kind: "subject", subjectId: f.member.subjectId },
        subjectId: f.member.subjectId,
        ...(parentSessionId ? { parentSessionId } : {}),
      });
    const parent = await session();
    const child = await session(parent.id);
    const put = (sessionId: string, policy: unknown) =>
      call("PUT", `${base}/sessions/${sessionId}/vault-policy`, asMember, { policy });

    const narrowed = await put(parent.id, { mode: "selected", vaultIds: [a.json.id] });
    expect(narrowed.status).toBe(200);
    const outside = await put(child.id, { mode: "selected", vaultIds: [b.json.id] });
    expect(outside.status).toBe(422);
    expect(outside.json).toMatchObject({
      error: "vault_policy_outside_parent",
      details: { outsideVaultIds: [b.json.id] },
    });
    expect((await put(child.id, { mode: "all" })).status).toBe(422);
    expect((await put(child.id, { mode: "selected", vaultIds: [a.json.id] })).status).toBe(200);

    const view = await call("GET", `${base}/sessions/${child.id}/secrets`, asMember);
    expect(view.status).toBe(200);
    expect(view.json).toMatchObject({ narrowedBySessionId: parent.id });
    expect(JSON.stringify(view.json)).toContain(a.json.id);

    // Session creation intersects the request policy with agent.vaultPolicy.
    const created = await call("POST", `${base}/sessions`, asMember, {
      initialMessage: "intersect vault policies",
      sandboxBackend: "none",
      tools: [],
      resources: [],
      vaultPolicy: { mode: "selected", vaultIds: [a.json.id, b.json.id.toUpperCase()] },
      agent: { vaultPolicy: { mode: "selected", vaultIds: [b.json.id] } },
    });
    expect(created.status).toBe(202);
    const [stored] = await shared!.admin<{ vault_policy: unknown }[]>`
      select vault_policy from sessions where id = ${created.json.id}::uuid`;
    expect(stored!.vault_policy).toEqual({ mode: "selected", vaultIds: [b.json.id] });

    // Without secrets:use the policy cannot change.
    const noUse = await bearer(f.member, ["sessions:read", "sessions:control", "secrets:list"]);
    expect(
      (
        await call("PUT", `${base}/sessions/${parent.id}/vault-policy`, noUse, {
          policy: { mode: "all" },
        })
      ).status,
    ).toBe(403);
  });
});
