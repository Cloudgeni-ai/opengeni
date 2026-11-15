import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { Settings } from "@opengeni/config";
import {
  effectiveNangoIntegrations,
  nangoAttemptTags,
  OPENGENI_API_CONTRACT_HEADER,
  OPENGENI_API_CONTRACT_REVISION,
  type IntegrationBackendSetting,
} from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { testSettings } from "@opengeni/testing/settings";
import {
  completeNangoConnect,
  handleNangoWebhook,
  nangoConnectPage,
  readNangoConnectState,
  startNangoConnect,
} from "../src/integrations/nango-connect";

const ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const WORKSPACE = "00000000-0000-4000-8000-0000000000b1";
const SUBJECT = "user:00000000-0000-4000-8000-0000000000c1";
const SIGNING_KEY = "nango-webhook-signing-key";

const settings = testSettings({
  environmentsEncryptionKey: randomBytes(32).toString("base64"),
  integrationsEnabled: true,
  integrationsStateSecret: "nango-connect-state-secret",
  publicBaseUrl: "https://api.opengeni.test",
  webBaseUrl: "https://app.opengeni.test",
  nangoSecretKey: "nango-secret-test",
  nangoApiBaseUrl: "https://nango.test",
  nangoWebhookSigningKey: SIGNING_KEY,
}) as Settings;

const gmailSetting: IntegrationBackendSetting = {
  integrationKey: "gmail",
  backend: "nango",
  providerConfigKey: "google-mail",
  enabled: true,
  definition: null,
  revision: 3,
  changedAt: "2026-11-13T00:00:00.000Z",
};
const backends = effectiveNangoIntegrations([gmailSetting], true);
const gmail = backends.get("gmail")!;

/** A database that must never be reached by the paths under test. */
const unreachableDb = new Proxy(
  {},
  {
    get() {
      throw new Error("database must not be used");
    },
  },
) as unknown as Database;

type Recorded = { method: string; url: string; headers: Headers; body: unknown };

function fakeNango(connections: unknown[], identityStatus = 200) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    requests.push({
      method: init?.method ?? "GET",
      url: url.toString(),
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.pathname === "/connect/sessions")
      return Response.json({
        data: {
          token: "session-token",
          connect_link: "https://connect.nango.test/?session_token=s",
        },
      });
    if (url.pathname === "/connections") return Response.json({ connections });
    if (url.pathname.startsWith("/proxy/"))
      return Response.json({ emailAddress: "person@example.com" }, { status: identityStatus });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { requests, fetchImpl };
}

