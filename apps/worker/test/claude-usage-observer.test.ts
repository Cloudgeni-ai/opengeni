import { expect, test } from "bun:test";
import { parseModelProvidersJson } from "@opengeni/config";
import {
  createClaudeUsageObserver,
  ClaudeSubscriptionConnectionUnavailable,
  type CapturedClaudeUsage,
} from "../src/activities/agent-turn/claude-usage-observer";
import { agentRunFailurePayload } from "../src/activities/agent-turn/errors";
import { withClaudeUsageObserver } from "../../../packages/runtime/src/claude-subscription-usage";
import { instrumentedModelFetch } from "../../../packages/runtime/src/model-provider-client";

const providers = parseModelProvidersJson(
  JSON.stringify([
    {
      id: "workspace-claude-subscription",
      kind: "claude-subscription-workspace",
      api: "anthropic-messages",
      apiKey: "sk-ant-oat01-fixture",
      baseUrl: "https://api.anthropic.com",
      models: [
        { id: "workspace-claude-subscription/claude-opus-5-5", upstreamModelId: "claude-opus-5-5" },
      ],
    },
  ]),
);

test("worker observations retain their captured identity and merge partial model responses", async () => {
  const latest = new Map<string, CapturedClaudeUsage>();
  const observe = await createClaudeUsageObserver(providers, latest, async () => ({
    token: "sk-ant-oat01-fixture",
    connectionId: "original",
    credentialVersion: 7,
  }));
  observe(
    "workspace-claude-subscription",
    new Response(null, { headers: { "anthropic-ratelimit-unified-5h-utilization": ".3" } }),
  );
  observe(
    "workspace-claude-subscription",
    new Response(null, { headers: { "anthropic-ratelimit-unified-7d-utilization": ".6" } }),
  );
  expect([...latest.values()][0]).toMatchObject({
    expectedConnectionId: "original",
    expectedCredentialVersion: 7,
  });
  expect([...latest.values()][0]!.observation!.windows.map((window) => window.usedPercent)).toEqual(
    [30, 60],
  );
});

test("one account's parallel model calls retain separate failure receipts", async () => {
  const latest = new Map<string, CapturedClaudeUsage>();
  const observe = await createClaudeUsageObserver(providers, latest, async () => ({
    token: "sk-ant-oat01-fixture",
    connectionId: "original",
    credentialVersion: 7,
  }));
  observe(
    "workspace-claude-subscription",
    new Response(null, { status: 429 }),
    "claude-opus-fixture",
  );
  observe(
    "workspace-claude-subscription",
    new Response(null, { headers: { "anthropic-ratelimit-unified-5h-utilization": ".2" } }),
    "claude-sonnet-fixture",
  );
  expect(latest.size).toBe(2);
  expect(
    [...latest.values()].find((value) => value.upstreamModelId === "claude-opus-fixture"),
  ).toMatchObject({ responseStatus: 429, expectedCredentialVersion: 7 });
  expect(
    [...latest.values()].find((value) => value.upstreamModelId === "claude-sonnet-fixture"),
  ).toMatchObject({ responseStatus: 200 });
});
test("failed or mismatched telemetry binding never observes a replacement credential", async () => {
  for (const read of [
    async () => {
      throw new Error("Database unavailable");
    },
    async () => ({
      token: "sk-ant-oat01-different",
      connectionId: "replacement",
      credentialVersion: 8,
    }),
  ]) {
    const latest = new Map<string, CapturedClaudeUsage>();
    const observe = await createClaudeUsageObserver(providers, latest, read);
    expect(() =>
      observe(
        "workspace-claude-subscription",
        new Response(null, {
          status: 401,
          headers: { "anthropic-ratelimit-unified-5h-utilization": "1" },
        }),
      ),
    ).not.toThrow();
    expect(latest.size).toBe(0);
  }
});

