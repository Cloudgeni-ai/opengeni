import { expect, test } from "bun:test";
import { shell, type SandboxSessionLike } from "@openai/agents/sandbox";
import type { MCPServer } from "@openai/agents";
import { ScriptedModel, functionCall, testSettings } from "@opengeni/testing";
import {
  buildOpenGeniAgent,
  createTurnInvocationDrain,
  buildSandboxV2PreparedFileManifest,
  preparedCompactionRequest,
  runAgentStream,
  type BuildAgentOptions,
  type RunAgentStreamOptions,
} from "../src/index";
import type { SandboxV2PreparationFile, SandboxV2PreparationRepository } from "@opengeni/contracts";
import { allAgentCapabilities } from "@opengeni/contracts";

const settings = testSettings({ sandboxBackend: "none", webSearchEnabled: false });

function nativeFixture(
  options: {
    approval?: boolean;
    files?: readonly SandboxV2PreparationFile[];
    repositories?: readonly SandboxV2PreparationRepository[];
    authorizeResources?: () => Promise<void>;
  } = {},
) {
  const calls: Array<{ callId: string; input: string }> = [];
  let executions = 0;
  let stops = 0;
  let materializations = 0;
  const session: SandboxSessionLike = {
    state: Object.freeze({
      kind: "machine-v2",
      manifest: buildSandboxV2PreparedFileManifest(options.files ?? []),
    }),
    execCommand: async () => {
      executions++;
      return "retained native output";
    },
    supportsPty: () => false,
    stop: async () => {
      stops++;
    },
    materializeEntry: async () => {
      materializations++;
      throw new Error("No SDK materialization may run for the prepared native workspace");
    },
  };
  const capability = shell({
    execCommandErrorFunction: (_context, error) => {
      throw error;
    },
    configureTools: (tools) =>
      tools.map((tool) => {
        if (tool.type !== "function") throw new Error("Expected function shell transport");
        const invoke = tool.invoke;
        return {
          ...tool,
          ...(options.approval ? { needsApproval: async () => true } : {}),
          invoke: async (context, input, details) => {
            expect(details?.toolCall?.type).toBe("function_call");
            expect(details?.toolCall?.arguments).toBe(input);
            calls.push({ callId: details!.toolCall!.callId, input });
            return await invoke(context, input, details);
          },
        };
      }),
  });
  return {
    session,
    capability,
    calls,
    counts: () => ({ executions, stops, materializations }),
    binding: {
      session,
      capabilities: [capability],
      files: options.files ?? [],
      repositories: options.repositories ?? [],
      ...(options.authorizeResources ? { authorizeResources: options.authorizeResources } : {}),
    },
  };
}

async function drain(stream: Awaited<ReturnType<typeof runAgentStream>>) {
  for await (const event of stream) void event;
  await stream.completed;
}

test("prepared native session uses standard model filters and exact calls despite a legacy default change", async () => {
  const fixture = nativeFixture();
  const args = { cmd: "printf synthetic", yield_time_ms: 1000 };
  const model = new ScriptedModel([
    { output: [functionCall("exec_command", args, "synthetic-native-call")] },
    { outputText: "finished" },
  ]);
  const agent = buildOpenGeniAgent(settings, [], {
    model,
    machineSandbox: fixture.binding,
    supportsImageInput: false,
  });
  let admitted = 0;
  let settled = 0;
  let filtered = 0;
  const phases: string[] = [];
  const stream = await runAgentStream(agent, "use the prepared workspace", settings, {
    beforeModelRequest: () => {
      admitted++;
    },
    onModelResponse: () => {
      settled++;
    },
    callModelInputFilter: (input) => {
      filtered++;
      return input.modelData;
    },
    onModelPreparationPhase: (measurement) => phases.push(measurement.phase),
  });
  await drain(stream);
  expect(stream.finalOutput).toBe("finished");
  expect(fixture.calls).toEqual([{ callId: "synthetic-native-call", input: JSON.stringify(args) }]);
  expect(fixture.counts()).toEqual({ executions: 1, stops: 0, materializations: 0 });
  expect({ admitted, settled, filtered }).toEqual({ admitted: 2, settled: 2, filtered: 2 });
  expect(phases).toContain("sandbox_session_manifest_inventory");
  expect(phases).not.toContain("sandbox_client_create");
  const prefix = preparedCompactionRequest(agent);
  expect(prefix.systemInstructions).toBe(model.requests.at(-1)!.systemInstructions);
  expect(prefix.tools.some((tool) => tool.name === "exec_command")).toBe(true);
  expect(prefix.tools.some((tool) => tool.name === "apply_patch")).toBe(false);
});

