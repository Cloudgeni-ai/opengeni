import { describe, expect, test } from "bun:test";
import {
  CapabilityCatalogItem,
  evaluateSetupReadiness,
  ReadyMadeSetup,
  type SetupConnection,
} from "@opengeni/contracts";

import {
  setupConnectionFacts,
  triggerAgentIdOf,
  viewerCanConnectItem,
  type SetupViewerRights,
} from "../src/agent-setup-readiness";

const GITHUB: SetupConnection = {
  provider: "github.com",
  name: "GitHub",
  required: true,
  why: "Opens the pull request.",
};
const POSTHOG: SetupConnection = {
  provider: "posthog.com",
  name: "PostHog",
  mcpUrl: "https://mcp.posthog.com/mcp",
  required: true,
  why: "Reads analytics.",
};
const SLACK: SetupConnection = {
  provider: "slack.com",
  name: "Slack",
  required: false,
  why: "Hears reports.",
};

function item(overrides: Record<string, unknown>) {
  return CapabilityCatalogItem.parse({
    id: "item",
    kind: "mcp",
    source: "registry",
    name: "Item",
    lifecycle: { status: "available", readiness: "setup_required" },
    ...overrides,
  });
}

const MEMBER: SetupViewerRights = {
  integrationAdmin: false,
  memberSetup: true,
  githubManage: false,
};
const LOCKED: SetupViewerRights = {
  integrationAdmin: false,
  memberSetup: false,
  githubManage: false,
};
const ADMIN: SetupViewerRights = { integrationAdmin: true, memberSetup: true, githubManage: true };

describe("setup readiness", () => {
  test("nothing connected: not ready, with the first reason in words and N of M", () => {
    const readiness = evaluateSetupReadiness({ connections: [GITHUB, SLACK] }, () => ({
      connected: false,
      canConnect: true,
      catalogItemId: null,
    }));
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe("Connect GitHub to turn this on.");
    expect(readiness.missing).toEqual([
      {
        kind: "connection",
        provider: "github.com",
        name: "GitHub",
        reason: "Connect GitHub to turn this on.",
      },
    ]);
    expect([readiness.requiredConnected, readiness.requiredTotal]).toEqual([0, 1]);
  });

  test("an optional connection never keeps it off", () => {
    const readiness = evaluateSetupReadiness({ connections: [GITHUB, SLACK] }, (connection) => ({
      connected: connection.provider === "github.com",
      canConnect: true,
      catalogItemId: null,
    }));
    expect(readiness.ready).toBe(true);
    expect(readiness.reason).toBeNull();
    expect([readiness.requiredConnected, readiness.requiredTotal]).toEqual([1, 1]);
  });

  test("someone who can't connect is told to ask an admin", () => {
    const readiness = evaluateSetupReadiness({ connections: [POSTHOG] }, () => ({
      connected: false,
      canConnect: false,
      catalogItemId: null,
    }));
    expect(readiness.reason).toBe("Ask an admin to connect PostHog.");
  });

  test("an item that declares nothing is ready", () => {
    const readiness = evaluateSetupReadiness(null, () => {
      throw new Error("not asked");
    });
    expect(readiness).toMatchObject({ ready: true, connections: [], missing: [] });
  });

  test("reuses a connection the viewer already has: any ready item of the provider counts", () => {
    const items = [
      item({ id: "gh-app", providerDomain: "github.com", surfaceType: "first_party_github" }),
      item({
        id: "gh-mine",
        providerDomain: "github.com",
        enabled: true,
        lifecycle: { status: "connected", readiness: "ready" },
      }),
    ];
    expect(setupConnectionFacts(items, GITHUB, LOCKED)).toEqual({
      connected: true,
      canConnect: true,
      catalogItemId: "gh-mine",
    });
  });

  test("matches an MCP connector by its address or its host's domain", () => {
    const byUrl = item({ id: "ph", mcpUrl: "https://mcp.posthog.com/mcp/" });
    expect(setupConnectionFacts([byUrl], POSTHOG, MEMBER)).toEqual({
      connected: false,
      canConnect: true,
      catalogItemId: "ph",
    });
    const byHost = item({ id: "slack", mcpUrl: "https://mcp.slack.com/sse" });
    expect(setupConnectionFacts([byHost], SLACK, MEMBER).catalogItemId).toBe("slack");
    expect(setupConnectionFacts([byHost], POSTHOG, MEMBER)).toEqual({
      connected: false,
      canConnect: false,
      catalogItemId: null,
    });
  });

  test("who may connect follows the Connect pages' rule", () => {
    const off = item({ id: "off", providerDomain: "linear.app" });
    expect(viewerCanConnectItem(off, MEMBER)).toBe(true);
    expect(viewerCanConnectItem(off, LOCKED)).toBe(false);
    expect(viewerCanConnectItem(off, ADMIN)).toBe(true);
    // Anyone may sign their own account in to an item that is on.
    const on = item({ id: "on", enabled: true, actions: ["connect"] });
    expect(viewerCanConnectItem(on, LOCKED)).toBe(true);
    // The workspace GitHub App needs github:manage, even for integration admins.
    const app = item({ id: "app", surfaceType: "first_party_github" });
    expect(viewerCanConnectItem(app, { ...ADMIN, githubManage: false })).toBe(false);
    expect(viewerCanConnectItem(app, { ...LOCKED, githubManage: true })).toBe(true);
  });

  test("finds the agent a trigger request starts", () => {
    expect(triggerAgentIdOf({ agentConfig: { agentId: "a-1" } })).toBe("a-1");
    expect(triggerAgentIdOf({ agentConfig: {} })).toBeNull();
    expect(triggerAgentIdOf(null)).toBeNull();
  });

  test("setup fields are optional with safe defaults, and strict", () => {
    expect(ReadyMadeSetup.parse({})).toEqual({
      connections: [],
      repository: null,
      worksWellWith: null,
      wontDoWithoutAsking: [],
      firstMessage: null,
      firstJob: null,
    });
    expect(ReadyMadeSetup.safeParse({ requiredAgents: ["pr-reviewer"] }).success).toBe(false);
  });
});
