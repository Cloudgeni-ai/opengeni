import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  TEAMS_ADMIN_ROLE_IDS,
  mintTeamsAdminState,
  teamsAdminAuthorizationUrl,
  teamsAdminOidcNonce,
  teamsAdminPkceVerifier,
  verifyTeamsAdminSignIn,
  verifyTeamsAdminState,
  type TeamsAdminSignInConfig,
} from "../src/integrations/teams-admin-proof";

const tenantId = "017dcee4-abab-4d45-9546-a26f65d15431";
const otherTenant = "20000000-0000-4000-8000-000000000009";
const actorId = "10000000-0000-4000-8000-000000000002";
const config: TeamsAdminSignInConfig = {
  clientId: "d3f8842e-a4b7-483d-a9a9-551c547911aa",
  clientSecret: "bot-secret",
  stateSecret: "state-secret",
  redirectUri: "https://app.example.test/teams/connect",
};
const binding = {
  proofNonce: "10000000-0000-4000-8000-000000000010",
  tenantId,
  actorId,
  subjectId: "user:human",
  workspaceId: "10000000-0000-4000-8000-000000000003",
};

const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "key-1", alg: "RS256", use: "sig" };

async function idToken(
  claims: Record<string, unknown>,
  options: { issuer?: string; audience?: string; expires?: string | number } = {},
) {
  return await new SignJWT({ ver: "2.0", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .setIssuer(options.issuer ?? `https://login.microsoftonline.com/${tenantId}/v2.0`)
    .setAudience(options.audience ?? config.clientId)
    .setIssuedAt()
    .setExpirationTime(options.expires ?? "5m")
    .sign(keys.privateKey);
}

function microsoft(token: string | (() => Promise<string>), tokenStatus = 200) {
  const requests: Array<{ url: string; body: URLSearchParams | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, body: init?.body ? new URLSearchParams(String(init.body)) : null });
    if (url.endsWith("/discovery/v2.0/keys")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/oauth2/v2.0/token"))
      return Response.json(
        { id_token: typeof token === "string" ? token : await token() },
        { status: tokenStatus },
      );
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function signedState(
  overrides: Partial<typeof binding> & {
    purpose?: "teams-admin-setup" | "teams-account-link";
  } = {},
) {
  return mintTeamsAdminState(config.stateSecret, { ...binding, ...overrides });
}

function adminClaims(state: ReturnType<typeof signedState>["state"], extra = {}) {
  return {
    tid: tenantId,
    oid: actorId,
    nonce: teamsAdminOidcNonce(config.stateSecret, state),
    wids: [TEAMS_ADMIN_ROLE_IDS.globalAdministrator, "b79fbf4d-3ef9-4689-8143-76b194e85509"],
    ...extra,
  };
}

describe("Teams admin sign-in state", () => {
  test("is signed, bounded and binds the exact setup", () => {
    const { token, state } = signedState();
    expect(verifyTeamsAdminState(config.stateSecret, token)).toEqual(state);
    expect(state).toMatchObject(binding);
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...state, tenantId: otherTenant })).toString(
      "base64url",
    );
    for (const bad of [
      `${forged}.${signature}`,
      `${payload}.${signature}.extra`,
      `${payload}`,
      "x".repeat(5000),
    ])
      expect(() => verifyTeamsAdminState(config.stateSecret, bad)).toThrow("state_invalid");
    expect(() => verifyTeamsAdminState("other-secret", token)).toThrow("state_invalid");
    expect(() => verifyTeamsAdminState(config.stateSecret, token, state.expiresAt + 1)).toThrow(
      "state_expired",
    );
  });

  test("authorizes only in the Teams tenant with PKCE and a derived nonce", () => {
    const { token, state } = signedState();
    const url = new URL(teamsAdminAuthorizationUrl(config, token, state));
    expect(`${url.origin}${url.pathname}`).toBe(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
    );
    const params = Object.fromEntries(url.searchParams);
    expect(params).toEqual({
      client_id: config.clientId,
      response_type: "code",
      response_mode: "query",
      redirect_uri: config.redirectUri,
      scope: "openid profile",
      state: token,
      nonce: teamsAdminOidcNonce(config.stateSecret, state),
      code_challenge: createHash("sha256")
        .update(teamsAdminPkceVerifier(config.stateSecret, state))
        .digest("base64url"),
      code_challenge_method: "S256",
      prompt: "select_account",
    });
    // The verifier never leaves the server.
    expect(url.toString()).not.toContain(teamsAdminPkceVerifier(config.stateSecret, state));
    // Each setup gets its own verifier and nonce.
    const second = signedState().state;
    expect(teamsAdminPkceVerifier(config.stateSecret, second)).not.toBe(
      teamsAdminPkceVerifier(config.stateSecret, state),
    );
  });
});