test("account and generation observations never merge within the same scope", async () => {
  const latest = new Map<string, CapturedClaudeUsage>();
  for (const [connectionId, credentialVersion, fraction] of [
    ["11111111-1111-4111-8111-111111111111", 1, ".1"],
    ["22222222-2222-4222-8222-222222222222", 1, ".2"],
    ["11111111-1111-4111-8111-111111111111", 2, ".3"],
  ] as const) {
    const bound = parseModelProvidersJson(
      JSON.stringify(
        providers.map((provider) => ({
          ...provider,
          anthropic: { auth: "oauth", credentialBinding: { connectionId, credentialVersion } },
        })),
      ),
    );
    const observe = await createClaudeUsageObserver(bound, latest, async () => null);
    observe(
      bound[0]!.id,
      new Response(null, {
        headers: { "anthropic-ratelimit-unified-5h-utilization": fraction },
      }),
      "claude-opus-5-5",
    );
  }
  expect(latest.size).toBe(3);
  expect(
    [...latest.values()].map((item) => [
      item.expectedConnectionId,
      item.expectedCredentialVersion,
      item.observation!.windows[0]!.usedPercent,
    ]),
  ).toEqual([
    ["11111111-1111-4111-8111-111111111111", 1, 10],
    ["22222222-2222-4222-8222-222222222222", 1, 20],
    ["11111111-1111-4111-8111-111111111111", 2, 30],
  ]);
});

test("a late authentication failure belongs to its dispatched token, not a concurrent renewal", async () => {
  const latest = new Map<string, CapturedClaudeUsage>();
  const observe = await createClaudeUsageObserver(providers, latest, async () => ({
    token: providers[0]!.apiKey!,
    connectionId: "original",
    credentialVersion: 7,
  }));
  let finishOld!: (response: Response) => void;
  let startedOld!: () => void;
  const started = new Promise<void>((resolve) => {
    startedOld = resolve;
  });
  const dispatched: string[] = [];
  const fetcher = instrumentedModelFetch(providers[0]!.id, (async (_input, init) => {
    const auth = new Headers(init?.headers).get("authorization")!;
    dispatched.push(auth);
    if (dispatched.length === 1) {
      startedOld();
      return new Promise<Response>((resolve) => {
        finishOld = resolve;
      });
    }
    return new Response(null, { headers: { "anthropic-ratelimit-unified-5h-utilization": ".2" } });
  }) as typeof fetch);
  let token = providers[0]!.apiKey!;
  await withClaudeUsageObserver(
    observe,
    async () => {
      const old = fetcher("https://example.test/v1/messages", { method: "POST", body: "{}" });
      await started;
      token = "sk-ant-oat01-renewed-fixture";
      await fetcher("https://example.test/v1/messages", { method: "POST", body: "{}" });
      finishOld(new Response(null, { status: 401 }));
      await old;
    },
    (id, headers) =>
      observe.prepareRequestWithObserver(id, headers, async () => ({
        token,
        connectionId: "original",
        credentialVersion: 7,
      })),
  );
  expect(dispatched).toEqual([`Bearer ${providers[0]!.apiKey}`, `Bearer ${token}`]);
  expect(latest.size).toBe(2);
  expect([...latest.values()].find((item) => item.token === token)?.refresh).toBeUndefined();
  expect(
    [...latest.values()].find((item) => item.token === providers[0]!.apiKey)?.refresh?.status,
  ).toBe("reconnect");
  expect([...latest.keys()].every((key) => !key.includes("sk-ant-oat01"))).toBe(true);
});

test("native generation bindings survive another replica renewing between catalog load and dispatch", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const bound = parseModelProvidersJson(
    JSON.stringify(
      providers.map((provider) => ({
        ...provider,
        anthropic: {
          auth: "oauth",
          credentialBinding: { connectionId: id, credentialVersion: 7 },
        },
      })),
    ),
  );
  const latest = new Map<string, CapturedClaudeUsage>();
  const observe = await createClaudeUsageObserver(bound, latest, async () => ({
    token: "sk-ant-oat01-renewed",
    connectionId: id,
    credentialVersion: 7,
  }));
  expect(observe.binding("workspace-claude-subscription")).toMatchObject({
    expectedConnectionId: id,
    expectedCredentialVersion: 7,
  });
  observe.renew("workspace-claude-subscription", {
    token: "sk-ant-oat01-renewed",
    connectionId: id,
    credentialVersion: 7,
  });
  observe(
    "workspace-claude-subscription",
    new Response(null, {
      headers: { "anthropic-ratelimit-unified-5h-utilization": ".4" },
    }),
  );
  expect([...latest.values()][0]!.token).toBe("sk-ant-oat01-renewed");
  observe.renew("workspace-claude-subscription", {
    token: "sk-ant-oat01-replaced",
    connectionId: id,
    credentialVersion: 8,
  });
  expect(observe.binding("workspace-claude-subscription")!.token).toBe("sk-ant-oat01-renewed");
});

