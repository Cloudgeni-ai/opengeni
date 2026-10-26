import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { signDelegatedAccessToken, type Permission } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createApiKey,
  createDb,
  ensureManagedAccessForUserWithOrganizationMemberships,
  listSelfOrganizationMemberships,
  type DbClient,
} from "@opengeni/db";
import { synchronizeCanonicalHumanLoginBindings } from "@opengeni/db/canonical-human-identities";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { registerEnrollmentRoutes } from "../src/routes/enrollments";
import { registerMachineRoutes } from "../src/routes/machines";

// A Member of a shared workspace is a full teammate: signed in as themselves
// with enrollments:read, they connect a machine only they can use, approve or
// decline its pairing code, and change or remove that machine. They cannot
// connect a workspace or organization machine, change one, or reach another
// person's Only me machine. Credentials acting for them without
// enrollments:manage, API keys and services keep the old refusal. Every
// refusal is a sentence, never a raw permission string.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const DELEGATION_SECRET = "member-own-machines-delegation-secret-32-bytes";
const MEMBER_PERMISSIONS: Permission[] = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "enrollments:read",
];

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let app: Hono | null = null;
const sessions = new Map<string, { sessionId: string; email: string; name: string }>();
const createdUsers: string[] = [];
const createdAccounts: string[] = [];

type Human = { userId: string; subject: string; cookie: string };

async function signedInHuman(label: string): Promise<Human> {
  const userId = `${label}-${crypto.randomUUID()}`;
  const email = `${userId}@example.test`;
  createdUsers.push(userId);
  await shared!.admin`
    insert into auth_users (id, name, email, email_verified)
    values (${userId}, ${label}, ${email}, true)`;
  await shared!.admin`
    insert into auth_identities (id, user_id, provider_id, account_id)
    values (${crypto.randomUUID()}, ${userId}, 'credential', ${userId})`;
  const identity = await synchronizeCanonicalHumanLoginBindings(client!.db, userId);
  const sessionId = `session-${crypto.randomUUID()}`;
  await shared!.admin`
    insert into auth_sessions (
      id, user_id, token, expires_at, identity_id, identity_revision, auth_revision
    ) values (
      ${sessionId}, ${userId}, ${crypto.randomUUID()}, now() + interval '1 hour',
      ${identity.identityId}, ${identity.identityRevision}, ${identity.authRevision}
    )`;
  sessions.set(userId, { sessionId, email, name: label });
  return { userId, subject: `user:${userId}`, cookie: `session=${userId}` };
}

/** An organization with one shared workspace, two Members and machines to act on. */
async function teamWithMachines() {
  const owner = await signedInHuman("owner");
  const ownerSession = sessions.get(owner.userId)!;
  await ensureManagedAccessForUserWithOrganizationMemberships(client!.db, {
    userId: owner.userId,
    email: ownerSession.email,
    name: "owner",
    emailVerified: true,
  });
  const [ownerMembership] = await listSelfOrganizationMemberships(client!.db, owner.subject);
  const accountId = ownerMembership!.organizationId;
  createdAccounts.push(accountId);
  const workspaceId = crypto.randomUUID();
  await shared!.admin`
    insert into workspaces (id, account_id, name) values (${workspaceId}, ${accountId}, 'Team')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspaceId}, ${accountId})`;
  await shared!.admin`
    insert into session_tenancy_activations (
      account_id, activation_version, inventory_digest, parity_digest, activated_by
    ) values (${accountId}, 1, ${"5".repeat(64)}, ${"6".repeat(64)}, 'member-own-machines')
    on conflict do nothing`;
  const member = await joinAsMember(accountId, workspaceId, "member");
  const colleague = await joinAsMember(accountId, workspaceId, "colleague");
  const workspaceMachine = await finalizeMachine(
    accountId,
    workspaceId,
    owner.subject,
    "workspace",
  );
  const colleagueMachine = await finalizeMachine(accountId, workspaceId, colleague.subject, "user");
  return { accountId, workspaceId, owner, member, colleague, workspaceMachine, colleagueMachine };
}

