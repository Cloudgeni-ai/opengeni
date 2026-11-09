import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE } from "@opengeni/contracts/managed-sign-in-methods";
import { createDb, type DbClient } from "@opengeni/db";
import {
  getCanonicalHumanIdentityProjection,
  synchronizeCanonicalHumanLoginBindings,
} from "@opengeni/db/canonical-human-identities";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { organizationAccessPresetPermissions } from "@opengeni/contracts";
import { WORKSPACE_ADMIN_ROLE_PERMISSIONS } from "@opengeni/contracts/api-key-delegation";
import { stampDelegatedHumanAuthorization, type ManagedEmailTransport } from "@opengeni/core";
import { createManagedAuth, hashManagedAuthPassword } from "../src/auth/managed-auth";
import { createApp } from "../src/app";
import { matchAdminRoute } from "../src/auth/admin-step-up";
import { createBetterAuthSessionAdapter } from "../src/auth/managed-auth-session-adapter";
import {
  createSoftwarePasskey,
  softwarePasskeyAssertion,
  softwarePasskeyRegistration,
  type SoftwarePasskey,
} from "./helpers/software-passkey";

const ORIGIN = "https://opengeni.test";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
let shared: SharedTestDatabase | undefined;
let client: DbClient;
let admin: postgres.Sql;

