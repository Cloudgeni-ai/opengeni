import { describe, expect, test } from "bun:test";
import {
  buildMissingSecretAskCard,
  SecretReferenceError,
  secretUseApprovalHumanInput,
  type AccessGrant,
  type SecretReferenceFailure,
  type SecretResolver,
} from "@opengeni/contracts";
import type { ApiRouteDeps } from "@opengeni/core";
import { mcpToolErrorOutput } from "@opengeni/runtime";
import { createSecretArgumentResolver } from "@opengeni/runtime/workspace-tool-gateway";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { createWorkspaceToolGateway } from "@opengeni/tool-gateway";
import { createStaticSecretResolver } from "@opengeni/vaults/testing";
import { buildOpenGeniMcpServer } from "../src/mcp/server";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const REFERENCE = "{{secret:Canary/password}}";

function approvalCard(surface: "mcp" | "run_on" | "file_write") {
  return secretUseApprovalHumanInput({
    id: "33333333-3333-4333-8333-333333333333",
    targets: [
      {
        vaultId: WORKSPACE,
        itemId: ACCOUNT,
        fieldKey: "password",
        fieldName: "password",
        vaultName: "Private",
        itemName: "Canary",
      },
    ],
    surface,
    toolName: surface === "mcp" ? "opengeni__run_on" : "run_on",
    destination: surface === "mcp" ? "opengeni" : "test-machine",
  });
}

function failure(code: "not_found" | "approval_required") {
  const failures: SecretReferenceFailure[] = [
    {
      raw: REFERENCE,
      code,
      message: code === "not_found" ? "Secret not found" : "This use needs approval",
    },
  ];
  return new SecretReferenceError(
    failures,
    code === "not_found" ? buildMissingSecretAskCard(failures, { hasActingHuman: true }) : null,
    code === "approval_required" ? approvalCard("run_on") : null,
  );
}

/** Render a failure through the real gateway's former literal-resolution path. */
async function literalGatewayFailure(error: SecretReferenceError, args: Record<string, unknown>) {
  const resolver: SecretResolver = {
    ...createStaticSecretResolver({}),
    resolve: async () => {
      throw error;
    },
  };
  let dispatched = false;
  const { catalog, gateway } = createWorkspaceToolGateway({
    accountId: ACCOUNT,
    workspaceId: WORKSPACE,
    generation: 1,
    resolveArguments: createSecretArgumentResolver({ resolver, modeFor: () => "literal" })!,
    definitions: [
      {
        identity: { serverId: "opengeni", toolName: "run_on" },
        source: "opengeni",
        modelName: "opengeni__run_on",
        description: "Run a one-off machine operation",
        approval: "none",
        inputSchema: {
          type: "object",
          properties: { target: { type: "string" }, op: { type: "object" } },
          required: ["target", "op"],
        },
        execute: () => {
          dispatched = true;
          throw new Error("Secret resolution must refuse before dispatch");
        },
      },
    ],
  });
  const prepared = await gateway.prepareCall({
    operationId: crypto.randomUUID(),
    catalogDigest: catalog.digest,
    identity: catalog.entries[0]!.identity,
    arguments: args,
    caller: { kind: "model", subjectId: "subject" },
  });
  const caught = await prepared.execute().catch((value) => value);
  expect(caught).toBe(error);
  expect(dispatched).toBe(false);
  return mcpToolErrorOutput(caught);
}

describe("run_on MCP secret failure envelope", () => {
  for (const kind of ["exec", "write"] as const) {
    for (const code of ["not_found", "approval_required"] as const) {
      test(`${kind} ${code}: byte-identical to the gateway envelope for the same error`, async () => {
        const error = failure(code);
        const grant: AccessGrant = {
          accountId: ACCOUNT,
          workspaceId: WORKSPACE,
          subjectId: "worker:fixture",
          principalKind: "agent_attempt",
          permissions: ["sessions:control"],
          metadata: {
            sessionId: crypto.randomUUID(),
            turnId: crypto.randomUUID(),
            attemptId: crypto.randomUUID(),
            firstPartyMcpTools: ["run_on"],
            executionGeneration: 1,
          },
        };
        let touches = 0;
        const deps = {
          settings: testSettings({ sandboxBackend: "none", sandboxSelfhostedEnabled: true }),
          bus: new MemoryEventBus(),
          // Inject at the first handler dependency. The core run-on tests prove
          // that target-side resolution propagates this exact typed error with
          // no exec or file write; here we exercise the registered MCP adapter.
          db: new Proxy(
            {},
            {
              get() {
                touches += 1;
                throw error;
              },
            },
          ),
          workflowClient: {},
        } as unknown as ApiRouteDeps;
        const server = buildOpenGeniMcpServer(deps, grant);
        const handler = (
          server as unknown as {
            _registeredTools: Record<
              string,
              {
                handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
              }
            >;
          }
        )._registeredTools.run_on!.handler;
        const args = {
          target: "test-machine",
          op:
            kind === "exec"
              ? { kind, cmd: `use ${REFERENCE}` }
              : { kind, path: "out.txt", content: REFERENCE },
        };
        const result = await handler(args, {});
        const expected = await literalGatewayFailure(error, args);
        expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
        expect(result).toEqual({
          isError: true,
          content: [{ type: "text", text: error.toModelOutput() }],
        });
        expect(touches).toBeGreaterThan(0);
      });
    }
  }

  test("approval wording describes the target command or file write, not the generic connector", () => {
    expect(approvalCard("mcp").questions[0]!.prompt).toBe(
      "Allow the agent to use Canary › password in a call to opengeni?",
    );
    expect(approvalCard("run_on").questions[0]!.prompt).toBe(
      "Allow the agent to use Canary › password in a command on test-machine?",
    );
    expect(approvalCard("file_write").questions[0]!.prompt).toBe(
      "Allow the agent to use Canary › password in a file it writes?",
    );
    expect(approvalCard("run_on").questions[0]!.helpText).toContain("for run_on.");
    expect(approvalCard("mcp").questions[0]!.helpText).toContain("for opengeni__run_on.");
  });
});