async function joinAsMember(
  accountId: string,
  workspaceId: string,
  label: string,
  permissions: Permission[] = MEMBER_PERMISSIONS,
) {
  const human = await signedInHuman(label);
  const personalWorkspaceId = crypto.randomUUID();
  await shared!.admin`
    insert into workspaces (id, account_id, name)
    values (${personalWorkspaceId}, ${accountId}, 'Personal')`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${personalWorkspaceId}, ${accountId})`;
  await shared!.admin`
    insert into organization_memberships (
      account_id, subject_id, role, status, personal_workspace_id, authorization_revision
    ) values (${accountId}, ${human.subject}, 'member', 'active', ${personalWorkspaceId}, 1)`;
  await shared!.admin`
    insert into workspace_memberships (account_id, workspace_id, subject_id, role, permissions)
    values (${accountId}, ${workspaceId}, ${human.subject}, 'member',
      ${shared!.admin.json(permissions)})`;
  return human;
}

async function finalizeMachine(
  accountId: string,
  workspaceId: string,
  subjectId: string,
  scope: "workspace" | "user",
) {
  return await shared!.admin.begin(async (tx) => {
    await tx`select
      set_config('opengeni.account_id', ${accountId}, true),
      set_config('opengeni.workspace_id', ${workspaceId}, true),
      set_config('opengeni.subject_id', ${subjectId}, true)`;
    const [row] = await tx<Array<{ enrollmentId: string; sandboxId: string }>>`
      select enrollment_id as "enrollmentId", sandbox_id as "sandboxId"
      from finalize_scoped_enrollment(
        ${accountId}::uuid, ${workspaceId}::uuid, ${scope},
        ${`ed25519:${crypto.randomUUID()}`}, true, false, 'macos', 'aarch64',
        ${`${scope} machine`}, false
      )`;
    return row!;
  });
}

async function enrollmentRow(enrollmentId: string) {
  const [row] = await shared!.admin<
    Array<{ scope: string; status: string; owner: string | null; policyRevision: number }>
  >`
    select e.authority_scope as scope, e.status, m.subject_id as owner,
      e.operation_policy_revision::int as "policyRevision"
    from enrollments e
    left join organization_memberships m on m.id = e.owner_organization_membership_id
    where e.id = ${enrollmentId}`;
  return row!;
}

function call(auth: string, method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = auth.startsWith("Bearer ")
    ? { authorization: auth }
    : { cookie: auth };
  if (body !== undefined) headers["content-type"] = "application/json";
  return Promise.resolve(
    app!.request(`http://x${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function refusal(response: Response, status: number): Promise<string> {
  expect(response.status).toBe(status);
  const text = await response.text();
  expect(text).not.toContain("missing permission");
  return text;
}

