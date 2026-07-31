import { describe, expect, test } from "bun:test";
import { OPENGENI_PERSONAL_SLACK_MCP_URL } from "@opengeni/contracts";

import type { CapabilityCatalogItem, ConnectionMetadata } from "@/types";
import {
  personalSlackAccountState,
  personalSlackCapability,
  personalSlackConnections,
  personalSlackOAuthTarget,
  preferredPersonalSlackConnection,
} from "./personal-slack";

function connection(overrides: Partial<ConnectionMetadata> = {}): ConnectionMetadata {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    accountId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    subjectId: "subject-a",
    providerDomain: "slack.com",
    kind: "oauth2",
    status: "active",
    grantedScopes: ["search:read.public", "chat:write"],
    expiresAt: new Date("2026-08-01T12:00:00Z").toISOString(),
    lastRefreshAt: null,
    lastUsedAt: null,
    lastError: null,
    version: 1,
    metadata: { mcpUrl: OPENGENI_PERSONAL_SLACK_MCP_URL },
    createdBySubjectId: "subject-a",
    updatedBySubjectId: "subject-a",
    createdAt: new Date("2026-07-31T10:00:00Z").toISOString(),
    updatedAt: new Date("2026-07-31T10:00:00Z").toISOString(),
    ...overrides,
  };
}

function capability(overrides: Partial<CapabilityCatalogItem> = {}): CapabilityCatalogItem {
  return {
    id: "mcp:personal-slack",
    kind: "mcp",
    source: "registry",
    name: "Slack personal",
    description: "Personal Slack",
    category: "integrations",
    tags: ["slack"],
    homepageUrl: "https://slack.com",
    endpointUrl: OPENGENI_PERSONAL_SLACK_MCP_URL,
    installUrl: null,
    authModel: "credential_ref",
    providerDomain: "slack.com",
    surfaceType: "mcp",
    transport: "streamable-http",
    mcpUrl: OPENGENI_PERSONAL_SLACK_MCP_URL,
    authKind: "oauth2",
    credentialFacts: [],
    tier: "verified",
    provenance: "test",
    logoAssetPath: null,
    importBatchId: null,
    stale: false,
    staleAt: null,
    tools: [],
    runtime: {
      available: true,
      mcpServerId: "personal-slack",
      transport: "streamable-http",
      notes: null,
      catalogTrust: { state: "trusted", reason: "trusted_source" },
    },
    enabled: true,
    enabledReason: null,
    connectionRef: {
      providerDomain: "slack.com",
      kind: "oauth2",
      subjectScope: "subject",
    },
    metadata: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("personal Slack account linking", () => {
  test("matches only the official subject-owned hosted MCP seam", () => {
    const item = capability();
    expect(personalSlackCapability([item])).toBe(item);
    expect(
      personalSlackCapability([
        capability({ mcpUrl: "https://slack.example.test/mcp", endpointUrl: null }),
      ]),
    ).toBeNull();

    const personal = connection();
    const workspaceBot = connection({
      id: crypto.randomUUID(),
      subjectId: null,
      kind: "app_install",
    });
    const nonOfficial = connection({
      id: crypto.randomUUID(),
      metadata: { mcpUrl: "https://slack.example.test/mcp" },
    });
    expect(personalSlackConnections([workspaceBot, nonOfficial, personal])).toEqual([personal]);
    expect(personalSlackOAuthTarget(item)).toEqual({
      providerDomain: "slack.com",
      mcpUrl: OPENGENI_PERSONAL_SLACK_MCP_URL,
    });
    expect(personalSlackOAuthTarget(item)).not.toHaveProperty("oauthClient");
  });

  test("prefers a usable row without losing a revoked reconnect target", () => {
    const revoked = connection({
      id: crypto.randomUUID(),
      status: "revoked",
      updatedAt: new Date("2026-07-31T12:00:00Z").toISOString(),
    });
    const active = connection({ updatedAt: new Date("2026-07-31T11:00:00Z").toISOString() });
    expect(preferredPersonalSlackConnection([revoked, active])?.id).toBe(active.id);
    expect(preferredPersonalSlackConnection([revoked])?.id).toBe(revoked.id);
  });

  test("keeps refreshable expiry distinct from reconnect-required and revoked states", () => {
    const now = new Date("2026-07-31T12:00:00Z");
    const expiredAt = new Date("2026-07-31T11:00:00Z").toISOString();

    expect(personalSlackAccountState(null, false, now)).toEqual({ state: "unverified" });
    expect(personalSlackAccountState(null, true, now)).toEqual({ state: "not_connected" });
    expect(
      personalSlackAccountState(connection({ expiresAt: expiredAt }), true, now),
    ).toMatchObject({
      state: "connected",
      accessTokenRefreshDue: true,
    });
    expect(
      personalSlackAccountState(
        connection({ status: "needs_reauth", expiresAt: expiredAt }),
        true,
        now,
      ),
    ).toMatchObject({ state: "reconnect_required", reason: "expired" });
    expect(
      personalSlackAccountState(connection({ status: "needs_reauth", expiresAt: null }), true, now),
    ).toMatchObject({ state: "reconnect_required", reason: "provider_rejected" });
    expect(personalSlackAccountState(connection({ status: "error" }), true, now)).toMatchObject({
      state: "reconnect_required",
      reason: "error",
    });
    expect(personalSlackAccountState(connection({ status: "revoked" }), true, now)).toMatchObject({
      state: "disconnected",
    });
  });
});
