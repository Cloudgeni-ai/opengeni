import { describe, expect, test } from "bun:test";
import {
  createSiteToolBridge,
  SiteToolCallFailedError,
  type SiteToolFailurePrompt,
} from "../src/site";
import { OpenGeniApiError } from "../src/index";
import type { ToolGatewayInvokeRequest, ToolGatewayResolvedTool } from "../src/types";

// Every way a Site's tool call can stop reaches the viewer as a clear state
// (Reconnect, a plain refusal, or Try again) and the Site as a typed code;
// never an HTTP status or an internal error string.
const declared = { serverId: "crm", toolName: "query" };
const route = { serverId: "account-1", toolName: "query" };
const connectionId = "0b9b8d5e-6f0f-4b8e-9d55-2d6c8a4c1f10";
const tool = {
  version: 1,
  entry: { identity: route, title: "Query" },
  definitionDigest: "digest",
} as unknown as ToolGatewayResolvedTool;
const apiError = (status: number, error: Record<string, unknown>) =>
  new OpenGeniApiError(status, JSON.stringify({ error, requestId: "req_1" }));
const ok = { content: [{ type: "text", text: "rows" }] };

function harness(script: Array<unknown>, options: { host?: boolean; again?: boolean } = {}) {
  const invokes: ToolGatewayInvokeRequest[] = [];
  const prompts: SiteToolFailurePrompt[] = [];
  const bridge = createSiteToolBridge({
    workspaceId: "workspace",
    artifactId: "site",
    siteVersionId: "version",
    requestedTools: [declared],
    workspaceTools: {
      $targetProtocol: 1,
      $catalog: async () => {
        throw new Error("unused");
      },
      $manifest: async () => {
        throw new Error("unused");
      },
      $resolve: async () => tool,
      $invoke: async (request) => {
        invokes.push(request as ToolGatewayInvokeRequest);
        const next = script[Math.min(invokes.length, script.length) - 1];
        if (next instanceof Error) throw next;
        return { operationId: request.operationId, tool, result: next } as never;
      },
    },
    fetchResponse: async (path) => {
      if (!path.endsWith("/site-consent")) return new Response("unexpected", { status: 500 });
      return Response.json({
        version: 1,
        accounts: [
          {
            identity: route,
            connector: "Microsoft Dynamics",
            account: "ada@example.com",
            connectionId,
            capabilityId: "cap-dynamics",
          },
        ],
        selected: route,
        review: null,
        connect: null,
      });
    },
    ...(options.host === false
      ? {}
      : {
          recoverToolCall: async (prompt: SiteToolFailurePrompt) => {
            prompts.push(prompt);
            return options.again ?? true;
          },
        }),
    callTool: async () => {
      throw new Error("unused");
    },
  });
  const invoke = async () =>
    await bridge.invoke!(
      { target: { identity: declared }, operationId: "op-1", arguments: {} },
      { signal: new AbortController().signal },
    );
  return { invoke, invokes, prompts };
}

describe("Site tool failures reach the viewer as clear states", () => {
  test("an expired connection offers Reconnect for that same account, then runs again", async () => {
    const h = harness([
      apiError(409, {
        code: "conflict",
        message: "Reconnect this account in Opengeni, then try again.",
        details: { code: "tool_connection_needs_attention", reason: "expired" },
      }),
      ok,
    ]);
    expect((await h.invoke()).result).toEqual(ok);
    expect(h.prompts.map(({ failure }) => failure)).toEqual([
      expect.objectContaining({
        code: "site_tool_reconnect_required",
        system: "Microsoft Dynamics",
        message: "Sign in to Microsoft Dynamics again to continue.",
        reconnect: { connectionId, capabilityId: "cap-dynamics", name: "Microsoft Dynamics" },
      }),
    ]);
    // The same operation, after the viewer signed in again.
    expect(h.invokes.map((request) => request.operationId)).toEqual(["op-1", "op-1"]);
  });

  test("a provider's sign-in refusal is the same Reconnect; closing it leaves a typed result", async () => {
    const h = harness(
      [
        {
          isError: true,
          content: [{ type: "text", text: "Microsoft Dynamics rejected the sign-in." }],
          structuredContent: {
            error: { code: "connection_auth_needed", message: "rejected the sign-in" },
          },
        },
      ],
      { again: false },
    );
    const { result } = await h.invoke();
    expect(h.prompts[0]?.failure.code).toBe("site_tool_reconnect_required");
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Sign in to Microsoft Dynamics again to continue." }],
      structuredContent: {
        error: { code: "site_tool_reconnect_required", detail: "rejected the sign-in" },
      },
    });
    expect(h.invokes).toHaveLength(1);
  });

  test("a provider's permission refusal names the system and is not retried", async () => {
    const providerText =
      "Dataverse returned 403: Principal user is missing prvReadAccount privilege.";
    const h = harness([
      {
        isError: true,
        content: [{ type: "text", text: providerText }],
        structuredContent: {
          error: { code: "provider_permission_denied", message: providerText },
        },
      },
    ]);
    const { result } = await h.invoke();
    expect(h.prompts[0]?.failure).toMatchObject({
      code: "site_tool_permission_denied",
      message: "Microsoft Dynamics didn't allow this for your account.",
      retryable: false,
      reconnect: null,
      detail: providerText,
    });
    // Even if the host answered "again", a refusal is not run again.
    expect(h.invokes).toHaveLength(1);
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Microsoft Dynamics didn't allow this for your account." }],
      structuredContent: {
        error: { code: "site_tool_permission_denied", system: "Microsoft Dynamics" },
      },
    });
  });

  test("any other failure is a plain message with Try again, never the raw status", async () => {
    const h = harness([apiError(404, { code: "not_found", message: "tool_unavailable" }), ok]);
    expect((await h.invoke()).result).toEqual(ok);
    const failure = h.prompts[0]!.failure;
    expect(failure).toMatchObject({
      code: "site_tool_unavailable",
      message: "Couldn't get this from Microsoft Dynamics.",
      retryable: true,
    });
    expect(failure.detail).toContain("tool_unavailable");
    expect(h.invokes).toHaveLength(2);
  });

  test("without host UI the Site still gets a typed, plain error", async () => {
    const h = harness([apiError(404, { code: "not_found", message: "tool_unavailable" })], {
      host: false,
    });
    const error = await h.invoke().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SiteToolCallFailedError);
    expect(error).toMatchObject({
      code: "site_tool_unavailable",
      message: "Couldn't get this from Microsoft Dynamics.",
      retryable: true,
      outcomeUnknown: false,
    });
    expect((error as Error).message).not.toMatch(/API|404|tool_unavailable/u);
  });

  test("an unknown outcome is never run again", async () => {
    const h = harness([
      apiError(502, {
        code: "upstream_unavailable",
        message: "The integration call ended without a confirmed provider result.",
        outcomeUnknown: true,
        retryable: false,
        details: { code: "tool_outcome_unknown" },
      }),
      ok,
    ]);
    const error = await h.invoke().catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "site_tool_outcome_unknown",
      outcomeUnknown: true,
      retryable: false,
    });
    expect(h.invokes).toHaveLength(1);
  });

  test("Try again is bounded", async () => {
    const h = harness([apiError(500, { code: "internal", message: "boom" })]);
    const error = await h.invoke().catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "site_tool_unavailable" });
    expect(h.invokes).toHaveLength(3);
    expect(h.prompts).toHaveLength(2);
  });
});
