import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ConnectionMetadata } from "@opengeni/contracts";
import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import { testSettings } from "@opengeni/testing/settings";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import {
  connectionAccountIdentityState,
  decideOAuthAccountConnection,
} from "../src/integrations/oauth-account-identity";
import { mcpToolAccountIdentity, oidcAccountIdentity } from "../src/integrations/oauth-client";
import {
  OFFICIAL_DRIVE_MCP_URL,
  OFFICIAL_GMAIL_MCP_URL,
  accountIdentityKeysFor,
  accountIdentityVerifierFor,
  builtInOAuthProfileFor,
  type AccountIdentityVerifier,
} from "../src/integrations/oauth-profiles";

const ATLASSIAN = "https://mcp.atlassian.com/v1/mcp/authv2";
const NO_TOKEN = { tokenResponse: {} };

describe("reviewed account identity verifiers", () => {
  test("Google Drive reads the signed-in email from Drive About", () => {
    const verifier = accountIdentityVerifierFor(OFFICIAL_DRIVE_MCP_URL)!;
    expect(verifier).toMatchObject({ kind: "http", identityKeys: ["googleDriveEmail"] });
    expect(verifier.kind === "http" && new URL(verifier.url).origin).toBe(
      "https://www.googleapis.com",
    );
    expect(
      verifier.validateIdentity([{ user: { emailAddress: "anna@example.test" } }], NO_TOKEN),
    ).toEqual({
      googleDriveEmail: "anna@example.test",
    });
    for (const payload of [{}, { user: {} }, { user: { emailAddress: "not an email" } }]) {
      expect(() => verifier.validateIdentity([payload], NO_TOKEN)).toThrow();
    }
    expect(
      accountIdentityKeysFor(
        builtInOAuthProfileFor({ mcpUrl: OFFICIAL_DRIVE_MCP_URL }),
        OFFICIAL_DRIVE_MCP_URL,
      ),
    ).toEqual(["googleDriveEmail"]);
  });

  test("Atlassian uses the stable account id and keeps the email only for the label", () => {
    const verifier = accountIdentityVerifierFor(ATLASSIAN)!;
    expect(verifier).toMatchObject({
      kind: "mcp_tool",
      calls: [{ toolName: "atlassianUserInfo", arguments: {} }],
      identityKeys: ["atlassianAccountId"],
    });
    const identity = verifier.validateIdentity(
      [
        {
          account_id: "712020:abc",
          email: "anna@example.test",
          name: "Anna",
          picture: "https://avatar.example.test/a.png",
        },
      ],
      NO_TOKEN,
    );
    expect(identity).toEqual({
      atlassianAccountId: "712020:abc",
      atlassianEmail: "anna@example.test",
      atlassianName: "Anna",
    });
    expect(connectionAccountIdentityLabel(identity, "Atlassian account")).toBe("anna@example.test");
    expect(() => verifier.validateIdentity([{ email: "anna@example.test" }], NO_TOKEN)).toThrow();
    expect(accountIdentityKeysFor(null, ATLASSIAN)).toEqual(["atlassianAccountId"]);
  });

  test("profiles that verify identity themselves keep their own keys", () => {
    const gmail = builtInOAuthProfileFor({ mcpUrl: OFFICIAL_GMAIL_MCP_URL });
    expect(accountIdentityKeysFor(gmail, OFFICIAL_GMAIL_MCP_URL)).toEqual(["gmailEmail"]);
    expect(accountIdentityVerifierFor("https://unreviewed.example.test/mcp")).toBeUndefined();
    expect(accountIdentityKeysFor(null, "https://unreviewed.example.test/mcp")).toBeUndefined();
  });

  test("a verified Atlassian identity allows a second account and reuses the same one", () => {
    const base = {
      mcpUrl: ATLASSIAN,
      authorizationServerIssuer: "https://auth.atlassian.com",
      clientId: "client",
    };
    const existing = {
      id: "existing",
      subjectId: "owner",
      providerDomain: "mcp.atlassian.com",
      kind: "oauth2",
      status: "active",
      grantedScopes: [],
      metadata: { ...base, atlassianAccountId: "712020:anna" },
      createdAt: "2026-01-01",
    } as unknown as ConnectionMetadata;
    const decide = (atlassianAccountId: string | undefined) =>
      decideOAuthAccountConnection({
        accounts: [existing],
        ownerSubjectId: "owner",
        providerDomain: "mcp.atlassian.com",
        mcpUrl: ATLASSIAN,
        metadata: { ...base, ...(atlassianAccountId ? { atlassianAccountId } : {}) },
        grantedScopes: [],
        identityKeys: accountIdentityKeysFor(null, ATLASSIAN),
      });
    expect(decide("712020:anna")).toMatchObject({ kind: "reuse" });
    expect(decide("712020:erik")).toEqual({ kind: "write" });
    // A failed identity read stays unknown: never assumed to be a new account.
    expect(decide(undefined)).toEqual({ kind: "reject", reason: "account_identity_unavailable" });
    // An Atlassian connection from before identity existed is signed in again once.
    expect(
      decideOAuthAccountConnection({
        accounts: [{ ...existing, metadata: base } as ConnectionMetadata],
        ownerSubjectId: "owner",
        providerDomain: "mcp.atlassian.com",
        mcpUrl: ATLASSIAN,
        metadata: { ...base, atlassianAccountId: "712020:erik" },
        grantedScopes: [],
        identityKeys: accountIdentityKeysFor(null, ATLASSIAN),
      }),
    ).toEqual({ kind: "reject", reason: "account_reconnect_required" });
  });

  test("the Atlassian tool check parses text or structured results and never throws", async () => {
    const verifier = accountIdentityVerifierFor(ATLASSIAN)!;
    if (verifier.kind !== "mcp_tool") throw new Error("expected an MCP tool verifier");
    const calls: unknown[] = [];
    const client = (result: unknown) =>
      ({
        callTool: async (params: unknown, options: unknown) => {
          calls.push([params, options]);
          if (result instanceof Error) throw result;
          return result;
        },
      }) as never;
    const check = (result: unknown, tools = ["atlassianUserInfo"], budget = 1_000) =>
      mcpToolAccountIdentity(client(result), verifier, tools, budget, new AbortController().signal);
    const text = {
      content: [
        { type: "text", text: "not json" },
        { type: "text", text: JSON.stringify({ account_id: "712020:anna", email: "a@x.test" }) },
      ],
    };
    expect(await check(text)).toEqual({
      identity: { atlassianAccountId: "712020:anna", atlassianEmail: "a@x.test" },
    });
    expect(await check({ structuredContent: { account_id: "712020:erik" } })).toEqual({
      identity: { atlassianAccountId: "712020:erik" },
    });
    expect(await check({ isError: true, content: [] })).toEqual({ failure: "tool_error" });
    expect(await check({ content: [{ type: "text", text: "{}" }] })).toEqual({
      failure: "invalid_identity",
    });
    expect(await check(new Error("socket closed"))).toEqual({ failure: "request_failed" });
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(await check(timeout)).toEqual({ failure: "timeout" });
    calls.length = 0;
    expect(await check(text, ["getJiraIssue"])).toEqual({ failure: "tool_missing" });
    expect(await check(text, undefined, 0)).toEqual({ failure: "budget_exhausted" });
    expect(calls).toEqual([]);
  });
});

