import { describe, expect, test } from "bun:test";
import { CapabilityCatalogItem } from "@opengeni/contracts";
import type { Permission } from "@opengeni/sdk";
import {
  inChatConnectDecision,
  isAgentCapabilityRequest,
  type InChatConnectSupport,
} from "../src/components/conversation-capability-connect";
import type { AuthNeededItem } from "../src/timeline";

const mail = CapabilityCatalogItem.parse({
  id: "mcp:mail",
  name: "Mail",
  kind: "mcp",
  source: "built_in",
  authKind: "oauth2",
});
/** A reviewed catalog OAuth integration a person may turn on for their own account. */
const reviewed = CapabilityCatalogItem.parse({
  id: "mcp:mail",
  name: "Mail",
  kind: "mcp",
  source: "built_in",
  authKind: "oauth2",
  runtime: { available: true, notes: null },
});
const keyed = CapabilityCatalogItem.parse({
  id: "mcp:keyed",
  name: "Keyed",
  kind: "mcp",
  source: "built_in",
  authKind: "api_key",
});

function request(overrides: Partial<AuthNeededItem> = {}): AuthNeededItem {
  return {
    kind: "auth-needed",
    id: "event-1",
    turnId: "turn-1",
    serverId: "opengeni-capability",
    source: "capability",
    providerDomain: "mail.example",
    connectionId: null,
    reason: "not_connected",
    scopes: [],
    resource: null,
    toolName: null,
    authorizationUrl: null,
    capability: {
      id: "mcp:mail",
      name: "Mail",
      kind: "mcp",
      source: "built_in",
      action: "connect",
      rationale: "Read the inbox.",
      requiredVariables: [],
    },
    occurredAt: "2026-10-25T09:00:00.000Z",
    ...overrides,
  } as AuthNeededItem;
}

const CONNECT: Permission[] = [
  "sessions:control",
  "connections:read",
  "connections:write",
  "capabilities:manage",
];

function ready(
  permissions: Permission[],
  items: CapabilityCatalogItem[] = [mail, keyed],
): InChatConnectSupport {
  return {
    status: "ready",
    permissions: new Set(permissions),
    catalog: new Map(items.map((item) => [item.id, item])),
  };
}

describe("isAgentCapabilityRequest", () => {
  test("an agent's catalog card is a capability request", () => {
    expect(isAgentCapabilityRequest(request())).toBe(true);
  });

  test("host-managed, custom-setup, unavailable and own-flow cards are not", () => {
    expect(isAgentCapabilityRequest(request({ authoritySource: "host" }))).toBe(false);
    expect(isAgentCapabilityRequest(request({ capability: null }))).toBe(false);
    expect(isAgentCapabilityRequest(request({ reason: "unsupported_auth" }))).toBe(false);
    expect(isAgentCapabilityRequest(request({ reason: "personal_authority_unavailable" }))).toBe(
      false,
    );
    expect(
      isAgentCapabilityRequest(
        request({
          setupRequest: { name: "Custom", url: "https://mcp.example/mcp" } as never,
        }),
      ),
    ).toBe(false);
    for (const id of ["api:connected-machine", "api:github-app", "mcp:codex_apps"]) {
      expect(
        isAgentCapabilityRequest(request({ capability: { ...request().capability!, id } })),
      ).toBe(false);
    }
  });
});