async function startPairing(workspaceId: string, label: string) {
  const response = await call("Bearer none", "POST", "/v1/enrollments/device/start", {
    publicKey: `ed25519:${label}-${crypto.randomUUID()}`,
    os: "macos",
    arch: "aarch64",
    machineName: label,
    canOfferDisplay: true,
    requestsScreenControl: false,
    workspaceId,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { deviceCode: string; userCode: string };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("api-member-own-machines");
  if (!shared) {
    if (requireRealDatabase) throw new Error("PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl);
  app = new Hono();
  const deps = {
    db: client.db,
    bus: new MemoryEventBus() as never,
    settings: testSettings({
      productAccessMode: "managed",
      delegationSecret: DELEGATION_SECRET,
      sandboxSelfhostedEnabled: true,
      enrollmentSigningSecret: "member-own-machines-enrollment-signing-secret",
      selfhostedNatsUrl: "nats://control.example:4222",
      selfhostedRelayUrl: "wss://relay.example",
      publicBaseUrl: "https://app.opengeni.example/",
    }),
    managedAuth: {
      api: {
        getSession: async (input: { headers: Headers }) => {
          const userId = /session=([^;]+)/.exec(input.headers.get("cookie") ?? "")?.[1];
          const session = userId ? sessions.get(userId) : undefined;
          return session
            ? {
                headers: new Headers(),
                response: {
                  session: { id: session.sessionId },
                  user: { id: userId, email: session.email, name: session.name },
                },
              }
            : { headers: new Headers(), response: null };
        },
      },
    } as never,
    schedulePromptPostCommit: () => undefined,
  } as unknown as ApiRouteDeps;
  registerEnrollmentRoutes(app, deps);
  registerMachineRoutes(app, deps);
}, 180_000);

afterAll(async () => {
  if (shared) {
    for (const accountId of createdAccounts) {
      await shared.admin`delete from managed_accounts where id = ${accountId}`.catch(
        () => undefined,
      );
    }
    for (const userId of createdUsers) {
      await shared.admin`delete from auth_users where id = ${userId}`.catch(() => undefined);
    }
  }
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("a Member connects and changes their own Only me machine", () => {
  test("connect command: Only me works, This workspace is refused with a sentence", async () => {
    if (!shared || !client || !app) return;
    const team = await teamWithMachines();
    const base = `/v1/workspaces/${team.workspaceId}/enrollments`;

    const minted = await call(team.member.cookie, "POST", `${base}/token`, { scope: "user" });
    expect(minted.status).toBe(201);
    const mint = (await minted.json()) as { token: string; scope: string };
    expect(mint.scope).toBe("user");
    const exchanged = await call("Bearer none", "POST", "/v1/enrollments/token/exchange", {
      token: mint.token,
      publicKey: `ed25519:${crypto.randomUUID()}`,
      os: "macos",
      arch: "aarch64",
      machineName: "member-mac",
      canOfferDisplay: true,
      requestsScreenControl: false,
    });
    expect(exchanged.status).toBe(201);
    const { credentials } = (await exchanged.json()) as { credentials: { agentId: string } };
    expect(await enrollmentRow(credentials.agentId)).toMatchObject({
      scope: "user",
      status: "active",
      owner: team.member.subject,
    });

    expect(
      await refusal(
        await call(team.member.cookie, "POST", `${base}/token`, { scope: "workspace" }),
        403,
      ),
    ).toContain("Only workspace admins can connect a machine for the whole workspace.");
    // Omitting the scope keeps the legacy workspace command, so it is refused too.
    await refusal(await call(team.member.cookie, "POST", `${base}/token`, {}), 403);

    // The member sees their own machine and the workspace one, never the colleague's.
    const listed = await call(team.member.cookie, "GET", base);
    expect(listed.status).toBe(200);
    const ids = ((await listed.json()) as { enrollments: Array<{ id: string }> }).enrollments.map(
      (enrollment) => enrollment.id,
    );
    expect(ids).toContain(credentials.agentId);
    expect(ids).toContain(team.workspaceMachine.enrollmentId);
    expect(ids).not.toContain(team.colleagueMachine.enrollmentId);
  }, 180_000);

  test("pairing code: Only me is approved, workspace and organization are refused, deny works", async () => {
    if (!shared || !client || !app) return;
    const team = await teamWithMachines();
    const approve = `/v1/workspaces/${team.workspaceId}/enrollments/device/approve`;

    const mine = await startPairing(team.workspaceId, "member-laptop");
    for (const [scope, message] of [
      ["workspace", "Only workspace admins can connect a machine for the whole workspace."],
      [
        "organization",
        "Only organization admins can connect a machine for the whole organization.",
      ],
    ] as const) {
      expect(
        await refusal(
          await call(team.member.cookie, "POST", approve, { userCode: mine.userCode, scope }),
          403,
        ),
      ).toContain(message);
    }
    const approved = await call(team.member.cookie, "POST", approve, { userCode: mine.userCode });
    expect(approved.status).toBe(201);
    const { enrollmentId } = (await approved.json()) as { enrollmentId: string };
    expect(await enrollmentRow(enrollmentId)).toMatchObject({
      scope: "user",
      owner: team.member.subject,
    });

    const declined = await startPairing(team.workspaceId, "unknown-box");
    const denied = await call(
      team.member.cookie,
      "POST",
      `/v1/workspaces/${team.workspaceId}/enrollments/device/deny`,
      { userCode: declined.userCode },
    );
    expect(denied.status).toBe(200);
    expect(await denied.json()).toEqual({ denied: true });
  }, 180_000);

  test("per-machine changes: own machine yes, workspace machine refused, colleague's unreachable", async () => {
    if (!shared || !client || !app) return;
    const team = await teamWithMachines();
    const own = await finalizeMachine(
      team.accountId,
      team.workspaceId,
      team.member.subject,
      "user",
    );
    const machines = `/v1/workspaces/${team.workspaceId}/machines`;
    const policy = { memoryMaxBytes: 536_870_912, memoryHighBytes: null, expectedRevision: 0 };

    const updated = await call(
      team.member.cookie,
      "PATCH",
      `${machines}/${own.enrollmentId}/operation-policy`,
      policy,
    );
    expect(updated.status).toBe(200);
    expect((await enrollmentRow(own.enrollmentId)).policyRevision).toBe(1);
    // The other changes reach their own checks on the Member's machine (it has
    // no live agent here), past the permission refusal.
    for (const [method, action, body] of [
      ["POST", "screen-control", {}],
      ["POST", "update", {}],
      ["POST", "privacy-settings", { pane: "accessibility" }],
    ] as const) {
      const response = await call(
        team.member.cookie,
        method,
        `${machines}/${own.enrollmentId}/${action}`,
        body,
      );
      expect([403, 404], `${action}: ${await response.clone().text()}`).not.toContain(
        response.status,
      );
    }
    // Who can use a machine stays with workspace machine managers, even one's own.
    expect(
      await refusal(
        await call(team.member.cookie, "POST", `${machines}/${own.enrollmentId}/audience/preview`, {
          audience: "workspace",
        }),
        403,
      ),
    ).toContain("Only workspace admins can change who can use a machine.");

    expect(
      await refusal(
        await call(
          team.member.cookie,
          "PATCH",
          `${machines}/${team.workspaceMachine.enrollmentId}/operation-policy`,
          policy,
        ),
        403,
      ),
    ).toContain("Only workspace admins can change a machine shared with the whole workspace.");
    for (const action of ["screen-control", "update"]) {
      await refusal(
        await call(
          team.member.cookie,
          "POST",
          `${machines}/${team.workspaceMachine.enrollmentId}/${action}`,
          {},
        ),
        403,
      );
    }
    await refusal(
      await call(
        team.member.cookie,
        "POST",
        `${machines}/${team.workspaceMachine.enrollmentId}/privacy-settings`,
        { pane: "accessibility" },
      ),
      403,
    );
    expect(
      await refusal(
        await call(
          team.member.cookie,
          "POST",
          `${machines}/${team.workspaceMachine.enrollmentId}/audience/preview`,
          { audience: "only_me" },
        ),
        403,
      ),
    ).toContain("Only workspace admins");
    expect(
      await refusal(
        await call(
          team.member.cookie,
          "POST",
          `/v1/workspaces/${team.workspaceId}/enrollments/${team.workspaceMachine.enrollmentId}/revoke`,
          {},
        ),
        403,
      ),
    ).toContain("Only workspace admins");
    expect(await enrollmentRow(team.workspaceMachine.enrollmentId)).toMatchObject({
      status: "active",
      policyRevision: 0,
    });

    // Someone else's Only me machine is not even visible: nothing changes.
    const colleague = team.colleagueMachine.enrollmentId;
    expect(
      (await call(team.member.cookie, "PATCH", `${machines}/${colleague}/operation-policy`, policy))
        .status,
    ).toBe(404);
    expect(
      (
        await call(
          team.member.cookie,
          "POST",
          `/v1/workspaces/${team.workspaceId}/enrollments/${colleague}/revoke`,
          {},
        )
      ).status,
    ).toBe(404);
    expect(await enrollmentRow(colleague)).toMatchObject({
      status: "active",
      policyRevision: 0,
      owner: team.colleague.subject,
    });

    const removed = await call(
      team.member.cookie,
      "POST",
      `/v1/workspaces/${team.workspaceId}/enrollments/${own.enrollmentId}/revoke`,
      {},
    );
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { revoked: boolean }).revoked).toBe(true);
    expect((await enrollmentRow(own.enrollmentId)).status).toBe("revoked");
  }, 180_000);

  test("credentials acting for the Member, API keys and services keep the old refusal", async () => {
    if (!shared || !client || !app) return;
    const team = await teamWithMachines();
    const own = await finalizeMachine(
      team.accountId,
      team.workspaceId,
      team.member.subject,
      "user",
    );
    const delegated = async (
      principalKind: "human_session" | "service",
      subjectId = team.member.subject,
    ) =>
      `Bearer ${await signDelegatedAccessToken(DELEGATION_SECRET, {
        accountId: team.accountId,
        workspaceId: team.workspaceId,
        subjectId,
        permissions: MEMBER_PERMISSIONS,
        principalKind,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })}`;
    const keyToken = `ogk_${crypto.randomUUID().replaceAll("-", "")}`;
    await createApiKey(client.db, {
      accountId: team.accountId,
      workspaceId: team.workspaceId,
      name: "Machine reader",
      prefix: keyToken.slice(0, 14),
      keyHash: await sha256Hex(keyToken),
      permissions: MEMBER_PERMISSIONS,
    });
    const callers = {
      delegatedMember: await delegated("human_session"),
      service: await delegated("service", "service:machine-test"),
      apiKey: `Bearer ${keyToken}`,
    };
    for (const [name, auth] of Object.entries(callers)) {
      const minted = await call(
        auth,
        "POST",
        `/v1/workspaces/${team.workspaceId}/enrollments/token`,
        { scope: "user" },
      );
      expect(minted.status, name).toBe(403);
      expect(await minted.text(), name).not.toContain("missing permission");
      const pairing = await startPairing(team.workspaceId, `${name}-box`);
      const approved = await call(
        auth,
        "POST",
        `/v1/workspaces/${team.workspaceId}/enrollments/device/approve`,
        { userCode: pairing.userCode, scope: "user" },
      );
      expect(approved.status, name).toBe(403);
      const denied = await call(
        auth,
        "POST",
        `/v1/workspaces/${team.workspaceId}/enrollments/device/deny`,
        { userCode: pairing.userCode },
      );
      expect(denied.status, name).toBe(403);
    }
    // Acting for the Member does not let a read-only delegation change their machine.
    const changed = await call(
      callers.delegatedMember,
      "PATCH",
      `/v1/workspaces/${team.workspaceId}/machines/${own.enrollmentId}/operation-policy`,
      { memoryMaxBytes: null, memoryHighBytes: null, expectedRevision: 0 },
    );
    expect(changed.status).toBe(403);
    expect(await changed.text()).toContain("Only you can change your own machine");
    expect((await enrollmentRow(own.enrollmentId)).policyRevision).toBe(0);

    // Someone who can't see the workspace's machines gets a sentence too.
    const viewer = await joinAsMember(team.accountId, team.workspaceId, "viewer", [
      "workspace:read",
      "sessions:read",
    ]);
    expect(
      await refusal(
        await call(viewer.cookie, "POST", `/v1/workspaces/${team.workspaceId}/enrollments/token`, {
          scope: "user",
        }),
        403,
      ),
    ).toContain("You don't have access to this workspace's machines.");
  }, 180_000);
});
