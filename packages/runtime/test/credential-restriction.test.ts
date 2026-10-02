import { describe, expect, test } from "bun:test";
import { verifyDelegatedAccessToken } from "@opengeni/contracts";
import { startTestMcpServer, testSettings } from "@opengeni/testing";
import { createFirstPartyAttemptClient } from "../src/first-party-client";
import { prepareAgentTools } from "../src/index";
import { createFirstPartyInteractionAttemptToolDefinitions } from "../src/interaction-tools";
import { mintSandboxCodemodeToken } from "../src/sandbox/codemode-authority";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
};
const secret = "test-delegation-secret";

describe.each([undefined, "developer_setup"] as const)(
  "delegated credential restriction: %s",
  (credentialRestriction) => {
    test("first-party MCP signs every request without changing permissions or attempt identity", async () => {
      const seen: Awaited<ReturnType<typeof verifyDelegatedAccessToken>>[] = [];
      const mcp = startTestMcpServer({
        validateAuthorization: async (authorization) => {
          if (!authorization?.startsWith("Bearer ")) return false;
          seen.push(await verifyDelegatedAccessToken(secret, authorization.slice(7)));
          return true;
        },
      });
      const url = `${mcp.url}?ws={workspaceId}`;
      const settings = testSettings({
        opengeniMcpInternalUrl: url,
        mcpServers: [{ id: "opengeni", url, cacheToolsList: false }],
      });
      const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "opengeni" }], {
        ...scope,
        ...(credentialRestriction ? { credentialRestriction } : {}),
        firstPartyPermissions: ["api_keys:manage"],
        firstPartyTools: ["session_get"],
      });
      try {
        await prepared.mcpServers[0]!.listTools();
        expect(seen.length).toBeGreaterThan(1);
        for (const payload of seen) {
          expect(payload).toMatchObject({
            ...scope,
            principalKind: "agent_attempt",
            permissions: ["api_keys:manage"],
            firstPartyMcpTools: ["session_get"],
          });
          expect(payload.credentialRestriction).toBe(credentialRestriction);
          expect(Object.hasOwn(payload, "credentialRestriction")).toBe(!!credentialRestriction);
        }
      } finally {
        await prepared.close();
        mcp.close();
      }
    });

    test("internal first-party client and interaction tools retain the same signed ceiling", async () => {
      const seen: Awaited<ReturnType<typeof verifyDelegatedAccessToken>>[] = [];
      const fetch = (async (_request, init) => {
        const authorization = new Headers(init?.headers).get("authorization")!;
        seen.push(await verifyDelegatedAccessToken(secret, authorization.slice(7)));
        return Response.json({
          browserSessionId: scope.sessionId,
          controllerGeneration: "controller-1",
          revision: 1,
          text: "clipboard",
          source: "copy",
          sourceTargetId: "tab-1",
          updatedAt: new Date().toISOString(),
        });
      }) as typeof globalThis.fetch;
      const input = {
        settings: testSettings(),
        scope,
        selectedTools: ["browser_clipboard"] as const,
        permissions: ["sessions:read"] as const,
        ...(credentialRestriction ? { credentialRestriction } : {}),
        fetch,
      };
      const client = createFirstPartyAttemptClient(input);
      await client.getSession(scope.workspaceId, scope.sessionId);
      const [interaction] = createFirstPartyInteractionAttemptToolDefinitions(input);
      await interaction!.execute(
        { browserSessionId: scope.sessionId },
        { operationId: crypto.randomUUID(), caller: { kind: "model", subjectId: "fixture" } },
      );
      expect(seen).toHaveLength(2);
      for (const payload of seen) {
        expect(payload).toMatchObject({
          ...scope,
          principalKind: "agent_attempt",
          permissions: ["sessions:read"],
          firstPartyMcpTools: ["browser_clipboard"],
        });
        expect(payload.credentialRestriction).toBe(credentialRestriction);
        expect(Object.hasOwn(payload, "credentialRestriction")).toBe(!!credentialRestriction);
      }
    });

    test("Codemode token mint and renewal retain the restriction and narrow permission", async () => {
      const settings = testSettings();
      const authority = { ...scope, ...(credentialRestriction ? { credentialRestriction } : {}) };
      for (const now of [Date.now(), Date.now() + 10 * 60_000]) {
        const minted = await mintSandboxCodemodeToken(settings, scope, authority, now);
        const payload = await verifyDelegatedAccessToken(secret, minted!.token);
        expect(payload).toMatchObject({
          ...scope,
          principalKind: "agent_attempt",
          permissions: ["codemode:call"],
        });
        expect(payload.credentialRestriction).toBe(credentialRestriction);
        expect(Object.hasOwn(payload, "credentialRestriction")).toBe(!!credentialRestriction);
      }
    });
  },
);
