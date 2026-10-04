import { describe, expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import { testSettings } from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  prepareAgentTools,
  type ConnectorActionPolicyHooks,
} from "../src/index";

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 1,
  credentialSubjectId: "subject-a",
};

describe("Slack bridge through the ordinary attempt gateway", () => {
  test("keeps selected personal and workspace accounts distinct for model and Codemode calls", async () => {
    const requests: { method: string; authorization: string | null }[] = [];
    const settings = testSettings({
      mcpServers: [
        {
          id: "slack_personal",
          url: "https://mcp.slack.com/mcp",
          connectionRef: {
            providerDomain: "slack.com",
            kind: "oauth2",
            subjectScope: "subject",
            connectionId: "personal",
          },
          cacheToolsList: false,
        },
        {
          id: "slack_workspace",
          url: "https://mcp.slack.com/mcp",
          connectionRef: {
            providerDomain: "slack.com",
            kind: "oauth2",
            subjectScope: "workspace",
            connectionId: "workspace",
          },
          cacheToolsList: false,
        },
      ],
    });
    const hooks: ConnectorActionPolicyHooks = {
      prepare: async () => ({ managed: false, decision: "unmanaged" }),
      begin: async () => ({ managed: false, allowed: true }),
      complete: async () => {},
    };
    const prepared = await prepareAgentTools(
      settings,
      [
        { kind: "mcp", id: "slack_personal" },
        { kind: "mcp", id: "slack_workspace" },
      ],
      {
        ...scope,
        connectorActionPolicy: hooks,
        mcpAccountLabels: new Map([
          ["slack_personal", "Personal: Alice"],
          ["slack_workspace", "Workspace: Team"],
        ]),
        resolveCredential: async (request) => {
          const selected = request.connectionRef.connectionId!;
          expect(["personal", "workspace"]).toContain(selected);
          return {
            status: "ok",
            connectionId: selected,
            headers: { authorization: `Bearer ${selected}` },
            grantedScopes: ["users:read"],
          };
        },
        mcpFetchImpl: async (url, init) => {
          const request = new Request(url, init);
          expect(new URL(request.url).origin).toBe("https://slack.com");
          const method = new URL(request.url).pathname.split("/").at(-1)!;
          const authorization = request.headers.get("authorization");
          requests.push({ method, authorization });
          return Response.json(
            method === "auth.test"
              ? {
                  ok: true,
                  team_id: "T123",
                  user_id: authorization === "Bearer personal" ? "U123" : "U456",
                }
              : { ok: true, user: { id: "U789", name: "requested user" } },
          );
        },
      },
    );
    try {
      expect(prepared.mcpServers).toHaveLength(2);
      const personal = prepared.mcpServers.find((server) =>
        server.name.includes("slack_personal"),
      )!;
      const workspace = prepared.mcpServers.find((server) =>
        server.name.includes("slack_workspace"),
      )!;
      const personalTools = await personal.listTools();
      const workspaceTools = await workspace.listTools();
      expect(
        personalTools.find((tool) => tool.name.endsWith("slack_get_user_info"))?.description,
      ).toContain("Personal: Alice");
      expect(
        workspaceTools.find((tool) => tool.name.endsWith("slack_get_user_info"))?.description,
      ).toContain("Workspace: Team");
      requests.length = 0;
      const modelResult = await personal.callTool("slack_personal__slack_get_user_info", {
        user: "U789",
      });
      expect(JSON.stringify(modelResult)).toContain("requested user");
      expect(requests.map((request) => request.authorization)).toEqual([
        "Bearer personal",
        "Bearer personal",
      ]);
      requests.length = 0;
      const codemodeResult = await prepared.attemptToolEnvironment!.call({
        operationId: "66666666-6666-4666-8666-666666666666",
        catalogDigest: prepared.attemptToolCatalog!.digest,
        identity: { serverId: "slack_workspace", toolName: "slack_get_user_info" },
        arguments: { user: "U789" },
        caller: { kind: "codemode", subjectId: "agent:test" },
      });
      expect(JSON.stringify(codemodeResult)).toContain("requested user");
      expect(requests.map((request) => request.authorization)).toEqual([
        "Bearer workspace",
        "Bearer workspace",
      ]);
      expect(prepared.resolvedMcpConnectionIds.get("slack_personal")).toBe("personal");
      expect(prepared.resolvedMcpConnectionIds.get("slack_workspace")).toBe("workspace");
    } finally {
      await prepared.close();
    }
  });

  test.each(["transport", "internal_error", "fatal_error"])(
    "ordinary human approval gates a send and an ambiguous %s result settles uncertain",
    async (failure) => {
      let approved = false;
      let sends = 0;
      const settlements: unknown[] = [];
      const settings = testSettings({
        mcpServers: [
          {
            id: "slack",
            url: "https://mcp.slack.com/mcp",
            connectionRef: {
              providerDomain: "slack.com",
              kind: "oauth2",
              subjectScope: "subject",
              connectionId: "personal",
            },
            cacheToolsList: false,
          },
        ],
      });
      const hooks: ConnectorActionPolicyHooks = {
        prepare: async (call) => {
          expect(call.connectionId).toBe("personal");
          expect(call.toolName).toBe("slack_send_message");
          return { managed: true, decision: "ask" };
        },
        begin: async () =>
          approved
            ? { allowed: true, managed: true, requestId: "send-request" }
            : {
                allowed: false,
                managed: true,
                requestId: "send-request",
                reason: "approval_required",
              },
        complete: async (result) => {
          settlements.push(result);
        },
      };
      const prepared = await prepareAgentTools(settings, [{ kind: "mcp", id: "slack" }], {
        ...scope,
        connectorActionPolicy: hooks,
        resolveCredential: async () => ({
          status: "ok",
          connectionId: "personal",
          headers: { authorization: "Bearer personal" },
          grantedScopes: ["chat:write"],
        }),
        mcpFetchImpl: async (url) => {
          if (new URL(url.toString()).pathname.endsWith("auth.test"))
            return Response.json({ ok: true, team_id: "T123", user_id: "U123" });
          sends++;
          if (failure === "transport")
            throw new Error("Provider transport failed after submission");
          return Response.json({ ok: false, error: failure });
        },
      });
      const agent = buildOpenGeniAgent(settings, [], {
        mcpServers: prepared.mcpServers,
        resolvedMcpConnectionIds: prepared.resolvedMcpConnectionIds,
        connectorActionPolicy: hooks,
      });
      try {
        const sdkTool = (await agent.getMcpTools(new RunContext())).find(
          (tool) => tool.type === "function" && tool.name === "slack__slack_send_message",
        );
        if (!sdkTool || sdkTool.type !== "function") throw new Error("Slack send tool missing");
        expect(
          await sdkTool.needsApproval(
            new RunContext(),
            { channel: "C123", text: "hello" },
            "call-send",
          ),
        ).toBe(true);
        expect(sends).toBe(0);
        approved = true;
        const output = await sdkTool.invoke(
          new RunContext(),
          JSON.stringify({ channel: "C123", text: "hello" }),
          {
            toolCall: { callId: "call-send" },
          } as any,
        );
        expect(JSON.stringify(output)).toContain('"isError":true');
        expect(JSON.stringify(output)).toContain("Do not retry automatically");
        expect(JSON.stringify(output)).not.toContain("Please try again");
        expect(sends).toBe(1);
        expect(settlements).toEqual([{ requestId: "send-request", outcome: "uncertain" }]);
      } finally {
        await prepared.close();
      }
    },
  );
});
