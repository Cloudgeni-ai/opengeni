import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { HTTPException } from "hono/http-exception";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import {
  bootstrapWorkspace,
  createDb,
  disconnectTeamsBot,
  getTeamsActor,
  getTeamsInstallation,
} from "@opengeni/db";
import type { AccessGrant } from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { completeTeamsSetup, startTeamsSetupSignIn } from "../src/integrations/teams-bot";
import { mintTeamsProof } from "../src/integrations/teams-protocol";
import { TEAMS_ADMIN_ROLE_IDS } from "../src/integrations/teams-admin-proof";

const STATE_SECRET = "teams-self-serve-state";
const CLIENT_ID = "d3f8842e-a4b7-483d-a9a9-551c547911aa";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const value = await acquireSharedTestDatabase("teams-self-serve-setup");
  if (!value) throw new Error("Teams self-serve setup requires real PostgreSQL");
  shared = value;
  client = createDb(shared.appUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
});

type Person = { grant: AccessGrant; subject: string };
async function person(): Promise<Person> {
  const subject = `user:teams-setup:${crypto.randomUUID()}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "teams-setup-test",
    accountExternalId: crypto.randomUUID(),
    accountName: "Teams setup",
    workspaceExternalSource: "teams-setup-test",
    workspaceExternalId: crypto.randomUUID(),
    workspaceName: "Shared",
    subjectId: subject,
  });
  return { grant: access.workspaceGrants[0]!, subject };
}

/** A fake Microsoft identity platform that signs ID tokens for chosen claims. */
function microsoft() {
  let claims: Record<string, unknown> = {};
  let issuerTenant: string | null = null;
  const tokenRequests: URLSearchParams[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/discovery/v2.0/keys")) return Response.json({ keys: [jwk] });
    const tenant = /login\.microsoftonline\.com\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(url)?.[1];
    if (!tenant) return new Response("not found", { status: 404 });
    const body = new URLSearchParams(String(init?.body));
    tokenRequests.push(body);
    const token = await new SignJWT({ ver: "2.0", tid: tenant, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://login.microsoftonline.com/${issuerTenant ?? tenant}/v2.0`)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    return Response.json({ id_token: token });
  }) as typeof fetch;
  return {
    fetchImpl,
    tokenRequests,
    signInAs(next: Record<string, unknown>, issuer: string | null = null) {
      claims = next;
      issuerTenant = issuer;
    },
  };
}

function deps(
  provider: ReturnType<typeof microsoft>,
  overrides: Parameters<typeof testSettings>[0] = {},
): ApiRouteDeps {
  const noop = async () => undefined;
  return {
    db: client.db,
    settings: testSettings({
      databaseUrl: shared.appUrl,
      sandboxBackend: "none",
      productAccessMode: "managed",
      teamsBotClientId: CLIENT_ID,
      teamsBotClientSecret: "bot-secret",
      teamsBotTenantId: "597bfa71-7575-4506-93d7-dc147bddfb22",
      teamsBotEnabled: true,
      teamsBotSelfServeSetupEnabled: true,
      integrationsStateSecret: STATE_SECRET,
      webBaseUrl: "https://app.example.test",
      ...overrides,
    }),
    bus: new MemoryEventBus(),
    workflowClient: { wakeSessionWorkflow: noop, requestSessionWorkflowWakeDispatch: noop },
    teamsAdminSignInFetch: provider.fetchImpl,
  } as unknown as ApiRouteDeps;
}

function setupProof(tenantId: string, actorId: string) {
  return mintTeamsProof(STATE_SECRET, {
    purpose: "setup",
    tenantId,
    actorId,
    workspaceId: null,
    generation: null,
  });
}

async function refusal(promise: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HTTPException) return { status: error.status, message: error.message };
    throw error;
  }
  throw new Error("expected refusal");
}

async function adminSignIn(
  provider: ReturnType<typeof microsoft>,
  d: ApiRouteDeps,
  who: Person,
  setupToken: string,
  claims: { oid: string; wids?: string[]; tid?: string },
  issuer: string | null = null,
) {
  const { authorizationUrl } = await startTeamsSetupSignIn(d, who.grant, setupToken);
  const url = new URL(authorizationUrl!);
  provider.signInAs({ nonce: url.searchParams.get("nonce"), ...claims }, issuer);
  return { code: "microsoft-code", state: url.searchParams.get("state")! };
}

