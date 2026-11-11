import { describe, expect, test } from "bun:test";
import { integrationDefinitionById } from "@opengeni/capabilities";
import { integrationDefinitionCapabilityRecommendations } from "@opengeni/core";
import type { ApiIntegrationRuntime } from "@opengeni/db";
import {
  chatToolSelectionIncludes,
  integrationDefinitionSetup,
} from "../src/mcp/integration-definition-capabilities";

const [outlook] = integrationDefinitionCapabilityRecommendations([
  integrationDefinitionById("microsoft-outlook-mail")!,
]);

function instance(
  overrides: Partial<Pick<ApiIntegrationRuntime, "definitionId" | "connectionStatus">> = {},
): ApiIntegrationRuntime {
  return {
    definitionId: "microsoft-outlook-mail",
    serverId: "outlook_mail_1",
    connectionRef: {
      connectionId: "11111111-1111-4111-8111-111111111111",
      providerDomain: "graph.microsoft.com",
      subjectScope: "subject",
    },
    connectionStatus: "active",
    ...overrides,
  } as ApiIntegrationRuntime;
}

const inChat = (...instances: ApiIntegrationRuntime[]) => ({
  instances,
  chatIncludes: () => true,
});

describe("integration definition setup status", () => {
  test("ready only when a signed-in account's tools are in this turn", () => {
    expect(
      integrationDefinitionSetup(outlook!, inChat(instance()), new Set(["outlook_mail_1"])),
    ).toEqual({
      status: "ready",
      action: null,
      detail: "Outlook Mail is connected and its tools are available in this turn.",
    });
    expect(integrationDefinitionSetup(outlook!, inChat(instance()), new Set())).toEqual({
      status: "unavailable",
      action: null,
      detail:
        "Outlook Mail is connected, but its tools are not in this turn. They load in the next turn; do not request another card.",
    });
  });

  test("an expired or revoked account asks for the card again", () => {
    for (const connectionStatus of ["needs_reauth", "revoked", "error"]) {
      const setup = integrationDefinitionSetup(
        outlook!,
        inChat(instance({ connectionStatus })),
        new Set(["outlook_mail_1"]),
      );
      expect({ connectionStatus, status: setup.status, action: setup.action }).toEqual({
        connectionStatus,
        status: "authorization_required",
        action: "connect",
      });
      expect(setup.detail).not.toContain("do not request another card");
    }
  });

  test("other definitions' accounts do not count", () => {
    expect(
      integrationDefinitionSetup(
        outlook!,
        inChat(instance({ definitionId: "microsoft-onedrive" })),
        new Set(["outlook_mail_1"]),
      ).status,
    ).toBe("authorization_required");
  });

  test("a chat limited to a tool list without it never hears 'do not request another card'", () => {
    const setup = integrationDefinitionSetup(
      outlook!,
      { instances: [instance()], chatIncludes: () => false },
      new Set(),
    );
    expect(setup).toEqual({
      status: "unavailable",
      action: null,
      detail:
        "Outlook Mail is connected, but this chat uses a fixed tool list that does not include it. Ask the person to add Outlook Mail to this chat's tools, then continue.",
    });
  });

  test("a chat's tool selection includes a new server unless it is limited or excluded", () => {
    const session = (toolPolicy: Record<string, unknown>, tools: string[] = []) =>
      ({ toolPolicy, tools: tools.map((id) => ({ kind: "mcp", id })) }) as never;
    expect(chatToolSelectionIncludes(session({ mode: "workspace_default" }))("outlook")).toBe(true);
    expect(
      chatToolSelectionIncludes(
        session({ mode: "workspace_default", excludedMcpServerIds: ["outlook"] }),
      )("outlook"),
    ).toBe(false);
    expect(chatToolSelectionIncludes(session({ mode: "explicit" }, ["linear"]))("outlook")).toBe(
      false,
    );
    expect(
      chatToolSelectionIncludes(session({ mode: "explicit" }, ["linear", "outlook"]))("outlook"),
    ).toBe(true);
    // A child chat inheriting a parent's fixed list is a fixed list too.
    const inherited = { mode: "inherited", inheritedFromSessionId: crypto.randomUUID() };
    expect(chatToolSelectionIncludes(session(inherited, ["linear"]))("outlook")).toBe(false);
    expect(chatToolSelectionIncludes(session(inherited, ["outlook"]))("outlook")).toBe(true);
  });

  test("a child chat with an inherited fixed list is told to add the tools, not to wait", () => {
    const setup = integrationDefinitionSetup(
      outlook!,
      {
        instances: [instance()],
        chatIncludes: chatToolSelectionIncludes({
          toolPolicy: { mode: "inherited", inheritedFromSessionId: crypto.randomUUID() },
          tools: [{ kind: "mcp", id: "linear" }],
        } as never),
      },
      new Set(),
    );
    expect(setup.status).toBe("unavailable");
    expect(setup.detail).toContain("fixed tool list");
    expect(setup.detail).not.toContain("do not request another card");
  });
});
