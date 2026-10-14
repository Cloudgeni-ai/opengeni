import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "../src/client";
import { OpenGeniToolReapprovalRequiredError } from "../src/tools";
import { createKnownWorkspaceTools } from "../src/known-tools";
import { createSiteToolBridge } from "../src/site-tool-bridge";
import type { ToolGatewayResolvedTool, ToolGatewayInvokeRequest } from "../src/types";
import { ToolGatewayInvokeRequest as InvokeSchema } from "@opengeni/contracts";

const identity = { serverId: "account-known", toolName: "search" };
const tool = (digest = "a".repeat(64)): ToolGatewayResolvedTool => ({
  version: 1,
  definitionDigest: digest,
  entry: {
    identity,
    modelName: "account-known__search",
    codemodePath: ["account_known", "search_hash"],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    source: "mcp",
    approval: "policy",
  },
});
const response = (value: unknown, status = 200) => Response.json(value, { status });
const stale = () =>
  response(
    {
      error: {
        code: "conflict",
        details: { code: "tool_definition_stale" },
        retryable: true,
        outcomeUnknown: false,
      },
    },
    409,
  );
const result = (request: ToolGatewayInvokeRequest, resolved = tool()) => ({
  operationId: request.operationId,
  tool: resolved,
  result: { content: [], structuredContent: { count: 1 } },
});

function fixture(
  handler: (path: string, body: any, request: Request) => Promise<Response> | Response,
) {
  const requests: { path: string; body: any }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://example.invalid",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname.split("/").at(-1)!;
      const body = request.body ? await request.json() : undefined;
      requests.push({ path, body });
      return await handler(path, body, request);
    },
  });
  return { tools: client.tools.forWorkspace("workspace"), requests };
}

