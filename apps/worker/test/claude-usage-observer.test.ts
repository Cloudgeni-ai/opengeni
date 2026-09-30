import { expect, test } from "bun:test";
import { parseModelProvidersJson } from "@opengeni/config";
import {
  createClaudeUsageObserver,
  type CapturedClaudeUsage,
} from "../src/activities/agent-turn/claude-usage-observer";

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
  const latest = new Map<"workspace" | "organization", CapturedClaudeUsage>();
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
  expect(latest.get("workspace")).toMatchObject({
    expectedConnectionId: "original",
    expectedCredentialVersion: 7,
  });
  expect(latest.get("workspace")!.observation!.windows.map((window) => window.usedPercent)).toEqual(
    [30, 60],
  );
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
    const latest = new Map<"workspace" | "organization", CapturedClaudeUsage>();
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
  const latest = new Map<"workspace" | "organization", CapturedClaudeUsage>();
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
  expect(latest.get("workspace")!.token).toBe("sk-ant-oat01-renewed");
  observe.renew("workspace-claude-subscription", {
    token: "sk-ant-oat01-replaced",
    connectionId: id,
    credentialVersion: 8,
  });
  expect(observe.binding("workspace-claude-subscription")!.token).toBe("sk-ant-oat01-renewed");
});
