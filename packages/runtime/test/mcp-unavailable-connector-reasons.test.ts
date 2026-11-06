import { expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing/settings";
import { prepareAgentTools } from "../src/index";

// A connector configured for the turn but left without tools must say why in
// tool discovery, so the model never guesses the cause of a missing connector.

const workspaceId = "22222222-2222-4222-8222-222222222222";

function connectorSettings() {
  return testSettings({
    mcpServers: [
      {
        id: "acme",
        name: "Acme",
        url: "https://mcp.acme.example/mcp",
        connectionRef: { providerDomain: "acme.example", kind: "oauth2", subjectScope: "subject" },
        cacheToolsList: false,
      },
    ],
  });
}

test("a sign-in that is not usable in this workspace names that cause, not a bare 401", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const prepared = await prepareAgentTools(
      connectorSettings(),
      [{ kind: "mcp", id: "acme", optional: true }],
      {
        workspaceId,
        credentialSubjectId: "subject-a",
        resolveCredential: async () => ({
          status: "auth_needed",
          reason: "personal_authority_unavailable",
          providerDomain: "acme.example",
        }),
        mcpFetchImpl: async () => {
          throw new Error("a request without a credential must not reach the provider");
        },
      },
    );
    try {
      expect(prepared.mcpServers).toHaveLength(0);
      expect(Object.fromEntries(prepared.unavailableMcpServers)).toEqual({
        acme: "could not connect: the person's own sign-in for it is not usable in this workspace for this turn, for example right after their workspace access changed; this can clear within minutes, otherwise they can sign in to it again.",
      });
    } finally {
      await prepared.close();
    }
  } finally {
    console.warn = originalWarn;
  }
});

test("a missing or expired sign-in gets its own plain reason", async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    for (const [reason, expected] of [
      [
        "missing_connection",
        "could not connect: no signed-in account is available for it; the person can sign in to it and try again.",
      ],
      [
        "expired",
        "could not connect: its sign-in expired or could not be renewed; the person can sign in to it again.",
      ],
    ] as const) {
      const prepared = await prepareAgentTools(
        connectorSettings(),
        [{ kind: "mcp", id: "acme", optional: true }],
        {
          workspaceId,
          credentialSubjectId: "subject-a",
          resolveCredential: async () => ({
            status: "auth_needed",
            reason,
            providerDomain: "acme.example",
          }),
        },
      );
      try {
        expect(prepared.unavailableMcpServers.get("acme")).toBe(expected);
      } finally {
        await prepared.close();
      }
    }
  } finally {
    console.warn = originalWarn;
  }
});

test("connectors the caller already left out are reported beside runtime failures", async () => {
  const prepared = await prepareAgentTools(testSettings({ mcpServers: [] }), [], {
    workspaceId,
    preparationUnavailableMcpServers: new Map([
      ["tickets", "not loaded this turn: no signed-in account for it was available to this turn."],
    ]),
  });
  try {
    expect(Object.fromEntries(prepared.unavailableMcpServers)).toEqual({
      tickets: "not loaded this turn: no signed-in account for it was available to this turn.",
    });
  } finally {
    await prepared.close();
  }
});
