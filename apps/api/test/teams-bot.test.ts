import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { testSettings } from "@opengeni/testing/settings";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  normalizeTeamsMessage,
  mintTeamsProof,
  verifyTeamsProof,
  teamsTenantEnabled,
  teamsServiceUrl,
} from "../src/integrations/teams-protocol";
import {
  registerTeamsBotRoutes,
  drainTeamsBotOnce,
  teamsTextParts,
} from "../src/integrations/teams-bot";
const tenant = "10000000-0000-4000-8000-000000000001";
const actor = "10000000-0000-4000-8000-000000000002";
const activity = () => ({
  type: "message",
  id: "message-1",
  timestamp: "2026-10-23T10:00:00Z",
  channelId: "msteams",
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  from: { id: "29:person", aadObjectId: actor },
  recipient: { id: "28:bot" },
  conversation: { id: "19:dm", conversationType: "personal", tenantId: tenant },
  channelData: { tenant: { id: tenant } },
  text: "Help me plan",
});
const configured = () =>
  testSettings({
    teamsBotClientId: actor,
    teamsBotClientSecret: "fake-client-secret",
    teamsBotTenantId: tenant,
    integrationsStateSecret: "fake-signing-secret",
    teamsBotAllowedTenantIds: [tenant],
  });
describe("Teams actor and transport boundary", () => {
  test("accepts exact personal message and stable provider-neutral identity", () => {
    const m = normalizeTeamsMessage(activity());
    expect(m?.actorId).toBe(actor);
    expect(m?.personal).toBe(true);
    expect(normalizeTeamsMessage({ ...activity(), text: "changed" })?.identity).toBe(m?.identity);
  });
  test("rejects bot, unknown/group conversations, missing Entra ID and mismatched tenants", () => {
    expect(
      normalizeTeamsMessage({
        ...activity(),
        from: { id: "bot", aadObjectId: actor, role: "bot" },
      }),
    ).toBeNull();
    expect(
      normalizeTeamsMessage({
        ...activity(),
        conversation: { id: "x", conversationType: "groupChat" },
      }),
    ).toBeNull();
    expect(normalizeTeamsMessage({ ...activity(), from: { id: "person" } })).toBeNull();
    expect(
      normalizeTeamsMessage({
        ...activity(),
        conversation: { id: "x", conversationType: "personal", tenantId: actor },
      }),
    ).toBeNull();
  });
  test("requires bot mention for channel work and keeps human text", () => {
    const channel = {
      ...activity(),
      conversation: { id: "19:channel", conversationType: "channel" },
      channelData: { tenant: { id: tenant }, channel: { id: "19:channel" } },
      text: "<at>Opengeni</at> Compare plans",
    };
    expect(normalizeTeamsMessage(channel)).toBeNull();
    const m = normalizeTeamsMessage({
      ...channel,
      entities: [{ type: "mention", mentioned: { id: "28:bot" }, text: "<at>Opengeni</at>" }],
    });
    expect(m?.text).toBe("Compare plans");
    expect(m?.threadId).toBe("message-1");
  });
  test.each([
    "http://smba.trafficmanager.net/",
    "https://smba.trafficmanager.net.evil.test/",
    "https://localhost/",
    "https://smba.trafficmanager.net@evil.test/",
    "https://smba.trafficmanager.net/?redirect=x",
  ])("rejects untrusted service URL %s", (value) => expect(() => teamsServiceUrl(value)).toThrow());
  test("rollout is denied unless configured and tenant enabled", () => {
    expect(teamsTenantEnabled(testSettings(), tenant)).toBe(false);
    expect(teamsTenantEnabled(configured(), tenant)).toBe(true);
    expect(teamsTenantEnabled(configured(), actor)).toBe(false);
  });
  test("setup/link proof binds actor, purpose, workspace, generation and expiry", () => {
    const now = Date.now();
    const input = {
      purpose: "setup" as const,
      tenantId: tenant,
      actorId: actor,
      workspaceId: null,
      generation: null,
    };
    const token = mintTeamsProof("secret", input, now);
    expect(verifyTeamsProof("secret", token, now).actorId).toBe(actor);
    expect(() => verifyTeamsProof("wrong", token, now)).toThrow();
    expect(() => verifyTeamsProof("secret", token, now + 600001)).toThrow();
    expect(() => verifyTeamsProof("secret", `${token}x`, now)).toThrow();
  });
  test("no session/provider/database access occurs with rollout disabled", async () => {
    const deps = {
      settings: testSettings(),
      db: new Proxy(
        {},
        {
          get() {
            throw new Error("DB touched");
          },
        },
      ),
    } as unknown as ApiRouteDeps;
    await drainTeamsBotOnce(deps);
    const app = new Hono();
    registerTeamsBotRoutes(app, deps);
    expect(
      (
        await app.request("/v1/integrations/teams/messages", {
          method: "POST",
          body: JSON.stringify(activity()),
        })
      ).status,
    ).toBe(404);
  });
  test("rejects unsigned activities before touching persistence", async () => {
    const deps = {
      settings: configured(),
      db: new Proxy(
        {},
        {
          get() {
            throw new Error("Unauthenticated DB access");
          },
        },
      ),
    } as unknown as ApiRouteDeps;
    const app = new Hono();
    registerTeamsBotRoutes(app, deps);
    const response = await app.request("/v1/integrations/teams/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(activity()),
    });
    expect(response.status).toBe(401);
  });
  test("text delivery splits without loss including multibyte Unicode", () => {
    const text = "🦉 hello ".repeat(12000);
    const parts = teamsTextParts(text);
    expect(parts.join("")).toBe(text);
    expect(parts.every((p) => Buffer.byteLength(p) <= 20000)).toBe(true);
  });
});

test.each(["https://login.microsoftonline.com/example/v2.0", "https://api.botframework.com"])(
  "rejects unsigned JWT claiming issuer %s before persistence",
  async (issuer) => {
    const deps = {
      settings: configured(),
      db: new Proxy(
        {},
        {
          get() {
            throw new Error("Unauthenticated DB access");
          },
        },
      ),
    } as unknown as ApiRouteDeps;
    const token = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: issuer, aud: actor, exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url")}.`;
    const app = new Hono();
    registerTeamsBotRoutes(app, deps);
    const result = await app.request("/v1/integrations/teams/messages", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(activity()),
    });
    expect(result.status).toBe(401);
  },
);