describe("Teams self-serve setup", () => {
  test("a tenant administrator connects an unconnected organization and is linked", async () => {
    const provider = microsoft();
    const d = deps(provider);
    const admin = await person();
    const tenantId = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    const setupToken = setupProof(tenantId, actorId);
    const { authorizationUrl } = await startTeamsSetupSignIn(d, admin.grant, setupToken);
    const url = new URL(authorizationUrl!);
    expect(`${url.origin}${url.pathname}`).toBe(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
    );
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example.test/teams/connect");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    const microsoftResult = await adminSignIn(provider, d, admin, setupToken, {
      oid: actorId,
      wids: [TEAMS_ADMIN_ROLE_IDS.teamsAdministrator],
    });
    const status = await completeTeamsSetup(d, admin.grant, {
      setupToken,
      microsoft: microsoftResult,
    });
    expect(status).toMatchObject({
      installation: { tenantId, workspaceId: admin.grant.workspaceId, active: true },
      linked: true,
    });
    const installation = await getTeamsInstallation(client.db, tenantId);
    expect(await getTeamsActor(client.db, installation!, actorId)).toBe(admin.subject);
    expect(provider.tokenRequests.at(-1)?.get("code_verifier")).toEqual(expect.any(String));

    // Replaying the same setup and sign-in can't run setup again.
    expect(
      (
        await refusal(
          completeTeamsSetup(d, admin.grant, { setupToken, microsoft: microsoftResult }),
        )
      ).status,
    ).toBe(409);
    // Another administrator of the same tenant can't take over an active connection.
    const other = await person();
    const otherActor = crypto.randomUUID();
    const otherToken = setupProof(tenantId, otherActor);
    const takeover = await refusal(
      completeTeamsSetup(d, other.grant, {
        setupToken: otherToken,
        microsoft: await adminSignIn(provider, d, other, otherToken, {
          oid: otherActor,
          wids: [TEAMS_ADMIN_ROLE_IDS.globalAdministrator],
        }),
      }),
    );
    expect(takeover.status).toBe(409);
    expect((await getTeamsInstallation(client.db, tenantId))?.workspace_id).toBe(
      admin.grant.workspaceId,
    );
  }, 60_000);

  test("people without an administrator role, another person's sign-in and another tenant are refused", async () => {
    const provider = microsoft();
    const d = deps(provider);
    const admin = await person();
    const tenantId = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    const setupToken = setupProof(tenantId, actorId);
    const cases: Array<[Parameters<typeof adminSignIn>[4], string | null, number, string]> = [
      [
        { oid: actorId, wids: ["b79fbf4d-3ef9-4689-8143-76b194e85509"] },
        null,
        403,
        "Global Administrator or Teams Administrator",
      ],
      [{ oid: actorId }, null, 403, "Global Administrator or Teams Administrator"],
      [
        { oid: crypto.randomUUID(), wids: [TEAMS_ADMIN_ROLE_IDS.globalAdministrator] },
        null,
        403,
        "same account you use in Teams",
      ],
      [
        {
          oid: actorId,
          wids: [TEAMS_ADMIN_ROLE_IDS.globalAdministrator],
          tid: crypto.randomUUID(),
        },
        null,
        403,
        "Teams organization you're connecting",
      ],
      // An administrator of a different tenant, issued by that tenant.
      [
        { oid: actorId, wids: [TEAMS_ADMIN_ROLE_IDS.globalAdministrator] },
        crypto.randomUUID(),
        400,
        "couldn't be verified",
      ],
    ];
    for (const [claims, issuer, status, message] of cases) {
      const result = await refusal(
        completeTeamsSetup(d, admin.grant, {
          setupToken,
          microsoft: await adminSignIn(provider, d, admin, setupToken, claims, issuer),
        }),
      );
      expect(result.status).toBe(status);
      expect(result.message).toContain(message);
    }
    expect(await getTeamsInstallation(client.db, tenantId)).toBeNull();
  }, 60_000);

  test("a sign-in started by one person or for one workspace or setup can't complete another", async () => {
    const provider = microsoft();
    const d = deps(provider);
    const admin = await person();
    const other = await person();
    const tenantId = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    const setupToken = setupProof(tenantId, actorId);
    const claims = { oid: actorId, wids: [TEAMS_ADMIN_ROLE_IDS.globalAdministrator] };
    const started = await adminSignIn(provider, d, admin, setupToken, claims);
    // Another Opengeni person (CSRF or a forwarded link) presenting this sign-in.
    const crossPerson = await refusal(
      completeTeamsSetup(d, other.grant, { setupToken, microsoft: started }),
    );
    expect(crossPerson).toMatchObject({ status: 400 });
    expect(crossPerson.message).toContain("another setup");
    // The same person, but with a different setup proof for the same tenant and actor.
    const freshToken = setupProof(tenantId, actorId);
    expect(
      (
        await refusal(
          completeTeamsSetup(d, admin.grant, { setupToken: freshToken, microsoft: started }),
        )
      ).status,
    ).toBe(400);
    // A forged state.
    expect(
      (
        await refusal(
          completeTeamsSetup(d, admin.grant, {
            setupToken,
            microsoft: { code: "x", state: `${started.state.split(".")[0]}.forged` },
          }),
        )
      ).status,
    ).toBe(400);
    // Without a Microsoft sign-in, a non-approved person can't connect.
    expect((await refusal(completeTeamsSetup(d, admin.grant, { setupToken }))).status).toBe(403);
    expect(await getTeamsInstallation(client.db, tenantId)).toBeNull();
    expect(provider.tokenRequests).toHaveLength(0);
  }, 60_000);

  test("a disconnected organization reconnects only in its own workspace", async () => {
    const provider = microsoft();
    const d = deps(provider);
    const admin = await person();
    const tenantId = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    const claims = { oid: actorId, wids: [TEAMS_ADMIN_ROLE_IDS.globalAdministrator] };
    const first = setupProof(tenantId, actorId);
    await completeTeamsSetup(d, admin.grant, {
      setupToken: first,
      microsoft: await adminSignIn(provider, d, admin, first, claims),
    });
    await disconnectTeamsBot(client.db, (await getTeamsInstallation(client.db, tenantId))!);
    expect((await getTeamsInstallation(client.db, tenantId))?.active).toBe(false);

    const elsewhere = await person();
    const moveToken = setupProof(tenantId, actorId);
    const moved = await refusal(
      completeTeamsSetup(d, elsewhere.grant, {
        setupToken: moveToken,
        microsoft: await adminSignIn(provider, d, elsewhere, moveToken, claims),
      }),
    );
    expect(moved.status).toBe(409);
    expect(moved.message).toContain("linked to another workspace");

    const again = setupProof(tenantId, actorId);
    const status = await completeTeamsSetup(d, admin.grant, {
      setupToken: again,
      microsoft: await adminSignIn(provider, d, admin, again, claims),
    });
    expect(status.installation).toMatchObject({
      workspaceId: admin.grant.workspaceId,
      active: true,
    });
  }, 60_000);

  test("a workspace connected to another organization can't start setup for a new one", async () => {
    const provider = microsoft();
    const d = deps(provider);
    const admin = await person();
    const tenantId = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    const token = setupProof(tenantId, actorId);
    await completeTeamsSetup(d, admin.grant, {
      setupToken: token,
      microsoft: await adminSignIn(provider, d, admin, token, {
        oid: actorId,
        wids: [TEAMS_ADMIN_ROLE_IDS.globalAdministrator],
      }),
    });
    const second = await refusal(
      startTeamsSetupSignIn(d, admin.grant, setupProof(crypto.randomUUID(), actorId)),
    );
    expect(second).toMatchObject({ status: 409 });
  }, 60_000);

  test("self-serve stays off by default and outside admitted tenants; operator approval still works", async () => {
    const provider = microsoft();
    const admin = await person();
    const tenantId = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    const token = setupProof(tenantId, actorId);
    const off = deps(provider, { teamsBotSelfServeSetupEnabled: false });
    expect((await refusal(startTeamsSetupSignIn(off, admin.grant, token))).status).toBe(403);
    const notAdmitted = deps(provider, {
      teamsBotEnabled: false,
      teamsBotAllowedTenantIds: [crypto.randomUUID()],
    });
    expect((await refusal(startTeamsSetupSignIn(notAdmitted, admin.grant, token))).status).toBe(
      403,
    );
    const consumer = setupProof("9188040d-6c67-4c5b-b112-36a304b66dad", actorId);
    expect(
      (await refusal(startTeamsSetupSignIn(deps(provider), admin.grant, consumer))).status,
    ).toBe(403);

    const approved = deps(provider, {
      teamsBotSelfServeSetupEnabled: false,
      teamsBotSetupAdminIds: [`${tenantId}:${actorId}`],
    });
    expect(await startTeamsSetupSignIn(approved, admin.grant, token)).toEqual({
      authorizationUrl: null,
    });
    const status = await completeTeamsSetup(approved, admin.grant, { setupToken: token });
    expect(status.installation).toMatchObject({ tenantId, active: true });
    expect(provider.tokenRequests).toHaveLength(0);
  }, 60_000);
});