test("prepared file refs reach model context without materialization and retain live grants on every request", async () => {
  const file = {
    fileId: crypto.randomUUID(),
    mountPath: "inputs",
    filename: "sample.csv",
    sizeBytes: 3,
    sha256: "a".repeat(64),
  };
  let grantChecks = 0;
  const fixture = nativeFixture({
    files: [file],
    authorizeResources: async () => {
      grantChecks++;
    },
  });
  const model = new ScriptedModel([
    {
      output: [functionCall("exec_command", { cmd: "cat inputs/sample.csv" }, "native-file-call")],
    },
    { outputText: "read file" },
  ]);
  const agent = buildOpenGeniAgent(
    settings,
    [{ kind: "file", fileId: file.fileId, mountPath: file.mountPath }],
    {
      model,
      machineSandbox: fixture.binding,
    },
  );
  let producerAdmissions = 0;
  await drain(
    await runAgentStream(agent, "read the current attachment", settings, {
      beforeModelRequest: () => {
        producerAdmissions++;
      },
    }),
  );
  expect(model.requests[0]!.systemInstructions).toContain("sample.csv");
  expect({ grantChecks, producerAdmissions }).toEqual({ grantChecks: 2, producerAdmissions: 2 });
  expect(fixture.counts()).toEqual({ executions: 1, stops: 0, materializations: 0 });
  expect(() =>
    buildOpenGeniAgent(settings, [{ kind: "file", fileId: file.fileId, mountPath: "other" }], {
      model,
      machineSandbox: fixture.binding,
    }),
  ).toThrow("unprepared resources");
  expect(() =>
    buildOpenGeniAgent(settings, [{ kind: "file", fileId: file.fileId, mountPath: "inputs" }], {
      model,
      machineSandbox: { ...fixture.binding, authorizeResources: undefined } as never,
    }),
  ).toThrow("live authorization owner");
});

test("native rig context names its pinned version and retained group in both prompt formats", async () => {
  for (const modular of [false, true]) {
    const fixture = nativeFixture();
    const rig = { name: "Synthetic native environment", version: 1 };
    const model = new ScriptedModel([{ outputText: "configuration received" }]);
    const agent = buildOpenGeniAgent(settings, [], {
      model,
      rig,
      machineSandbox: fixture.binding,
      ...(modular
        ? {
            agentConfig: {
              version: 1 as const,
              from: "all" as const,
              capabilities: allAgentCapabilities(),
              unavailable: [],
              identity: null,
              renderer: "opengeni" as const,
              source: "request" as const,
            },
            agentPromptResources: {
              managedSandbox: true,
              connectedMachine: false,
              repositories: false,
              gitCredentials: false,
              attachments: false,
              rig,
            },
          }
        : {}),
    });
    await drain(await runAgentStream(agent, "describe the configuration", settings));
    const instructions = model.requests[0]!.systemInstructions;
    expect(instructions).toContain(
      'sandbox environment "Synthetic native environment" (pinned version v1)',
    );
    expect(instructions).toContain("Your sandbox machine is retained for this sandbox group.");
    expect(instructions).not.toContain("EPHEMERAL FORK");
    expect(fixture.counts()).toEqual({ executions: 0, stops: 0, materializations: 0 });
  }
});

test("prepared native repositories use original references and no SDK clone lifecycle", async () => {
  const repository = {
    uri: "https://repository.example.test/owner/project.git",
    ref: "main",
    mountPath: "project",
    expectedCommitSha: "a".repeat(40),
  };
  let grantChecks = 0;
  const fixture = nativeFixture({
    repositories: [repository],
    authorizeResources: async () => {
      grantChecks++;
    },
  });
  const resource = { kind: "repository" as const, ...repository };
  const model = new ScriptedModel([
    {
      output: [
        functionCall("exec_command", { cmd: "cat project/example.ts" }, "native-repository-call"),
      ],
    },
    { outputText: "read repository" },
  ]);
  const agent = buildOpenGeniAgent(testSettings({ sandboxBackend: "modal" }), [resource], {
    model,
    machineSandbox: fixture.binding,
  });
  await drain(await runAgentStream(agent, "read the prepared repository", settings));
  expect(fixture.counts()).toEqual({ executions: 1, stops: 0, materializations: 0 });
  expect(grantChecks).toBe(2);
  expect(() =>
    buildOpenGeniAgent(settings, [{ ...resource, expectedCommitSha: "b".repeat(40) }], {
      model,
      machineSandbox: fixture.binding,
    }),
  ).toThrow("unprepared resources");
  expect(() =>
    buildOpenGeniAgent(settings, [resource], {
      model,
      machineSandbox: { ...fixture.binding, authorizeResources: undefined } as never,
    }),
  ).toThrow("live authorization owner");
});