describe("known tools SDK", () => {
  test("explicit malformed target pins reach validation rather than becoming unpinned execution", async () => {
    for (const pin of ["", null, "not-a-digest"] as const) {
      let effects = 0;
      const f = fixture((path, body) => {
        expect(path).toBe("invoke");
        expect(body).toHaveProperty("expectedDefinitionDigest", pin);
        if (!InvokeSchema.safeParse(body).success)
          return response(
            { error: { code: "invalid_request", retryable: false, outcomeUnknown: false } },
            400,
          );
        effects++;
        return response(result(body));
      });
      await expect(
        f.tools.$call(identity, {}, { expectedDefinitionDigest: pin as string }),
      ).rejects.toMatchObject({ status: 400 });
      expect(effects).toBe(0);
      expect(f.requests).toHaveLength(1);
    }
  });
  test("cold exact and symbolic calls invoke directly and unwrap using executed metadata", async () => {
    const f = fixture((path, body) => {
      expect(path).toBe("invoke");
      return response(result(body));
    });
    expect(f.tools.$targetProtocol).toBe(1);
    expect(await f.tools.$call(identity)).toEqual({ count: 1 });
    expect(await (f.tools.account_known!.search_hash as Function)({})).toEqual({ count: 1 });
    expect(f.requests.map((request) => request.path)).toEqual(["invoke", "invoke"]);
    expect(f.requests[0]!.body.expectedDefinitionDigest).toBeUndefined();
    await f.tools.$call(identity);
    expect(f.requests[2]!.body.expectedDefinitionDigest).toBe(tool().definitionDigest);
  });
  test("schema-less results and provider errors are not unwrapped or retried", async () => {
    let calls = 0;
    const f = fixture((_path, body) => {
      calls++;
      const resolved = tool();
      delete resolved.entry.outputSchema;
      return response({
        ...result(body, resolved),
        result:
          calls === 1
            ? { content: [{ type: "image", data: "image" }], structuredContent: { count: 1 } }
            : {
                isError: true,
                content: [],
                structuredContent: { error: { code: "unknown", outcomeUnknown: true } },
              },
      });
    });
    expect(await f.tools.$call(identity)).toMatchObject({ content: [{ type: "image" }] });
    await expect(f.tools.$call(identity)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(calls).toBe(2);
  });
  test("concurrent stale calls share a post-rejection resolution and keep operation IDs", async () => {
    const fresh = tool("b".repeat(64));
    let resolves = 0;
    const f = fixture(async (path, body) => {
      if (path === "resolve") {
        resolves++;
        await Bun.sleep(10);
        return response(resolves === 1 ? tool() : fresh);
      }
      return body.expectedDefinitionDigest === tool().definitionDigest
        ? stale()
        : response(result(body, fresh));
    });
    await f.tools.$resolve({ identity });
    await Promise.all([f.tools.$call(identity), f.tools.$call(identity)]);
    expect(resolves).toBe(2);
    const calls = f.requests.filter((request) => request.path === "invoke");
    expect(calls).toHaveLength(4);
    expect(
      calls
        .slice(0, 2)
        .map((call) => call.body.operationId)
        .sort(),
    ).toEqual(
      calls
        .slice(2)
        .map((call) => call.body.operationId)
        .sort(),
    );
  });
  test("explicit schema pins are never silently refreshed into execution", async () => {
    const f = fixture(() => stale());
    await expect(
      f.tools.$call(identity, {}, { expectedDefinitionDigest: tool().definitionDigest }),
    ).rejects.toMatchObject({ details: { code: "tool_definition_stale" } });
    expect(f.requests).toHaveLength(1);
  });
  test("target approval binds operation and definition and stale requires reapproval", async () => {
    let resolved = tool();
    const token = `ogta_${"a".repeat(43)}`;
    const f = fixture((path, body) => {
      if (path === "resolve") return response(resolved);
      if (path === "target-approvals")
        return response({
          bindingVersion: 2,
          operationId: body.operationId,
          tool: resolved,
          approvalToken: token,
          expiresAt: "2027-01-01T00:00:00Z",
        });
      return stale();
    });
    const approval = await f.tools.$approveTarget(identity);
    resolved = tool("b".repeat(64));
    await expect(
      f.tools.$call(
        identity,
        {},
        {
          operationId: approval.operationId,
          approvalToken: token,
          expectedDefinitionDigest: approval.tool.definitionDigest,
        },
      ),
    ).rejects.toBeInstanceOf(OpenGeniToolReapprovalRequiredError);
    expect(f.requests.filter((request) => request.path === "invoke")).toHaveLength(1);
    expect(f.requests.some((request) => request.path === "catalog")).toBe(false);
  });
  test("network failure after invocation has no downgrade, discovery or replay", async () => {
    const f = fixture(() => {
      throw new TypeError("lost response");
    });
    await expect(f.tools.$call(identity)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(f.requests.map((request) => request.path)).toEqual(["invoke"]);
  });
  test("approval provenance is not implicitly pinned to its public Ask presentation", async () => {
    const token = `ogta_${"a".repeat(43)}`;
    const asked = tool();
    asked.entry.approval = "human";
    const allowed = tool("b".repeat(64));
    const f = fixture((path, body) => {
      if (path === "resolve") return response(asked);
      if (path === "target-approvals")
        return response({
          bindingVersion: 2,
          tool: asked,
          operationId: body.operationId,
          approvalToken: token,
          expiresAt: "2027-01-01T00:00:00Z",
        });
      expect(body.expectedDefinitionDigest).toBeUndefined();
      return response(result(body, allowed));
    });
    const approved = await f.tools.$approveTarget(identity);
    expect(
      await f.tools.$call(
        identity,
        {},
        { approvalToken: token, operationId: approved.operationId },
      ),
    ).toEqual({ count: 1 });
    expect(f.requests.map(({ path }) => path)).toEqual(["resolve", "target-approvals", "invoke"]);
  });
  test("contradictory stale flags veto replay at both HTTP and bridge transport seams", async () => {
    for (const flags of [
      { retryable: false, outcomeUnknown: false },
      { retryable: true, outcomeUnknown: true },
      { retryable: false, outcomeUnknown: true },
    ]) {
      const f = fixture((path) =>
        path === "resolve"
          ? response(tool())
          : response(
              {
                error: {
                  code: "conflict",
                  details: { code: "tool_definition_stale" },
                  ...flags,
                },
              },
              409,
            ),
      );
      await f.tools.$resolve({ identity });
      await expect(f.tools.$call(identity)).rejects.toMatchObject(flags);
      expect(f.requests.map(({ path }) => path)).toEqual(["resolve", "invoke"]);
      let effects = 0;
      const tools = createKnownWorkspaceTools(
        {
          requestJson: async (_method, path) => {
            if (path.endsWith("/resolve")) return tool() as never;
            effects++;
            throw Object.assign(new Error("contradictory bridge failure"), {
              code: "tool_definition_stale",
              ...flags,
            });
          },
        },
        "workspace",
        () => {
          throw new Error("no legacy");
        },
      );
      await tools.$resolve({ identity });
      await expect(tools.$call(identity)).rejects.toMatchObject(flags);
      expect(effects).toBe(1);
    }
  });
  test("newer cold invocation metadata wins over an older late result", async () => {
    let finishOld!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finishOld = resolve;
    });
    let calls = 0;
    const fresh = tool("b".repeat(64));
    const f = fixture(async (path, body) => {
      expect(path).toBe("invoke");
      if (++calls === 1) {
        entered();
        await gate;
        return response(result(body));
      }
      return response(result(body, fresh));
    });
    const old = f.tools.$call(identity);
    await started;
    await f.tools.$call(identity);
    finishOld();
    await old;
    await f.tools.$call(identity);
    expect(f.requests[2]!.body.expectedDefinitionDigest).toBe(fresh.definitionDigest);
  });
  test("one cancelled resolver does not cancel its sibling", async () => {
    let providerAborted = false;
    const f = fixture(async (_path, _body, request) => {
      request.signal.addEventListener("abort", () => {
        providerAborted = true;
      });
      await Bun.sleep(20);
      return response(tool());
    });
    const controller = new AbortController();
    const first = f.tools.$resolve({ identity }, { signal: controller.signal });
    const second = f.tools.$resolve({ identity });
    await Bun.sleep(1);
    controller.abort();
    await expect(first).rejects.toThrow();
    expect((await second).entry.identity).toEqual(identity);
    expect(providerAborted).toBe(false);
    expect(f.requests).toHaveLength(1);
  });
  test("existing Site catalog uses only a bounded manifest; calls translate its retained pin", async () => {
    const f = fixture((path, body) => {
      if (path === "manifest")
        return response({ version: 1, digest: "c".repeat(64), tools: [tool()] });
      expect(path).toBe("invoke");
      return response(result(body));
    });
    const bridge = createSiteToolBridge({
      workspaceTools: f.tools,
      workspaceId: "workspace",
      artifactId: "artifact",
      siteVersionId: "version",
      requestedTools: [identity],
      callTool: async () => {
        throw new Error("legacy workspace call forbidden");
      },
    });
    const signal = new AbortController().signal;
    const catalog = await bridge.catalog({ signal });
    const called = await bridge.call(
      { catalogDigest: catalog.digest, identity, arguments: {} },
      { signal },
    );
    expect(called.catalogDigest).toBe(catalog.digest);
    expect(f.requests.map((request) => request.path)).toEqual(["manifest", "invoke"]);
    expect(f.requests[1]!.body).toMatchObject({
      expectedDefinitionDigest: tool().definitionDigest,
      siteArtifactId: "artifact",
      siteVersionId: "version",
    });
    await expect(
      bridge.call({ catalogDigest: "unknown", identity, arguments: {} }, { signal }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.requests).toHaveLength(2);
  });
  test("modern Site calls strip forged host authority and approval tokens", async () => {
    const f = fixture((_path, body) => response(result(body)));
    const bridge = createSiteToolBridge({
      workspaceTools: f.tools,
      workspaceId: "workspace",
      artifactId: "real",
      siteVersionId: "pinned",
      requestedTools: [identity],
      callTool: async () => {
        throw new Error("legacy forbidden");
      },
    });
    await bridge.invoke!(
      {
        target: { identity },
        operationId: crypto.randomUUID(),
        arguments: {},
        siteArtifactId: "forged",
        siteVersionId: "forged",
        approvalToken: "forged",
      },
      { signal: new AbortController().signal },
    );
    expect(f.requests[0]!.body).toMatchObject({ siteArtifactId: "real", siteVersionId: "pinned" });
    expect(f.requests[0]!.body.approvalToken).toBeUndefined();
  });
});
