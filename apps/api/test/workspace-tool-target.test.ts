import { describe, expect, test } from "bun:test";
import { accessGrantAuthorizationFromContext, type ApiRouteDeps } from "@opengeni/core";
import { ToolGatewayApprovalOperationStartedError } from "@opengeni/db";
import { ToolGatewayInvokeRequest, ToolGatewayResolveRequest } from "@opengeni/contracts";
import { createWorkspaceToolGateway } from "@opengeni/tool-gateway";
import {
  approveWorkspaceToolTarget,
  invokeWorkspaceToolTarget,
  resolveWorkspaceToolTarget,
  resolveWorkspaceToolManifest,
  type TargetGatewayOptions,
} from "../src/workspace-tool-target";

const grant = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "human:test",
  principalKind: "human_session" as const,
  permissions: ["workspace:read" as const],
};
const identity = { serverId: "docs", toolName: "search" };
const authorization = accessGrantAuthorizationFromContext(
  {
    subjectId: grant.subjectId,
    accountGrants: [{ accountId: grant.accountId, subjectId: grant.subjectId, permissions: [] }],
    workspaceGrants: [grant],
  } as unknown as Parameters<typeof accessGrantAuthorizationFromContext>[0],
  grant,
);
authorization.canonicalManagedHumanSession = true;
const deps = {} as ApiRouteDeps;

function fixture() {
  const state = {
    effects: 0,
    closes: 0,
    admissions: 0,
    description: "v1",
    ask: false,
    invalidOutput: false,
    failAfterEffect: false,
    failClose: false,
  };
  const options: TargetGatewayOptions = {
    prepare: async () => {
      const { catalog, gateway } = createWorkspaceToolGateway({
        ...grant,
        generation: 1,
        definitions: [
          {
            identity,
            modelName: "docs__search",
            source: "docs",
            description: state.description,
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
              additionalProperties: false,
            },
            outputSchema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
            },
            approval: state.ask ? "human" : "none",
            approvalAuthorityDigest: "c".repeat(64),
            execute: () => {
              state.effects++;
              if (state.failAfterEffect) throw new Error("connection lost");
              return {
                content: [],
                structuredContent: { ok: state.invalidOutput ? "invalid" : true },
              };
            },
          },
        ],
        requireApproval: (_entry, _caller, context) =>
          context.transportMeta?.approvalConfirmed !== true,
      });
      return {
        toolGateway: gateway,
        toolGatewayCatalog: catalog,
        close: async () => {
          state.closes++;
          if (state.failClose) throw new Error("secret cleanup detail");
        },
      };
    },
    begin: async () => {
      state.admissions++;
      return true;
    },
  };
  const request = () => ({
    target: { identity },
    arguments: { query: "hello" },
    operationId: crypto.randomUUID(),
  });
  return { state, options, request };
}

