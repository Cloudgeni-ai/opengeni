import { beforeEach, describe, expect, test } from "bun:test";
import {
  AZURE_COGNITIVE_SERVICES_SCOPE,
  AzureEntraTokenError,
  azureEntraCredentialConfigured,
  createAzureEntraAccessTokenSource,
  resetSharedAzureEntraAccessTokenSources,
  sharedAzureEntraAccessTokenSource,
} from "../src/azure-entra";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const CLIENT = "00000000-0000-4000-8000-0000000000b2";
const SECRET = "fake-client-secret-value";

type Call = { url: string; body: URLSearchParams };

function tokenEndpoint(
  responses: Array<() => Response | Promise<Response>>,
  calls: Call[] = [],
): (input: string, init: RequestInit) => Promise<Response> {
  return async (input, init) => {
    calls.push({ url: input, body: new URLSearchParams(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected token request");
    return await next();
  };
}

const issued =
  (token: string, expiresIn = 3_600, extra: Record<string, unknown> = {}) =>
  () =>
    Response.json({ token_type: "Bearer", access_token: token, expires_in: expiresIn, ...extra });

describe("Microsoft Entra ID access tokens", () => {
  beforeEach(() => resetSharedAzureEntraAccessTokenSources());

  test("a client secret is exchanged for a Cognitive Services token at the tenant endpoint", async () => {
    const calls: Call[] = [];
    const source = createAzureEntraAccessTokenSource(
      { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET },
      { fetch: tokenEndpoint([issued("token-1")], calls) },
    );
    expect(await source()).toBe("token-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(Object.fromEntries(calls[0]!.body)).toEqual({
      grant_type: "client_credentials",
      client_id: CLIENT,
      scope: AZURE_COGNITIVE_SERVICES_SCOPE,
      client_secret: SECRET,
    });
    expect(AZURE_COGNITIVE_SERVICES_SCOPE).toBe("https://cognitiveservices.azure.com/.default");
  });

  test("a workload identity sends its federated token, read again for every request", async () => {
    const calls: Call[] = [];
    let rotation = 0;
    let clock = 0;
    const source = createAzureEntraAccessTokenSource(
      {
        tenantId: TENANT,
        clientId: CLIENT,
        federatedTokenFile: "/var/run/secrets/azure/tokens/azure-identity-token",
        authorityHost: "https://login.example-sovereign.test/",
      },
      {
        fetch: tokenEndpoint([issued("token-1"), issued("token-2")], calls),
        readTokenFile: async (path) => {
          expect(path).toBe("/var/run/secrets/azure/tokens/azure-identity-token");
          rotation += 1;
          return `projected-assertion-${rotation}\n`;
        },
        now: () => clock,
      },
    );
    expect(await source()).toBe("token-1");
    clock = 60 * 60_000;
    expect(await source()).toBe("token-2");
    expect(calls.map((call) => call.url)).toEqual([
      `https://login.example-sovereign.test/${TENANT}/oauth2/v2.0/token`,
      `https://login.example-sovereign.test/${TENANT}/oauth2/v2.0/token`,
    ]);
    expect(calls.map((call) => call.body.get("client_assertion"))).toEqual([
      "projected-assertion-1",
      "projected-assertion-2",
    ]);
    expect(calls[0]!.body.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    expect(calls[0]!.body.has("client_secret")).toBe(false);
  });

  test("tokens refresh five minutes before they expire, never after", async () => {
    let clock = 1_000_000;
    const calls: Call[] = [];
    const source = createAzureEntraAccessTokenSource(
      { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET },
      {
        fetch: tokenEndpoint([issued("first", 3_600), issued("second", 3_600)], calls),
        now: () => clock,
      },
    );
    expect(await source()).toBe("first");
    clock += 54 * 60_000;
    expect(await source()).toBe("first");
    clock += 60_001;
    expect(await source()).toBe("second");
    expect(calls).toHaveLength(2);
    // A turn that outlives several tokens keeps getting a fresh one.
    clock += 3_600_000;
    await expect(source()).rejects.toThrow("Could not reach Microsoft Entra ID");
  });

  test("a short-lived token refreshes at half its lifetime, and refresh_in is honored", async () => {
    let clock = 0;
    const source = createAzureEntraAccessTokenSource(
      { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET },
      {
        fetch: tokenEndpoint([
          issued("short", 120),
          issued("long", 86_400, { refresh_in: 43_200 }),
          issued("after-refresh-in", 86_400),
        ]),
        now: () => clock,
      },
    );
    expect(await source()).toBe("short");
    clock = 59_000;
    expect(await source()).toBe("short");
    clock = 60_000;
    expect(await source()).toBe("long");
    clock = 60_000 + 43_200_000 - 1;
    expect(await source()).toBe("long");
    clock = 60_000 + 43_200_000;
    expect(await source()).toBe("after-refresh-in");
  });

  test("concurrent callers share one token request", async () => {
    const calls: Call[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const source = createAzureEntraAccessTokenSource(
      { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET },
      {
        fetch: tokenEndpoint(
          [
            async () => {
              await gate;
              return issued("shared")();
            },
          ],
          calls,
        ),
      },
    );
    const waiting = Promise.all([source(), source(), source()]);
    release();
    expect(await waiting).toEqual(["shared", "shared", "shared"]);
    expect(calls).toHaveLength(1);
  });

  test("a failed refresh keeps sending the still-valid token, then fails once it expires", async () => {
    let clock = 0;
    const calls: Call[] = [];
    const source = createAzureEntraAccessTokenSource(
      { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET },
      {
        fetch: tokenEndpoint(
          [
            issued("valid", 3_600),
            () => new Response("upstream", { status: 503 }),
            () => new Response("upstream", { status: 503 }),
          ],
          calls,
        ),
        now: () => clock,
      },
    );
    expect(await source()).toBe("valid");
    clock = 56 * 60_000;
    expect(await source()).toBe("valid");
    // Backed off: no second request right away.
    expect(await source()).toBe("valid");
    expect(calls).toHaveLength(2);
    clock = 60 * 60_000;
    const error = await source().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AzureEntraTokenError);
    expect((error as AzureEntraTokenError).reason).toBe("unavailable");
    expect((error as AzureEntraTokenError).retryable).toBe(true);
  });

  test("a refusal names Entra's codes but never the secret or its description", async () => {
    const source = createAzureEntraAccessTokenSource(
      { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET },
      {
        fetch: tokenEndpoint([
          () =>
            Response.json(
              {
                error: "invalid_client",
                error_description: `AADSTS7000215: Invalid client secret provided: ${SECRET}`,
                error_codes: [7000215],
              },
              { status: 401 },
            ),
        ]),
      },
    );
    const error = (await source().catch((caught: unknown) => caught)) as AzureEntraTokenError;
    expect(error).toBeInstanceOf(AzureEntraTokenError);
    expect(error.message).toBe(
      "Microsoft Entra ID refused a token (invalid_client, AADSTS7000215)",
    );
    expect(error.reason).toBe("rejected");
    expect(error.retryable).toBe(false);
    expect(error.code).toBe("invalid_client");
    expect(error.errorCodes).toEqual([7000215]);
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(SECRET);
  });

  test("discard drops a token the service refused, and only that token", async () => {
    const source = createAzureEntraAccessTokenSource(
      { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET },
      { fetch: tokenEndpoint([issued("revoked"), issued("replacement")]) },
    );
    expect(await source()).toBe("revoked");
    source.discard("some-older-token");
    expect(await source()).toBe("revoked");
    source.discard("revoked");
    expect(await source()).toBe("replacement");
    expect(await source()).toBe("replacement");
  });

  test("shared sources are keyed by the whole credential", () => {
    const config = { tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET };
    const first = sharedAzureEntraAccessTokenSource(config);
    expect(sharedAzureEntraAccessTokenSource({ ...config })).toBe(first);
    expect(sharedAzureEntraAccessTokenSource({ ...config, clientSecret: "other-secret" })).not.toBe(
      first,
    );
    expect(
      sharedAzureEntraAccessTokenSource({
        tenantId: TENANT,
        clientId: CLIENT,
        federatedTokenFile: "/token",
      }),
    ).not.toBe(first);
    expect(
      sharedAzureEntraAccessTokenSource(config, { scope: "https://ai.azure.com/.default" }),
    ).not.toBe(first);
  });

  test("a configuration is usable only with a token file or a secret", () => {
    expect(azureEntraCredentialConfigured({ tenantId: TENANT, clientId: CLIENT })).toBe(false);
    expect(
      azureEntraCredentialConfigured({ tenantId: TENANT, clientId: CLIENT, clientSecret: "x" }),
    ).toBe(true);
    expect(
      azureEntraCredentialConfigured({ tenantId: " ", clientId: CLIENT, federatedTokenFile: "/t" }),
    ).toBe(false);
    expect(azureEntraCredentialConfigured(undefined)).toBe(false);
  });
});
