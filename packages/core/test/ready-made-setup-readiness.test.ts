import { describe, expect, test } from "bun:test";
import {
  CapabilityCatalogItem,
  evaluateSetupReadiness,
  ReadyMadeSetup,
  type SetupConnection,
} from "@opengeni/contracts";

import {
  githubSetupFacts,
  isAgentSetupIncompleteCause,
  requireAgentTriggerReady,
  setSetupReadinessMetricsSink,
  setupConnectionFacts,
  templateTriggerUsesGitHubEvents,
  viewerCanConnectItem,
  type GitHubSetupFacts,
  type SetupViewerRights,
} from "../src/domain/ready-made-setup-readiness";
import { agentTemplateByKey } from "../src/agent-templates";

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
  grant: { permissions: ["connections:personal", "connections:read", "connections:write"] },
  memberIntegrationSetup: "members",
  githubManage: false,
};
const LOCKED: SetupViewerRights = {
  grant: { permissions: ["sessions:read"] },
  memberIntegrationSetup: "members",
  githubManage: false,
};
const ADMIN: SetupViewerRights = {
  grant: { permissions: ["workspace:admin"] },
  memberIntegrationSetup: "members",
  githubManage: true,
};
const NO_GITHUB: GitHubSetupFacts = {
  appInstalled: false,
  personalConnected: false,
  canConnectApp: false,
  canConnectPersonal: false,
};

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
    // An organization that keeps turning integrations on for admins.
    expect(viewerCanConnectItem(off, { ...MEMBER, memberIntegrationSetup: "admins" })).toBe(false);
    // Anyone may sign their own account in to an item that is on.
    const on = item({ id: "on", enabled: true, actions: ["connect"] });
    expect(viewerCanConnectItem(on, LOCKED)).toBe(true);
    // The workspace GitHub App needs github:manage, even for integration admins.
    const app = item({ id: "app", surfaceType: "first_party_github" });
    expect(viewerCanConnectItem(app, { ...ADMIN, githubManage: false })).toBe(false);
    expect(viewerCanConnectItem(app, { ...LOCKED, githubManage: true })).toBe(true);
  });

  test("an organization's connector that is unavailable here is for its admins", () => {
    const orgItem = item({
      id: "org",
      providerDomain: "linear.app",
      lifecycle: { status: "available", readiness: "unavailable", managedBy: "organization" },
    });
    expect(viewerCanConnectItem(orgItem, ADMIN)).toBe(false);
    expect(viewerCanConnectItem(orgItem, MEMBER)).toBe(false);
  });

  test("GitHub isn't a catalog item: the App or one's own GitHub, with an empty catalog", () => {
    const app = { ...NO_GITHUB, appInstalled: true };
    const personal = { ...NO_GITHUB, personalConnected: true };
    expect(setupConnectionFacts([], GITHUB, LOCKED, app)).toEqual({
      connected: true,
      canConnect: true,
      catalogItemId: null,
    });
    expect(setupConnectionFacts([], GITHUB, LOCKED, personal).connected).toBe(true);
    expect(
      setupConnectionFacts([], GITHUB, LOCKED, { ...NO_GITHUB, canConnectPersonal: true }),
    ).toEqual({ connected: false, canConnect: true, catalogItemId: null });
    expect(setupConnectionFacts([], GITHUB, LOCKED, NO_GITHUB).canConnect).toBe(false);
    // Without GitHub facts an empty catalog means not connected.
    expect(setupConnectionFacts([], GITHUB, ADMIN).connected).toBe(false);
  });

  test("a trigger on GitHub events needs the GitHub App: one's own GitHub isn't enough", () => {
    const events = { githubEvents: true };
    const personal = { ...NO_GITHUB, personalConnected: true, canConnectPersonal: true };
    expect(setupConnectionFacts([], GITHUB, LOCKED, personal, events)).toEqual({
      connected: false,
      canConnect: false,
      catalogItemId: null,
    });
    expect(
      setupConnectionFacts([], GITHUB, LOCKED, { ...personal, canConnectApp: true }, events),
    ).toEqual({ connected: false, canConnect: true, catalogItemId: null });
    expect(
      setupConnectionFacts([], GITHUB, LOCKED, { ...NO_GITHUB, appInstalled: true }, events)
        .connected,
    ).toBe(true);
    // A GitHub MCP connector is fine on a schedule, not for GitHub events.
    const mcp = item({
      id: "gh-mcp",
      providerDomain: "github.com",
      enabled: true,
      lifecycle: { status: "connected", readiness: "ready" },
    });
    expect(setupConnectionFacts([mcp], GITHUB, LOCKED, NO_GITHUB).connected).toBe(true);
    expect(setupConnectionFacts([mcp], GITHUB, LOCKED, NO_GITHUB, events).connected).toBe(false);
  });

  test("which trigger runs on GitHub events: the named one, else the one Enable turns on", () => {
    const reviewer = agentTemplateByKey("pr-reviewer")!;
    const scanner = agentTemplateByKey("cve-scanner")!;
    expect(templateTriggerUsesGitHubEvents(reviewer)).toBe(true);
    expect(templateTriggerUsesGitHubEvents(scanner, "Every Monday morning")).toBe(false);
    expect(templateTriggerUsesGitHubEvents(scanner, "When a pull request opens")).toBe(true);
  });

  test("who may connect GitHub: github:manage with the App configured, or personal GitHub", async () => {
    const grant = { accountId: "acc", workspaceId: "ws", subjectId: null } as never;
    const db = {} as never;
    const none = { githubAppId: "", githubAppPrivateKey: "", githubPersonalOauthEnabled: false };
    expect(
      await githubSetupFacts({ db, settings: none as never }, grant, { githubManage: true }),
    ).toEqual(NO_GITHUB);
    const personal = { ...none, githubPersonalOauthEnabled: true };
    expect(
      await githubSetupFacts({ db, settings: personal as never }, grant, { githubManage: false }),
    ).toEqual({ ...NO_GITHUB, canConnectPersonal: true });
    // The App is configured but this workspace's installations can't be read: not installed.
    const app = { ...none, githubAppId: "1", githubAppPrivateKey: "key" };
    expect(
      await githubSetupFacts({ db, settings: app as never }, grant, { githubManage: true }),
    ).toEqual({ ...NO_GITHUB, canConnectApp: true });
    expect(
      await githubSetupFacts({ db, settings: app as never }, grant, { githubManage: false }),
    ).toEqual(NO_GITHUB);
  });

  test("a trigger with no agent, or a check that can't be read, never blocks", async () => {
    const grant = { accountId: "acc", workspaceId: "ws", subjectId: "s" } as never;
    const deps = { db: {} as never, settings: {} as never };
    await expect(requireAgentTriggerReady(deps, grant, null)).resolves.toBeUndefined();
    const counted: unknown[] = [];
    setSetupReadinessMetricsSink({ incrementCounter: (input) => void counted.push(input) });
    await expect(requireAgentTriggerReady(deps, grant, "agent-1")).resolves.toBeUndefined();
    // It doesn't block, but an outage shows: logged and counted.
    expect(counted).toEqual([
      expect.objectContaining({ name: "opengeni_agent_setup_readiness_unchecked_total" }),
    ]);
    setSetupReadinessMetricsSink(null);
    expect(isAgentSetupIncompleteCause({ code: "agent_setup_incomplete", missing: [] })).toBe(true);
    expect(isAgentSetupIncompleteCause({ code: "other" })).toBe(false);
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