test("revoked cached-file grants stop native model dispatch and cannot be bypassed by a caller admission hook", async () => {
  const file = {
    fileId: crypto.randomUUID(),
    mountPath: "inputs",
    filename: "sample.csv",
    sizeBytes: 3,
    sha256: "a".repeat(64),
  };
  const refusal = new Error("Synthetic attachment grant revoked");
  const fixture = nativeFixture({
    files: [file],
    authorizeResources: async () => {
      throw refusal;
    },
  });
  const model = new ScriptedModel("must not run");
  const agent = buildOpenGeniAgent(
    settings,
    [{ kind: "file", fileId: file.fileId, mountPath: "inputs" }],
    {
      model,
      machineSandbox: fixture.binding,
    },
  );
  let producerAdmissions = 0;
  await expect(
    (async () => {
      await drain(
        await runAgentStream(agent, "read", settings, {
          beforeModelRequest: () => {
            producerAdmissions++;
          },
        }),
      );
    })(),
  ).rejects.toBe(refusal);
  expect(producerAdmissions).toBe(0);
  expect(model.calls).toBe(0);
  expect(fixture.counts()).toEqual({ executions: 0, stops: 0, materializations: 0 });
});

test("prepared native file manifests reject sources and target collisions before setup", () => {
  const file = {
    fileId: crypto.randomUUID(),
    mountPath: "inputs",
    filename: "one.txt",
    sizeBytes: 3,
    sha256: "a".repeat(64),
  };
  const second = { ...file, fileId: crypto.randomUUID(), filename: "two.txt" };
  expect(buildSandboxV2PreparedFileManifest([file, second]).describe()).toContain("two.txt");
  expect(() =>
    buildSandboxV2PreparedFileManifest([file, { ...second, filename: "ONE.txt" }]),
  ).toThrow("targets collide");
  expect(() =>
    buildSandboxV2PreparedFileManifest([file, { ...second, mountPath: "inputs/one.txt" }]),
  ).toThrow("conflicts with a directory");
  expect(() =>
    buildSandboxV2PreparedFileManifest([
      { ...file, url: "https://example.test/private-source" } as never,
    ]),
  ).toThrow();
  const fixture = nativeFixture({ files: [file] });
  expect(() =>
    buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel("must not run"),
      machineSandbox: { ...fixture.binding, files: [] },
    }),
  ).toThrow("manifest does not match");
});

test("unprepared resources and legacy credential/cancellation declarations fail before execution", () => {
  const fixture = nativeFixture();
  const model = new ScriptedModel("must not run");
  const incompatible: BuildAgentOptions[] = [
    { gitTokenSeed: "synthetic-secret" },
    { codemodeTokenSeed: "synthetic-secret", codemodeTokenSessionId: "synthetic-session" },
    { rigSetup: { script: "printf synthetic" } as never },
    { onToolCancellationFence: () => undefined },
    { activeSandboxBackend: "selfhosted", sandboxWorkspaceRoot: "/workspace" },
  ];
  for (const options of incompatible) {
    expect(() =>
      buildOpenGeniAgent(settings, [], { ...options, model, machineSandbox: fixture.binding }),
    ).toThrow("Native sandbox preparation cannot use legacy");
  }
  expect(() =>
    buildOpenGeniAgent(settings, [{ kind: "file", fileId: crypto.randomUUID() }], {
      model,
      machineSandbox: fixture.binding,
    }),
  ).toThrow("Native sandbox preparation cannot use legacy");
  expect(model.calls).toBe(0);
  expect(fixture.counts().executions).toBe(0);
});

test("legacy runtime owners cannot decorate or replace the prepared native session", async () => {
  const fixture = nativeFixture();
  const model = new ScriptedModel("must not run");
  const agent = buildOpenGeniAgent(settings, [], { model, machineSandbox: fixture.binding });
  const incompatible: RunAgentStreamOptions[] = [
    { sandboxClient: { backendId: "synthetic-legacy" } },
    { ownedSandbox: { client: {}, session: fixture.session } },
    { runCredentialSessionId: "synthetic-session" },
    { onRunCredentialSessionReady: async () => undefined },
    { onSandboxSessionReady: async () => undefined },
  ];
  for (const options of incompatible) {
    await expect(runAgentStream(agent, "test", settings, options)).rejects.toThrow(
      "Prepared native sandbox cannot be combined",
    );
  }
  const legacyAgent = buildOpenGeniAgent(settings, [], { model });
  await expect(
    runAgentStream(legacyAgent, "test", settings, {
      ownedSandbox: { client: {}, session: fixture.session },
    }),
  ).rejects.toThrow("Native session requires its prepared agent");
  await expect(
    runAgentStream(legacyAgent, "test", settings, {
      ownedSandbox: { client: {}, session: {}, setupSession: fixture.session },
    }),
  ).rejects.toThrow("Native session requires its prepared agent");
  expect(model.calls).toBe(0);
  expect(fixture.counts()).toEqual({ executions: 0, stops: 0, materializations: 0 });
});

