import { describe, expect, test } from "bun:test";
import {
  createSiteToolBridge,
  SiteToolConnectionRequiredError,
  SiteToolConsentDeclinedError,
  type SiteToolConsentDecision,
  type SiteToolConsentPrompt,
} from "../src/site";
import { OpenGeniApiError } from "../src/index";
import type {
  ToolGatewayIdentity,
  ToolGatewayInvokeRequest,
  ToolGatewayResolvedTool,
} from "../src/types";

// The Opengeni frame confirms a Site's approval-required tool call: host code
// asks the viewer, mints the approval and retries the same operation. Site
// code can neither carry an approval nor reach the approval endpoints.
const declared = { serverId: "gmail", toolName: "send_message" };
const work = { serverId: "account-work", toolName: "send_message" };
const home = { serverId: "account-home", toolName: "send_message" };
const accounts = [
  { identity: work, connector: "Gmail", account: "ada@work.example" },
  { identity: home, connector: "Gmail", account: "ada@home.example" },
];
const tool = (identity: ToolGatewayIdentity) =>
  ({
    version: 1,
    entry: { identity, title: "Send message", approval: "human" },
    definitionDigest: `digest-${identity.serverId}`,
  }) as unknown as ToolGatewayResolvedTool;
const conflict = (code: string) =>
  new OpenGeniApiError(
    409,
    JSON.stringify({ error: { code: "conflict", message: code, details: { code } } }),
  );

function harness(
  options: {
    decide?: (prompt: SiteToolConsentPrompt) => SiteToolConsentDecision;
    firstError?: string;
    approval?: "token" | "not_required";
    confirm?: false;
    connect?: boolean;
    capabilityId?: string | null;
  } = {},
) {
  const invokes: Array<ToolGatewayInvokeRequest & Record<string, unknown>> = [];
  const host: Array<{ path: string; body: Record<string, unknown> }> = [];
  const prompts: SiteToolConsentPrompt[] = [];
  let connectPrompts = 0;
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
      $resolve: async (target) => tool("identity" in target ? target.identity : declared),
      $invoke: async (request) => {
        invokes.push(request as ToolGatewayInvokeRequest & Record<string, unknown>);
        if (invokes.length === 1)
          throw conflict(options.firstError ?? "tool_gateway_approval_required");
        return {
          operationId: request.operationId,
          tool: tool(declared),
          result: { content: [] },
        } as never;
      },
    },
    fetchResponse: async (path, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      host.push({ path, body });
      if (path.endsWith("/site-consent"))
        return Response.json(
          options.connect
            ? {
                version: 1,
                accounts: [],
                selected: null,
                review: null,
                connect: {
                  capabilityId: options.capabilityId === undefined ? "gmail" : options.capabilityId,
                  name: "Gmail",
                  providerDomain: "gmail",
                },
              }
            : {
                version: 1,
                accounts,
                selected: (body.identity as ToolGatewayIdentity).serverId.startsWith("account-")
                  ? body.identity
                  : null,
                // As Gmail reads the call on that account.
                review: {
                  kind: "gmail",
                  email: {
                    from: `${(body.identity as ToolGatewayIdentity).serverId}@example.test`,
                    to: "anyone@example.test",
                    cc: "",
                    bcc: "",
                    subject: "Read by Gmail",
                    attachments: 0,
                  },
                },
                connect: null,
              },
        );
      if (path.endsWith("/target-approvals")) {
        if (options.approval === "not_required")
          return Response.json(
            { error: { code: "unprocessable", message: "tool_does_not_require_human_approval" } },
            { status: 422 },
          );
        return Response.json(
          { approvalToken: `ogta_${"t".repeat(43)}`, operationId: body.operationId },
          { status: 201 },
        );
      }
      return new Response("unexpected", { status: 500 });
    },
    ...(options.confirm === false
      ? {}
      : {
          confirmToolCall: async (prompt: SiteToolConsentPrompt) => {
            prompts.push(prompt);
            return (options.decide ?? (() => ({})))(prompt);
          },
        }),
    connectForToolCall: async () => {
      connectPrompts++;
      return true;
    },
    callTool: async () => {
      throw new Error("unused");
    },
  });
  const invoke = (extra: Record<string, unknown> = {}) =>
    bridge.invoke!(
      {
        target: { identity: declared },
        operationId: "op-1",
        arguments: { to: ["bendik@cloudgeni.ai"], subject: "Hello" },
        ...extra,
      } as ToolGatewayInvokeRequest,
      { signal: new AbortController().signal },
    );
  return { invoke, invokes, host, prompts, connectPrompts: () => connectPrompts };
}