beforeAll(async () => {
  shared = (await acquireSharedTestDatabase("admin-step-up")) ?? undefined;
  if (!shared) throw new Error("Admin step-up integration requires PostgreSQL");
  admin = shared.admin;
  client = createDb(shared.appUrl, { max: 8, rlsStrategy: "force" });
}, 900_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

function runtime(mode: "off" | "required" = "required") {
  const transport: ManagedEmailTransport = {
    sender: "auth@example.test",
    idempotency: { scope: "test:admin-step-up", retentionSeconds: 86400 },
    send: async () => ({ status: "sent" as const, providerMessageId: null }),
  };
  const settings = testSettings({
    databaseUrl: shared!.appUrl,
    productAccessMode: "managed",
    managedAuthSessionSetMode: "legacy",
    publicBaseUrl: ORIGIN,
    betterAuthSecret: "admin-step-up-test-secret-at-least-32-bytes-long",
    managedAuthRequireEmailVerification: false,
    managedAuthPasskeySignUpEnabled: true,
    adminPasskeyStepUp: mode,
    integrationsEnabled: true,
    environmentsEncryptionKey: ENCRYPTION_KEY,
  });
  const auth = createManagedAuth(settings, client.db, transport)!;
  const adapter = createBetterAuthSessionAdapter(auth, client.db);
  const app = createApp({
    settings,
    db: client.db,
    managedAuth: auth,
    managedAuthSessionAdapter: adapter,
    managedEmailTransport: transport,
    bus: new MemoryEventBus(),
    workflowClient: {} as never,
  });
  return { app, adapter };
}
type Runtime = ReturnType<typeof runtime>;

async function call(
  rt: Runtime,
  method: string,
  path: string,
  cookie: string,
  body: unknown = {},
): Promise<Response> {
  return await rt.app.request(path, {
    method,
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

function sessionCookie(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0]!)
    .filter((cookie) => !cookie.endsWith("="))
    .join("; ");
}

async function passkeyPerson(rt: Runtime, name: string) {
  const passkey = createSoftwarePasskey();
  const options = await call(rt, "POST", "/v1/auth/passkey/sign-up/options", "", { name });
  expect(options.status).toBe(200);
  const ceremony = (await options.json()) as { challengeId: string; options: never };
  const response = await call(rt, "POST", "/v1/auth/passkey/sign-up", "", {
    challengeId: ceremony.challengeId,
    response: softwarePasskeyRegistration(passkey, ceremony.options, { origin: ORIGIN }),
  });
  expect(response.status).toBe(200);
  const cookie = sessionCookie(response);
  const [user] = await admin<{ id: string }[]>`
    select user_id as id from auth_sessions where token = ${decodeURIComponent(
      /session_token=([^.;]+)/u.exec(cookie)![1]!,
    )}`;
  return { passkey, cookie, userId: user!.id };
}

async function passwordPerson(rt: Runtime) {
  const userId = crypto.randomUUID();
  await admin`insert into auth_users(id,name,email,email_verified) values(${userId},'Password Admin',${`${userId}@example.test`},true)`;
  await admin`insert into auth_identities(id,user_id,provider_id,account_id,password,created_at,updated_at)
    values(${crypto.randomUUID()},${userId},'credential',${userId},${await hashManagedAuthPassword("fixture-password-123")},now(),now())`;
  await synchronizeCanonicalHumanLoginBindings(client.db, userId);
  const projection = await getCanonicalHumanIdentityProjection(client.db, userId);
  const binding = projection.loginBindings.find((b) => b.providerId === "credential")!;
  const token = crypto.randomUUID();
  await admin`insert into auth_sessions(id,user_id,token,expires_at,identity_id,identity_revision,auth_revision,login_binding_id,login_binding_revision)
    values(${crypto.randomUUID()},${userId},${token},now()+interval '1 hour',${projection.activeIdentity.id},${projection.activeIdentity.identityRevision},${projection.activeIdentity.authRevision},${binding.id},${binding.revision})`;
  const cookie = (await rt.adapter.createLegacySelectedSessionCookies({ token } as never, null))
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  return { userId, cookie };
}

type Organization = { id: string; updatedAt: string };

async function createOrganization(
  rt: Runtime,
  cookie: string,
): Promise<Organization & { workspaceId: string }> {
  const response = await call(rt, "POST", "/v1/organizations", cookie, {
    name: "Step-up Org",
    operationId: crypto.randomUUID(),
  });
  expect(response.status).toBe(201);
  const created = (await response.json()) as { organization: Organization; workspaceId: string };
  return { ...created.organization, workspaceId: created.workspaceId };
}

/** Rename the organization; a success moves its updatedAt on. */
async function rename(rt: Runtime, cookie: string, organization: Organization) {
  const response = await call(rt, "PATCH", `/v1/organizations/${organization.id}`, cookie, {
    name: `Renamed ${crypto.randomUUID().slice(0, 6)}`,
    expectedUpdatedAt: organization.updatedAt,
    operationId: crypto.randomUUID(),
  });
  if (response.status === 200) {
    organization.updatedAt = ((await response.clone().json()) as Organization).updatedAt;
  }
  return response;
}

async function expireStepUps(userId: string) {
  await admin`update auth_verifications set expires_at = now() - interval '1 second'
    where starts_with(identifier, ${`opengeni-admin-step-up:${userId}:`})`;
}

async function stepUp(rt: Runtime, cookie: string, passkey: SoftwarePasskey) {
  const options = await call(rt, "POST", "/v1/auth/passkey/step-up/options", cookie);
  expect(options.status).toBe(200);
  const ceremony = (await options.json()) as { challengeId: string; options: never };
  return await call(rt, "POST", "/v1/auth/passkey/step-up", cookie, {
    challengeId: ceremony.challengeId,
    response: softwarePasskeyAssertion(passkey, ceremony.options, { origin: ORIGIN }),
  });
}

async function refusal(response: Response) {
  expect(response.status).toBe(403);
  return ((await response.json()) as { error: { details?: Record<string, unknown> } }).error;
}

async function stepUpCode(response: Response): Promise<unknown> {
  if (response.status !== 403) return null;
  return ((await response.json()) as { error: { details?: { code?: unknown } } }).error.details
    ?.code;
}

/** Invite a person to the organization and have them accept. */
async function join(
  rt: Runtime,
  owner: { cookie: string },
  person: { userId: string; cookie: string },
  organizationId: string,
) {
  const invited = await call(
    rt,
    "POST",
    `/v1/organizations/${organizationId}/invitations`,
    owner.cookie,
    {
      email: `${person.userId}@example.test`,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      operationId: crypto.randomUUID(),
    },
  );
  expect(invited.status).toBeLessThan(300);
  const { id } = (await invited.json()) as { id: string };
  const listed = await call(rt, "GET", "/v1/organization-invitations", person.cookie);
  const page = (await listed.json()) as { invitations: { id: string; revision: number }[] };
  const invitation = page.invitations.find((item) => item.id === id)!;
  const accepted = await call(
    rt,
    "POST",
    `/v1/organization-invitations/${invitation.id}/accept`,
    person.cookie,
    { expectedRevision: invitation.revision, operationId: crypto.randomUUID() },
  );
  expect(accepted.status).toBe(200);
}

async function sharedWorkspace(rt: Runtime, cookie: string, organizationId: string) {
  const made = await call(rt, "POST", "/v1/workspaces", cookie, {
    accountId: organizationId,
    name: "Shared",
  });
  expect(made.status, await made.clone().text()).toBeLessThan(300);
  const workspace = (await made.json()) as { id?: string; workspace?: { id: string } };
  return (workspace.workspace?.id ?? workspace.id)!;
}

describe("admin passkey step-up", () => {
  test("an owner confirms with a passkey; signing in with one counts, and it lapses", async () => {
    const rt = runtime();
    const owner = await passkeyPerson(rt, "Owner");
    const organization = await createOrganization(rt, owner.cookie);
    // A passkey sign-in a moment ago is a confirmation.
    expect((await rename(rt, owner.cookie, organization)).status).toBe(200);

    await expireStepUps(owner.userId);
    const refused = await refusal(await rename(rt, owner.cookie, organization));
    expect(refused.details).toMatchObject({
      code: ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE,
      passkeyRegistered: true,
      browserRequired: false,
    });
    // Reads never need it.
    expect(
      (await call(rt, "GET", `/v1/organizations/${organization.id}/members`, owner.cookie)).status,
    ).not.toBe(403);

    const confirmed = await stepUp(rt, owner.cookie, owner.passkey);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ confirmed: true });
    expect((await rename(rt, owner.cookie, organization)).status).toBe(200);
  }, 120_000);

  test("someone else's passkey never confirms for this session", async () => {
    const rt = runtime();
    const owner = await passkeyPerson(rt, "Owner Two");
    const other = await passkeyPerson(rt, "Other");
    const organization = await createOrganization(rt, owner.cookie);
    await expireStepUps(owner.userId);
    const options = await call(rt, "POST", "/v1/auth/passkey/step-up/options", owner.cookie);
    const ceremony = (await options.json()) as { challengeId: string; options: never };
    const response = await call(rt, "POST", "/v1/auth/passkey/step-up", owner.cookie, {
      challengeId: ceremony.challengeId,
      response: softwarePasskeyAssertion(other.passkey, ceremony.options, { origin: ORIGIN }),
    });
    expect(response.status).toBe(422);
    await refusal(await rename(rt, owner.cookie, organization));
    // Signed out, nothing can be confirmed.
    expect((await call(rt, "POST", "/v1/auth/passkey/step-up/options", "")).status).toBe(403);
  }, 120_000);

  test("an admin without a passkey is told to add one", async () => {
    const rt = runtime();
    const owner = await passwordPerson(rt);
    const organization = await createOrganization(rt, owner.cookie);
    const refused = await refusal(await rename(rt, owner.cookie, organization));
    expect(refused.details).toMatchObject({
      code: ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE,
      passkeyRegistered: false,
    });
    const options = await call(rt, "POST", "/v1/auth/passkey/step-up/options", owner.cookie);
    expect(options.status).toBe(409);
    expect(await options.json()).toMatchObject({ code: "PASSKEY_NONE_REGISTERED" });
  }, 120_000);

  test("an agent acting as the admin needs the person's recent passkey too", async () => {
    const rt = runtime();
    const owner = await passkeyPerson(rt, "Owner Four");
    const organization = await createOrganization(rt, owner.cookie);
    const asAgent = () => {
      const body = JSON.stringify({
        email: `${crypto.randomUUID()}@example.test`,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        operationId: crypto.randomUUID(),
      });
      // An exact length, as the in-process dispatcher sends, keeps this Request.
      const request = new Request(`${ORIGIN}/v1/organizations/${organization.id}/invitations`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(body.length) },
        body,
      });
      stampDelegatedHumanAuthorization(request, {
        organizationId: organization.id,
        subjectId: `user:${owner.userId}`,
        permissions: organizationAccessPresetPermissions("full"),
        workspaceScope: { kind: "all" },
      });
      return rt.app.fetch(request);
    };
    await expireStepUps(owner.userId);
    const refused = await refusal(await asAgent());
    expect(refused.details).toMatchObject({
      code: ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE,
      browserRequired: true,
    });
    // Once the person confirms in their browser, the agent may go on.
    expect((await stepUp(rt, owner.cookie, owner.passkey)).status).toBe(200);
    const allowed = await asAgent();
    expect(
      allowed.status === 403
        ? ((await allowed.json()) as { error: { details?: { code?: unknown } } }).error.details
            ?.code
        : null,
    ).not.toBe(ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE);
  }, 120_000);

  test("a normal member is never asked, and a deployment can leave it off", async () => {
    const rt = runtime();
    const owner = await passkeyPerson(rt, "Owner Three");
    const member = await passwordPerson(rt);
    const organization = await createOrganization(rt, owner.cookie);
    const invited = await call(
      rt,
      "POST",
      `/v1/organizations/${organization.id}/invitations`,
      owner.cookie,
      {
        email: `${member.userId}@example.test`,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        operationId: crypto.randomUUID(),
      },
    );
    expect(invited.status).toBeLessThan(300);
    const { id } = (await invited.json()) as { id: string };
    // Listing binds the invitation to the invitee, which moves its revision on.
    const listed = await call(rt, "GET", "/v1/organization-invitations", member.cookie);
    const page = (await listed.json()) as { invitations: { id: string; revision: number }[] };
    const invitation = page.invitations.find((item) => item.id === id)!;
    const accepted = await call(
      rt,
      "POST",
      `/v1/organization-invitations/${invitation.id}/accept`,
      member.cookie,
      { expectedRevision: invitation.revision, operationId: crypto.randomUUID() },
    );
    expect(accepted.status).toBe(200);
    const memberResponse = await rename(rt, member.cookie, organization);
    expect(memberResponse.status).toBe(403);
    expect(
      ((await memberResponse.json()) as { error: { details?: { code?: unknown } } }).error.details
        ?.code,
    ).not.toBe(ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE);

    await expireStepUps(owner.userId);
    expect((await rename(runtime("off"), owner.cookie, organization)).status).toBe(200);
  }, 120_000);

  test("the request's own form can't skip it: escaped paths, stray headers, personal keys", async () => {
    const rt = runtime();
    // A password owner is refused too (told to add a passkey), which is all
    // this needs; setup runs where step-up is off.
    const setup = runtime("off");
    const owner = await passwordPerson(rt);
    const organization = await createOrganization(setup, owner.cookie);
    const key = await call(
      setup,
      "POST",
      `/v1/organizations/${organization.id}/personal-api-keys`,
      owner.cookie,
      {
        name: "Step-up key",
        access: {
          preset: "full",
          permissions: organizationAccessPresetPermissions("full"),
          workspaceScope: { kind: "all" },
        },
      },
    );
    expect(key.status).toBe(201);
    const { token } = (await key.json()) as { token: string };

    const renameWith = (path: string, headers: Record<string, string>) =>
      rt.app.request(path, {
        method: "PATCH",
        headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
        body: JSON.stringify({
          name: "Never renamed",
          expectedUpdatedAt: organization.updatedAt,
          operationId: crypto.randomUUID(),
        }),
      });
    // The router decodes the path; the guard matches the same decoded path.
    const escaped = await renameWith(`/v1/%6Frganizations/${organization.id}`, {
      cookie: owner.cookie,
      "sec-fetch-site": "same-origin",
    });
    expect(await stepUpCode(escaped)).toBe(ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE);
    // An Authorization header nothing recognises leaves the cookie in charge.
    const strayBearer = await renameWith(`/v1/organizations/${organization.id}`, {
      cookie: owner.cookie,
      "sec-fetch-site": "same-origin",
      authorization: "Bearer not-a-credential",
    });
    expect(strayBearer.status).not.toBe(200);
    // A personal API key acts as its owner, so it needs their recent passkey.
    const personalKey = await renameWith(`/v1/organizations/${organization.id}`, {
      authorization: `Bearer ${token}`,
    });
    const refused = await refusal(personalKey);
    expect(refused.details).toMatchObject({
      code: ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE,
      browserRequired: true,
    });
    // Billing reads the organization from the query or the body: any one the
    // person administers counts.
    const checkout = await rt.app.request(`/v1/billing/checkout?accountId=${crypto.randomUUID()}`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: owner.cookie,
      },
      body: JSON.stringify({ accountId: organization.id }),
    });
    expect(await stepUpCode(checkout)).toBe(ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE);
  }, 120_000);

  test("shared connections are admin settings; the admin's own are not", async () => {
    const rt = runtime();
    const setup = runtime("off");
    const owner = await passwordPerson(rt);
    const organization = await createOrganization(setup, owner.cookie);
    // A shared workspace (the one made with the organization is the owner's own).
    const workspaceId = await sharedWorkspace(setup, owner.cookie, organization.id);
    const connections = `/v1/workspaces/${workspaceId}/connections`;
    const create = (target: Runtime, ownership?: "personal") =>
      call(target, "POST", connections, owner.cookie, {
        providerDomain: "step-up.example.test",
        kind: "api_key",
        credential: { headers: { "X-Api-Key": "fixture-key" } },
        ...(ownership ? { ownership } : {}),
      });
    const sharedConnection = await create(setup);
    expect(sharedConnection.status, await sharedConnection.clone().text()).toBeLessThan(300);
    const { connection } = (await sharedConnection.json()) as { connection: { id: string } };
    // Shared by default when no ownership is named.
    expect(await stepUpCode(await create(rt))).toBe(ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE);
    expect(
      await stepUpCode(await call(rt, "DELETE", `${connections}/${connection.id}`, owner.cookie)),
    ).toBe(ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE);
    const personal = await create(rt, "personal");
    expect(await stepUpCode(personal)).not.toBe(ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE);
  }, 120_000);

  test("a workspace admin's narrowly scoped personal key is still the admin", async () => {
    const rt = runtime();
    const setup = runtime("off");
    const owner = await passwordPerson(rt);
    const workspaceAdmin = await passwordPerson(rt);
    const organization = await createOrganization(setup, owner.cookie);
    await join(setup, owner, workspaceAdmin, organization.id);
    const workspaceId = await sharedWorkspace(setup, owner.cookie, organization.id);
    const candidates = await call(
      setup,
      "GET",
      `/v1/workspaces/${workspaceId}/member-candidates`,
      owner.cookie,
    );
    const { members } = (await candidates.json()) as {
      members: { organizationMembershipId: string; subjectId: string }[];
    };
    const candidate = members.find(
      (member) => member.subjectId === `user:${workspaceAdmin.userId}`,
    )!;
    const added = await call(setup, "POST", `/v1/workspaces/${workspaceId}/members`, owner.cookie, {
      organizationMembershipId: candidate.organizationMembershipId,
      permissions: [...WORKSPACE_ADMIN_ROLE_PERMISSIONS],
    });
    expect(added.status, await added.clone().text()).toBeLessThan(300);
    const key = await call(
      setup,
      "POST",
      `/v1/organizations/${organization.id}/personal-api-keys`,
      workspaceAdmin.cookie,
      {
        name: "Connections only",
        access: {
          preset: "custom",
          permissions: ["workspace:read", "connections:read", "connections:write"],
          workspaceScope: { kind: "all" },
        },
      },
    );
    expect(key.status, await key.clone().text()).toBe(201);
    const { token } = (await key.json()) as { token: string };
    const body = JSON.stringify({
      providerDomain: "step-up.example.test",
      kind: "api_key",
      credential: { headers: { "X-Api-Key": "fixture-key" } },
    });
    const viaKey = await rt.app.request(`/v1/workspaces/${workspaceId}/connections`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
    expect(await stepUpCode(viaKey)).toBe(ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE);
    // In their browser too.
    const inBrowser = await call(
      rt,
      "POST",
      `/v1/workspaces/${workspaceId}/connections`,
      workspaceAdmin.cookie,
      JSON.parse(body),
    );
    expect(await stepUpCode(inBrowser)).toBe(ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE);
  }, 120_000);

  test("no admin route is answered before the guard runs", () => {
    const { app } = runtime();
    const routes = app.routes as { method: string; path: string; handler: { name?: string } }[];
    const guardAt = routes.findIndex((entry) => entry.handler.name === "adminStepUpMiddleware");
    expect(guardAt).toBeGreaterThan(-1);
    const sample = (path: string) =>
      path.replace(/:[A-Za-z]+(?:\{[^}]*\})?/gu, "5d0f3c1e-2b7a-4c8e-9f61-3a4b5c6d7e8f");
    const early = routes
      .slice(0, guardAt)
      .filter((entry) => entry.method !== "ALL" && !entry.path.endsWith("*"))
      .filter((entry) => matchAdminRoute(entry.method, sample(entry.path)) !== null)
      .map((entry) => `${entry.method} ${entry.path}`);
    expect(early).toEqual([]);
  });
});