async function startedState(): Promise<string> {
  const started = await startNangoConnect(
    { db: unreachableDb, settings, nangoBackends: async () => backends },
    {
      integrationKey: "gmail",
      accountId: ACCOUNT,
      workspaceId: WORKSPACE,
      subjectId: SUBJECT,
      personalOwnershipAllowed: true,
      browserBinding: { browserProof: "none" },
      requestUrl: "https://api.opengeni.test/v1/workspaces/x/connections/oauth/start",
      payload: { mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1", ownership: "personal" },
    } as never,
    gmail,
  ).catch(async (error) => {
    // The organization policy fence needs a database; tests start past it.
    if (String(error).includes("database must not be used")) return null;
    throw error;
  });
  if (started) return started.state;
  const { createSignedState } = await import("@opengeni/github");
  return createSignedState(settings.integrationsStateSecret!, {
    kind: "nango_connect",
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    subjectId: SUBJECT,
    personalOwnerVerified: true,
    ownership: "personal",
    integrationKey: "gmail",
    providerConfigKey: "google-mail",
    providerDomain: "nango:gmail",
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
    returnPath: `/workspaces/${WORKSPACE}/integrations`,
    browserProof: "none",
  });
}

describe("Nango Connect", () => {
  test("the signed state binds one owner, integration and Nango integration", async () => {
    const state = readNangoConnectState(settings, await startedState());
    expect(state).toMatchObject({
      kind: "nango_connect",
      accountId: ACCOUNT,
      subjectId: SUBJECT,
      ownership: "personal",
      integrationKey: "gmail",
      providerConfigKey: "google-mail",
      providerDomain: "nango:gmail",
    });
    expect(() => readNangoConnectState(settings, "forged.state")).toThrow();
  });

  test("the page opens a session for exactly this integration, tagged with this attempt", async () => {
    const token = await startedState();
    const nango = fakeNango([]);
    const response = await nangoConnectPage(
      {
        db: unreachableDb,
        settings,
        fetchImpl: nango.fetchImpl,
        nangoBackends: async () => backends,
      },
      {
        state: token,
        browser: { bindingDigests: [], signedInSubjectId: null },
        requestUrl: "https://api.opengeni.test/v1/integrations/nango/connect",
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-src https://connect.nango.test",
    );
    const session = nango.requests.find((request) => request.url.endsWith("/connect/sessions"))!;
    expect(session.headers.get("authorization")).toBe("Bearer nango-secret-test");
    const state = readNangoConnectState(settings, token);
    expect(session.body).toEqual({
      tags: nangoAttemptTags({
        accountId: ACCOUNT,
        workspaceId: WORKSPACE,
        subjectId: SUBJECT,
        attemptId: state.nonce,
        integrationKey: "gmail",
      }),
      allowed_integrations: ["google-mail"],
    });
    const html = await response.text();
    expect(html).not.toContain("nango-secret-test");
    // ConnectUI handshake: the token goes by postMessage, never in the frame URL.
    expect(html).toContain('src="https://connect.nango.test/?apiURL=https%3A%2F%2Fnango.test"');
    expect(html).not.toContain("session_token=s");
    expect(html).toContain('"sessionToken":"session-token"');
    expect(html).toContain('type: "session_token"');
    // After connect, 409 (connection changed) is retried within the short backoff only.
    expect(html).toContain("retryConflict && response.status === 409");
    expect(html).toContain("await complete(true)");
    // The completion POST passes the browser API-contract fence.
    expect(html).toContain("[data.contractHeader]: data.contractRevision");
    expect(html).toContain(`"contractHeader":"${OPENGENI_API_CONTRACT_HEADER}"`);
    expect(html).toContain(`"contractRevision":"${OPENGENI_API_CONTRACT_REVISION}"`);
  });

  test("completion stores nothing until Nango has a connection with this attempt's tags", async () => {
    const token = await startedState();
    const state = readNangoConnectState(settings, token);
    // Another attempt's connection, and one of another integration, never count.
    const nango = fakeNango([
      {
        connection_id: "other-attempt",
        provider_config_key: "google-mail",
        tags: nangoAttemptTags({
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          subjectId: SUBJECT,
          attemptId: "another-attempt",
          integrationKey: "gmail",
        }),
      },
      {
        connection_id: "other-integration",
        provider_config_key: "google-drive",
        tags: nangoAttemptTags({
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          subjectId: SUBJECT,
          attemptId: state.nonce,
          integrationKey: "gmail",
        }),
      },
    ]);
    expect(
      await completeNangoConnect(
        {
          db: unreachableDb,
          settings,
          fetchImpl: nango.fetchImpl,
          nangoBackends: async () => backends,
        },
        { state: token, browser: { bindingDigests: [], signedInSubjectId: null } },
      ),
    ).toEqual({ status: "pending" });
  });

  test("an account Nango cannot name is never stored and is deleted in Nango", async () => {
    const token = await startedState();
    const state = readNangoConnectState(settings, token);
    const nango = fakeNango(
      [
        {
          connection_id: "nango-conn-1",
          provider_config_key: "google-mail",
          tags: nangoAttemptTags({
            accountId: ACCOUNT,
            workspaceId: WORKSPACE,
            subjectId: SUBJECT,
            attemptId: state.nonce,
            integrationKey: "gmail",
          }),
        },
      ],
      403,
    );
    await expect(
      completeNangoConnect(
        {
          db: unreachableDb,
          settings,
          fetchImpl: nango.fetchImpl,
          nangoBackends: async () => backends,
        },
        { state: token, browser: { bindingDigests: [], signedInSubjectId: null } },
      ),
    ).rejects.toThrow("could not be verified");
    const identity = nango.requests.find((request) => request.url.includes("/proxy/"))!;
    expect(identity.url).toBe("https://nango.test/proxy/gmail/v1/users/me/profile");
    expect(identity.headers.get("base-url-override")).toBe("https://gmail.googleapis.com");
    expect(identity.headers.get("connection-id")).toBe("nango-conn-1");
    expect(identity.headers.get("provider-config-key")).toBe("google-mail");
    expect(
      nango.requests.some(
        (request) =>
          request.method === "DELETE" && request.url.includes("/connections/nango-conn-1"),
      ),
    ).toBe(true);
  });

  test("a completion from another browser is refused", async () => {
    const { createSignedState } = await import("@opengeni/github");
    const token = createSignedState(settings.integrationsStateSecret!, {
      ...readNangoConnectState(settings, await startedState()),
      browserProof: "session",
    });
    await expect(
      completeNangoConnect(
        { db: unreachableDb, settings, nangoBackends: async () => backends },
        { state: token, browser: { bindingDigests: [], signedInSubjectId: "user:someone-else" } },
      ),
    ).rejects.toThrow();
  });
});

describe("Nango webhook", () => {
  const body = JSON.stringify({
    type: "auth",
    operation: "refresh",
    connectionId: "c",
    providerConfigKey: "p",
    success: false,
    tags: {},
  });
  const sign = (raw: string) => createHmac("sha256", SIGNING_KEY).update(raw).digest("hex");

  test("rejects a missing or wrong signature", async () => {
    for (const signature of [undefined, "0".repeat(64), sign(`${body} `)])
      await expect(
        handleNangoWebhook({ db: unreachableDb, settings }, { rawBody: body, signature }),
      ).rejects.toMatchObject({ status: 401 });
  });

  test("is not served unless Nango and its signing key are configured", async () => {
    await expect(
      handleNangoWebhook(
        {
          db: unreachableDb,
          settings: { ...settings, nangoWebhookSigningKey: undefined } as Settings,
        },
        { rawBody: body, signature: sign(body) },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("ignores signed events that carry no Opengeni attempt", async () => {
    expect(
      await handleNangoWebhook(
        { db: unreachableDb, settings, nangoBackends: async () => backends },
        { rawBody: body, signature: sign(body) },
      ),
    ).toBe("ignored");
  });
});