describe("targeted gateway contract and settlement", () => {
  test("strict targets and paired host context reject malformed authority", () => {
    for (const target of [
      { identity, path: ["docs", "search"] },
      { path: ["__proto__", "search"] },
      { path: ["docs"] },
    ]) {
      expect(ToolGatewayResolveRequest.safeParse({ target }).success).toBe(false);
    }
    expect(
      ToolGatewayResolveRequest.safeParse({ target: { identity }, siteArtifactId: grant.accountId })
        .success,
    ).toBe(false);
    expect(
      ToolGatewayInvokeRequest.safeParse({
        target: { identity },
        arguments: {},
        operationId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  test("full-entry prose drift rejects a pin before approval admission; cold calls use current definition", async () => {
    const f = fixture();
    const previous = await resolveWorkspaceToolTarget(
      deps,
      authorization,
      { target: { identity } },
      f.options,
    );
    f.state.description = "v2";
    await expect(
      invokeWorkspaceToolTarget(
        deps,
        authorization,
        { ...f.request(), expectedDefinitionDigest: previous.definitionDigest },
        f.options,
      ),
    ).rejects.toMatchObject({ status: 409, details: { code: "tool_definition_stale" } });
    expect(f.state.admissions).toBe(0);
    expect(f.state.effects).toBe(0);
    const response = await invokeWorkspaceToolTarget(deps, authorization, f.request(), f.options);
    expect(response.tool.entry.description).toBe("v2");
    expect(f.state.effects).toBe(1);
    expect(f.state.closes).toBe(3);
  });

  test("invalid arguments and revoked live authority prevent approval and effects", async () => {
    const f = fixture();
    await expect(
      invokeWorkspaceToolTarget(deps, authorization, { ...f.request(), arguments: {} }, f.options),
    ).rejects.toMatchObject({ status: 422 });
    let checked = 0;
    await expect(
      invokeWorkspaceToolTarget(deps, authorization, f.request(), {
        ...f.options,
        reauthorize: async () => {
          if (++checked > 1) throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(f.state.effects).toBe(0);
    expect(f.state.admissions).toBe(0);
    expect(f.state.closes).toBe(2);
  });

  test("target approvals bind executable authority separately and tombstones never invoke", async () => {
    const f = fixture();
    f.state.ask = true;
    const tool = await resolveWorkspaceToolTarget(
      deps,
      authorization,
      { target: { identity } },
      f.options,
    );
    let issued: unknown;
    const request = f.request();
    const approval = await approveWorkspaceToolTarget(
      deps,
      authorization,
      {
        identity,
        arguments: request.arguments,
        operationId: request.operationId,
        expectedDefinitionDigest: tool.definitionDigest,
      },
      {
        ...f.options,
        issue: async (_db, input) => {
          issued = input;
        },
      },
    );
    expect(issued).toMatchObject({
      bindingVersion: 2,
      approvalAuthorityDigest: "c".repeat(64),
      targetBindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(issued).not.toHaveProperty("catalogDigest");
    expect(approval.bindingVersion).toBe(2);
    expect(f.state.effects).toBe(0);
    await expect(
      invokeWorkspaceToolTarget(
        deps,
        authorization,
        { ...request, approvalToken: approval.approvalToken },
        {
          ...f.options,
          begin: async () => {
            throw new ToolGatewayApprovalOperationStartedError();
          },
        },
      ),
    ).rejects.toMatchObject({ status: 409, outcomeUnknown: true });
    expect(f.state.effects).toBe(0);
  });

  test("post-dispatch output failure and lost response are uncertain and execute only once", async () => {
    for (const failure of ["invalidOutput", "failAfterEffect"] as const) {
      const f = fixture();
      f.state[failure] = true;
      await expect(
        invokeWorkspaceToolTarget(deps, authorization, f.request(), f.options),
      ).rejects.toMatchObject({ status: 502, outcomeUnknown: true, retryable: false });
      expect(f.state.effects).toBe(1);
      expect(f.state.admissions).toBe(1);
      expect(f.state.closes).toBe(1);
    }
  });

  test("cleanup failures preserve success, preexecution errors and uncertain outcomes without leaking content", async () => {
    for (const failure of [null, "invalidOutput", "failAfterEffect"] as const) {
      const f = fixture();
      f.state.failClose = true;
      const logs: unknown[] = [];
      const loggingDeps = {
        observability: { warn: (...args: unknown[]) => logs.push(args) },
      } as unknown as ApiRouteDeps;
      if (failure) {
        f.state[failure] = true;
        await expect(
          invokeWorkspaceToolTarget(loggingDeps, authorization, f.request(), f.options),
        ).rejects.toMatchObject({ status: 502, retryable: false, outcomeUnknown: true });
      } else {
        expect(
          (await invokeWorkspaceToolTarget(loggingDeps, authorization, f.request(), f.options))
            .result.structuredContent,
        ).toEqual({ ok: true });
      }
      expect(f.state.effects).toBe(1);
      expect(f.state.closes).toBe(1);
      expect(logs).toEqual([["target_tool_cleanup_failed"]]);
      await expect(
        invokeWorkspaceToolTarget(
          loggingDeps,
          authorization,
          { ...f.request(), arguments: {} },
          f.options,
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(
        (
          await resolveWorkspaceToolTarget(
            loggingDeps,
            authorization,
            { target: { identity } },
            f.options,
          )
        ).entry.identity,
      ).toEqual(identity);
      expect(
        (
          await resolveWorkspaceToolManifest(
            loggingDeps,
            authorization,
            { identities: [identity] },
            f.options,
          )
        ).tools,
      ).toHaveLength(1);
    }
  });
  test("missing trustworthy executable effect binding fails closed before admission or approval issuance", async () => {
    const f = fixture();
    f.state.ask = true;
    let issued = 0;
    const prepare = f.options.prepare!;
    f.options.prepare = async (...args) => {
      const prepared = await prepare(...args);
      const original = prepared.toolGateway.prepareCall.bind(prepared.toolGateway);
      prepared.toolGateway.prepareCall = async (...callArgs) => {
        const { effectDigest: _effect, ...call } = await original(...callArgs);
        return call;
      };
      return prepared;
    };
    f.options.issue = async () => {
      issued++;
    };
    await expect(
      invokeWorkspaceToolTarget(deps, authorization, f.request(), f.options),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      approveWorkspaceToolTarget(deps, authorization, { ...f.request(), identity }, f.options),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.state.effects).toBe(0);
    expect(f.state.admissions).toBe(0);
    expect(issued).toBe(0);
  });
});
