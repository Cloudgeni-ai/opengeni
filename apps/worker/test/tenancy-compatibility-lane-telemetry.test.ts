// Tenancy validate phase: the two connection compatibility lanes must be countable
// while they are still live, so an operator can watch them drain. The counter
// is content-free (lane name only) and must never change what the credential
// resolution actually returns.
import { describe, expect, test } from "bun:test";
import type { SessionTurn } from "@opengeni/contracts";
import type { Database, resolveAcceptedConnectionUse } from "@opengeni/db";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing";
import { connectionTokenResolverForTurn } from "../src/activities/mcp-credentials";

type AuthorizeInput = Parameters<typeof resolveAcceptedConnectionUse>[1];
type Authorization = Awaited<ReturnType<typeof resolveAcceptedConnectionUse>>;

const turn = {
  id: "turn-1",
  executionGeneration: 4,
  personalConnectionDelegations: [],
  initiator: { kind: "subject", subjectId: "user:someone", label: "Someone" },
  initiatorContext: { source: "test" },
} as unknown as SessionTurn;

function observability() {
  return createObservability(
    {
      serviceName: "opengeni",
      environment: "test",
      deploymentRevision: "revision-test",
      observabilityStructuredLogs: false,
      observabilityMetricsEnabled: true,
      observabilityOtlpHeaders: "",
    },
    { component: "worker-turn", now: () => 1 },
  );
}

async function laneCount(
  obs: ReturnType<typeof observability>,
  lane: string,
): Promise<number | null> {
  const line = (await obs.prometheusMetrics())
    .split("\n")
    .find(
      (candidate) =>
        candidate.startsWith("opengeni_tenancy_compatibility_lane_uses_total{") &&
        candidate.includes(`lane="${lane}"`),
    );
  if (!line) return null;
  return Number(line.slice(line.lastIndexOf(" ") + 1));
}

function resolverFor(input: {
  obs: ReturnType<typeof observability>;
  authorize?: (authority: AuthorizeInput) => Authorization;
}) {
  return connectionTokenResolverForTurn({
    db: {} as Database,
    settings: testSettings(),
    accountId: "account-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    rootSessionId: "session-root",
    attemptId: "attempt-1",
    turn,
    observability: input.obs,
    isSessionTenancyProductActivated: async () => false,
    ...(input.authorize
      ? { authorizeAcceptedUse: async (_db, authority) => input.authorize!(authority) }
      : {}),
    connectionCredentials: {
      mcpCredentials: async (request) => ({
        status: "ok",
        accountId: request.accountId,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        headers: { Authorization: "Bearer resolved" },
        connectionId: request.connectionRef.connectionId ?? "connection-ws",
        providerDomain: request.connectionRef.providerDomain,
        ...(request.connectionRef.provider ? { provider: request.connectionRef.provider } : {}),
      }),
    },
  });
}

const request = {
  workspaceId: "workspace-1",
  serverId: "linear",
  destinationUrl: "https://mcp.linear.app/mcp",
  toolName: "create_issue",
  connectionRef: {
    provider: "linear",
    providerDomain: "linear.app",
    connectionId: "connection-ws",
    kind: "oauth2" as const,
    subjectScope: "workspace" as const,
  },
};

function authorizedAs(scope: "workspace" | "legacy_user"): Authorization {
  return {
    status: "authorized",
    originWorkspaceId: "workspace-1",
    connectionKind: "oauth2",
    attribution: {
      organizationId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      connectionId: "connection-ws",
      connectionGeneration: 2,
      scope,
      ownerSubjectId: scope === "legacy_user" ? "user:someone" : null,
      authorityId: null,
      grantId: null,
    },
  };
}

describe("tenancy compatibility lane telemetry", () => {
  test("counts the pre-snapshot ref lane, which leaves no durable audit fact", async () => {
    const obs = observability();
    const resolver = resolverFor({ obs });
    const result = await resolver({
      ...request,
      connectionRef: {
        provider: "linear",
        providerDomain: "linear.app",
        kind: "oauth2" as const,
        subjectScope: "workspace" as const,
      },
    });

    expect(result.status).toBe("ok");
    expect(await laneCount(obs, "connection_pre_snapshot_ref")).toBe(1);
    expect(await laneCount(obs, "connection_legacy_user")).toBe(0);
    // Content-free: the server id, provider domain, and workspace never appear.
    const metrics = await obs.prometheusMetrics();
    const laneLines = metrics
      .split("\n")
      .filter((line) => line.startsWith("opengeni_tenancy_compatibility_lane_uses_total{"))
      .join("\n");
    expect(laneLines).not.toContain("linear");
    expect(laneLines).not.toContain("workspace-1");
  });

  test("counts a legacy_user connection use and leaves the activated lane at zero", async () => {
    const obs = observability();
    const legacy = resolverFor({ obs, authorize: () => authorizedAs("legacy_user") });
    expect((await legacy(request)).status).toBe("ok");
    expect(await laneCount(obs, "connection_legacy_user")).toBe(1);
    expect(await laneCount(obs, "connection_pre_snapshot_ref")).toBe(0);

    const activated = resolverFor({ obs, authorize: () => authorizedAs("workspace") });
    expect((await activated(request)).status).toBe("ok");
    // The activated workspace lane is not a compatibility lane and must not
    // inflate the counter an operator uses as the drain gate.
    expect(await laneCount(obs, "connection_legacy_user")).toBe(1);
  });

  test("a denied use is not a compatibility-lane use", async () => {
    const obs = observability();
    const resolver = resolverFor({
      obs,
      authorize: () => ({ status: "denied", reason: "connection_status_inactive" }),
    });
    expect((await resolver(request)).status).toBe("auth_needed");
    expect(await laneCount(obs, "connection_legacy_user")).toBe(0);
    expect(await laneCount(obs, "connection_pre_snapshot_ref")).toBe(0);
  });

  test("resolution still succeeds with no observability wired at all", async () => {
    const resolver = connectionTokenResolverForTurn({
      db: {} as Database,
      settings: testSettings(),
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      rootSessionId: "session-root",
      attemptId: "attempt-1",
      turn,
      isSessionTenancyProductActivated: async () => false,
      connectionCredentials: {
        mcpCredentials: async (hostRequest) => ({
          status: "ok",
          accountId: hostRequest.accountId,
          workspaceId: hostRequest.workspaceId,
          sessionId: hostRequest.sessionId,
          headers: { Authorization: "Bearer resolved" },
          connectionId: "connection-ws",
          providerDomain: hostRequest.connectionRef.providerDomain,
          ...(hostRequest.connectionRef.provider
            ? { provider: hostRequest.connectionRef.provider }
            : {}),
        }),
      },
    });
    const result = await resolver({
      ...request,
      connectionRef: {
        provider: "linear",
        providerDomain: "linear.app",
        kind: "oauth2" as const,
        subjectScope: "workspace" as const,
      },
    });
    expect(result.status).toBe("ok");
  });
});