test("native path keeps producer model admission before model or command I/O", async () => {
  const fixture = nativeFixture();
  const model = new ScriptedModel([
    { output: [functionCall("exec_command", { cmd: "printf synthetic" })] },
  ]);
  const agent = buildOpenGeniAgent(settings, [], { model, machineSandbox: fixture.binding });
  const refusal = new Error("Synthetic revoked model admission");
  await expect(
    (async () => {
      const stream = await runAgentStream(agent, "test", settings, {
        beforeModelRequest: () => {
          throw refusal;
        },
      });
      await drain(stream);
    })(),
  ).rejects.toBe(refusal);
  expect(model.calls).toBe(0);
  expect(fixture.calls).toEqual([]);
  expect(fixture.counts().stops).toBe(0);
});

test("SDK approval interruption freezes a native shell call before its accepted invocation", async () => {
  const fixture = nativeFixture({ approval: true });
  const model = new ScriptedModel([
    { output: [functionCall("exec_command", { cmd: "printf synthetic" }, "native-approval-call")] },
  ]);
  const agent = buildOpenGeniAgent(settings, [], { model, machineSandbox: fixture.binding });
  const stream = await runAgentStream(agent, "test", settings);
  await drain(stream);
  expect(stream.interruptions).toHaveLength(1);
  expect(fixture.calls).toEqual([]);
  expect(fixture.counts()).toEqual({ executions: 0, stops: 0, materializations: 0 });
  expect(model.calls).toBe(1);
});

test("native worker invocation admission closes model and cloned SDK tool dispatch without stopping the machine", async () => {
  const fixture = nativeFixture();
  const invocations = createTurnInvocationDrain();
  const model = new ScriptedModel([
    { output: [functionCall("exec_command", { cmd: "printf synthetic" }, "drained-native-call")] },
    { outputText: "finished" },
  ]);
  const agent = buildOpenGeniAgent(settings, [], {
    model,
    machineSandbox: { ...fixture.binding, invocationDrain: invocations },
  });
  await drain(await runAgentStream(agent, "run", settings));
  expect(fixture.calls).toHaveLength(1);
  invocations.cancel();
  await invocations.waitForDrain();
  await expect(
    (async () => {
      await drain(await runAgentStream(agent, "late stream", settings));
    })(),
  ).rejects.toThrow("TURN_ATTEMPT_FINALIZED");
  expect(model.calls).toBe(2);
  expect(fixture.counts()).toEqual({ executions: 1, stops: 0, materializations: 0 });
});

test("native standard SDK MCP callbacks stay owned after cancellation until their real promise settles", async () => {
  const fixture = nativeFixture();
  const invocations = createTurnInvocationDrain();
  const started = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const server: MCPServer = {
    name: "synthetic-owned-mcp",
    cacheToolsList: false,
    connect: async () => {},
    close: async () => {},
    invalidateToolsCache: async () => {},
    listTools: async () => [
      {
        name: "synthetic_external",
        description: "Synthetic owned external callback",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    callTool: async (_name, _args, _meta, options) => {
      calls++;
      started.resolve(options!.signal!);
      await release.promise;
      return [{ type: "text", text: "original callback completed" }];
    },
  };
  const model = new ScriptedModel([
    { output: [functionCall("synthetic_external", {}, "owned-mcp-call")] },
    { outputText: "must not dispatch" },
  ]);
  const agent = buildOpenGeniAgent(settings, [], {
    model,
    mcpServers: [server],
    machineSandbox: { ...fixture.binding, invocationDrain: invocations },
  });
  const running = drain(await runAgentStream(agent, "call", settings));
  const outcome = running.catch((error) => error);
  const signal = await started.promise;
  const reason = new Error("Synthetic MCP turn cancelled");
  invocations.cancel(reason);
  expect(signal.aborted).toBe(true);
  let drained = false;
  const waiting = invocations.waitForDrain().then(() => {
    drained = true;
  });
  await Bun.sleep(0);
  expect(drained).toBe(false);
  release.resolve();
  await waiting;
  expect(await outcome).toBe(reason);
  expect(calls).toBe(1);
  expect(model.calls).toBe(1);
  expect(fixture.counts()).toEqual({ executions: 0, stops: 0, materializations: 0 });
});