describe("Teams admin sign-in verification", () => {
  test("accepts a Global Administrator or Teams Administrator with matching tid and oid", async () => {
    for (const role of Object.values(TEAMS_ADMIN_ROLE_IDS)) {
      const { state } = signedState();
      const { fetchImpl, requests } = microsoft(
        await idToken(adminClaims(state, { wids: [role] })),
      );
      expect(await verifyTeamsAdminSignIn(config, state, "code-1", fetchImpl)).toEqual({
        tenantId,
        actorId,
        roles: [role],
      });
      expect(requests[0]!.url).toBe(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      );
      expect(Object.fromEntries(requests[0]!.body!)).toEqual({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "authorization_code",
        code: "code-1",
        redirect_uri: config.redirectUri,
        code_verifier: teamsAdminPkceVerifier(config.stateSecret, state),
        scope: "openid profile",
      });
    }
  });

  test("refuses people without an administrator role, including a missing wids claim", async () => {
    for (const wids of [undefined, [], ["b79fbf4d-3ef9-4689-8143-76b194e85509"], "62e90394"]) {
      const { state } = signedState();
      const { fetchImpl } = microsoft(await idToken(adminClaims(state, { wids })));
      await expect(verifyTeamsAdminSignIn(config, state, "code", fetchImpl)).rejects.toThrow(
        "not_tenant_admin",
      );
    }
  });

  test("refuses another tenant's token, another person and cross-tenant issuers", async () => {
    const { state } = signedState();
    const cases: Array<[Promise<string>, string]> = [
      [idToken(adminClaims(state, { tid: otherTenant })), "tenant_mismatch"],
      [
        idToken(adminClaims(state, { oid: "10000000-0000-4000-8000-000000000099" })),
        "user_mismatch",
      ],
      // A valid token for this app, signed by Microsoft, but issued by another tenant.
      [
        idToken(adminClaims(state, { tid: otherTenant }), {
          issuer: `https://login.microsoftonline.com/${otherTenant}/v2.0`,
        }),
        "id_token_invalid",
      ],
      [
        idToken(adminClaims(state), { audience: "00000000-0000-4000-8000-000000000001" }),
        "id_token_invalid",
      ],
      [
        idToken(adminClaims(state), { expires: Math.floor(Date.now() / 1000) - 600 }),
        "id_token_invalid",
      ],
      [idToken(adminClaims(state, { nonce: "replayed" })), "id_token_invalid"],
      [idToken({ ...adminClaims(state), oid: undefined }), "id_token_invalid"],
    ];
    for (const [token, reason] of cases) {
      const { fetchImpl } = microsoft(await token);
      await expect(verifyTeamsAdminSignIn(config, state, "code", fetchImpl)).rejects.toThrow(
        reason,
      );
    }
  });

  test("refuses a token from another sign-in for the same person (nonce binding)", async () => {
    const first = signedState().state;
    const second = signedState().state;
    const { fetchImpl } = microsoft(await idToken(adminClaims(first)));
    await expect(verifyTeamsAdminSignIn(config, second, "code", fetchImpl)).rejects.toThrow(
      "id_token_invalid",
    );
  });

  test("refuses unsigned or foreign-key tokens and failed exchanges", async () => {
    const { state } = signedState();
    const other = await generateKeyPair("RS256");
    const foreign = await new SignJWT(adminClaims(state))
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
      .setAudience(config.clientId)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(other.privateKey);
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ ...adminClaims(state), iss: `https://login.microsoftonline.com/${tenantId}/v2.0`, aud: config.clientId, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000) })).toString("base64url")}.`;
    for (const token of [foreign, unsigned]) {
      const { fetchImpl } = microsoft(token);
      await expect(verifyTeamsAdminSignIn(config, state, "code", fetchImpl)).rejects.toThrow(
        "id_token_invalid",
      );
    }
    const { fetchImpl } = microsoft(await idToken(adminClaims(state)), 400);
    await expect(verifyTeamsAdminSignIn(config, state, "code", fetchImpl)).rejects.toThrow(
      "token_exchange_failed",
    );
  });

  test("never contacts Microsoft for a personal-account tenant", async () => {
    const { state } = signedState({ tenantId: "9188040d-6c67-4c5b-b112-36a304b66dad" });
    const { fetchImpl, requests } = microsoft("unused");
    await expect(verifyTeamsAdminSignIn(config, state, "code", fetchImpl)).rejects.toThrow(
      "consumer_tenant",
    );
    expect(requests).toEqual([]);
  });
});

describe("Teams account-link sign-in verification", () => {
  const linkState = () => signedState({ purpose: "teams-account-link" });

  test("signs its purpose, so a link state is never a setup state", () => {
    const { token, state } = linkState();
    expect(state.purpose).toBe("teams-account-link");
    expect(signedState().state.purpose).toBe("teams-admin-setup");
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...state, purpose: "teams-admin-setup" })).toString(
      "base64url",
    );
    expect(verifyTeamsAdminState(config.stateSecret, token)).toEqual(state);
    expect(() => verifyTeamsAdminState(config.stateSecret, `${forged}.${signature}`)).toThrow(
      "state_invalid",
    );
    expect(payload).not.toBe(forged);
  });

  test("accepts the matching identity without an administrator role", async () => {
    for (const wids of [undefined, [], ["b79fbf4d-3ef9-4689-8143-76b194e85509"]]) {
      const { state } = linkState();
      const { fetchImpl } = microsoft(await idToken(adminClaims(state, { wids })));
      await expect(verifyTeamsAdminSignIn(config, state, "code", fetchImpl)).resolves.toMatchObject(
        { tenantId, actorId },
      );
    }
  });

  test("refuses a different oid or tid and says who signed in", async () => {
    const { state } = linkState();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ oid: "10000000-0000-4000-8000-000000000099" }, "user_mismatch"],
      [{ tid: otherTenant }, "tenant_mismatch"],
    ];
    for (const [claims, code] of cases) {
      const { fetchImpl } = microsoft(
        await idToken(
          adminClaims(state, { ...claims, preferred_username: "bob@contoso.test", name: "Bob" }),
        ),
      );
      const error = await verifyTeamsAdminSignIn(config, state, "code", fetchImpl).catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code, signedInAs: "bob@contoso.test" });
    }
    const { fetchImpl } = microsoft(
      await idToken(adminClaims(state, { oid: "10000000-0000-4000-8000-000000000099" })),
    );
    const error = await verifyTeamsAdminSignIn(config, state, "code", fetchImpl).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "user_mismatch", signedInAs: null });
  });

  test("keeps the nonce, issuer and audience checks", async () => {
    const { state } = linkState();
    for (const token of [
      idToken(adminClaims(state, { nonce: "replayed" })),
      idToken(adminClaims(state, { tid: otherTenant }), {
        issuer: `https://login.microsoftonline.com/${otherTenant}/v2.0`,
      }),
      idToken(adminClaims(state), { audience: "00000000-0000-4000-8000-000000000001" }),
    ]) {
      const { fetchImpl } = microsoft(await token);
      await expect(verifyTeamsAdminSignIn(config, state, "code", fetchImpl)).rejects.toThrow(
        "id_token_invalid",
      );
    }
  });
});