describe("inChatConnectDecision", () => {
  test("offers the shared card when the grant covers every setup step", () => {
    expect(inChatConnectDecision(request(), ready(CONNECT), true)).toEqual({
      kind: "card",
      item: mail,
      personalOnly: false,
    });
  });

  test("leaves the default row while loading or when the proxy owns chat setup", () => {
    expect(inChatConnectDecision(request(), { status: "loading" }, true).kind).toBe("default");
    expect(inChatConnectDecision(request(), { status: "failed" }, true).kind).toBe("default");
    expect(inChatConnectDecision(request(), ready(CONNECT), false).kind).toBe("default");
  });

  test("host-managed connections keep their own row", () => {
    expect(
      inChatConnectDecision(request({ authoritySource: "host" }), ready(CONNECT), true).kind,
    ).toBe("default");
  });

  test("non-OAuth and unknown capabilities keep the default row", () => {
    const keyedRequest = request({
      capability: { ...request().capability!, id: "mcp:keyed", action: "add_credentials" },
    });
    expect(inChatConnectDecision(keyedRequest, ready(CONNECT), true).kind).toBe("default");
    expect(inChatConnectDecision(request(), ready(CONNECT, [keyed]), true).kind).toBe("default");
  });

  test("a person without connect authority sees that setup is unavailable here", () => {
    const conversationOnly: Permission[] = ["sessions:read", "sessions:control"];
    expect(inChatConnectDecision(request(), ready(conversationOnly), true).kind).toBe(
      "unavailable",
    );
    expect(
      inChatConnectDecision(
        request(),
        ready(["sessions:control", "connections:read", "connections:write"]),
        true,
      ).kind,
    ).toBe("unavailable");
  });

  test("an enabled capability needs no capabilities:manage", () => {
    const enabled = { ...mail, enabled: true };
    expect(
      inChatConnectDecision(
        request(),
        ready(["sessions:control", "connections:read", "connections:write"], [enabled]),
        true,
      ).kind,
    ).toBe("card");
  });

  test("connections:personal offers only the person's own account", () => {
    const narrow: Permission[] = ["sessions:control", "connections:personal"];
    expect(inChatConnectDecision(request(), ready(narrow, [reviewed]), true)).toEqual({
      kind: "card",
      item: reviewed,
      personalOnly: true,
    });
    // Each person's own account is already the binding: nothing to enable.
    const personalBinding = {
      ...mail,
      enabled: true,
      connectionRef: {
        providerDomain: "mail.example",
        kind: "oauth2",
        subjectScope: "subject" as const,
      },
    };
    expect(inChatConnectDecision(request(), ready(narrow, [personalBinding]), true)).toEqual({
      kind: "card",
      item: personalBinding,
      personalOnly: true,
    });
  });

  test("connections:personal never covers unreviewed, unavailable or shared setups", () => {
    const narrow: Permission[] = ["sessions:control", "connections:personal"];
    const custom = { ...reviewed, source: "manual" as const };
    const unavailable = { ...reviewed, runtime: { available: false, notes: null } };
    const untrusted = { ...reviewed, source: "registry" as const };
    for (const item of [custom, unavailable, untrusted, mail])
      expect(inChatConnectDecision(request(), ready(narrow, [item]), true).kind).toBe(
        "unavailable",
      );
    // Without chat control the card cannot add the tools to this chat.
    expect(
      inChatConnectDecision(request(), ready(["connections:personal"], [reviewed]), true).kind,
    ).toBe("unavailable");
  });

  test("an explicit grant does not treat workspace:admin as connect authority", () => {
    expect(
      inChatConnectDecision(
        request(),
        {
          status: "ready",
          permissions: new Set<Permission>(["sessions:control", "workspace:admin"]),
          permissionMode: "explicit",
          catalog: new Map([[reviewed.id, reviewed]]),
        },
        true,
      ).kind,
    ).toBe("unavailable");
  });

  test("a shared workspace account needs only read and chat control", () => {
    const shared = {
      ...mail,
      enabled: true,
      connectionRef: {
        connectionId: "connection-1",
        providerDomain: "mail.example",
        kind: "mcp-oauth",
        subjectScope: "workspace" as const,
      },
    };
    const personal = {
      ...shared,
      connectionRef: { ...shared.connectionRef, subjectScope: "subject" as const },
    };
    const readOnly: Permission[] = ["sessions:control", "connections:read"];
    expect(inChatConnectDecision(request(), ready(readOnly, [shared]), true).kind).toBe("card");
    expect(inChatConnectDecision(request(), ready(readOnly, [personal]), true).kind).toBe(
      "unavailable",
    );
  });
});