type ToolReply = unknown;
const json = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const timedOut = () => Object.assign(new Error("timed out"), { name: "TimeoutError" });

/** Runs a reviewed tool verifier against scripted tool replies. */
async function verify(
  url: string,
  replies: Record<string, ToolReply>,
  options: { listed?: string[]; tokenResponse?: Record<string, unknown>; budgetMs?: number } = {},
) {
  const verifier = accountIdentityVerifierFor(url) as Extract<
    AccountIdentityVerifier,
    { kind: "mcp_tool" }
  >;
  if (verifier?.kind !== "mcp_tool") throw new Error(`expected an MCP tool verifier for ${url}`);
  const called: string[] = [];
  const client = {
    callTool: async ({ name }: { name: string }) => {
      called.push(name);
      const reply = replies[name];
      if (reply instanceof Error) throw reply;
      if (reply === undefined) throw new Error(`unexpected tool ${name}`);
      return reply;
    },
  } as never;
  const result = await mcpToolAccountIdentity(
    client,
    verifier,
    options.listed ?? Object.keys(replies),
    options.budgetMs ?? 1_000,
    new AbortController().signal,
    { tokenResponse: options.tokenResponse ?? {} },
  );
  return { result, called };
}

describe("per-service identity verifiers", () => {
  const LINEAR = "https://mcp.linear.app/mcp";
  const NOTION = "https://mcp.notion.com/mcp";
  const ASANA = "https://mcp.asana.com/v2/mcp";
  const STRIPE = "https://mcp.stripe.com/";
  const linearUser = {
    id: "54e4137a-0000-4000-8000-000000000001",
    name: "Anna Berg",
    displayName: "anna",
    email: "anna@example.test",
    teams: [{ id: "t", name: "Core" }],
  };

  test("Linear keys the account by user id and names it by email and workspace", async () => {
    const { result } = await verify(LINEAR, {
      get_user: json(linearUser),
      get_workspace: json({ id: "org", name: "Cloudgeni", url: "https://linear.app/cloudgeni" }),
    });
    expect(result).toEqual({
      identity: {
        linearUserId: linearUser.id,
        linearEmail: "anna@example.test",
        linearName: "anna",
        linearWorkspaceName: "Cloudgeni",
      },
    });
    expect(connectionAccountIdentityLabel(result.identity!, "Linear account")).toBe(
      "anna@example.test · Cloudgeni",
    );
    expect(accountIdentityKeysFor(null, LINEAR)).toEqual(["linearUserId"]);
  });

  test("Linear's workspace name is optional; its user read is not", async () => {
    for (const workspace of [undefined, { isError: true, content: [] }, timedOut()]) {
      const { result } = await verify(
        LINEAR,
        { get_user: json(linearUser), ...(workspace ? { get_workspace: workspace } : {}) },
        { listed: workspace ? ["get_user", "get_workspace"] : ["get_user"] },
      );
      expect(result.identity?.linearUserId).toBe(linearUser.id);
      expect(result.identity?.linearWorkspaceName).toBeUndefined();
    }
    expect((await verify(LINEAR, {}, { listed: ["get_workspace"] })).result).toEqual({
      failure: "tool_missing",
    });
    expect((await verify(LINEAR, { get_user: { isError: true, content: [] } })).result).toEqual({
      failure: "tool_error",
    });
    expect((await verify(LINEAR, { get_user: timedOut() })).result).toEqual({
      failure: "timeout",
    });
    for (const malformed of [json({ name: "Anna" }), json([linearUser]), { content: [] }]) {
      expect((await verify(LINEAR, { get_user: malformed })).result).toEqual({
        failure: "invalid_identity",
      });
    }
    expect((await verify(LINEAR, { get_user: json(linearUser) }, { budgetMs: 0 })).result).toEqual({
      failure: "budget_exhausted",
    });
  });

  const notionSelf = (user: Record<string, unknown>) =>
    json({ workspace: { id: "ws-1", name: "Acme" }, user });
  const person = { type: "person", id: "user-1", name: "Anna", email: "anna@example.test" };

  test("Notion prefers the token response pair and labels from notion-get-self", async () => {
    const tokenResponse = { workspace_id: "ws-1", user_id: "user-1", workspace_name: "Acme" };
    const { result } = await verify(
      NOTION,
      { "notion-get-self": notionSelf(person) },
      { tokenResponse },
    );
    expect(result).toEqual({
      identity: {
        notionWorkspaceId: "ws-1",
        notionUserId: "user-1",
        notionEmail: "anna@example.test",
        notionName: "Anna",
        notionWorkspaceName: "Acme",
      },
    });
    expect(accountIdentityKeysFor(null, NOTION)).toEqual(["notionWorkspaceId", "notionUserId"]);
    // A token acting as a workspace bot is still identified by who authorized it.
    const bot = await verify(
      NOTION,
      { "notion-get-self": notionSelf({ type: "bot", id: "bot-1", name: "Bot" }) },
      { tokenResponse },
    );
    expect(bot.result).toEqual({
      identity: { notionWorkspaceId: "ws-1", notionUserId: "user-1", notionWorkspaceName: "Acme" },
    });
    // The token pair alone suffices when the tool is missing, fails or times out.
    for (const reply of [undefined, { isError: true, content: [] }, timedOut()]) {
      const { result: fallback } = await verify(NOTION, reply ? { "notion-get-self": reply } : {}, {
        tokenResponse,
        listed: reply ? ["notion-get-self"] : [],
      });
      expect(fallback.identity).toMatchObject({
        notionWorkspaceId: "ws-1",
        notionUserId: "user-1",
      });
    }
  });

  test("Notion without token fields needs a person from notion-get-self", async () => {
    expect((await verify(NOTION, { "notion-get-self": notionSelf(person) })).result).toEqual({
      identity: {
        notionWorkspaceId: "ws-1",
        notionUserId: "user-1",
        notionEmail: "anna@example.test",
        notionName: "Anna",
        notionWorkspaceName: "Acme",
      },
    });
    expect(
      (await verify(NOTION, { "notion-get-self": notionSelf({ type: "bot", id: "bot-1" }) }))
        .result,
    ).toEqual({ failure: "invalid_identity" });
    expect((await verify(NOTION, {}, { listed: [] })).result).toEqual({ failure: "tool_missing" });
    expect(
      (await verify(NOTION, { "notion-get-self": { isError: true, content: [] } })).result,
    ).toEqual({ failure: "tool_error" });
    expect((await verify(NOTION, { "notion-get-self": timedOut() })).result).toEqual({
      failure: "timeout",
    });
    expect((await verify(NOTION, { "notion-get-self": json({ user: person }) })).result).toEqual({
      failure: "invalid_identity",
    });
  });

  test("Asana keys the account by its numeric user gid", async () => {
    for (const body of [
      { gid: "1200000000000001", name: "Anna", email: "anna@example.test" },
      { data: { gid: "1200000000000001", name: "Anna", email: "anna@example.test" } },
    ]) {
      expect((await verify(ASANA, { get_me: json(body) })).result).toEqual({
        identity: {
          asanaUserId: "1200000000000001",
          asanaEmail: "anna@example.test",
          asanaName: "Anna",
        },
      });
    }
    expect((await verify(ASANA, {}, { listed: ["get_user"] })).result).toEqual({
      failure: "tool_missing",
    });
    expect((await verify(ASANA, { get_me: { isError: true, content: [] } })).result).toEqual({
      failure: "tool_error",
    });
    expect((await verify(ASANA, { get_me: timedOut() })).result).toEqual({ failure: "timeout" });
    for (const malformed of [{ gid: "me" }, { name: "Anna" }, { data: [] }]) {
      expect((await verify(ASANA, { get_me: json(malformed) })).result).toEqual({
        failure: "invalid_identity",
      });
    }
  });

  test("Stripe keys the account by its acct_ id", async () => {
    const account = {
      id: "acct_1TrfPUDaGV12u0NB",
      object: "account",
      email: "billing@example.test",
      settings: { dashboard: { display_name: "Acme" } },
    };
    expect((await verify(STRIPE, { get_stripe_account_info: json(account) })).result).toEqual({
      identity: {
        stripeAccountId: "acct_1TrfPUDaGV12u0NB",
        stripeEmail: "billing@example.test",
        stripeAccountName: "Acme",
      },
    });
    expect(accountIdentityVerifierFor("https://mcp.stripe.com")).toBe(
      accountIdentityVerifierFor(STRIPE),
    );
    expect((await verify(STRIPE, {}, { listed: [] })).result).toEqual({ failure: "tool_missing" });
    expect(
      (await verify(STRIPE, { get_stripe_account_info: { isError: true, content: [] } })).result,
    ).toEqual({ failure: "tool_error" });
    expect((await verify(STRIPE, { get_stripe_account_info: timedOut() })).result).toEqual({
      failure: "timeout",
    });
    for (const malformed of [
      json({ id: "cus_123" }),
      { content: [{ type: "text", text: "Account ID: acct_123" }] },
    ]) {
      expect((await verify(STRIPE, { get_stripe_account_info: malformed })).result).toEqual({
        failure: "invalid_identity",
      });
    }
  });

  test("HubSpot, Sentry and Apollo stay unidentified and get the one-account rule", () => {
    for (const url of [
      "https://mcp.hubspot.com/anthropic",
      "https://mcp.sentry.dev/mcp",
      "https://mcp.apollo.io/mcp",
    ]) {
      expect(accountIdentityVerifierFor(url)).toBeUndefined();
      expect(
        connectionAccountIdentityState({
          kind: "oauth2",
          providerDomain: new URL(url).hostname,
          metadata: { mcpUrl: url },
        }),
      ).toBe("single");
    }
  });
});