test.each(["workspace", "organization"] as const)(
  "physical %s requests renew the same generation and stop when its connection changes",
  async (scope) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const providerId = `${scope}-claude-subscription`;
    const bound = parseModelProvidersJson(
      JSON.stringify(
        providers.map((provider) => ({
          ...provider,
          id: providerId,
          kind: `claude-subscription-${scope}`,
          anthropic: {
            auth: "oauth",
            credentialBinding: { connectionId: id, credentialVersion: 7 },
          },
          models: provider.models.map((model) => ({
            ...model,
            id: `${providerId}/claude-opus-5-5`,
          })),
        })),
      ),
    );
    const observe = await createClaudeUsageObserver(bound, new Map(), async () => {
      throw new Error("Captured generation needs no fallback lookup");
    });
    const renewed = { token: "sk-ant-oat01-renewed", connectionId: id, credentialVersion: 7 };
    const headers = new Headers({
      authorization: "Bearer sk-ant-oat01-fixture",
      "x-api-key": "fixture",
    });
    await observe.prepareRequest(providerId, headers, async (binding) => {
      expect(binding).toEqual({ scope, expectedConnectionId: id, expectedCredentialVersion: 7 });
      return renewed;
    });
    expect(headers.get("authorization")).toBe("Bearer sk-ant-oat01-renewed");
    expect(headers.has("x-api-key")).toBe(false);
    expect(observe.binding(providerId)!.token).toBe(renewed.token);
    for (const credential of [
      null,
      { ...renewed, credentialVersion: 8 },
      { ...renewed, connectionId: "replacement" },
    ]) {
      let dispatched = 0;
      const send = async () => {
        await observe.prepareRequest(providerId, headers, async () => credential);
        dispatched++;
      };
      await expect(send()).rejects.toBeInstanceOf(ClaudeSubscriptionConnectionUnavailable);
      expect(dispatched).toBe(0);
      expect(observe.binding(providerId)!.token).toBe(renewed.token);
    }
  },
);

test("unbound managed subscriptions stop while other provider credentials remain untouched", async () => {
  const observe = await createClaudeUsageObserver(providers, new Map(), async () => null);
  const headers = new Headers({ authorization: "Bearer fixture" });
  let lookups = 0;
  const resolve = async () => {
    lookups++;
    return null;
  };
  await expect(
    observe.prepareRequest("workspace-claude-subscription", headers, resolve),
  ).rejects.toBeInstanceOf(ClaudeSubscriptionConnectionUnavailable);
  expect(await observe.prepareRequest("registry-claude", headers, resolve)).toBe(headers);
  expect(lookups).toBe(0);
  expect(headers.get("authorization")).toBe("Bearer fixture");
  expect(agentRunFailurePayload(new ClaudeSubscriptionConnectionUnavailable())).toEqual({
    error:
      "Claude connection changed or was disconnected. Start a new turn with the current connection.",
    code: "claude_subscription_connection_changed",
    retryable: false,
  });
});

test("renewal failures propagate without dispatching the captured token", async () => {
  const observe = await createClaudeUsageObserver(providers, new Map(), async () => ({
    token: "sk-ant-oat01-fixture",
    connectionId: "original",
    credentialVersion: 7,
  }));
  const reason = new Error("Synthetic refresh unavailable");
  await expect(
    observe.prepareRequest("workspace-claude-subscription", new Headers(), async () => {
      throw reason;
    }),
  ).rejects.toBe(reason);
});

test("parallel same-model requests preserve exact rejected and successful stream receipts", async () => {
  const latest = new Map<string, CapturedClaudeUsage>();
  const observe = await createClaudeUsageObserver(providers, latest, async () => ({
    token: providers[0]!.apiKey!,
    connectionId: "original",
    credentialVersion: 7,
  }));
  for (const [requestId, status] of [
    ["synthetic-main", 429],
    ["synthetic-title", 200],
    ["synthetic-second", 401],
  ] as const) {
    observe(
      providers[0]!.id,
      new Response(null, {
        status,
        headers: { "request-id": requestId, "anthropic-ratelimit-unified-5h-utilization": ".2" },
      }),
      "claude-opus-fixture",
    );
  }
  // A stream can fail after its HTTP 200 response, without quota headers.
  observe(
    providers[0]!.id,
    new Response(null, { headers: { "request-id": "synthetic-stream" } }),
    "claude-opus-fixture",
  );
  expect(
    [...latest.values()].map(({ requestId, responseStatus }) => [requestId, responseStatus]),
  ).toEqual([
    ["synthetic-main", 429],
    ["synthetic-title", 200],
    ["synthetic-second", 401],
    ["synthetic-stream", 200],
  ]);
});