describe("Site tool consent in the host bridge", () => {
  test("confirming mints an approval and retries the same operation on the chosen account", async () => {
    const h = harness({ decide: () => ({ identity: home, alwaysAllow: true }) });
    // A Site-supplied approval is never forwarded.
    await h.invoke({ approvalToken: `ogta_${"x".repeat(43)}` });
    expect(h.invokes[0]).not.toHaveProperty("approvalToken");
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toMatchObject({
      accounts,
      selected: work,
      arguments: { to: ["bendik@cloudgeni.ai"], subject: "Hello" },
    });
    expect(h.host.map((request) => request.path)).toEqual([
      "/v1/workspaces/workspace/tools/site-consent",
      "/v1/workspaces/workspace/tools/target-approvals",
    ]);
    // The host asks the provider to read the exact arguments it will send.
    expect(h.host[0]!.body).toEqual({
      identity: declared,
      arguments: { to: ["bendik@cloudgeni.ai"], subject: "Hello" },
      siteArtifactId: "site",
      siteVersionId: "version",
    });
    expect(h.host[1]!.body).toEqual({
      identity: home,
      operationId: "op-1",
      arguments: { to: ["bendik@cloudgeni.ai"], subject: "Hello" },
      expectedDefinitionDigest: "digest-account-home",
      rememberForSite: true,
      siteArtifactId: "site",
      siteVersionId: "version",
    });
    expect(h.invokes[1]).toMatchObject({
      target: { identity: home },
      operationId: "op-1",
      approvalToken: `ogta_${"t".repeat(43)}`,
      siteArtifactId: "site",
      siteVersionId: "version",
    });
  });

  test("an account outside the viewer's own list is never used", async () => {
    const h = harness({
      decide: () => ({ identity: { serverId: "account-someone-else", toolName: "send_message" } }),
    });
    await h.invoke();
    expect(h.host[1]!.body.identity).toEqual(work);
    expect(h.host[1]!.body).not.toHaveProperty("rememberForSite");
    expect(h.invokes[1]!.target).toEqual({ identity: work });
  });

  test("cancel runs nothing and mints no approval", async () => {
    const h = harness({ decide: () => null });
    await expect(h.invoke()).rejects.toBeInstanceOf(SiteToolConsentDeclinedError);
    expect(h.invokes).toHaveLength(1);
    expect(h.host.map((request) => request.path)).toEqual([
      "/v1/workspaces/workspace/tools/site-consent",
    ]);
  });

  test("an account choice without approval runs without a token", async () => {
    const h = harness({ firstError: "site_tool_account_required", approval: "not_required" });
    await h.invoke();
    expect(h.invokes[1]).toMatchObject({ target: { identity: work } });
    expect(h.invokes[1]).not.toHaveProperty("approvalToken");
  });

  test("without a connected account the host offers to connect, then retries", async () => {
    const h = harness({ firstError: "site_tool_connection_required", connect: true });
    await h.invoke();
    expect(h.connectPrompts()).toBe(1);
    expect(h.prompts).toHaveLength(0);
    expect(h.invokes).toHaveLength(2);
  });

  test("the prompt carries the provider's review, read again for another account", async () => {
    const h = harness({ decide: () => ({ identity: home }) });
    await h.invoke({ arguments: { raw: "VG86IGFueW9uZUBleGFtcGxlLnRlc3Q" } });
    const prompt = h.prompts[0]!;
    expect(prompt.review?.email).toMatchObject({ to: "anyone@example.test" });
    expect(await prompt.reviewFor(home)).toMatchObject({
      email: { from: "account-home@example.test" },
    });
    expect(h.host.at(-1)).toEqual({
      path: "/v1/workspaces/workspace/tools/site-consent",
      body: {
        identity: home,
        arguments: { raw: "VG86IGFueW9uZUBleGFtcGxlLnRlc3Q" },
        siteArtifactId: "site",
        siteVersionId: "version",
      },
    });
  });

  test("a connector without a connect card says what to connect instead of Cancelled", async () => {
    const h = harness({
      firstError: "site_tool_connection_required",
      connect: true,
      capabilityId: null,
    });
    const error = await h.invoke().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(SiteToolConnectionRequiredError);
    expect((error as Error).message).toBe("Connect Gmail in Opengeni, then try again.");
    expect(h.connectPrompts()).toBe(0);
    expect(h.invokes).toHaveLength(1);
  });

  test("without host consent UI the original refusal is returned", async () => {
    const h = harness({ confirm: false });
    await expect(h.invoke()).rejects.toMatchObject({
      status: 409,
      details: { code: "tool_gateway_approval_required" },
    });
    expect(h.host).toHaveLength(0);
  });
});