describe("generic OpenID Connect identity", () => {
  const settings = testSettings();
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let userinfo: () => Response | Promise<Response> = () => Response.json({});
  let userinfoCalls = 0;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let jwks: Record<string, unknown>;
  beforeAll(async () => {
    keys = await generateKeyPair("ES256");
    jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "ES256" }] };
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/jwks") return Response.json(jwks);
        if (path === "/userinfo") {
          userinfoCalls++;
          if (request.headers.get("authorization") !== "Bearer access-token")
            return new Response("no", { status: 401 });
          return await userinfo();
        }
        return new Response("missing", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server?.stop(true));

  const state = () => ({
    issuer: `${base}/`,
    clientId: "client-1",
    oidcUserinfoEndpoint: `${base}/userinfo`,
    oidcJwksUri: `${base}/jwks`,
  });
  const token = (raw: Record<string, unknown> = {}) => ({
    accessToken: "access-token",
    tokenType: "Bearer",
    raw,
  });
  const run = (
    overrides: Partial<ReturnType<typeof state>> = {},
    raw: Record<string, unknown> = {},
    budgetMs = 2_000,
  ) =>
    oidcAccountIdentity(
      settings,
      { ...state(), ...overrides },
      token(raw),
      budgetMs,
      new AbortController().signal,
    );
  const idToken = (claims: Record<string, unknown>, audience = "client-1") =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(base)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(keys.privateKey);

  test("userinfo gives the stable subject, with email and name only for the label", async () => {
    userinfo = () =>
      Response.json({ sub: "user-42", email: "anna@example.test", name: "Anna", extra: "x" });
    expect(await run()).toEqual({
      identity: { oidcSubject: "user-42", oidcEmail: "anna@example.test", oidcName: "Anna" },
    });
    userinfo = () => Response.json({ sub: "user-42", preferred_username: "anna" });
    expect(await run()).toEqual({ identity: { oidcSubject: "user-42", oidcName: "anna" } });
    expect(accountIdentityKeysFor(null, "https://mcp.posthog.com/mcp", true)).toEqual([
      "oidcSubject",
    ]);
  });

  test("userinfo errors, malformed claims and timeouts leave identity unknown", async () => {
    userinfo = () => new Response("down", { status: 503 });
    expect(await run()).toEqual({ failure: "userinfo_http_503" });
    for (const body of [{ email: "anna@example.test" }, { sub: "" }, { sub: 42 }, []]) {
      userinfo = () => Response.json(body);
      expect(await run()).toEqual({ failure: "userinfo_invalid_identity" });
    }
    userinfo = () => new Response("not json", { headers: { "content-type": "text/plain" } });
    expect((await run()).failure).toStartWith("userinfo_");
    userinfo = () => new Promise((resolve) => setTimeout(() => resolve(Response.json({})), 500));
    expect(await run({}, {}, 50)).toEqual({ failure: "userinfo_timeout" });
    expect(await run({}, {}, 0)).toEqual({ failure: "budget_exhausted" });
  });

  test("a verified id_token identifies the account without calling userinfo", async () => {
    userinfoCalls = 0;
    const raw = { id_token: await idToken({ sub: "user-7", email: "erik@example.test" }) };
    expect(await run({}, raw)).toEqual({
      identity: { oidcSubject: "user-7", oidcEmail: "erik@example.test" },
    });
    expect(userinfoCalls).toBe(0);
  });

  test("an id_token for another client or with a forged signature is not proof", async () => {
    userinfo = () => Response.json({ sub: "user-42" });
    const wrongAudience = { id_token: await idToken({ sub: "user-7" }, "someone-else") };
    // Falls back to userinfo for the identity.
    expect(await run({}, wrongAudience)).toEqual({ identity: { oidcSubject: "user-42" } });
    expect(await run({ oidcUserinfoEndpoint: undefined }, wrongAudience)).toEqual({
      failure: "id_token_invalid_identity",
    });
    const forger = await generateKeyPair("ES256");
    const forged = await new SignJWT({ sub: "user-7" })
      .setProtectedHeader({ alg: "ES256", kid: "k1" })
      .setIssuer(base)
      .setAudience("client-1")
      .setExpirationTime("5m")
      .sign(forger.privateKey);
    expect(await run({ oidcUserinfoEndpoint: undefined }, { id_token: forged })).toEqual({
      failure: "id_token_invalid_identity",
    });
  });
});

describe("account identity state for connect affordances", () => {
  const state = (metadata: Record<string, unknown>, kind: ConnectionMetadata["kind"] = "oauth2") =>
    connectionAccountIdentityState({ kind, providerDomain: "service.test", metadata });

  test("verified, reconnect once, or one account per person", () => {
    expect(state({ mcpUrl: ATLASSIAN, atlassianAccountId: "712020:a" })).toBe("verified");
    expect(state({ mcpUrl: ATLASSIAN })).toBe("reconnect");
    expect(state({ mcpUrl: "https://unreviewed.example.test/mcp" })).toBe("single");
    expect(
      state({
        mcpUrl: "https://mcp.posthog.com/mcp",
        accountIdentityMethod: "oidc",
        oidcSubject: "u",
      }),
    ).toBe("verified");
    expect(state({ mcpUrl: "https://mcp.posthog.com/mcp", accountIdentityMethod: "oidc" })).toBe(
      "reconnect",
    );
    expect(state({ mcpUrl: ATLASSIAN }, "api_key")).toBeUndefined();
    expect(state({})).toBeUndefined();
  });
});
