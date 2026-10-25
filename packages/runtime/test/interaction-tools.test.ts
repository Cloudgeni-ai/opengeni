import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import {
  CUA_DESKTOP_TOOLS,
  BrowserSession as BrowserSessionSchema,
  EPHEMERAL_CHROMIUM_DRIVER_ID,
  ComputerSession as ComputerSessionSchema,
} from "@opengeni/contracts";
import type {
  AuthRun,
  BrowserActionRequest,
  BrowserActionReceipt,
  BrowserObservation,
  BrowserSession,
  BrowserTarget,
  ComputerActionRequest,
  ComputerActionReceipt,
  ComputerObservation,
  ComputerSession,
  ComputerTarget,
  InteractionIntervention,
} from "@opengeni/contracts";
import { OpenGeniApiError, type InteractionTransport } from "@opengeni/sdk";
import {
  INTERACTION_ATTEMPT_TOOL_NAMES,
  createInteractionAttemptToolDefinitions,
  nativeCuaSchema,
  openComputerAppWindow,
  type UserSetupCardPoster,
} from "../src/interaction-tools";
import { computerObservationText } from "../src/computer-model-text";
import { MCP_MAX_TOOL_RESULT_BYTES, mcpSerializedSizeBytes } from "../src/mcp-network";
import { modelToolResultFits } from "../src/tool-result-spill";

const accountId = randomUUID();
const workspaceId = randomUUID();
const sessionId = randomUUID();
const turnId = randomUUID();
const attemptId = randomUUID();
const browserSessionId = randomUUID();
const computerSessionId = randomUUID();
const now = "2026-08-10T12:00:00.000Z";

describe("interaction attempt tools", () => {
  test("every native CUA tool exposes one top-level object schema", () => {
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({ callNativeComputerTool: async () => ({}) as never }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_open", "computer_act"],
      permissions: ["sessions:control"],
    }).filter((tool) => tool.modelName.startsWith("interaction__cua_"));
    expect(definitions.length).toBe(CUA_DESKTOP_TOOLS.length);
    for (const tool of definitions) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.anyOf).toBeUndefined();
      expect(tool.inputSchema.oneOf).toBeUndefined();
      // Optional: omitted, it is the computer the agent used last.
      expect(tool.inputSchema.required ?? []).not.toContain("computerSessionId");
      expect(
        (tool.inputSchema.properties as Record<string, unknown>).computerSessionId,
      ).toBeDefined();
      expect((tool.inputSchema.properties as Record<string, unknown>).session).toBeUndefined();
      // Found under "cua" in Code Mode, next to its model name interaction__cua_<name>.
      expect(tool.codemodePath).toEqual(["interaction", "cua", tool.identity.toolName.slice(4)]);
      expect(tool.description).toContain(
        "interaction__cua_<name> (in Code Mode interaction.cua.<name>)",
      );
    }
  });
  test("platform CUA schemas merge by property and keep real constraint differences", () => {
    const merged = nativeCuaSchema([
      {
        type: "object",
        additionalProperties: false,
        required: ["pid", "x"],
        properties: {
          pid: { type: "integer", description: "macOS pid" },
          x: { type: "number" },
          action: { type: "string" },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["pid"],
        properties: {
          pid: { type: "integer", description: "Linux pid" },
          x: { type: "integer", minimum: 0 },
          coordinate_frame: { enum: ["window", "desktop"], type: "string" },
        },
      },
    ]);
    expect(merged).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["pid"],
      properties: {
        pid: { type: "integer", description: "macOS pid" },
        x: { anyOf: [{ type: "number" }, { type: "integer", minimum: 0 }] },
        action: { type: "string" },
        coordinate_frame: { enum: ["window", "desktop"], type: "string" },
      },
    });
  });
  test("a nested step field one platform lacks merges into the steps instead of an anyOf", () => {
    const steps = (extra: Record<string, unknown>, required: string[]) => ({
      type: "object",
      properties: {
        steps: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            required,
            additionalProperties: true,
            properties: { tool: { type: "string" }, ...extra },
          },
        },
      },
    });
    const merged = nativeCuaSchema([
      steps({ toggle_to: { type: "boolean" } }, ["tool"]),
      steps({}, ["tool"]),
      steps({ timeout_ms: { type: "integer" } }, ["tool", "timeout_ms"]),
    ]);
    expect(merged).toEqual({
      type: "object",
      properties: {
        steps: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            required: ["tool"],
            additionalProperties: true,
            properties: {
              tool: { type: "string" },
              toggle_to: { type: "boolean" },
              timeout_ms: { type: "integer" },
            },
          },
        },
      },
    });
    // A real constraint difference around the nested fields still keeps both.
    const differing = nativeCuaSchema([
      steps({ toggle_to: { type: "boolean" } }, ["tool"]),
      { type: "object", properties: { steps: { type: "array", maxItems: 8, items: {} } } },
    ]);
    expect((differing.properties as any).steps.anyOf).toHaveLength(2);
  });
  test.each(["browser_read", "browser_act"] as const)(
    "%s preserves the definite tab diagnosis at the model boundary",
    async (tool) => {
      const message = "This tab is not responding. Reload or close it.";
      const failure = new OpenGeniApiError(
        409,
        JSON.stringify({
          error: {
            code: "tab_not_responding",
            message,
            retryable: false,
            outcomeUnknown: false,
          },
        }),
      );
      const definitions = createInteractionAttemptToolDefinitions({
        workspaceId,
        sessionId,
        selectedTools: [tool],
        permissions: ["sessions:read", "sessions:control"],
        transport: partialTransport({
          observeBrowserTarget: async () => {
            throw failure;
          },
          getBrowserTargetState: async () => {
            throw failure;
          },
          actInBrowser: async () => {
            throw failure;
          },
        }),
      });
      const result = await definitions[0]!.execute(
        {
          browserSessionId,
          targetId: "hung-tab",
          ...(tool === "browser_act"
            ? { action: { type: "click", locator: { kind: "css", selector: "button" } } }
            : {}),
        },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "tab_not_responding",
            message: expect.stringContaining(message),
            retryable: false,
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain("network_error");
      expect(JSON.stringify(result)).not.toContain("outcome_unknown");
    },
  );

  test("browser_act tells the model where upload workspace File IDs come from", () => {
    const definitions = createInteractionAttemptToolDefinitions({
      workspaceId,
      sessionId,
      selectedTools: ["browser_act"],
      permissions: ["sessions:control"],
      transport: partialTransport({}),
    });
    const act = definitions.find(
      (definition) => definition.modelName === "interaction__browser_act",
    )!;
    expect(act.description).toContain(
      "An upload action takes paths of files in this session's workspace",
    );
    expect(act.description).toContain("a sandbox_file_publish artifactId");
  });

  test("browser and computer entry tools tell the model to solve CAPTCHAs itself", () => {
    const definitions = createInteractionAttemptToolDefinitions({
      workspaceId,
      sessionId,
      selectedTools: ["browser_open", "computer_open"],
      permissions: ["sessions:control"],
      transport: partialTransport({}),
    });
    // The entry tools are visible from the first request of every session that
    // can drive a browser or computer, so the CAPTCHA rule travels with them
    // rather than with the secrets capability.
    for (const name of ["browser_open", "computer_open"]) {
      const description = definitions.find(
        (definition) => definition.modelName === `interaction__${name}`,
      )!.description;
      expect(description).toEndWith(
        "Solve CAPTCHAs and other verification challenges yourself, retrying and trying alternatives as needed; never hand them to the user.",
      );
    }
  });

  test("login tools tell the model to sign in itself and hand off only physical steps", () => {
    const definitions = createInteractionAttemptToolDefinitions({
      workspaceId,
      sessionId,
      selectedTools: ["browser_auth", "interaction_request_human"],
      permissions: ["sessions:control"],
      transport: partialTransport({}),
    });
    const description = (name: string) =>
      definitions.find((definition) => definition.modelName === `interaction__${name}`)!
        .description;
    const auth = description("browser_auth");
    expect(auth).toContain("Reuse a saved sign-in, the first rung of the login ladder");
    expect(auth).toContain("sign in yourself");
    expect(auth).toContain("solve CAPTCHAs yourself");
    expect(auth).not.toContain(
      "If an operation returns needs_human, call interaction_request_human",
    );
    const human = description("interaction_request_human");
    expect(human).toContain("a push approval on their phone, a hardware security key");
    expect(human).toContain("never hand over a CAPTCHA or a step you can do");
    expect(human).not.toContain("login/MFA handoffs");
  });

  test("native platform alternatives admit Linux arguments and retain the session boundary", async () => {
    let calls = 0;
    const definitions = createInteractionAttemptToolDefinitions({
      workspaceId,
      sessionId,
      selectedTools: ["computer_open", "computer_act"],
      permissions: ["sessions:control"],
      transport: partialTransport({
        callNativeComputerTool: async (_workspace, _computer, request) => {
          calls++;
          expect(request.arguments).toEqual({ launch_path: "fixture-app" });
          return {
            protocolVersion: 1,
            operationId: request.operationId,
            computerSessionId,
            controllerGeneration: "fixture",
            targetId: null,
            state: "failed",
            dispatchedAt: null,
            settledAt: now,
            observation: null,
            error: { code: "unsupported", message: "Synthetic fixture", retryable: false },
          };
        },
      }),
    });
    const environment = createAttemptToolEnvironment({
      scope: { accountId, workspaceId, sessionId, turnId, attemptId, executionGeneration: 1 },
      generation: 1,
      definitions,
    });
    await environment.callModel({
      operationId: randomUUID(),
      subjectId: "model:fixture",
      modelName: "interaction__cua_launch_app",
      arguments: { computerSessionId, launch_path: "fixture-app" },
    });
    expect(calls).toBe(1);
    await expect(
      environment.callModel({
        operationId: randomUUID(),
        subjectId: "model:fixture",
        modelName: "interaction__cua_launch_app",
        arguments: { computerSessionId, session: "other", launch_path: "fixture-app" },
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  test("a native call the API refuses is a definite tool error, not an unknown outcome", async () => {
    let failure: Error = new OpenGeniApiError(
      409,
      "This Desktop belonged to a previous task placement and was retired. Open a new Desktop.",
      { code: "conflict", retryable: false },
    );
    const definitions = createInteractionAttemptToolDefinitions({
      workspaceId,
      sessionId,
      selectedTools: ["computer_open", "computer_act"],
      permissions: ["sessions:control"],
      transport: partialTransport({
        callNativeComputerTool: async () => {
          throw failure;
        },
      }),
    });
    const listWindows = definitions.find(
      (definition) => definition.modelName === "interaction__cua_list_windows",
    )!;
    const context = {
      operationId: randomUUID(),
      caller: { kind: "model" as const, subjectId: "model:test" },
    };
    const refused = await listWindows.execute({ computerSessionId }, context);
    expect(refused).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "conflict",
          retryable: false,
          message: expect.stringContaining("was retired. Open a new Desktop."),
        },
      },
    });
    // A server failure or an uncertain dispatch keeps its failure path.
    failure = new OpenGeniApiError(503, "Unavailable", { code: "unavailable", retryable: true });
    await expect(listWindows.execute({ computerSessionId }, context)).rejects.toThrow(
      "Unavailable",
    );
  });
  test("oversized native output retains completed operation evidence through the prepared gateway", async () => {
    const definitions = createInteractionAttemptToolDefinitions({
      workspaceId,
      sessionId,
      selectedTools: ["computer_open", "computer_act"],
      permissions: ["sessions:control"],
      transport: partialTransport({
        callNativeComputerTool: async (_workspace, _computer, request) => ({
          protocolVersion: 1,
          operationId: request.operationId,
          computerSessionId,
          controllerGeneration: "controller-1",
          targetId: null,
          state: "completed",
          dispatchedAt: now,
          settledAt: now,
          error: null,
          observation: {
            target: null,
            computerSessionId,
            controllerGeneration: "controller-1",
            tool: request.tool,
            outcome: "completed",
            error: null,
            result: {
              content: [{ type: "text", text: "Large desktop inventory" }],
              structuredContent: { apps: [], extra: "A".repeat(17 * 1024 * 1024) },
            },
          },
        }),
      }),
    });
    const environment = createAttemptToolEnvironment({
      scope: { accountId, workspaceId, sessionId, turnId, attemptId, executionGeneration: 1 },
      generation: 1,
      definitions,
    });
    const operationId = randomUUID();
    const result = await environment.callModel({
      operationId,
      modelName: "interaction__cua_list_apps",
      subjectId: "model:fixture",
      arguments: { computerSessionId },
    });
    expect(result.isError).toBe(true);
    expect(result._meta?.opengeniOperation).toMatchObject({ operationId, state: "completed" });
    expect(JSON.stringify(result)).toContain("Do not repeat the action");
    expect(JSON.stringify(result).length).toBeLessThan(12 * 1024 * 1024);
  });
  test("native CUA definitions retain upstream schemas and raw partial batch evidence", async () => {
    let calls = 0;
    const original = {
      content: [
        { type: "text", text: "step 2 failed" },
        { type: "image", mimeType: "image/png", data: "AA==" },
      ],
      structuredContent: { ok: false, executed: 2 },
      isError: true,
    };
    const transport = partialTransport({
      callNativeComputerTool: async (workspace, computer, request) => {
        expect(workspace).toBe(workspaceId);
        expect(computer).toBe(computerSessionId);
        expect(request.arguments).toEqual({
          steps: [{ tool: "click", args: { pid: 42, window_id: 1, element_token: "snapshot:0" } }],
          observe: {},
        });
        calls++;
        return {
          protocolVersion: 1,
          operationId: request.operationId,
          computerSessionId,
          controllerGeneration: "controller-1",
          targetId: null,
          state: "outcome_unknown",
          dispatchedAt: now,
          settledAt: now,
          observation: {
            target: null,
            computerSessionId,
            controllerGeneration: "controller-1",
            tool: request.tool,
            result: original,
            outcome: "outcome_unknown",
            error: { code: "driver_failed", message: "partial", retryable: false },
          },
          error: { code: "driver_failed", message: "partial", retryable: false },
        };
      },
    });
    const definitions = createInteractionAttemptToolDefinitions({
      transport,
      workspaceId,
      sessionId,
      selectedTools: ["computer_open", "computer_act"],
      permissions: ["sessions:control"],
    });
    expect(calls).toBe(0);
    const batch = definitions.find((tool) => tool.modelName === "interaction__cua_run_steps")!;
    const upstream = CUA_DESKTOP_TOOLS.find((tool) => tool.name === "run_steps")!;
    expect((batch.inputSchema.properties as any).steps).toEqual(
      (upstream.inputSchema.properties as any).steps,
    );
    expect((batch.inputSchema.properties as any).session).toBeUndefined();
    const result = await batch.execute(
      {
        computerSessionId,
        steps: [{ tool: "click", args: { pid: 42, window_id: 1, element_token: "snapshot:0" } }],
        observe: {},
      },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:fixture" } },
    );
    expect(result.content.slice(0, 2)).toEqual(original.content);
    expect(result.structuredContent).toEqual(original.structuredContent);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Do not replay");
    expect(calls).toBe(1);
    for (const options of [
      { selectedTools: ["computer_open"] as const, permissions: ["sessions:control"] as const },
      {
        selectedTools: ["computer_open", "computer_act"] as const,
        permissions: ["sessions:read"] as const,
      },
    ])
      expect(
        createInteractionAttemptToolDefinitions({
          transport,
          workspaceId,
          sessionId,
          ...options,
        }).some((tool) => tool.modelName.startsWith("interaction__cua_")),
      ).toBe(false);
  });
  test("attached Chrome discovery never loads unrelated workspace inventories", async () => {
    const bridge = {
      enrollmentId: randomUUID(),
      state: "online" as const,
      bridgeGeneration: "bridge-1",
      inventoryRevision: 1,
      connectedProfileCount: 0,
      lastSeenAt: now,
    };
    const requests: unknown[] = [];
    const unexpected = async () => {
      throw new Error("Unrelated workspace inventory must not be loaded");
    };
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listBrowserSessions: unexpected,
        listComputerSessions: unexpected,
        listBrowserIdentities: unexpected,
        listAttachedBrowsers: async (workspace, options) => {
          requests.push({ workspace, options });
          return { revision: 42, bridges: [bridge], devices: [] };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["interaction_discover"],
      permissions: ["sessions:read"],
    });
    for (const includeDisconnectedDevices of [undefined, true]) {
      const result = await definitions[0]!.execute(
        { scope: "attached_browsers", includeDisconnectedDevices },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        browserRevision: 42,
        computerRevision: 42,
        identityRevision: 42,
        attachedBrowserRevision: 42,
        browsers: [],
        computers: [],
        identities: [],
        attachedBrowserBridges: [{ enrollmentId: bridge.enrollmentId, connectedProfileCount: 0 }],
        attachedBrowsers: [],
      });
    }
    expect(requests).toEqual([
      { workspace: workspaceId, options: { includeDisconnected: false } },
      { workspace: workspaceId, options: { includeDisconnected: true } },
    ]);
  });

  test("attached Chrome discovery lists lean profiles and hides bridges once one is connected", async () => {
    const device = {
      id: randomUUID(),
      accountId,
      workspaceId,
      enrollmentId: randomUUID(),
      name: "Work laptop",
      profileLabel: "Personal",
      browserName: "Google Chrome",
      browserVersion: "150.0.0.0",
      extensionVersion: "0.1.4",
      platform: "macos" as const,
      architecture: "arm64" as const,
      state: "connected" as const,
      connectionGeneration: "connection-1",
      inventoryRevision: 3,
      tabCount: 12,
      capabilities: {
        tabInventory: true,
        debuggerAttachment: true,
        semanticObservation: true,
        screenshots: true,
        liveFrames: false,
        humanInput: true,
        diagnostics: true,
        rawCdp: false,
        linkedComputer: false,
      },
      lastSeenAt: now,
      disconnectedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const bridges = (["online", "offline"] as const).map((state) => ({
      enrollmentId: randomUUID(),
      state,
      bridgeGeneration: "bridge-1",
      inventoryRevision: 1,
      connectedProfileCount: 1,
      lastSeenAt: now,
    }));
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listAttachedBrowsers: async () => ({ revision: 7, bridges, devices: [device] }),
      }),
      workspaceId,
      sessionId,
      selectedTools: ["interaction_discover"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      { scope: "attached_browsers" },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(result.structuredContent).toMatchObject({
      attachedBrowserBridges: [],
      attachedBrowsers: [
        {
          id: device.id,
          name: "Work laptop",
          profileLabel: "Personal",
          browserName: "Google Chrome",
          platform: "macos",
          state: "connected",
          tabCount: 12,
          unsupported: ["liveFrames", "rawCdp", "linkedComputer"],
        },
      ],
    });
    expect(
      Object.keys(
        (result.structuredContent as { attachedBrowsers: object[] }).attachedBrowsers[0]!,
      ),
    ).toHaveLength(8);
  });

  test("attached Chrome discovery names each profile's and bridge's computer", async () => {
    const thisMachine = randomUUID();
    const bridge = (sandboxId: string, machineName: string, connectedProfileCount: number) => ({
      enrollmentId: randomUUID(),
      sandboxId,
      machineName,
      state: "online" as const,
      bridgeGeneration: "bridge-1",
      inventoryRevision: 1,
      connectedProfileCount,
      lastSeenAt: now,
    });
    const here = bridge(thisMachine, "Mac mini", 1);
    const there = bridge(randomUUID(), "Laptop", 1);
    const device = (name: string, enrollmentId: string) => ({
      id: randomUUID(),
      accountId,
      workspaceId,
      enrollmentId,
      name,
      profileLabel: null,
      browserName: "Google Chrome",
      browserVersion: "150.0.0.0",
      extensionVersion: "0.1.4",
      platform: "macos" as const,
      architecture: "arm64" as const,
      state: "connected" as const,
      connectionGeneration: "connection-1",
      inventoryRevision: 3,
      tabCount: 2,
      capabilities: {
        tabInventory: true,
        debuggerAttachment: true,
        semanticObservation: true,
        screenshots: true,
        liveFrames: true,
        humanInput: true,
        diagnostics: true,
        rawCdp: true,
        linkedComputer: true,
      },
      lastSeenAt: now,
      disconnectedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const discover = async (
      inventory: { bridges: ReturnType<typeof bridge>[]; devices: ReturnType<typeof device>[] },
      scope: "attached_browsers" | "workspace",
    ) => {
      const definitions = createInteractionAttemptToolDefinitions({
        transport: {
          ...partialTransport({
            listBrowserSessions: async () => ({ revision: 1, sessions: [] }),
            listComputerSessions: async () => ({ revision: 1, sessions: [] }),
            listBrowserIdentities: async () => ({ revision: 1, identities: [] }) as never,
            listAttachedBrowsers: async () => ({ revision: 1, ...inventory }),
          }),
          getSession: async () =>
            ({
              id: sessionId,
              sandboxGroupId: randomUUID(),
              activeSandboxId: thisMachine,
            }) as never,
        },
        workspaceId,
        sessionId,
        selectedTools: ["interaction_discover"],
        permissions: ["sessions:read"],
      });
      return (
        await definitions[0]!.execute(
          { scope },
          { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
        )
      ).structuredContent;
    };
    const mine = device("Personal", here.enrollmentId);
    const theirs = device("Work", there.enrollmentId);
    for (const scope of ["attached_browsers", "workspace"] as const) {
      expect(
        await discover({ bridges: [here, there], devices: [mine, theirs] }, scope),
      ).toMatchObject({
        attachedBrowserBridges: [],
        attachedBrowsers: [
          { id: mine.id, name: "Personal", machine: "Mac mini", onThisMachine: true },
          { id: theirs.id, name: "Work", machine: "Laptop" },
        ],
      });
    }
    const listed = (await discover(
      { bridges: [here, there], devices: [mine, theirs] },
      "attached_browsers",
    )) as {
      attachedBrowsers: object[];
    };
    expect(listed.attachedBrowsers[1]).not.toHaveProperty("onThisMachine");
    // A machine ready for the extension says which computer it is.
    expect(
      await discover(
        { bridges: [{ ...here, connectedProfileCount: 0 }], devices: [] },
        "attached_browsers",
      ),
    ).toMatchObject({
      attachedBrowserBridges: [
        {
          enrollmentId: here.enrollmentId,
          machine: "Mac mini",
          onThisMachine: true,
          connectedProfileCount: 0,
        },
      ],
    });
  });

  test("discovery shows the model a compact, bounded inventory and Code Mode every record", async () => {
    const otherSession = randomUUID();
    const browsers = Array.from({ length: 60 }, (_, index) => {
      const browser = discoveredBrowserSession(randomUUID(), otherSession);
      browser.lifecycle = index % 3 === 0 ? "lost" : "active";
      browser.lastUsedAt = new Date(Date.parse(now) - index * 60_000).toISOString();
      return browser;
    });
    // An older session of this one still comes first.
    const own = discoveredBrowserSession(randomUUID(), sessionId);
    own.lifecycle = "suspended";
    own.lastUsedAt = new Date(Date.parse(now) - 24 * 60 * 60_000).toISOString();
    own.identityId = randomUUID();
    const computer = discoveredComputerSession(randomUUID(), otherSession);
    const definitions = createInteractionAttemptToolDefinitions({
      transport: {
        ...partialTransport({
          listBrowserSessions: async () => ({ revision: 3, sessions: [...browsers, own] }),
          listComputerSessions: async () => ({ revision: 3, sessions: [computer] }),
          listBrowserIdentities: async () => ({ revision: 3, identities: [] }) as never,
          listAttachedBrowsers: async () => ({ revision: 3, bridges: [], devices: [] }),
        }),
        getSession: async () => ({ id: sessionId, sandboxGroupId: randomUUID() }) as never,
      },
      workspaceId,
      sessionId,
      selectedTools: ["interaction_discover"],
      permissions: ["sessions:read"],
    });
    const discover = async (caller: "model" | "codemode") =>
      await definitions[0]!.execute(
        { scope: "workspace" },
        { operationId: randomUUID(), caller: { kind: caller, subjectId: `${caller}:test` } },
      );

    const model = await discover("model");
    expect(model.isError).not.toBe(true);
    const selected = (model.structuredContent as { browsers: BrowserSession[] }).browsers;
    expect(selected).toHaveLength(50);
    expect(selected[0]!.id).toBe(own.id);
    // Usable sessions before lost ones, each most recently used first.
    const lifecycles = selected.slice(1).map((browser) => browser.lifecycle);
    expect(lifecycles.indexOf("lost")).toBe(40);
    expect(lifecycles.slice(40).every((lifecycle) => lifecycle === "lost")).toBe(true);
    expect(selected[0]).toEqual(own);
    const [text, note] = model.content as Array<{ type: "text"; text: string }>;
    expect(note?.text).toContain("Listed 50 of 61 BrowserSessions");
    expect(note?.text).toContain("interaction.discover receives every record");
    const compact = JSON.parse(text!.text) as {
      browsers: Array<Record<string, unknown>>;
      computers: Array<Record<string, unknown>>;
    };
    expect(compact.browsers).toHaveLength(50);
    expect(compact.browsers[0]).toEqual({
      id: own.id,
      name: "Browser",
      lifecycle: "suspended",
      placement: own.placement,
      engine: "chromium",
      headless: false,
      identityId: own.identityId,
      lastUsedAt: own.lastUsedAt,
      thisSession: true,
      unsupported: ["rawCdp"],
    });
    expect(compact.computers).toEqual([
      {
        id: computer.id,
        name: "Computer",
        lifecycle: "starting",
        placement: computer.placement,
        lastUsedAt: computer.lastUsedAt,
      },
    ]);
    expect(text!.text).not.toContain(accountId);
    expect(text!.text.length).toBeLessThan(JSON.stringify(model.structuredContent).length / 3);

    const codemode = await discover("codemode");
    expect((codemode.structuredContent as { browsers: unknown[] }).browsers).toHaveLength(61);
    expect(codemode.content).toHaveLength(1);
    expect(JSON.parse((codemode.content[0] as { text: string }).text)).toEqual(
      codemode.structuredContent,
    );
  });

  test("discovery stays within its byte budget for sessions with long association histories", async () => {
    const history = (associatedSessionId: string) =>
      Array.from({ length: 1_000 }, (_, index) => ({
        sessionId: index === 999 ? associatedSessionId : randomUUID(),
        turnId: randomUUID(),
        attemptId: randomUUID(),
        relationship: "using" as const,
        actorSubjectId: `model:${randomUUID()}`,
        lastUsedAt: now,
      }));
    const browsers = Array.from({ length: 60 }, (_, index) => ({
      ...discoveredBrowserSession(randomUUID(), sessionId),
      name: `Browser ${index} ${"n".repeat(180)}`,
      associations: history(index < 10 ? sessionId : randomUUID()),
    }));
    const computers = Array.from({ length: 60 }, () => ({
      ...discoveredComputerSession(randomUUID(), randomUUID()),
      associations: history(randomUUID()),
    }));
    const definitions = createInteractionAttemptToolDefinitions({
      transport: {
        ...partialTransport({
          listBrowserSessions: async () => ({ revision: 1, sessions: browsers }) as never,
          listComputerSessions: async () => ({ revision: 1, sessions: computers }) as never,
          listBrowserIdentities: async () => ({ revision: 1, identities: [] }) as never,
          listAttachedBrowsers: async () => ({ revision: 1, bridges: [], devices: [] }),
        }),
        getSession: async () => ({ id: sessionId, sandboxGroupId: randomUUID() }) as never,
      },
      workspaceId,
      sessionId,
      selectedTools: ["interaction_discover"],
      permissions: ["sessions:read"],
    });
    const discover = async (caller: "model" | "codemode") =>
      await definitions[0]!.execute(
        { scope: "workspace" },
        { operationId: randomUUID(), caller: { kind: caller, subjectId: `${caller}:test` } },
      );
    const codemode = await discover("codemode");
    // Code Mode still receives every complete record, megabytes in all.
    expect(mcpSerializedSizeBytes(codemode)).toBeGreaterThan(MCP_MAX_TOOL_RESULT_BYTES * 4);
    expect(
      (codemode.structuredContent as { browsers: BrowserSession[] }).browsers[0]!.associations,
    ).toHaveLength(1_000);

    const model = await discover("model");
    expect(model.isError).not.toBe(true);
    expect(mcpSerializedSizeBytes(model)).toBeLessThanOrEqual(768 * 1024);
    expect(modelToolResultFits(model)).toBe(true);
    const selected = model.structuredContent as {
      browsers: BrowserSession[];
      computers: ComputerSession[];
    };
    expect(selected.browsers).toHaveLength(50);
    expect(selected.computers).toHaveLength(50);
    // Only the association with this session remains, and only on its own browsers.
    expect(
      selected.browsers.slice(0, 10).every((browser) => browser.associations.length === 1),
    ).toBe(true);
    expect(selected.browsers.slice(0, 10)[0]!.associations[0]!.sessionId).toBe(sessionId);
    expect(selected.browsers.slice(10).every((browser) => browser.associations.length === 0)).toBe(
      true,
    );
    expect(selected.computers.every((computer) => computer.associations.length === 0)).toBe(true);
    const compact = JSON.parse((model.content[0] as { text: string }).text) as {
      browsers: Array<{ thisSession?: true }>;
    };
    expect(compact.browsers.filter((browser) => browser.thisSession)).toHaveLength(10);
    expect((model.content[1] as { text: string }).text).toContain(
      "Listed 50 of 60 BrowserSessions, 50 of 60 ComputerSessions",
    );
  });

  test("discovery bounds even a huge attached-profile inventory by bytes", async () => {
    const devices = Array.from({ length: 4_000 }, (_, index) => ({
      id: randomUUID(),
      accountId,
      workspaceId,
      enrollmentId: randomUUID(),
      name: `Profile ${index} ${"p".repeat(180)}`,
      profileLabel: "l".repeat(200),
      browserName: "Google Chrome",
      browserVersion: "150.0.0.0",
      extensionVersion: "0.2.0",
      platform: "macos" as const,
      architecture: "arm64" as const,
      state: "disconnected" as const,
      connectionGeneration: `connection-${index}`,
      inventoryRevision: 1,
      tabCount: 1,
      capabilities: {
        tabInventory: true,
        debuggerAttachment: true,
        semanticObservation: true,
        screenshots: true,
        liveFrames: true,
        humanInput: true,
        diagnostics: true,
        rawCdp: true,
        linkedComputer: true,
      },
      lastSeenAt: now,
      disconnectedAt: now,
      createdAt: now,
      updatedAt: now,
    }));
    const browsers = Array.from({ length: 5 }, () =>
      discoveredBrowserSession(randomUUID(), sessionId),
    );
    const definitions = createInteractionAttemptToolDefinitions({
      transport: {
        ...partialTransport({
          listBrowserSessions: async () => ({ revision: 1, sessions: browsers }),
          listComputerSessions: async () => ({ revision: 1, sessions: [] }),
          listBrowserIdentities: async () => ({ revision: 1, identities: [] }) as never,
          listAttachedBrowsers: async () => ({ revision: 1, bridges: [], devices }),
        }),
        getSession: async () => ({ id: sessionId, sandboxGroupId: randomUUID() }) as never,
      },
      workspaceId,
      sessionId,
      selectedTools: ["interaction_discover"],
      permissions: ["sessions:read"],
    });
    const model = await definitions[0]!.execute(
      { scope: "workspace" },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(model.isError).not.toBe(true);
    expect(mcpSerializedSizeBytes(model)).toBeLessThanOrEqual(768 * 1024);
    const listed = (model.structuredContent as { attachedBrowsers: unknown[]; browsers: unknown[] })
      .attachedBrowsers.length;
    expect(listed).toBeGreaterThan(100);
    expect(listed).toBeLessThan(4_000);
    // Each kind gets its turn while the budget lasts, so the sessions still fit.
    expect((model.structuredContent as { browsers: unknown[] }).browsers).toHaveLength(5);
    expect((model.content[1] as { text: string }).text).toContain(
      `Listed ${listed} of 4000 attached Chrome profiles`,
    );
  });

  test("discovery leaves a small inventory complete for the model", async () => {
    const browser = discoveredBrowserSession(randomUUID(), sessionId);
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listBrowserSessions: async () => ({ revision: 1, sessions: [browser] }),
        listComputerSessions: async () => ({ revision: 1, sessions: [] }),
        listBrowserIdentities: async () => ({ revision: 1, identities: [] }) as never,
        listAttachedBrowsers: async () => ({ revision: 1, bridges: [], devices: [] }),
      }),
      workspaceId,
      sessionId,
      selectedTools: ["interaction_discover"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      {},
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect((result.structuredContent as { browsers: unknown[] }).browsers).toEqual([browser]);
    expect(result.content).toHaveLength(1);
  });

  test("browser_open, computer_open and discovery narrow inventories in the query", async () => {
    const requests: Array<{ kind: string; options: unknown }> = [];
    const record = (kind: string) => async (_workspace: string, options?: unknown) => {
      requests.push({ kind, options });
      return { revision: 1, sessions: [] };
    };
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listBrowserSessions: record("browser") as never,
        listComputerSessions: record("computer") as never,
        listBrowserIdentities: async () => ({ revision: 1, identities: [] }) as never,
        listAttachedBrowsers: async () => ({ revision: 1, bridges: [], devices: [] }),
        createBrowserSession: async () => ({ session: { lifecycle: "starting" } }) as never,
        createComputerSession: async () => ({ session: { lifecycle: "starting" } }) as never,
      }),
      workspaceId,
      sessionId,
      selectedTools: ["interaction_discover", "browser_open", "computer_open"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const tool = (name: string) =>
      definitions.find((entry) => entry.modelName === `interaction__${name}`)!;
    const context = () => ({
      operationId: randomUUID(),
      caller: { kind: "model" as const, subjectId: "model:test" },
    });
    const own = { associatedSessionId: sessionId, includeTerminal: false };

    await tool("browser_open").execute({}, context());
    await tool("computer_open").execute({}, context());
    expect(requests.splice(0)).toEqual([
      { kind: "browser", options: own },
      { kind: "computer", options: own },
    ]);

    await tool("interaction_discover").execute({}, context());
    expect(requests.splice(0)).toEqual([
      { kind: "browser", options: own },
      { kind: "computer", options: own },
    ]);

    await tool("interaction_discover").execute(
      { scope: "workspace", includeTerminal: true },
      context(),
    );
    expect(requests.splice(0)).toEqual([
      { kind: "browser", options: {} },
      { kind: "computer", options: {} },
    ]);
  });

  test("browser reuse never crosses explicit ephemeral and private profile modes", async () => {
    for (const requestedMode of ["private_profile", "ephemeral_context"] as const) {
      const createRequests: Array<Record<string, unknown>> = [];
      const other = discoveredBrowserSession(randomUUID(), sessionId);
      other.headless = true;
      other.driverId =
        requestedMode === "private_profile" ? EPHEMERAL_CHROMIUM_DRIVER_ID : "chromium";
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          listBrowserSessions: async () => ({ revision: 0, sessions: [other] }),
          createBrowserSession: async (_workspaceId, request) => {
            createRequests.push(request as unknown as Record<string, unknown>);
            return { session: { lifecycle: "starting" } } as never;
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: ["browser_open"],
        permissions: ["sessions:control"],
      });
      await definitions[0]!.execute(
        {
          headless: true,
          ...(requestedMode === "ephemeral_context" ? { storageMode: requestedMode } : {}),
        },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      expect(createRequests).toHaveLength(1);
      expect(createRequests[0]?.storageMode).toBe(
        requestedMode === "ephemeral_context" ? requestedMode : undefined,
      );
    }
  });

  test.each([false, true])(
    "browser_open reuse consumes authoritative inventory once (explicit=%s)",
    async (explicit) => {
      const session = discoveredBrowserSession(browserSessionId, sessionId);
      session.lifecycle = "active";
      session.controller = {
        controllerId: "synthetic-controller",
        controllerGeneration: "controller-1",
        placementInstanceId: "placement-1",
      };
      const prior = { ...browserTarget(), selected: false };
      const opened = {
        ...browserTarget(),
        id: "new-tab",
        url: "https://redirect.example.test/final",
      };
      let lists = 0,
        opens = 0;
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          getBrowserSession: async () => session,
          listBrowserSessions: async () => ({ revision: 1, sessions: [session] }),
          listBrowserTargets: async () => {
            lists++;
            return { browserSessionId, controllerGeneration: "controller-1", targets: [prior] };
          },
          openBrowserTargetWithInventory: async (workspace, id, request) => {
            opens++;
            expect([workspace, id, request?.url]).toEqual([
              workspaceId,
              browserSessionId,
              "https://new.example.test/",
            ]);
            return {
              browserSessionId,
              controllerGeneration: "controller-1",
              targets: [prior, opened],
            };
          },
          openBrowserTarget: async () => {
            throw new Error("full observation must not be discarded");
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: ["browser_open"],
        permissions: ["sessions:control"],
      });
      const result = await definitions[0]!.execute(
        { ...(explicit ? { browserSessionId } : {}), initialUrl: "https://new.example.test/" },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      expect(result.structuredContent).toEqual({
        session,
        targets: [prior, opened].map(agentTarget),
      });
      expect(lists).toBe(1);
      expect(opens).toBe(1);
    },
  );

  test.each(["initial-url", "selected", "failed"] as const)(
    "browser_open returns a compact observation of the primary tab (%s)",
    async (scenario) => {
      const session = discoveredBrowserSession(browserSessionId, sessionId);
      session.lifecycle = "active";
      session.controller = {
        controllerId: "synthetic-controller",
        controllerGeneration: "controller-1",
        placementInstanceId: "placement-1",
      };
      const selected = browserTarget();
      const requested = {
        ...browserTarget(),
        id: "tab-2",
        url: "https://requested.example.test/",
        selected: false,
      };
      const observed: string[] = [];
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          getBrowserSession: async () => session,
          listBrowserTargets: async () => ({
            browserSessionId,
            controllerGeneration: "controller-1",
            targets: [selected, requested],
          }),
          observeBrowserTarget: async (_workspace, _id, targetId) => {
            observed.push(targetId ?? "default");
            if (scenario === "failed") throw new Error("synthetic observation failure");
            return browserObservation(targetId === requested.id ? requested : selected);
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: ["browser_open"],
        permissions: ["sessions:control"],
      });
      const result = await definitions[0]!.execute(
        {
          browserSessionId,
          ...(scenario === "selected" ? {} : { initialUrl: requested.url }),
        },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      const primary = scenario === "selected" ? selected : requested;
      expect(observed).toEqual([primary.id]);
      const content = result.structuredContent as Record<string, unknown>;
      if (scenario === "selected") {
        // Without a requested URL every tab stays listed.
        expect(content.targets).toEqual([selected, requested].map(agentTarget));
        expect(content).not.toHaveProperty("otherTabCount");
      } else {
        // A browser opened on a URL lists only that tab and counts the rest.
        expect(content.targets).toEqual([agentTarget(requested)]);
        expect(content.otherTabCount).toBe(1);
      }
      if (scenario === "failed") {
        expect(content).not.toHaveProperty("observation");
      } else {
        expect(content.observation).toMatchObject({
          target: agentTarget(primary),
          agentView: { sourceKind: "snapshot" },
        });
        expect(content.observation).not.toHaveProperty("semantic");
      }
    },
  );

  test("browser_open returns the opened tab's screenshot in the same call when includeScreenshot is set", async () => {
    const session = discoveredBrowserSession(browserSessionId, sessionId);
    session.lifecycle = "active";
    session.controller = {
      controllerId: "synthetic-controller",
      controllerGeneration: "controller-1",
      placementInstanceId: "placement-1",
    };
    const target = browserTarget();
    const image = new Uint8Array([4, 5, 6]);
    const order: string[] = [];
    let captureFails = false;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        getBrowserSession: async () => session,
        listBrowserTargets: async () => ({
          browserSessionId,
          controllerGeneration: "controller-1",
          targets: [target],
        }),
        observeBrowserTarget: async () => {
          order.push("observe");
          return browserObservation(target);
        },
        captureBrowserTarget: async (_workspaceId, capturedSessionId, targetId) => {
          order.push(`capture:${capturedSessionId}:${targetId}`);
          if (captureFails) throw new Error("synthetic capture failure");
          return {
            frameId: "captured-browser-frame",
            browserSessionId,
            controllerGeneration: target.controllerGeneration,
            targetId: target.id,
            targetGeneration: target.targetGeneration,
            documentGeneration: target.documentGeneration!,
            sequence: 1,
            mediaType: "image/jpeg",
            width: 1,
            height: 1,
            deviceScaleFactor: 1,
            scrollX: 0,
            scrollY: 0,
            capturedAt: now,
            data: image,
          };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_open"],
      permissions: ["sessions:control"],
    });
    const context = () => ({
      operationId: randomUUID(),
      caller: { kind: "model" as const, subjectId: "model:test" },
    });

    const plain = await definitions[0]!.execute({ browserSessionId }, context());
    expect(plain.content).toHaveLength(1);
    expect(order).toEqual(["observe"]);

    order.length = 0;
    const visual = await definitions[0]!.execute(
      { browserSessionId, includeScreenshot: true },
      context(),
    );
    // The capture follows the settled open and targets the tab it observed.
    expect(order).toEqual(["observe", `capture:${browserSessionId}:${target.id}`]);
    expect(visual.isError).toBeFalsy();
    expect(visual.content).toHaveLength(2);
    expect(visual.content[0]).toMatchObject({ type: "text" });
    expect(visual.content[1]).toEqual({
      type: "image",
      data: Buffer.from(image).toString("base64"),
      mimeType: "image/jpeg",
    });
    expect(visual.structuredContent).toMatchObject({ session: { id: browserSessionId } });

    // A failed capture keeps the opened browser's result and says why.
    captureFails = true;
    const failed = await definitions[0]!.execute(
      { browserSessionId, includeScreenshot: true },
      context(),
    );
    expect(failed.isError).toBeFalsy();
    expect(failed.structuredContent).toMatchObject({ session: { id: browserSessionId } });
    expect(failed.content).toHaveLength(2);
    expect((failed.content[1] as { text: string }).text).toBe(
      "The browser opened, but its screenshot could not be captured: synthetic capture failure",
    );
  });

  test.each([true, false])(
    "browser_open create uses the launch view instead of two more reads (view=%s)",
    async (withView) => {
      const session = discoveredBrowserSession(browserSessionId, sessionId);
      session.lifecycle = "active";
      session.controller = {
        controllerId: "synthetic-controller",
        controllerGeneration: "controller-1",
        placementInstanceId: "placement-1",
      };
      const opened = { ...browserTarget(), url: "https://requested.example.test/" };
      const other = { ...browserTarget(), id: "tab-2", selected: false };
      let reads = 0;
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          listBrowserSessions: async () => ({ revision: 0, sessions: [] }),
          createBrowserSession: async () =>
            ({
              session,
              ...(withView
                ? {
                    initialView: {
                      targets: [opened, other],
                      observation: browserObservation(opened),
                    },
                  }
                : {}),
            }) as never,
          listBrowserTargets: async () => {
            reads++;
            return {
              browserSessionId,
              controllerGeneration: "controller-1",
              targets: [opened, other],
            };
          },
          observeBrowserTarget: async () => {
            reads++;
            return browserObservation(opened);
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: ["browser_open"],
        permissions: ["sessions:control"],
      });
      const result = await definitions[0]!.execute(
        { initialUrl: opened.url },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      // Both paths give the model the same result; only the reads differ.
      expect(reads).toBe(withView ? 0 : 2);
      const content = result.structuredContent as Record<string, unknown>;
      expect(content.targets).toEqual([agentTarget(opened)]);
      expect(content.otherTabCount).toBe(1);
      expect(content.observation).toMatchObject({
        target: agentTarget(opened),
        agentView: { sourceKind: "snapshot" },
      });
    },
  );

  test.each([true, false])(
    "browser_open create returns the tab it opened, not an older tab on the same URL (view=%s)",
    async (withView) => {
      // A person's Chrome (or a concurrent session sharing the profile) can
      // already show the requested URL. The new session must get its own tab.
      const session = discoveredBrowserSession(browserSessionId, sessionId);
      session.lifecycle = "active";
      session.controller = {
        controllerId: "synthetic-controller",
        controllerGeneration: "controller-1",
        placementInstanceId: "placement-1",
      };
      const url = "https://requested.example.test/";
      const older = { ...browserTarget(), id: "tab-older", url, selected: false };
      const opened = { ...browserTarget(), id: "tab-opened", url, selected: true };
      const observed: string[] = [];
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          listBrowserSessions: async () => ({ revision: 0, sessions: [] }),
          createBrowserSession: async () =>
            ({
              session,
              ...(withView
                ? {
                    initialView: {
                      targets: [older, opened],
                      observation: browserObservation(opened),
                    },
                  }
                : {}),
            }) as never,
          listBrowserTargets: async () => ({
            browserSessionId,
            controllerGeneration: "controller-1",
            targets: [older, opened],
          }),
          observeBrowserTarget: async (_workspaceId, _browserSessionId, targetId) => {
            observed.push(targetId);
            return browserObservation(targetId === opened.id ? opened : older);
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: ["browser_open"],
        permissions: ["sessions:control"],
      });
      const result = await definitions[0]!.execute(
        { initialUrl: url },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      expect(observed).toEqual(withView ? [] : [opened.id]);
      const content = result.structuredContent as Record<string, unknown>;
      expect(content.targets).toEqual([agentTarget(opened)]);
      expect(content.otherTabCount).toBe(1);
      expect(content.observation).toMatchObject({ target: agentTarget(opened) });
    },
  );

  test.each([
    ["controller_resource_missing", true],
    ["controller_transition_expired", true],
    ["browser_crashed", false],
    [null, false],
  ] as const)(
    "browser_open continues a lost browser only through the resume route (%s)",
    async (failureCode, resumable) => {
      const lost = discoveredBrowserSession(browserSessionId, sessionId);
      lost.lifecycle = "lost";
      lost.failureCode = failureCode;
      const active = discoveredBrowserSession(browserSessionId, sessionId);
      active.lifecycle = "active";
      active.controller = {
        controllerId: "synthetic-controller",
        controllerGeneration: "controller-1",
        placementInstanceId: "placement-1",
      };
      const target = browserTarget();
      const resumes: string[] = [];
      let refuse = false;
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          getBrowserSession: async () => lost,
          resumeBrowserSession: async (_workspaceId, resumedId) => {
            resumes.push(resumedId);
            if (refuse)
              throw new OpenGeniApiError(
                409,
                JSON.stringify({
                  error: {
                    code: "conflict",
                    message:
                      "BrowserSession was lost when its controller restarted, and its working copy could not be recovered",
                    retryable: false,
                  },
                }),
              );
            return { session: active } as never;
          },
          listBrowserTargets: async () => ({
            browserSessionId,
            controllerGeneration: "controller-1",
            targets: [target],
          }),
          observeBrowserTarget: async () => browserObservation(target),
        }),
        workspaceId,
        sessionId,
        selectedTools: ["browser_open"],
        permissions: ["sessions:control"],
      });
      const open = async () =>
        await definitions[0]!.execute(
          { browserSessionId },
          { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
        );
      const result = await open();
      const content = result.structuredContent as Record<string, unknown>;
      expect(resumes).toEqual(resumable ? [browserSessionId] : []);
      expect(content.session).toMatchObject({ lifecycle: resumable ? "active" : "lost" });
      expect(content.targets).toEqual(resumable ? [agentTarget(target)] : []);
      if (!resumable) return;
      refuse = true;
      // A refused resume is a definite answer the model can act on.
      expect(await open()).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: "conflict",
            message: expect.stringContaining("working copy could not be recovered"),
            retryable: false,
          },
        },
      });
    },
  );

  test.each([
    ["observe on the current tab", "browser_observe", {}, "replay"],
    ["observe on a named tab", "browser_observe", { targetId: "tab-1" }, "report"],
    [
      "act on the current tab",
      "browser_act",
      { action: { type: "scroll", deltaX: 0, deltaY: 400 } },
      "report",
    ],
    [
      "act on a named tab",
      "browser_act",
      { targetId: "tab-1", action: { type: "scroll", deltaX: 0, deltaY: 400 } },
      "report",
    ],
    ["list tabs", "browser_tabs", { operation: "list" }, "replay"],
    ["close a named tab", "browser_tabs", { operation: "close", targetId: "tab-1" }, "report"],
  ] as const)(
    "browser tools resume a suspended browser (%s)",
    async (_label, tool, args, expected) => {
      const suspended = discoveredBrowserSession(browserSessionId, sessionId);
      suspended.lifecycle = "suspended";
      const active = discoveredBrowserSession(browserSessionId, sessionId);
      active.lifecycle = "active";
      active.controller = {
        controllerId: "synthetic-controller",
        controllerGeneration: "controller-2",
        placementInstanceId: "placement-1",
      };
      // Resuming reopens the saved tab under a new ID.
      const restored = { ...browserTarget(), id: "tab-2", controllerGeneration: "controller-2" };
      let running = false;
      const notActive = () => new OpenGeniApiError(409, "BrowserSession is not active");
      const resumes: string[] = [];
      const observed: string[] = [];
      const acted: string[] = [];
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          getBrowserSession: async () => (running ? active : suspended),
          resumeBrowserSession: async (_workspaceId, resumedId, request) => {
            resumes.push(`${resumedId}:${request.operationId}`);
            running = true;
            return { session: active, operation: { state: "completed", error: null } } as never;
          },
          listBrowserTargets: async () => {
            if (!running) throw notActive();
            return { browserSessionId, controllerGeneration: "controller-2", targets: [restored] };
          },
          observeBrowserTarget: async (_workspaceId, _browserSessionId, targetId) => {
            if (!running) throw notActive();
            observed.push(targetId);
            return browserObservation(restored);
          },
          actInBrowser: async (_workspaceId, _browserSessionId, request) => {
            acted.push(request.targetId);
            throw notActive();
          },
          closeBrowserTarget: async () => {
            throw notActive();
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: [tool],
        permissions: ["sessions:read", "sessions:control"],
      });
      const operationId = randomUUID();
      const result = await definitions[0]!.execute(
        { browserSessionId, ...args },
        { operationId, caller: { kind: "model", subjectId: "model:test" } },
      );
      // One resume, under its own operation ID rather than the tool call's.
      expect(resumes).toHaveLength(1);
      expect(resumes[0]).not.toContain(operationId);
      // An action never runs on the reloaded page.
      expect(acted).toEqual("targetId" in args && tool === "browser_act" ? ["tab-1"] : []);
      if (expected === "replay") {
        expect(result.isError).toBeFalsy();
        expect(observed).toEqual(tool === "browser_observe" ? ["tab-2"] : []);
        return;
      }
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "browser_resumed", retryable: false } },
      });
      const message = (result.structuredContent as { error: { message: string } }).error.message;
      expect(message).toContain("resumed from its saved state");
      expect(message).toContain("this call did not run");
      expect(message).toContain("tab-2");
      // The report carries the selected tab's outline for the next call.
      expect(observed).toEqual(["tab-2"]);
    },
  );

  test.each([
    ["an active browser", "active", null],
    ["a browser lost to a crash", "lost", "browser_crashed"],
  ] as const)("browser tools keep a refusal on %s", async (_label, lifecycle, failureCode) => {
    const session = discoveredBrowserSession(browserSessionId, sessionId);
    session.lifecycle = lifecycle;
    session.failureCode = failureCode;
    let resumed = false;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        getBrowserSession: async () => session,
        resumeBrowserSession: async () => {
          resumed = true;
          return { session } as never;
        },
        observeBrowserTarget: async () => {
          throw new OpenGeniApiError(409, "BrowserSession controller authority changed");
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const result = await definitions[0]!.execute(
      { browserSessionId, targetId: "tab-1" },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(resumed).toBe(false);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { message: expect.stringContaining("controller authority changed") },
      },
    });
  });

  test.each([
    ["browser_observe", { targetId: "tab-1" }],
    ["browser_act", { targetId: "tab-1", action: { type: "scroll", deltaX: 0, deltaY: 400 } }],
    ["browser_tabs", { operation: "list" }],
  ] as const)(
    "%s with a mistyped BrowserSession id lists this chat's open BrowserSessions",
    async (tool, args) => {
      const open = discoveredBrowserSession(browserSessionId, sessionId);
      open.lifecycle = "active";
      open.name = "Research\n  browser";
      const older = discoveredBrowserSession(randomUUID(), sessionId);
      older.lifecycle = "suspended";
      older.name = "x".repeat(80);
      older.lastUsedAt = new Date(Date.parse(open.lastUsedAt) - 60_000).toISOString();
      // Never offered: another chat's browser, and one that has ended.
      const otherChats = discoveredBrowserSession(randomUUID(), randomUUID());
      otherChats.lifecycle = "active";
      const ended = discoveredBrowserSession(randomUUID(), sessionId);
      ended.lifecycle = "ended";
      const mistyped = `${browserSessionId.slice(0, -1)}${browserSessionId.endsWith("0") ? "1" : "0"}`;
      const missing = () =>
        new OpenGeniApiError(
          404,
          JSON.stringify({
            error: {
              code: "not_found",
              message: "BrowserSession not found",
              requestId: "request-1",
            },
          }),
        );
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          listBrowserSessions: async () =>
            ({ revision: 1, sessions: [older, otherChats, ended, open] }) as never,
          observeBrowserTarget: async () => {
            throw missing();
          },
          actInBrowser: async () => {
            throw missing();
          },
          getBrowserTargetState: async () => {
            throw missing();
          },
          listBrowserTargets: async () => {
            throw missing();
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: [tool],
        permissions: ["sessions:read", "sessions:control"],
      });
      const result = await definitions[0]!.execute(
        { browserSessionId: mistyped, ...args },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "not_found", retryable: false } },
      });
      const message = (result.structuredContent as { error: { message: string } }).error.message;
      expect(message).toBe(
        `API 404: BrowserSession not found. This chat's open BrowserSessions, most recently used first: ${browserSessionId} "Research browser", ${older.id} "${"x".repeat(59)}…". Use one of these ids, or omit browserSessionId to use the one you used last. Reference: request-1.`,
      );
    },
  );

  test("a missing BrowserSession in a chat with no open browser says to open one", async () => {
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listBrowserSessions: async () => ({ revision: 1, sessions: [] }) as never,
        observeBrowserTarget: async () => {
          throw new OpenGeniApiError(404, "BrowserSession not found");
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const result = await definitions[0]!.execute(
      { browserSessionId, targetId: "tab-1" },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    const message = (result.structuredContent as { error: { message: string } }).error.message;
    expect(message).toBe(
      "API 404: BrowserSession not found. This chat has no open BrowserSession; call browser_open to start one.",
    );
  });

  test("a missing-id hint lists at most five sessions and leaves other 404s alone", async () => {
    const sessions = Array.from({ length: 7 }, (_, index) => {
      const browser = discoveredBrowserSession(randomUUID(), sessionId);
      browser.lifecycle = "active";
      browser.name = `Browser ${index}`;
      browser.lastUsedAt = new Date(Date.parse(now) - index * 60_000).toISOString();
      return browser;
    });
    let refusal = new OpenGeniApiError(404, "BrowserSession not found");
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listBrowserSessions: async () => ({ revision: 1, sessions }) as never,
        observeBrowserTarget: async () => {
          throw refusal;
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const run = async () =>
      (
        (
          await definitions[0]!.execute(
            { browserSessionId: randomUUID(), targetId: "tab-1" },
            { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
          )
        ).structuredContent as { error: { message: string } }
      ).error.message;
    const listed = await run();
    for (const browser of sessions.slice(0, 5)) expect(listed).toContain(browser.id);
    for (const browser of sessions.slice(5)) expect(listed).not.toContain(browser.id);
    refusal = new OpenGeniApiError(404, "browser target does not exist");
    expect(await run()).toBe("API 404: browser target does not exist");
  });

  test("computer tools with a mistyped ComputerSession id list this chat's open ComputerSessions", async () => {
    const open = discoveredComputerSession(randomUUID(), sessionId);
    open.lifecycle = "active";
    open.name = "Desktop";
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listComputerSessions: async () => ({ revision: 1, sessions: [open] }) as never,
        observeComputerTarget: async () => {
          throw new OpenGeniApiError(404, "ComputerSession not found");
        },
        captureComputerTarget: async () => {
          throw new OpenGeniApiError(404, "ComputerSession not found");
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_observe"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      { computerSessionId: randomUUID(), targetId: "window-1" },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    const message = (result.structuredContent as { error: { message: string } }).error.message;
    expect(message).toBe(
      `API 404: ComputerSession not found. This chat's open ComputerSessions, most recently used first: ${open.id} "Desktop". Use one of these ids, or omit computerSessionId to use the one you used last.`,
    );
  });

  describe("tools that name a session directly give the same hint", () => {
    const browserMissing = () => new OpenGeniApiError(404, "BrowserSession not found");
    const computerMissing = () => new OpenGeniApiError(404, "ComputerSession not found");
    const openBrowser = () => {
      const browser = discoveredBrowserSession(randomUUID(), sessionId);
      browser.lifecycle = "active";
      browser.name = "Research";
      return browser;
    };
    const openComputer = () => {
      const computer = discoveredComputerSession(randomUUID(), sessionId);
      computer.lifecycle = "active";
      computer.name = "Desktop";
      return computer;
    };
    const run = async (
      tool: string,
      args: Record<string, unknown>,
      transport: Parameters<typeof partialTransport>[0],
    ) => {
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport(transport),
        workspaceId,
        sessionId,
        selectedTools: [
          tool,
          ...(tool.startsWith("interaction__cua_") ? ["computer_open", "computer_act"] : []),
        ],
        permissions: ["sessions:read", "sessions:control", "files:upload", "identities:write"],
      });
      const definition = definitions.find(
        (candidate) => candidate.identity.toolName === tool || candidate.modelName === tool,
      )!;
      const result = await definition.execute(args, {
        operationId: randomUUID(),
        caller: { kind: "model", subjectId: "model:test" },
      });
      expect(result).toMatchObject({ isError: true });
      return (result.structuredContent as { error: { message: string } }).error.message;
    };

    test.each([
      ["browser_clipboard", {}],
      ["browser_downloads", { operation: "list" }],
      [
        "browser_download_save",
        { downloadId: randomUUID(), destinationPath: "downloads/report.pdf" },
      ],
      ["browser_publish", { identityId: randomUUID(), expectedHeadGeneration: 0 }],
      ["browser_lifecycle", { action: "suspend" }],
      ["browser_lifecycle", { action: "end" }],
    ] as const)("%s %j lists the open BrowserSessions to use instead", async (tool, args) => {
      const open = openBrowser();
      const message = await run(
        tool,
        { browserSessionId: randomUUID(), ...args },
        {
          listBrowserSessions: async () => ({ revision: 1, sessions: [open] }) as never,
          readBrowserClipboard: async () => {
            throw browserMissing();
          },
          listBrowserDownloads: async () => {
            throw browserMissing();
          },
          saveBrowserDownload: async () => {
            throw browserMissing();
          },
          publishBrowserRevision: async () => {
            throw browserMissing();
          },
          suspendBrowserSession: async () => {
            throw browserMissing();
          },
          endBrowserSession: async () => {
            throw browserMissing();
          },
        },
      );
      // The id is required here, so there is no "omit it" alternative.
      expect(message).toBe(
        `API 404: BrowserSession not found. This chat's open BrowserSessions, most recently used first: ${open.id} "Research". Use one of these ids.`,
      );
    });

    test("browser_open attaching to a missing BrowserSession offers the open ones or a new one", async () => {
      const open = openBrowser();
      let sessions = [open];
      const transport = {
        listBrowserSessions: async () => ({ revision: 1, sessions }) as never,
        getBrowserSession: async () => {
          throw browserMissing();
        },
      };
      expect(await run("browser_open", { browserSessionId: randomUUID() }, transport)).toBe(
        `API 404: BrowserSession not found. This chat's open BrowserSessions, most recently used first: ${open.id} "Research". Use one of these ids, or omit browserSessionId to open or reuse one.`,
      );
      sessions = [];
      expect(await run("browser_open", { browserSessionId: randomUUID() }, transport)).toBe(
        "API 404: BrowserSession not found. This chat has no open BrowserSession; omit browserSessionId to open one.",
      );
    });

    test("computer_open and computer_lifecycle name the open ComputerSessions", async () => {
      const open = openComputer();
      const transport = {
        listComputerSessions: async () => ({ revision: 1, sessions: [open] }) as never,
        getComputerSession: async () => {
          throw computerMissing();
        },
        endComputerSession: async () => {
          throw computerMissing();
        },
      };
      const listed = `API 404: ComputerSession not found. This chat's open ComputerSessions, most recently used first: ${open.id} "Desktop". Use one of these ids`;
      expect(await run("computer_open", { computerSessionId: randomUUID() }, transport)).toBe(
        `${listed}, or omit computerSessionId to open or reuse one.`,
      );
      expect(
        await run(
          "computer_lifecycle",
          { computerSessionId: randomUUID(), action: "end" },
          transport,
        ),
      ).toBe(`${listed}.`);
    });

    test("a native computer tool naming a missing ComputerSession lists the open ones", async () => {
      const open = openComputer();
      const message = await run(
        "interaction__cua_list_windows",
        { computerSessionId: randomUUID() },
        {
          listComputerSessions: async () => ({ revision: 1, sessions: [open] }) as never,
          callNativeComputerTool: async () => {
            throw computerMissing();
          },
        },
      );
      expect(message).toBe(
        `API 404: ComputerSession not found. This chat's open ComputerSessions, most recently used first: ${open.id} "Desktop". Use one of these ids, or omit computerSessionId to use the one you used last.`,
      );
    });

    test("a long label is cut by character, never inside an emoji", async () => {
      const open = openBrowser();
      // The cut falls exactly where a surrogate pair starts in UTF-16.
      open.name = `${"x".repeat(58)}🧭🧭 and more`;
      const message = await run(
        "browser_clipboard",
        { browserSessionId: randomUUID() },
        {
          listBrowserSessions: async () => ({ revision: 1, sessions: [open] }) as never,
          readBrowserClipboard: async () => {
            throw browserMissing();
          },
        },
      );
      expect(message).toContain(`${open.id} "${"x".repeat(58)}🧭…"`);
      expect(message).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    });
  });

  test("an action never runs on a browser resumed while it was in flight", async () => {
    const browser = stoppedBrowser();
    // The restored tab's outline is slow, so the resume stays unreported while
    // a concurrent action resolves the current tab.
    let releaseOutline!: () => void;
    const outlineHeld = new Promise<void>((resolve) => (releaseOutline = resolve));
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        ...browser.transport,
        observeBrowserTarget: async () => {
          await outlineHeld;
          return browserObservation(browser.restored);
        },
        listBrowserDiagnostics: async () => {
          throw browser.notActive();
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_debug", "browser_act"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const tool = (name: string) =>
      definitions.find((definition) => definition.modelName === `interaction__${name}`)!;
    const call = (name: string, args: Record<string, unknown>) =>
      tool(name).execute(args, {
        operationId: randomUUID(),
        caller: { kind: "model", subjectId: "model:test" },
      });
    const debug = call("browser_debug", { browserSessionId, targetId: "tab-1" });
    while (browser.resumes.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const act = call("browser_act", {
      browserSessionId,
      action: { type: "scroll", deltaX: 0, deltaY: 400 },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseOutline();
    for (const result of await Promise.all([debug, act])) {
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "browser_resumed" } },
      });
    }
    expect(browser.resumes).toHaveLength(1);
    expect(browser.acted).toEqual([]);
    // Once a result reported the resume, the next action runs on the restored tab.
    await call("browser_act", {
      browserSessionId,
      action: { type: "scroll", deltaX: 0, deltaY: 400 },
    });
    expect(browser.acted).toEqual(["tab-2"]);
  });

  test.each(["succeeds", "fails", "succeeds after a parallel read"] as const)(
    "an action waits for a resume still in flight and does not run (inventory %s)",
    async (scenario) => {
      const inventory = scenario === "fails" ? "fails" : "succeeds";
      const browser = stoppedBrowser();
      // The resume's own tab inventory is slow; other listings answer at once.
      let releaseInventory!: (outcome: "succeeds" | "fails") => void;
      const inventoryHeld = new Promise<"succeeds" | "fails">(
        (resolve) => (releaseInventory = resolve),
      );
      let signalHeld!: () => void;
      const held = new Promise<void>((resolve) => (signalHeld = resolve));
      let heldOnce = false;
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          ...browser.transport,
          listBrowserTargets: async (...args) => {
            if (browser.running() && !heldOnce) {
              heldOnce = true;
              signalHeld();
              if ((await inventoryHeld) === "fails") {
                throw new OpenGeniApiError(503, "browser controller is unavailable");
              }
            }
            return await browser.transport.listBrowserTargets!(...args);
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: ["browser_observe", "browser_act"],
        permissions: ["sessions:read", "sessions:control"],
      });
      const call = (name: string, args: Record<string, unknown>) =>
        definitions
          .find((definition) => definition.modelName === `interaction__${name}`)!
          .execute(args, {
            operationId: randomUUID(),
            caller: { kind: "model", subjectId: "model:test" },
          });
      const observe = call("browser_observe", { browserSessionId });
      await held;
      const press = () =>
        call("browser_act", { browserSessionId, action: { type: "press", key: "Enter" } }).catch(
          (error: unknown) => error,
        );
      const act = press();
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (scenario === "succeeds after a parallel read") {
        // A read that finishes first cannot make an action chosen before it safe.
        expect(
          (await call("browser_observe", { browserSessionId, targetId: "tab-2" })).isError,
        ).toBeFalsy();
      }
      releaseInventory(inventory);
      const [observed, acted] = await Promise.all([observe, act]);
      expect(browser.acted).toEqual([]);
      expect(browser.resumes).toHaveLength(1);
      if (inventory === "succeeds") {
        expect((observed as { isError?: boolean }).isError).toBeFalsy();
        expect(acted).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "browser_resumed" } },
        });
      } else {
        // The resume's failure is the action's answer; the next action is told
        // about the reloaded tabs before any action runs.
        expect(acted).toBeInstanceOf(OpenGeniApiError);
        expect(await press()).toMatchObject({
          isError: true,
          structuredContent: { error: { code: "browser_resumed" } },
        });
        expect(browser.acted).toEqual([]);
      }
      expect((await press()) as object).not.toBeInstanceOf(Error);
      expect(browser.acted).toEqual(["tab-2"]);
      expect(browser.resumes).toHaveLength(1);
    },
  );

  test("a tab opened before the browser stopped is not opened again", async () => {
    const browser = stoppedBrowser({ running: true });
    let opens = 0;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        ...browser.transport,
        openBrowserTarget: async () => {
          opens += 1;
          // The browser stops right after opening the tab.
          browser.stop();
          return browserObservation(browser.restored);
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_tabs"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const result = await definitions[0]!.execute(
      { browserSessionId, operation: "open", url: "https://example.test/next" },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(opens).toBe(1);
    expect(browser.resumes).toHaveLength(1);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "browser_resumed",
          message: expect.stringContaining("The tab open completed"),
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("did not run");
  });

  test("a browser that stops again after a resume resumes again", async () => {
    const browser = stoppedBrowser({ running: true });
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport(browser.transport),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const observe = async () =>
      await definitions[0]!.execute(
        { browserSessionId },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
    for (const round of [1, 2]) {
      browser.stop();
      expect((await observe()).isError).toBeFalsy();
      expect(browser.resumes).toHaveLength(round);
    }
  });

  test("an unknown resume outcome stays unknown", async () => {
    const browser = stoppedBrowser();
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        ...browser.transport,
        resumeBrowserSession: async () =>
          ({
            session: browser.suspended,
            operation: {
              state: "outcome_unknown",
              error: {
                code: "outcome_unknown",
                message: "The controller did not answer.",
                retryable: false,
              },
            },
          }) as never,
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const failure = await definitions[0]!
      .execute(
        { browserSessionId },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(OpenGeniApiError);
    expect((failure as OpenGeniApiError).outcomeUnknown).toBe(true);
  });

  test("a failed resume is reported as failed, not as still resuming", async () => {
    const browser = stoppedBrowser();
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        ...browser.transport,
        resumeBrowserSession: async () =>
          ({
            session: browser.suspended,
            operation: {
              state: "failed",
              error: {
                code: "capacity_exhausted",
                message: "This machine has no room for another browser.",
                retryable: true,
              },
            },
          }) as never,
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const result = await definitions[0]!.execute(
      { browserSessionId },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "capacity_exhausted",
          message: expect.stringContaining("no room for another browser"),
        },
      },
    });
  });

  test("after a resume the current tab is the restored one, even if the replay fails", async () => {
    const browser = stoppedBrowser({ running: true });
    let failRestored = true;
    const observed: string[] = [];
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        ...browser.transport,
        observeBrowserTarget: async (_workspaceId, _browserSessionId, targetId) => {
          if (!browser.running()) throw browser.notActive();
          observed.push(targetId);
          if (targetId === "tab-1") return browserObservation(browserTarget());
          if (failRestored) {
            failRestored = false;
            throw new OpenGeniApiError(422, "page is busy");
          }
          return browserObservation(browser.restored);
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const observe = (args: Record<string, unknown>) =>
      definitions[0]!.execute(args, {
        operationId: randomUUID(),
        caller: { kind: "model", subjectId: "model:test" },
      });
    // The model last used tab-1, then the browser stopped.
    expect((await observe({ browserSessionId, targetId: "tab-1" })).isError).toBeFalsy();
    browser.stop();
    // The current-tab read resumes it and runs again on the restored tab, which fails.
    expect((await observe({})).isError).toBe(true);
    expect((await observe({})).isError).toBeFalsy();
    expect(observed).toEqual(["tab-1", "tab-2", "tab-2"]);
    expect(browser.resumes).toHaveLength(1);
  });

  test.each(["matching", "missing", "unknown", "session", "generation", "target"] as const)(
    "browser_open reuse preserves no-op, refusal and unknown boundaries (%s)",
    async (scenario) => {
      const session = discoveredBrowserSession(browserSessionId, sessionId);
      session.lifecycle = "active";
      session.controller = {
        controllerId: "synthetic-controller",
        controllerGeneration: "controller-1",
        placementInstanceId: "placement-1",
      };
      const target = browserTarget();
      let lists = 0,
        opens = 0;
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          getBrowserSession: async () => session,
          listBrowserTargets: async () => {
            lists++;
            return { browserSessionId, controllerGeneration: "controller-1", targets: [target] };
          },
          ...(scenario === "missing"
            ? {}
            : {
                openBrowserTargetWithInventory: async () => {
                  opens++;
                  if (scenario === "unknown") throw new Error("synthetic outcome unknown");
                  return {
                    browserSessionId: scenario === "session" ? randomUUID() : browserSessionId,
                    controllerGeneration:
                      scenario === "generation" ? "other-controller" : "controller-1",
                    targets: [
                      {
                        ...target,
                        controllerGeneration:
                          scenario === "target" ? "other-controller" : "controller-1",
                      },
                    ],
                  };
                },
              }),
          openBrowserTarget: async () => {
            throw new Error("must not fall back to an observation mutation");
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: ["browser_open"],
        permissions: ["sessions:control"],
      });
      const pending = definitions[0]!.execute(
        {
          browserSessionId,
          initialUrl: scenario === "matching" ? target.url : "https://new.example.test/",
        },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      if (scenario === "matching")
        expect((await pending).structuredContent).toEqual({
          session,
          targets: [agentTarget(target)],
        });
      else
        await expect(pending).rejects.toThrow(
          scenario === "missing"
            ? "does not support metadata-only"
            : scenario === "unknown"
              ? "synthetic outcome unknown"
              : "another session binding",
        );
      expect(lists).toBe(1);
      expect(opens).toBe(["matching", "missing"].includes(scenario) ? 0 : 1);
    },
  );

  test("explicit browser selection rejects a storage-mode mismatch before using targets", async () => {
    const session = discoveredBrowserSession(browserSessionId, sessionId);
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({ getBrowserSession: async () => session }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_open"],
      permissions: ["sessions:control"],
    });
    await expect(
      definitions[0]!.execute(
        { browserSessionId, storageMode: "ephemeral_context" },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      ),
    ).rejects.toThrow("storage mode does not match");
  });

  test("opens managed Chromium headed by default for supported human sign-in", async () => {
    let createRequest: Record<string, unknown> | null = null;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listBrowserSessions: async () => {
          throw new Error("legacy inventory unavailable");
        },
        createBrowserSession: async (_workspaceId, request) => {
          createRequest = request as unknown as Record<string, unknown>;
          return { session: { lifecycle: "starting" } } as never;
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_open"],
      permissions: ["sessions:control"],
    });

    await definitions[0]!.execute(
      { mode: "new", initialUrl: "https://accounts.google.com/" },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );

    expect(createRequest).toMatchObject({
      sessionId,
      headless: false,
      initialUrl: "https://accounts.google.com/",
    });
  });

  test("a browser that failed to start reports why instead of a failed session", async () => {
    const failedId = randomUUID();
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listBrowserSessions: async () => ({ revision: "0", sessions: [] }) as never,
        createBrowserSession: async () =>
          ({
            session: { id: failedId, lifecycle: "failed", failureCode: "unsupported" },
            operation: {
              state: "failed",
              error: {
                code: "unsupported",
                message: "No Google Chrome or Chromium is installed on this machine.",
                retryable: false,
              },
            },
          }) as never,
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_open"],
      permissions: ["sessions:control"],
    });

    const result = await definitions[0]!.execute(
      { mode: "new", initialUrl: "https://example.com/" },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.structuredContent);
    expect(text).toContain(
      `BrowserSession ${failedId} did not start: No Google Chrome or Chromium is installed`,
    );
    expect(text).toContain("unsupported");
  });

  test("opens attached browsers headed and forwards the selected network route", async () => {
    let createRequest: Record<string, unknown> | null = null;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listBrowserSessions: async () => ({ revision: 0, sessions: [] }),
        createBrowserSession: async (_workspaceId, request) => {
          createRequest = request as unknown as Record<string, unknown>;
          return { session: { lifecycle: "starting" } } as never;
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_open"],
      permissions: ["sessions:control"],
    });
    const deviceId = randomUUID();
    const networkRouteId = randomUUID();
    await definitions[0]!.execute(
      {
        mode: "new",
        placement: { kind: "attached_device", deviceId },
        networkRouteId,
      },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(createRequest).toMatchObject({
      sessionId,
      headless: false,
      placement: { kind: "attached_device", deviceId },
      networkRouteId,
    });
  });

  describe("browser_open on the person's own Chrome without a deviceId", () => {
    const profile = (
      name: string,
      updatedAt: string,
      overrides: { state?: "connected" | "disconnected"; debuggerAttachment?: boolean } = {},
    ) => {
      const state = overrides.state ?? "connected";
      return {
        id: randomUUID(),
        accountId,
        workspaceId,
        enrollmentId: randomUUID(),
        name,
        profileLabel: name,
        browserName: "Chrome",
        browserVersion: "150.0.0.0",
        extensionVersion: "0.1.4",
        platform: "macos" as const,
        architecture: "arm64" as const,
        state,
        connectionGeneration: "connection-1",
        inventoryRevision: 3,
        tabCount: 4,
        capabilities: {
          tabInventory: true,
          debuggerAttachment: overrides.debuggerAttachment ?? true,
          semanticObservation: true,
          screenshots: true,
          liveFrames: false,
          humanInput: true,
          diagnostics: true,
          rawCdp: false,
          linkedComputer: false,
        },
        lastSeenAt: updatedAt,
        disconnectedAt: state === "connected" ? null : updatedAt,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt,
      };
    };
    const open = async (
      devices: ReturnType<typeof profile>[],
      postSetupCard?: UserSetupCardPoster,
      machines: {
        bridges?: Array<{ enrollmentId: string; sandboxId: string | null; machineName: string }>;
        activeSandboxId?: string | null;
      } = {},
    ) => {
      let createRequest: Record<string, unknown> | null = null;
      const definitions = createInteractionAttemptToolDefinitions({
        transport: {
          ...partialTransport({
            listBrowserSessions: async () => ({ revision: 0, sessions: [] }),
            listAttachedBrowsers: async () => ({
              revision: 1,
              bridges: (machines.bridges ?? []).map((bridge) => ({
                ...bridge,
                state: "online" as const,
                bridgeGeneration: "bridge-1",
                inventoryRevision: 1,
                connectedProfileCount: 1,
                lastSeenAt: now,
              })),
              devices,
            }),
            createBrowserSession: async (_workspaceId, request) => {
              createRequest = request as unknown as Record<string, unknown>;
              return { session: discoveredBrowserSession(randomUUID(), sessionId) } as never;
            },
          }),
          ...(machines.activeSandboxId !== undefined
            ? {
                getSession: async () =>
                  ({
                    id: sessionId,
                    sandboxGroupId: randomUUID(),
                    activeSandboxId: machines.activeSandboxId,
                  }) as never,
              }
            : {}),
        },
        workspaceId,
        sessionId,
        selectedTools: ["browser_open"],
        permissions: ["sessions:control"],
        ...(postSetupCard ? { postSetupCard } : {}),
      });
      const result = await definitions[0]!.execute(
        { placement: { kind: "attached_device" } },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      return { result, createRequest: createRequest as Record<string, unknown> | null };
    };

    test("opens the only connected profile", async () => {
      const only = profile("Personal", "2026-10-15T10:00:00.000Z");
      const { result, createRequest } = await open([only]);
      expect(createRequest).toMatchObject({
        placement: { kind: "attached_device", deviceId: only.id },
      });
      expect(result.structuredContent).toMatchObject({
        attachedProfile: { id: only.id, name: "Personal" },
      });
      expect(result.structuredContent).not.toHaveProperty("otherAttachedProfiles");
    });

    test("opens the most recently active profile and names the others", async () => {
      const older = profile("Work", "2026-10-15T09:00:00.000Z");
      const newer = profile("Personal", "2026-10-15T10:00:00.000Z");
      const gone = profile("Old", "2026-10-15T11:00:00.000Z", { state: "disconnected" });
      const blind = profile("Locked", "2026-10-15T12:00:00.000Z", { debuggerAttachment: false });
      const { result, createRequest } = await open([older, gone, blind, newer]);
      expect(createRequest).toMatchObject({
        placement: { kind: "attached_device", deviceId: newer.id },
      });
      expect(result.structuredContent).toMatchObject({
        attachedProfile: { id: newer.id, name: "Personal" },
        otherAttachedProfiles: [{ id: older.id, name: "Work" }],
      });
    });

    test("prefers a profile on the computer this session runs on, and says where each is", async () => {
      const thisMachine = randomUUID();
      const here = profile("Here", "2026-10-15T09:00:00.000Z");
      const elsewhere = profile("Elsewhere", "2026-10-15T10:00:00.000Z");
      const bridges = [
        { enrollmentId: here.enrollmentId, sandboxId: thisMachine, machineName: "Mac mini" },
        { enrollmentId: elsewhere.enrollmentId, sandboxId: randomUUID(), machineName: "Laptop" },
      ];
      const { result, createRequest } = await open([elsewhere, here], undefined, {
        bridges,
        activeSandboxId: thisMachine,
      });
      // The other computer's profile is newer, but this computer's comes first.
      expect(createRequest).toMatchObject({
        placement: { kind: "attached_device", deviceId: here.id },
      });
      expect(result.structuredContent).toMatchObject({
        attachedProfile: { id: here.id, machine: "Mac mini", onThisMachine: true },
        otherAttachedProfiles: [{ id: elsewhere.id, machine: "Laptop" }],
      });
      expect(
        (result.structuredContent as { otherAttachedProfiles: object[] }).otherAttachedProfiles[0],
      ).not.toHaveProperty("onThisMachine");
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain(
        `Attached Chrome profile: "Here" on "Mac mini" (this session's machine) deviceId ${here.id}`,
      );
      expect(text).toContain(
        `Other attached profiles: "Elsewhere" on "Laptop" deviceId ${elsewhere.id}`,
      );
    });

    test("without a profile on this computer, opens the most recent one and names its computer", async () => {
      const older = profile("Work", "2026-10-15T09:00:00.000Z");
      const newer = profile("Personal", "2026-10-15T10:00:00.000Z");
      const bridges = [
        { enrollmentId: older.enrollmentId, sandboxId: randomUUID(), machineName: "Desktop" },
        { enrollmentId: newer.enrollmentId, sandboxId: randomUUID(), machineName: "Laptop" },
      ];
      // A managed sandbox (no active Connected Machine) and a machine with no
      // connected profile both fall back to recency.
      for (const activeSandboxId of [null, randomUUID()]) {
        const { result, createRequest } = await open([older, newer], undefined, {
          bridges,
          activeSandboxId,
        });
        expect(createRequest).toMatchObject({
          placement: { kind: "attached_device", deviceId: newer.id },
        });
        expect(result.structuredContent).toMatchObject({
          attachedProfile: { id: newer.id, machine: "Laptop" },
          otherAttachedProfiles: [{ id: older.id, machine: "Desktop" }],
        });
        expect(
          (result.structuredContent as { attachedProfile: object }).attachedProfile,
        ).not.toHaveProperty("onThisMachine");
        expect((result.content[0] as { text: string }).text).toContain(
          `Attached Chrome profile: "Personal" on "Laptop" deviceId ${newer.id}`,
        );
      }
    });

    test("explains how to connect Chrome when no profile is connected", async () => {
      const { result, createRequest } = await open([
        profile("Old", "2026-10-15T11:00:00.000Z", { state: "disconnected" }),
      ]);
      expect(createRequest).toBeNull();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.structuredContent)).toContain("No Chrome profile is connected");
      expect(JSON.stringify(result.structuredContent)).toContain("attached_browser_unavailable");
      // Without a card poster, the model is told to post the card itself.
      expect(JSON.stringify(result.structuredContent)).toContain(
        "capability_authorization_request (capabilityId api:connected-machine)",
      );
    });

    test("posts the Chrome setup card on the first failed open and says so", async () => {
      const posted: Array<{ code: string; purpose?: string; toolName: string }> = [];
      const chatUrl = "https://app.example.test/workspaces/w/sessions/s";
      const { result, createRequest } = await open([], async (blocker, toolName) => {
        posted.push({ code: blocker.code, purpose: blocker.purpose, toolName });
        return { chatUrl };
      });
      expect(posted).toEqual([
        { code: "attached_browser_unavailable", purpose: "chrome", toolName: "browser_open" },
      ]);
      expect(createRequest).toBeNull();
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.structuredContent);
      expect(text).toContain("attached_browser_unavailable");
      expect(text).toContain("No Chrome profile is connected");
      expect(text).toContain("A card that fixes this is now posted in this chat");
      expect(text).toContain("do not post another card");
      expect(text).toContain(chatUrl);
      expect(text).not.toContain("capability_authorization_request");
    });

    test("asks the model to offer the fix when the card can't be posted", async () => {
      for (const poster of [
        async () => null,
        async () => {
          throw new Error("turn replaced");
        },
      ]) {
        const { result } = await open([], poster);
        expect(result.isError).toBe(true);
        const text = JSON.stringify(result.structuredContent);
        expect(text).toContain("attached_browser_unavailable");
        expect(text).not.toContain("now posted in this chat");
        expect(text).toContain("Offer the fix in this reply");
        expect(text).toContain(
          "capability_authorization_request (capabilityId api:connected-machine)",
        );
        expect(text).toContain("chromewebstore.google.com");
      }
    });

    test("does not post the setup card when a profile is connected", async () => {
      let posts = 0;
      const { result } = await open([profile("Personal", "2026-10-15T10:00:00.000Z")], async () => {
        posts += 1;
        return { chatUrl: null };
      });
      expect(result.isError).toBeFalsy();
      expect(posts).toBe(0);
    });

    test("says the fix isn't available when this deployment can't offer it", async () => {
      const { result } = await open([], async () => "unavailable");
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.structuredContent);
      expect(text).toContain("attached_browser_unavailable");
      expect(text).toContain("can't fix it here");
      expect(text).not.toContain("now posted in this chat");
      expect(text).not.toContain("capability_authorization_request");
    });
  });

  test("any tool refused for something the person can fix posts the same setup card", async () => {
    const posted: Array<{ code: string; toolName: string }> = [];
    const refuse = (code: string) =>
      createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          listComputerSessions: async () => ({ revision: 0, sessions: [] }),
          createComputerSession: async () => {
            throw new OpenGeniApiError(409, "The machine's owner has not allowed this chat.", {
              code,
            });
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: ["computer_open"],
        permissions: ["sessions:read", "sessions:control"],
        postSetupCard: async (blocker, toolName) => {
          posted.push({ code: blocker.code, toolName });
          return { chatUrl: null };
        },
      })[0]!.execute(
        { mode: "new" },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:fixture" } },
      );

    const fixable = await refuse("personal_machine_permission_required");
    expect(posted).toEqual([
      { code: "personal_machine_permission_required", toolName: "computer_open" },
    ]);
    expect(fixable.isError).toBe(true);
    expect(JSON.stringify(fixable.structuredContent)).toContain(
      "A card that fixes this is now posted in this chat",
    );

    // A refusal the person can't fix is returned unchanged, with no card.
    const other = await refuse("personal_machine_not_permitted");
    expect(posted).toHaveLength(1);
    expect(other.isError).toBe(true);
    const text = JSON.stringify(other.structuredContent);
    expect(text).toContain("has not allowed this chat");
    expect(text).not.toContain("now posted in this chat");
  });

  test("projects one permission-filtered definition set into the exact attempt catalog", () => {
    const definitions = createInteractionAttemptToolDefinitions({
      transport: unusedTransport(),
      workspaceId,
      sessionId,
      permissions: ["sessions:read"],
    });

    expect(definitions.map((definition) => definition.identity.toolName)).toEqual([
      "interaction_discover",
      "browser_observe",
      "browser_read",
      "browser_screenshot",
      "browser_clipboard",
      "browser_debug",
      "browser_downloads",
      "computer_targets",
      "computer_observe",
      "computer_clipboard",
    ]);
    const environment = createAttemptToolEnvironment({
      scope: {
        accountId,
        workspaceId,
        sessionId,
        turnId,
        attemptId,
        executionGeneration: 1,
      },
      generation: 1,
      definitions,
    });
    expect(environment.catalog.entries).toHaveLength(10);
    expect(environment.catalog.entries[0]).toMatchObject({
      identity: { serverId: "interaction", toolName: "interaction_discover" },
      modelName: "interaction__interaction_discover",
      codemodePath: ["interaction", "discover"],
      source: "interaction",
      approval: "none",
      annotations: { readOnlyHint: true, idempotentHint: true },
    });
    expect(environment.catalog.entries[0]!.inputSchema).toMatchObject({
      type: "object",
    });
    expect(environment.catalog.entries[0]!.outputSchema).toMatchObject({
      type: "object",
    });
  });

  test("reads only the private BrowserSession clipboard through the shared catalog", async () => {
    const clipboard = {
      browserSessionId,
      controllerGeneration: "controller-1",
      revision: 2,
      text: "copied text",
      source: "copy" as const,
      sourceTargetId: "tab-1",
      updatedAt: now,
    };
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        readBrowserClipboard: async () => clipboard,
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_clipboard"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      { browserSessionId },
      {
        operationId: randomUUID(),
        caller: { kind: "model", subjectId: "model:test" },
      },
    );

    expect(definitions[0]).toMatchObject({
      codemodePath: ["interaction", "browser", "clipboard"],
      annotations: { readOnlyHint: true, idempotentHint: true },
    });
    expect(result.structuredContent).toEqual(clipboard);
  });

  test("keeps discovery task-local by default and exposes workspace scope explicitly", async () => {
    const current = discoveredBrowserSession(browserSessionId, sessionId);
    const peer = discoveredBrowserSession(randomUUID(), randomUUID());
    const currentComputer = discoveredComputerSession(computerSessionId, sessionId);
    const identity = {
      id: randomUUID(),
      accountId,
      workspaceId,
      name: "Reusable identity",
      status: "active" as const,
      version: 1,
      defaultRevisionId: null,
      headGeneration: 0,
      revisionCount: 0,
      createdBySubjectId: "model:test",
      createdAt: now,
      updatedAt: now,
    };
    const bridge = {
      enrollmentId: randomUUID(),
      state: "online" as const,
      bridgeGeneration: "bridge-1",
      inventoryRevision: 1,
      connectedProfileCount: 0,
      lastSeenAt: now,
    };
    expect(BrowserSessionSchema.parse(current)).toEqual(current);
    expect(ComputerSessionSchema.parse(currentComputer)).toEqual(currentComputer);
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listBrowserSessions: async () => ({ revision: 2, sessions: [current, peer] }),
        listComputerSessions: async () => ({ revision: 1, sessions: [currentComputer] }),
        listBrowserIdentities: async () => ({ revision: 3, identities: [identity] }),
        listAttachedBrowsers: async () => ({ revision: 4, bridges: [bridge], devices: [] }),
      }),
      workspaceId,
      sessionId,
      selectedTools: ["interaction_discover"],
      permissions: ["sessions:read"],
    });

    const local = await definitions[0]!.execute(
      {},
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(local.structuredContent).toMatchObject({
      browsers: [{ id: current.id }],
      computers: [{ id: currentComputer.id }],
      identities: [],
      attachedBrowserBridges: [],
      attachedBrowsers: [],
    });

    const workspace = await definitions[0]!.execute(
      { scope: "workspace" },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect((workspace.structuredContent as { browsers: BrowserSession[] }).browsers).toHaveLength(
      2,
    );
    expect(workspace.structuredContent).toMatchObject({
      identities: [{ id: identity.id }],
      attachedBrowserBridges: [{ enrollmentId: bridge.enrollmentId }],
    });
  });

  test("tab open/select observations support a fenced next action without another page read", async () => {
    for (const operation of ["open", "select"] as const) {
      const target = browserTarget();
      const observation = browserObservation(target);
      observation.focusedRef = "button-ref";
      observation.semantic = {
        kind: "snapshot",
        nodeCount: 76,
        roots: Array.from({ length: 76 }, (_, index) => ({
          ref: index === 0 ? "button-ref" : `text-${index}`,
          role: index === 0 ? "button" : "text",
          name: index === 0 ? "Continue" : "Example content ".repeat(30),
          states: index === 0 ? ["focused"] : [],
          actions: index === 0 ? ["click"] : [],
          children: [],
        })),
      };
      // The authoritative inventory can advance independently of this snapshot.
      const otherTarget = { ...target, id: "tab-2", title: "Other", selected: true };
      const tabs = {
        browserSessionId,
        controllerGeneration: target.controllerGeneration,
        targets: [{ ...target, selected: false }, otherTarget],
      };
      const calls: string[] = [];
      let actionRequest: BrowserActionRequest | null = null;
      const unexpectedRead = async () => {
        throw new Error("The mutation observation already provides the page fences");
      };
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          openBrowserTarget: async () => {
            calls.push("open");
            return observation;
          },
          selectBrowserTarget: async () => {
            calls.push("select");
            return observation;
          },
          listBrowserTargets: async () => {
            calls.push("list");
            return tabs;
          },
          observeBrowserTarget: unexpectedRead,
          getBrowserTargetState: unexpectedRead,
          actInBrowser: async (_workspace, _browser, request) => {
            calls.push("act");
            actionRequest = request;
            return { ...browserReceipt(request.operationId, observation), observation: null };
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: ["browser_tabs", "browser_act"],
        permissions: ["sessions:control"],
      });
      const context = {
        operationId: randomUUID(),
        caller: { kind: "model" as const, subjectId: "model:test" },
      };
      const result = await definitions
        .find((definition) => definition.modelName === "interaction__browser_tabs")!
        .execute(
          operation === "open"
            ? { operation, browserSessionId, url: "https://example.test/" }
            : { operation, browserSessionId, targetId: target.id },
          context,
        );
      expect(result.isError).not.toBe(true);
      const output = result.structuredContent as {
        mutationObservation: {
          target: ReturnType<typeof agentTarget>;
          frameId: string;
          agentView: { nodes: Array<{ ref: string }>; omittedNodeCount: number };
        };
      };
      const snapshot = output.mutationObservation;
      expect(result.structuredContent).toMatchObject({
        browserSessionId: tabs.browserSessionId,
        targets: tabs.targets.map(agentTarget),
      });
      expect(snapshot).toMatchObject({
        target: agentTarget(target),
        frameId: observation.frameId,
        agentView: { sourceKind: "snapshot" },
      });
      expect(snapshot).toMatchObject({ focusedRef: observation.focusedRef });
      for (const omitted of ["semantic", "observationId", "observedAt", "diagnostics"])
        expect(snapshot).not.toHaveProperty(omitted);
      expect(snapshot.agentView.nodes).toContainEqual(
        expect.objectContaining({ ref: "button-ref", role: "button", name: "Continue" }),
      );
      expect(snapshot.agentView.nodes.length).toBeLessThanOrEqual(60);
      expect(snapshot.agentView.omittedNodeCount).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify(snapshot.agentView.nodes))).toBeLessThan(12_100);
      expect(observation.semantic.kind).toBe("snapshot");
      const actionOperationId = randomUUID();
      const action = await definitions
        .find((definition) => definition.modelName === "interaction__browser_act")!
        .execute(
          {
            browserSessionId,
            targetId: snapshot.target.id,
            expectedTargetGeneration: snapshot.target.targetGeneration,
            expectedDocumentGeneration: snapshot.target.documentGeneration,
            expectedFrameId: snapshot.frameId,
            view: "none",
            action: { type: "scroll", deltaX: 0, deltaY: 100 },
          },
          { ...context, operationId: actionOperationId },
        );
      expect(action.isError).not.toBe(true);
      expect(actionRequest).toMatchObject({
        operationId: actionOperationId,
        targetId: target.id,
        expectedTargetGeneration: target.targetGeneration,
        expectedDocumentGeneration: target.documentGeneration,
        expectedFrameId: observation.frameId,
        observationMode: "none",
      });
      expect(action.structuredContent).toEqual({ targetId: target.id, state: "completed" });
      expect(calls).toEqual([operation, "list", "act"]);
    }
  });

  test("tab list/close preserve their existing output without observing a page", async () => {
    for (const operation of ["list", "close"] as const) {
      const target = browserTarget();
      const tabs = {
        browserSessionId,
        controllerGeneration: target.controllerGeneration,
        targets: [target],
      };
      const calls: string[] = [];
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          listBrowserTargets: async () => {
            calls.push("list");
            return tabs;
          },
          closeBrowserTarget: async () => {
            calls.push("close");
            return tabs;
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: ["browser_tabs"],
        permissions: ["sessions:control"],
      });
      const result = await definitions[0]!.execute(
        operation === "list"
          ? { operation, browserSessionId }
          : { operation, browserSessionId, targetId: target.id },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      expect(result.structuredContent).toEqual({
        browserSessionId: tabs.browserSessionId,
        targets: tabs.targets.map(agentTarget),
      });
      expect(calls).toEqual([operation]);
    }
  });

  test("sends a fence-free Browser action as one request for the API to fence", async () => {
    const target = browserTarget();
    const observation = browserObservation(target);
    let request: BrowserActionRequest | null = null;
    const transport = partialTransport({
      observeBrowserTarget: async () => {
        throw new Error("unexpected full AX read");
      },
      getBrowserTargetState: async () => {
        throw new Error("unexpected separate target-state request");
      },
      actInBrowser: async (_workspaceId, _browserSessionId, value) => {
        request = value;
        return browserReceipt(value.operationId, observation);
      },
    });
    const definitions = createInteractionAttemptToolDefinitions({
      transport,
      workspaceId,
      sessionId,
      selectedTools: ["browser_act"],
      permissions: ["sessions:control"],
    });
    const environment = createAttemptToolEnvironment({
      scope: {
        accountId,
        workspaceId,
        sessionId,
        turnId,
        attemptId,
        executionGeneration: 7,
      },
      generation: 3,
      definitions,
    });
    const operationId = randomUUID();

    const result = await environment.callModel({
      operationId,
      modelName: "interaction__browser_act",
      subjectId: "model:test",
      arguments: {
        browserSessionId,
        targetId: target.id,
        action: { type: "scroll", deltaX: 0, deltaY: 480 },
      },
    });

    expect(request).toEqual({
      operationId,
      targetId: target.id,
      action: { type: "scroll", deltaX: 0, deltaY: 480 },
    });
    expect(result.structuredContent).toMatchObject({
      targetId: target.id,
      state: "completed",
      observation: { target: agentTarget(target), agentView: { sourceKind: "snapshot" } },
    });
    for (const omitted of ["operationId", "browserSessionId", "dispatchedAt", "error"])
      expect(result.structuredContent).not.toHaveProperty(omitted);
  });

  test("returns a post-action screenshot in the same call when includeScreenshot is set", async () => {
    const target = browserTarget();
    const observation = browserObservation(target);
    const image = new Uint8Array([1, 2, 3]);
    const order: string[] = [];
    let captureFails = false;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        actInBrowser: async (_workspaceId, _browserSessionId, value) => {
          order.push("act");
          return browserReceipt(value.operationId, observation);
        },
        captureBrowserTarget: async (_workspaceId, _browserSessionId, targetId) => {
          order.push(`capture:${targetId}`);
          if (captureFails) throw new Error("synthetic capture failure");
          return {
            frameId: "captured-browser-frame",
            browserSessionId,
            controllerGeneration: target.controllerGeneration,
            targetId: target.id,
            targetGeneration: target.targetGeneration,
            documentGeneration: target.documentGeneration!,
            sequence: 1,
            mediaType: "image/jpeg",
            width: 1,
            height: 1,
            deviceScaleFactor: 1,
            scrollX: 0,
            scrollY: 0,
            capturedAt: now,
            data: image,
          };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_act"],
      permissions: ["sessions:control"],
    });
    const context = {
      operationId: randomUUID(),
      caller: { kind: "model" as const, subjectId: "model:test" },
    };
    const action = { type: "scroll", deltaX: 0, deltaY: 480 };

    const plain = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id, action },
      context,
    );
    expect(plain.content).toHaveLength(1);
    expect(order).toEqual(["act"]);

    order.length = 0;
    const visual = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id, action, includeScreenshot: true },
      { ...context, operationId: randomUUID() },
    );
    // The capture follows the settled action, never runs alongside it.
    expect(order).toEqual(["act", `capture:${target.id}`]);
    expect(visual.isError).toBeFalsy();
    expect(visual.content).toHaveLength(2);
    expect(visual.content[0]).toMatchObject({ type: "text" });
    expect(visual.content[1]).toEqual({
      type: "image",
      data: Buffer.from(image).toString("base64"),
      mimeType: "image/jpeg",
    });
    expect(visual.structuredContent).toMatchObject({ targetId: target.id, state: "completed" });

    // A failed capture keeps the completed action's receipt and says why.
    captureFails = true;
    const failed = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id, action, includeScreenshot: true },
      { ...context, operationId: randomUUID() },
    );
    expect(failed.isError).toBeFalsy();
    expect(failed.structuredContent).toMatchObject({ targetId: target.id, state: "completed" });
    expect(failed.content).toHaveLength(2);
    expect((failed.content[1] as { text: string }).text).toBe(
      "The action ran, but its screenshot could not be captured: synthetic capture failure",
    );
  });

  test("an open JavaScript dialog replaces a requested screenshot with what to do next", async () => {
    const target = browserTarget();
    const dialog = {
      type: "confirm" as const,
      message: "Delete this revision?",
      defaultPrompt: "",
      openedAt: now,
    };
    const observation = { ...browserObservation(target), dialog };
    let captures = 0;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        actInBrowser: async (_workspaceId, _browserSessionId, value) =>
          browserReceipt(value.operationId, observation),
        observeBrowserTarget: async () => observation,
        captureBrowserTarget: async () => {
          captures += 1;
          throw new Error("a dialog blocks capture");
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_act", "browser_observe"],
      permissions: ["sessions:control", "sessions:read"],
    });
    const context = {
      operationId: randomUUID(),
      caller: { kind: "model" as const, subjectId: "model:test" },
    };
    const note =
      "No screenshot: a JavaScript dialog is open in this tab. Handle it first with browser_act action {type:'handle_dialog'}.";
    const acted = await definitions
      .find((definition) => definition.modelName === "interaction__browser_act")!
      .execute(
        {
          browserSessionId,
          targetId: target.id,
          action: { type: "click", locator: { kind: "ref", ref: "e1" } },
          view: "none",
          includeScreenshot: true,
        },
        context,
      );
    expect(acted.isError).toBeFalsy();
    expect(acted.structuredContent).toMatchObject({ observation: { dialog } });
    expect(acted.content.at(-1)).toEqual({ type: "text", text: note });
    // The action path never asks a blocked tab for pixels.
    expect(captures).toBe(0);

    const observed = await definitions
      .find((definition) => definition.modelName === "interaction__browser_observe")!
      .execute(
        { browserSessionId, targetId: target.id, includeScreenshot: true },
        { ...context, operationId: randomUUID() },
      );
    expect(observed.isError).toBeFalsy();
    expect(observed.structuredContent).toMatchObject({ dialog });
    expect(observed.content.at(-1)).toEqual({ type: "text", text: note });
  });

  test("an upload by workspace path publishes each file once per operation and dispatches File IDs", async () => {
    const target = browserTarget();
    const observation = browserObservation(target);
    const published: string[] = [];
    const dispatched: BrowserActionRequest[] = [];
    let failDispatch = true;
    const fileIds = new Map<string, string>();
    const definitions = createInteractionAttemptToolDefinitions({
      transport: {
        ...partialTransport({
          actInBrowser: async (_workspaceId, _browserSessionId, value) => {
            dispatched.push(value);
            if (failDispatch) {
              failDispatch = false;
              throw new Error("synthetic dispatch failure");
            }
            return browserReceipt(value.operationId, observation);
          },
        }),
        publishSandboxFileArtifact: async (_workspaceId, publishingSessionId, request) => {
          expect(publishingSessionId).toBe(sessionId);
          published.push(request.path);
          const artifactId = randomUUID();
          fileIds.set(request.path, artifactId);
          return {
            type: "sandbox_file" as const,
            sandboxPath: request.path,
            filename: request.path.split("/").at(-1)!,
            artifact: {
              available: true as const,
              artifactId,
              kind: "file" as const,
              contentType: "text/csv",
              originalBytes: 3,
              sha256: "0".repeat(64),
              retainedAt: now,
            },
          };
        },
      },
      workspaceId,
      sessionId,
      selectedTools: ["browser_act"],
      permissions: ["sessions:control"],
    });
    const context = {
      operationId: randomUUID(),
      caller: { kind: "model" as const, subjectId: "model:test" },
    };
    const input = {
      browserSessionId,
      targetId: target.id,
      action: {
        type: "batch",
        actions: [
          { type: "upload", locator: "e1a2b3c4d", paths: ["out/a.csv", "out/b.csv"] },
          { type: "click", locator: "e5f6a7b8c" },
        ],
      },
    };

    await expect(definitions[0]!.execute(input, context)).rejects.toThrow(
      "synthetic dispatch failure",
    );
    // The retry of the same operation dispatches the same File IDs without publishing again.
    const retried = await definitions[0]!.execute(input, context);
    expect(retried.isError).toBeFalsy();
    expect(published).toEqual(["out/a.csv", "out/b.csv"]);
    expect(dispatched).toHaveLength(2);
    for (const request of dispatched) {
      expect(request.action).toEqual({
        type: "batch",
        actions: [
          {
            type: "upload",
            locator: { kind: "ref", ref: "e1a2b3c4d" },
            workspaceFileIds: [fileIds.get("out/a.csv"), fileIds.get("out/b.csv")],
          },
          { type: "click", locator: { kind: "ref", ref: "e5f6a7b8c" } },
        ],
      });
    }

    // File IDs still pass through untouched, and the model sees both forms in one line.
    const direct = await definitions[0]!.execute(
      {
        browserSessionId,
        targetId: target.id,
        action: {
          type: "upload",
          locator: "e1a2b3c4d",
          workspaceFileIds: [fileIds.get("out/a.csv")],
        },
      },
      { ...context, operationId: randomUUID() },
    );
    expect(direct.isError).toBeFalsy();
    expect(dispatched.at(-1)!.action).toEqual({
      type: "upload",
      locator: { kind: "ref", ref: "e1a2b3c4d" },
      workspaceFileIds: [fileIds.get("out/a.csv")],
    });
    expect(published).toHaveLength(2);
    expect(JSON.stringify(definitions[0]!.inputSchema)).toContain(
      "upload: locator, workspaceFileIds?, paths?",
    );
  });

  test("navigate waitUntil dispatches the navigation and a wait; viewport defaults to desktop", async () => {
    const target = browserTarget();
    const observation = browserObservation(target);
    const dispatched: BrowserActionRequest[] = [];
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        actInBrowser: async (_workspaceId, _browserSessionId, value) => {
          dispatched.push(value);
          return browserReceipt(value.operationId, observation);
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_act"],
      permissions: ["sessions:control"],
    });
    const act = async (action: unknown) =>
      await definitions[0]!.execute(
        { browserSessionId, targetId: target.id, action },
        { operationId: randomUUID(), caller: { kind: "model" as const, subjectId: "model:test" } },
      );

    expect(
      (await act({ type: "navigate", url: "https://example.com/a", waitUntil: "network_idle" }))
        .isError,
    ).toBeFalsy();
    expect(dispatched.at(-1)!.action).toEqual({
      type: "batch",
      actions: [
        { type: "navigate", url: "https://example.com/a" },
        { type: "wait", condition: "network_idle" },
      ],
    });
    expect((await act({ type: "navigate", url: "https://example.com/b" })).isError).toBeFalsy();
    expect(dispatched.at(-1)!.action).toEqual({ type: "navigate", url: "https://example.com/b" });

    expect(
      (
        await act({
          type: "batch",
          actions: [
            { type: "viewport", width: 390, height: 844 },
            { type: "navigate", url: "https://example.com/c", waitUntil: "load" },
            { type: "viewport", width: 390, height: 844, mobile: true },
          ],
        })
      ).isError,
    ).toBeFalsy();
    expect(dispatched.at(-1)!.action).toEqual({
      type: "batch",
      actions: [
        { type: "viewport", width: 390, height: 844, mobile: false },
        { type: "navigate", url: "https://example.com/c" },
        { type: "wait", condition: "load" },
        { type: "viewport", width: 390, height: 844, mobile: true },
      ],
    });

    const tooMany = Array.from({ length: 17 }, (_, index) => ({
      type: "navigate",
      url: `https://example.com/${index}`,
      waitUntil: "load",
    }));
    await expect(act({ type: "batch", actions: tooMany })).rejects.toThrow("split the batch");
    const schema = JSON.stringify(definitions[0]!.inputSchema);
    expect(schema).toContain("waitUntil");
    expect(schema).toContain("navigate: url, waitUntil?");
  });

  test("skips the pre-action AX read with all explicit fences and omits post-action AX on request", async () => {
    const target = browserTarget();
    let request: BrowserActionRequest | null = null;
    let observationCalls = 0;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeBrowserTarget: async () => {
          observationCalls += 1;
          throw new Error("unexpected pre-action observation");
        },
        getBrowserTargetState: async () => {
          observationCalls += 1;
          throw new Error("unexpected pre-action state read");
        },
        actInBrowser: async (_workspaceId, _browserSessionId, value) => {
          request = value;
          return {
            ...browserReceipt(value.operationId, browserObservation(target)),
            observation: null,
          };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_act"],
      permissions: ["sessions:control"],
    });
    const result = await definitions[0]!.execute(
      {
        browserSessionId,
        targetId: target.id,
        expectedTargetGeneration: target.targetGeneration,
        expectedDocumentGeneration: target.documentGeneration,
        expectedFrameId: "frame-2",
        view: "none",
        action: { type: "scroll", deltaX: 0, deltaY: 100 },
      },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(request).toMatchObject({
      expectedTargetGeneration: target.targetGeneration,
      expectedDocumentGeneration: target.documentGeneration,
      expectedFrameId: "frame-2",
      observationMode: "none",
    });
    expect(observationCalls).toBe(0);
    expect(result.structuredContent).toEqual({ targetId: target.id, state: "completed" });
  });

  test("returns a bounded tool error for invalid action input without touching transport", async () => {
    let called = false;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeBrowserTarget: async () => {
          called = true;
          return browserObservation(browserTarget());
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_act"],
      permissions: ["sessions:control"],
    });
    const result = await definitions[0]!.execute(
      {
        browserSessionId,
        targetId: "tab-1",
        action: { type: "scroll", deltaX: 0 },
      },
      {
        operationId: randomUUID(),
        caller: { kind: "model", subjectId: "model:test" },
      },
    );

    expect(called).toBe(false);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "invalid_arguments", retryable: false },
      },
    });
  });

  test("preserves an explicit semantic Computer observation without refreshing it or forwarding its pixel frame", async () => {
    const target = computerTarget();
    const observation = computerObservation(target);
    let request: ComputerActionRequest | null = null;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeComputerTarget: async () => {
          throw new Error("explicit Computer fences must not trigger a fresh observation");
        },
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          request = value;
          return computerReceipt(value.operationId, observation);
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const operationId = randomUUID();
    const result = await definitions[0]!.execute(
      {
        computerSessionId,
        targetId: target.id,
        expectedTargetGeneration: target.targetGeneration,
        expectedObservationId: observation.observationId,
        expectedFrameId: observation.frameId,
        action: {
          type: "semantic",
          locator: { kind: "role", role: "button", name: "Save" },
          action: "invoke",
        },
      },
      { operationId, caller: { kind: "model", subjectId: "model:test" } },
    );

    expect(request).toEqual({
      operationId,
      targetId: target.id,
      expectedTargetGeneration: target.targetGeneration,
      expectedObservationId: observation.observationId,
      expectedFrameId: null,
      action: {
        type: "semantic",
        locator: { kind: "role", role: "button", name: "Save" },
        action: "invoke",
      },
    });
    expect(result.isError).not.toBe(true);
  });

  test("a Computer action's reading shows only what changed since the reading the model last saw", async () => {
    const target = computerTarget();
    const styles = Array.from({ length: 8 }, (_, index) => ({
      ref: `e${index + 2}`,
      role: "radio",
      name: `Style ${index}`,
      states: [],
      actions: ["invoke"],
    }));
    const reading = (value: string) => ({
      ...computerObservation(target),
      semantic: {
        kind: "snapshot" as const,
        roots: [
          { ref: "e1", role: "textbox", name: "Name", value, states: [], actions: ["set_value"] },
          ...styles,
        ],
        nodeCount: styles.length + 1,
      },
    });
    const readings = [reading(""), reading("Ada"), reading("Ada")];
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        actInComputer: async (_workspaceId, _computerSessionId, value) =>
          computerReceipt(value.operationId, readings.shift()!),
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const act = async () => {
      const result = await definitions[0]!.execute(
        {
          computerSessionId,
          targetId: target.id,
          expectedTargetGeneration: target.targetGeneration,
          expectedObservationId: "fenced",
          action: {
            type: "semantic",
            locator: { kind: "ref", ref: "e1" },
            action: "set_value",
            value: "Ada",
          },
        },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      return (result.content[0] as { text: string }).text;
    };
    // Nothing read yet in this attempt: the whole window.
    const first = await act();
    expect(first).toContain('radio "Style 7" [e9]');
    // Then only the field that changed; the styles keep their refs.
    const second = await act();
    expect(second).toContain("elements not listed are unchanged and keep their refs");
    expect(second).toContain('textbox "Name" [e1] value="Ada"');
    expect(second).not.toContain("Style");
    // And an action that changed nothing says so.
    expect(await act()).toContain("No element changed since");
  });

  test("a browser action's outline shows only what changed since the outline the model last saw", async () => {
    const target = browserTarget();
    const links = Array.from({ length: 8 }, (_, index) => ({
      ref: `e${index + 2}`,
      role: "link",
      name: `Section ${index}`,
      states: [],
      actions: ["click"],
    }));
    const reading = (value: string): BrowserObservation => ({
      ...browserObservation(target),
      semantic: {
        kind: "snapshot",
        roots: [
          {
            ref: "e1",
            role: "textbox",
            name: "How can we help you?",
            value,
            states: [],
            actions: ["fill"],
          },
          ...links,
        ],
        nodeCount: links.length + 1,
      },
    });
    const readings = [reading(""), reading("Agents at scale")];
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        actInBrowser: async (_workspaceId, _browserSessionId, value) =>
          browserReceipt(value.operationId, readings.shift()!),
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_act"],
      permissions: ["sessions:control"],
    });
    const act = async (caller: "model" | "codemode" = "model") => {
      const result = await definitions[0]!.execute(
        {
          browserSessionId,
          targetId: target.id,
          action: { type: "fill", locator: "e1", value: "Agents at scale" },
        },
        { operationId: randomUUID(), caller: { kind: caller, subjectId: `${caller}:test` } },
      );
      return (result.content[0] as { text: string }).text;
    };
    // Nothing read yet in this attempt: the whole outline.
    expect(await act()).toContain('link "Section 7" [e9]');
    // Then only the field that changed; the links keep their refs.
    const second = await act();
    expect(second).toContain("elements not listed are unchanged and keep their refs");
    expect(second).toContain('textbox "How can we help you?" [e1] value="Agents at scale"');
    expect(second).not.toContain("Section");
    // And an action that changed nothing says so.
    readings.push(reading("Agents at scale"));
    expect(await act()).toContain("No element changed since your last reading of this page");
    // A Code Mode program's result is not something the model read: it keeps
    // the whole outline and does not move the model's baseline.
    readings.push(reading("Other"));
    expect(await act("codemode")).toContain('link "Section 7" [e9]');
    readings.push(reading("Agents at scale"));
    expect(await act()).toContain("No element changed since your last reading of this page");
  });

  test("runs a Computer batch in order, fencing each action by the observation the one before it returned", async () => {
    const target = computerTarget();
    const initial = computerObservation(target);
    const requests: ComputerActionRequest[] = [];
    // The controller's journal: an operation ID bound to a different command
    // (another fence) conflicts; its receipt stays readable.
    const journal = new Map<
      string,
      { request: ComputerActionRequest; receipt: ComputerActionReceipt }
    >();
    let observed = 0;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        // This computer runs a batch one action at a time.
        getComputerSession: async () => ({ capabilities: { actionBatches: false } }) as never,
        observeComputerTarget: async () => {
          observed += 1;
          return observed === 1 ? initial : { ...initial, observationId: `fresh-${observed}` };
        },
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          requests.push(value);
          const existing = journal.get(value.operationId);
          if (existing) {
            if (JSON.stringify(existing.request) !== JSON.stringify(value))
              throw new Error("operation id is already bound to a different computer command");
            return existing.receipt;
          }
          const receipt = computerReceipt(value.operationId, {
            ...computerObservation({ ...target, targetGeneration: `target-${journal.size + 3}` }),
            observationId: `after-${journal.size + 1}`,
          });
          journal.set(value.operationId, { request: value, receipt });
          return receipt;
        },
        getComputerActionReceipt: async (_workspaceId, _computerSessionId, id) => {
          const existing = journal.get(id);
          if (!existing)
            throw new OpenGeniApiError(404, "operation not found", { code: "resource_not_found" });
          return existing.receipt;
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const actions = [
      { type: "keyboard", action: "press", value: "5" },
      {
        type: "semantic",
        locator: { kind: "role", role: "button", name: "Multiply" },
        action: "invoke",
      },
      { type: "keyboard", action: "type", value: "12" },
    ];
    const operationId = randomUUID();
    const run = async () =>
      await definitions[0]!.execute(
        { computerSessionId, targetId: target.id, action: { type: "batch", actions } },
        { operationId, caller: { kind: "model", subjectId: "model:test" } },
      );
    const result = await run();

    expect(observed).toBe(1);
    expect(requests.map((request) => request.action)).toEqual(actions as never);
    expect(
      requests.map((request) => [request.expectedTargetGeneration, request.expectedObservationId]),
    ).toEqual([
      [target.targetGeneration, initial.observationId],
      ["target-3", "after-1"],
      ["target-4", "after-2"],
    ]);
    expect(requests.every((request) => request.expectedFrameId === null)).toBe(true);
    const operationIds = requests.map((request) => request.operationId);
    expect(new Set([...operationIds, operationId]).size).toBe(4);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      type: "batch",
      actionCount: 3,
      steps: operationIds.map((id) => ({ operationId: id, state: "completed", error: null })),
      observation: { observationId: "after-3" },
      observationPrecedesStop: false,
    });
    expect((result.content[0] as { text: string }).text).toStartWith(
      `Batch completed on ${target.id}: 3 actions.\n`,
    );

    // A retried call finds the first action's recorded receipt, and the
    // later actions, fenced by the recorded observations, repeat their
    // recorded commands: nothing acts again.
    requests.length = 0;
    const retried = await run();
    expect(observed).toBe(1);
    expect(requests.map((request) => request.operationId)).toEqual(operationIds.slice(1));
    expect(journal.size).toBe(3);
    expect(retried.structuredContent).toEqual(result.structuredContent);
  });

  test("a computer action can leave out its type and name elements as role:name", async () => {
    const target = computerTarget();
    const after = { ...computerObservation(target), observationId: "after-batch" };
    const requests: ComputerActionRequest[] = [];
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        getComputerActionReceipt: noRecordedReceipt,
        getComputerSession: async () => ({ capabilities: { actionBatches: true } }) as never,
        listComputerTargets: async () => ({ targets: [target] }) as never,
        observeComputerTarget: async () => after,
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          requests.push(value);
          return computerReceipt(value.operationId, after);
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const result = await definitions[0]!.execute(
      {
        computerSessionId,
        targetId: target.id,
        action: {
          actions: [
            { locator: "link:Accounts", action: "invoke" },
            { locator: "textbox:Search accounts", action: "set_value", value: "AC-1" },
            { type: "keyboard", action: "press", value: "enter" },
          ],
        },
      },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(result.isError).not.toBe(true);
    expect(requests[0]?.action).toEqual({
      type: "batch",
      actions: [
        {
          type: "semantic",
          locator: { kind: "role", role: "link", name: "Accounts", exact: true },
          action: "invoke",
        },
        {
          type: "semantic",
          locator: { kind: "role", role: "textbox", name: "Search accounts", exact: true },
          action: "set_value",
          value: "AC-1",
        },
        { type: "keyboard", action: "press", value: "enter" },
      ],
    });
    // The model view says so: type is optional, on an action and in a batch.
    const schema = definitions[0]!.inputSchema as {
      properties: {
        action: {
          required?: string[];
          description?: string;
          properties: Record<string, { items?: { required?: string[] } }>;
        };
      };
    };
    expect(schema.properties.action.required).toBeUndefined();
    expect(schema.properties.action.description).toStartWith(
      "type defaults to semantic when locator is set and to batch when actions is.",
    );
    expect(schema.properties.action.properties.actions?.items?.required).toBeUndefined();
  });

  test("a computer that runs batches gets the whole batch as one operation", async () => {
    const target = computerTarget();
    const initial = computerObservation(target);
    const after = { ...initial, observationId: "after-batch" };
    const requests: ComputerActionRequest[] = [];
    let stopAfter: number | null = null;
    let roleStandIns: ComputerActionReceipt["roleStandIns"];
    let sessionReads = 0;
    let observed = 0;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        getComputerActionReceipt: noRecordedReceipt,
        getComputerSession: async () => {
          sessionReads += 1;
          return { capabilities: { actionBatches: true } } as never;
        },
        listComputerTargets: async () => ({ targets: [target] }) as never,
        observeComputerTarget: async () => {
          observed += 1;
          return after;
        },
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          requests.push(value);
          if (stopAfter === null)
            return {
              ...computerReceipt(value.operationId, after),
              ...(roleStandIns ? { roleStandIns } : {}),
            };
          return {
            ...computerReceipt(value.operationId, after),
            state: "outcome_unknown",
            observation: null,
            error: {
              code: "outcome_unknown",
              message: "CUA stopped the batch at action 2: did not confirm",
              retryable: false,
              details: { batchActionsCompleted: stopAfter, batchStoppedActionState: "failed" },
            },
          };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const actions = [
      { type: "semantic", locator: { kind: "ref", ref: "e1" }, action: "invoke" },
      { type: "keyboard", action: "type", value: "12" },
      { type: "keyboard", action: "press", value: "enter" },
    ];
    const run = async () =>
      await definitions[0]!.execute(
        {
          computerSessionId,
          targetId: target.id,
          expectedObservationId: initial.observationId,
          action: { type: "batch", actions },
        },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );

    const result = await run();
    expect(requests).toHaveLength(1);
    // The batch's own observation is its fence: the window is not read again,
    // which would retire its refs, and the target list gives the generation.
    expect(observed).toBe(0);
    expect(requests[0]).toMatchObject({
      expectedTargetGeneration: target.targetGeneration,
      expectedObservationId: initial.observationId,
      expectedFrameId: null,
      action: { type: "batch", actions },
    });
    const batchOperationId = requests[0]!.operationId;
    expect(result.structuredContent).toMatchObject({
      type: "batch",
      actionCount: 3,
      steps: actions.map(() => ({ operationId: batchOperationId, state: "completed" })),
      observation: { observationId: "after-batch" },
      observationPrecedesStop: false,
    });
    expect((result.content[0] as { text: string }).text).toStartWith(
      `Batch completed on ${target.id}: 3 actions.\n`,
    );

    // A batch stopped part way reports each action as it would one at a
    // time, and shows the state the batch left.
    stopAfter = 1;
    const stopped = await run();
    expect(observed).toBe(1);
    expect(stopped.structuredContent).toMatchObject({
      steps: [
        { state: "completed", error: null },
        {
          state: "failed",
          error: {
            code: "outcome_unknown",
            message: "CUA stopped the batch at action 2: did not confirm",
          },
        },
      ],
      observation: { observationId: "after-batch" },
    });
    const text = (stopped.content[0] as { text: string }).text;
    expect(text).toStartWith(`Batch stopped on ${target.id} at action 2 of 3: action 2 failed`);
    // The bookkeeping that says how far the batch got is not shown again.
    expect(text).not.toContain("batchActionsCompleted");

    // An action that pressed a link it named as a button says so.
    stopAfter = null;
    roleStandIns = [{ actionIndex: 0, requestedRole: "button", role: "link", name: "Pay" }];
    const stoodIn = await run();
    expect(stoodIn.structuredContent).toMatchObject({ roleStandIns });
    expect((stoodIn.content[0] as { text: string }).text).toContain(
      'Action 1 named button "Pay", but no button here has that name, so it used the link "Pay"; name it as role "link" next time.\n',
    );
    expect(result.structuredContent).not.toHaveProperty("roleStandIns");
    // Support is read once for the session.
    expect(sessionReads).toBe(1);
  });

  test("a retried Computer batch reports what its first try ran without sending it again", async () => {
    const target = computerTarget();
    // Like CUA, every read is a new observation, and the computer's journal
    // refuses one operation ID sent with different fences.
    let reads = 0;
    const read = () => ({ ...computerObservation(target), observationId: `obs-${++reads}` });
    const journal = new Map<
      string,
      { request: ComputerActionRequest; receipt: ComputerActionReceipt }
    >();
    const sent: ComputerActionRequest[] = [];
    let receiptReads = 0;
    let windowGone = false;
    const tryOnce = async (operationId: string, support: boolean | "unreadable") =>
      await createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          // The computer fixes its answer for the session's life.
          getComputerSession: async () => {
            if (support === "unreadable") throw new Error("api unavailable");
            return { capabilities: { actionBatches: support } } as never;
          },
          listComputerTargets: async () => ({ targets: [target] }) as never,
          observeComputerTarget: async () => {
            if (windowGone) throw new Error("window closed");
            return read();
          },
          actInComputer: async (_workspaceId, _computerSessionId, value) => {
            const existing = journal.get(value.operationId);
            if (existing) {
              if (existing.request.expectedObservationId !== value.expectedObservationId)
                throw new OpenGeniApiError(409, "operation id is already bound", {
                  code: "operation_conflict",
                });
              return existing.receipt;
            }
            sent.push(value);
            const receipt = computerReceipt(value.operationId, read());
            journal.set(value.operationId, { request: value, receipt });
            return receipt;
          },
          getComputerActionReceipt: async (_workspaceId, _computerSessionId, id) => {
            receiptReads += 1;
            return journal.get(id)?.receipt ?? (await noRecordedReceipt());
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: ["computer_act"],
        permissions: ["sessions:control"],
      })[0]!.execute(
        {
          computerSessionId,
          targetId: target.id,
          action: {
            type: "batch",
            actions: [
              { type: "keyboard", action: "press", value: "5" },
              { type: "keyboard", action: "press", value: "6" },
            ],
          },
        },
        { operationId, caller: { kind: "model", subjectId: "model:test" } },
      );

    // Run as one operation: nothing is read before it is sent.
    const native = randomUUID();
    const whole = await tryOnce(native, true);
    expect(sent.map((request) => request.action.type)).toEqual(["batch"]);
    expect(receiptReads).toBe(0);
    sent.length = 0;
    // A retry reads the window again, so the journal refuses its new fence,
    // and the recorded receipt says what ran.
    const again = await tryOnce(native, true);
    expect(sent).toEqual([]);
    expect(again.structuredContent).toEqual(whole.structuredContent);
    // So does a retry once the batch closed the window.
    windowGone = true;
    const gone = await tryOnce(native, true);
    expect(sent).toEqual([]);
    expect(gone.structuredContent).toEqual(whole.structuredContent);
    // A retry that cannot read how the computer runs batches sends nothing.
    await expect(tryOnce(native, "unreadable")).rejects.toThrow(
      "so the batch was not sent; retry the call",
    );
    expect(sent).toEqual([]);

    // One action at a time: a retry reuses the recorded actions.
    windowGone = false;
    const sequential = randomUUID();
    const first = await tryOnce(sequential, false);
    expect(sent.map((request) => request.action.type)).toEqual(["keyboard", "keyboard"]);
    sent.length = 0;
    const retried = await tryOnce(sequential, false);
    expect(sent).toEqual([]);
    expect(retried.structuredContent).toEqual(first.structuredContent);
  });

  test("does not send a Computer batch whose way of running cannot be read", async () => {
    const target = computerTarget();
    const observation = computerObservation(target);
    let sent = 0;
    for (const session of ["unreadable", { capabilities: null }] as const) {
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          getComputerSession: async () => {
            if (session === "unreadable") throw new Error("api unavailable");
            return session as never;
          },
          listComputerTargets: async () => ({ targets: [target] }) as never,
          observeComputerTarget: async () => observation,
          actInComputer: async (_workspaceId, _computerSessionId, value) => {
            sent += 1;
            return computerReceipt(value.operationId, observation);
          },
          getComputerActionReceipt: async () => await noRecordedReceipt(),
        }),
        workspaceId,
        sessionId,
        selectedTools: ["computer_act"],
        permissions: ["sessions:control"],
      });
      await expect(
        definitions[0]!.execute(
          {
            computerSessionId,
            targetId: target.id,
            expectedObservationId: observation.observationId,
            action: {
              type: "batch",
              actions: [
                { type: "keyboard", action: "press", value: "5" },
                { type: "keyboard", action: "press", value: "6" },
              ],
            },
          },
          { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
        ),
      ).rejects.toThrow("so the batch was not sent; retry the call");
    }
    expect(sent).toBe(0);
  });

  test("concurrent tries of one Computer batch run it one way, once", async () => {
    const target = computerTarget();
    const observation = computerObservation(target);
    const journal = new Map<string, ComputerActionReceipt>();
    const sent: ComputerActionRequest[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    let observes = 0;
    let firstObserving!: () => void;
    const firstReading = new Promise<void>((resolve) => (firstObserving = resolve));
    const tryOnce = async (operationId: string) =>
      await createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          getComputerSession: async () => ({ capabilities: { actionBatches: true } }) as never,
          // The batch names no observation, so each try reads the window
          // first; the first try is held there until the second finishes.
          listComputerTargets: async () => ({ targets: [target] }) as never,
          observeComputerTarget: async () => {
            observes += 1;
            if (observes === 1) {
              firstObserving();
              await firstHeld;
            }
            return observation;
          },
          actInComputer: async (_workspaceId, _computerSessionId, value) => {
            const existing = journal.get(value.operationId);
            if (existing) return existing;
            sent.push(value);
            const receipt = computerReceipt(value.operationId, observation);
            journal.set(value.operationId, receipt);
            return receipt;
          },
          getComputerActionReceipt: async (_workspaceId, _computerSessionId, id) =>
            journal.get(id) ?? (await noRecordedReceipt()),
        }),
        workspaceId,
        sessionId,
        selectedTools: ["computer_act"],
        permissions: ["sessions:control"],
      })[0]!.execute(
        {
          computerSessionId,
          targetId: target.id,
          action: {
            type: "batch",
            actions: [
              { type: "keyboard", action: "press", value: "5" },
              { type: "keyboard", action: "press", value: "6" },
            ],
          },
        },
        { operationId, caller: { kind: "model", subjectId: "model:test" } },
      );
    const operationId = randomUUID();
    const first = tryOnce(operationId);
    await firstReading;
    const second = await tryOnce(operationId);
    releaseFirst();
    const held = await first;
    expect(sent.map((request) => request.action.type)).toEqual(["batch"]);
    expect(held.structuredContent).toEqual(second.structuredContent);
  });

  test("a retried Computer batch reuses actions that ran even when the window can no longer be read", async () => {
    const target = computerTarget();
    const observation = computerObservation(target);
    const journal = new Map<string, ComputerActionReceipt>();
    let windowGone = false;
    let acts = 0;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        // This computer runs a batch one action at a time.
        getComputerSession: async () => ({ capabilities: { actionBatches: false } }) as never,
        observeComputerTarget: async () => {
          if (windowGone) throw new Error("window closed");
          return observation;
        },
        // Each action completes without an observation.
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          acts += 1;
          const receipt = { ...computerReceipt(value.operationId, observation), observation: null };
          journal.set(value.operationId, receipt);
          return receipt;
        },
        getComputerActionReceipt: async (_workspaceId, _computerSessionId, id) => {
          const existing = journal.get(id);
          if (!existing)
            throw new OpenGeniApiError(404, "operation not found", { code: "resource_not_found" });
          return existing;
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const operationId = randomUUID();
    const run = async () =>
      await definitions[0]!.execute(
        {
          computerSessionId,
          targetId: target.id,
          action: {
            type: "batch",
            actions: [
              { type: "keyboard", action: "press", value: "5" },
              { type: "keyboard", action: "press", value: "6" },
            ],
          },
        },
        { operationId, caller: { kind: "model", subjectId: "model:test" } },
      );
    const first = await run();
    expect(acts).toBe(2);
    expect(first.structuredContent).toMatchObject({
      steps: [{ state: "completed" }, { state: "completed" }],
    });

    windowGone = true;
    const retried = await run();
    expect(acts).toBe(2);
    expect(retried.structuredContent).toMatchObject({
      steps: [{ state: "completed" }, { state: "completed" }],
    });

    // When neither the window nor the recorded result can be read, the
    // action is not sent and the text says an earlier try may have sent it.
    let reads = 0;
    let sent = 0;
    const unknown = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        getComputerSession: async () => ({ capabilities: { actionBatches: false } }) as never,
        observeComputerTarget: async () => {
          reads += 1;
          if (reads === 1) return observation;
          throw new Error("window closed");
        },
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          sent += 1;
          return { ...computerReceipt(value.operationId, observation), observation: null };
        },
        // The controller stops answering after the first action is sent.
        getComputerActionReceipt: async () => {
          if (sent === 0) return await noRecordedReceipt();
          throw new Error("controller unreachable");
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const unread = await unknown[0]!.execute(
      {
        computerSessionId,
        targetId: target.id,
        action: {
          type: "batch",
          actions: [
            { type: "keyboard", action: "press", value: "5" },
            { type: "keyboard", action: "press", value: "6" },
          ],
        },
      },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(sent).toBe(1);
    expect(unread.structuredContent).toMatchObject({
      steps: [{ state: "completed" }, { state: "outcome_unknown" }],
    });
    expect((unread.content[0] as { text: string }).text.split("\n")[1]).toBe(
      "Error outcome_unknown: this call did not send this action because the window could not be read, and whether an earlier try of this batch sent it could not be read either: window closed",
    );
  });

  test("a retried Computer batch continues from a recovered action's own observation", async () => {
    const target = computerTarget();
    // Like CUA, only the latest observation is a valid fence, and every read
    // replaces it.
    let latest = 0;
    const read = () => ({ ...computerObservation(target), observationId: `obs-${++latest}` });
    const journal = new Map<string, ComputerActionReceipt>();
    let reachable = true;
    let secondFails = true;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        // This computer runs a batch one action at a time.
        getComputerSession: async () => ({ capabilities: { actionBatches: false } }) as never,
        observeComputerTarget: async () => {
          if (!reachable) throw new Error("controller unavailable");
          return read();
        },
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          const existing = journal.get(value.operationId);
          if (existing) return existing;
          if (journal.size === 1 && secondFails) {
            reachable = false;
            throw new Error("socket hang up");
          }
          if (value.expectedObservationId !== `obs-${latest}`)
            throw new OpenGeniApiError(409, "observation_stale", { code: "observation_stale" });
          const receipt = computerReceipt(value.operationId, read());
          journal.set(value.operationId, receipt);
          return receipt;
        },
        getComputerActionReceipt: async (_workspaceId, _computerSessionId, id) => {
          const existing = journal.get(id);
          if (!existing)
            throw new OpenGeniApiError(404, "operation not found", { code: "resource_not_found" });
          return existing;
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const operationId = randomUUID();
    const run = async () =>
      await definitions[0]!.execute(
        {
          computerSessionId,
          targetId: target.id,
          action: {
            type: "batch",
            actions: [
              { type: "keyboard", action: "press", value: "5" },
              { type: "keyboard", action: "press", value: "6" },
            ],
          },
        },
        { operationId, caller: { kind: "model", subjectId: "model:test" } },
      );
    const first = await run();
    expect(first.structuredContent).toMatchObject({
      steps: [{ state: "completed" }, { state: "outcome_unknown" }],
    });

    reachable = true;
    secondFails = false;
    const retried = await run();
    expect(retried.structuredContent).toMatchObject({
      steps: [{ state: "completed" }, { state: "completed" }],
    });
    expect(journal.size).toBe(2);
  });

  test("stops a Computer batch at the first action that does not complete and says what ran", async () => {
    const target = computerTarget();
    const observation = computerObservation(target);
    const requests: ComputerActionRequest[] = [];
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        // This computer runs a batch one action at a time.
        getComputerSession: async () => ({ capabilities: { actionBatches: false } }) as never,
        getComputerActionReceipt: noRecordedReceipt,
        observeComputerTarget: async () => observation,
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          requests.push(value);
          if (requests.length < 2) return computerReceipt(value.operationId, observation);
          return {
            ...computerReceipt(value.operationId, observation),
            state: "failed",
            observation: null,
            error: {
              code: "unsupported",
              message: "CUA type_text refused the operation",
              retryable: false,
            },
          };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const result = await definitions[0]!.execute(
      {
        computerSessionId,
        targetId: target.id,
        action: {
          type: "batch",
          actions: [
            { type: "keyboard", action: "press", value: "5" },
            { type: "keyboard", action: "type", value: "*" },
            { type: "keyboard", action: "press", value: "3" },
            { type: "keyboard", action: "press", value: "return" },
          ],
        },
      },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );

    expect(requests).toHaveLength(2);
    const text = (result.content[0] as { text: string }).text;
    expect(text.split("\n").slice(0, 4)).toEqual([
      `Batch stopped on ${target.id} at action 2 of 4: action 2 failed (operation ${requests[1]!.operationId}).`,
      "Error unsupported: CUA type_text refused the operation",
      "Action 1 completed.",
      "Actions 3 to 4 were not run.",
    ]);
    // The state the first action left stays in view.
    expect(result.structuredContent).toMatchObject({
      observation: { observationId: observation.observationId },
    });
  });

  test("stops a Computer batch at an action that opened another window and shows that window", async () => {
    const target = computerTarget();
    const observation = computerObservation(target);
    const opened = computerObservation({ ...target, id: "window-opened" });
    const requests: ComputerActionRequest[] = [];
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        // This computer runs a batch one action at a time.
        getComputerSession: async () => ({ capabilities: { actionBatches: false } }) as never,
        getComputerActionReceipt: noRecordedReceipt,
        observeComputerTarget: async () => observation,
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          requests.push(value);
          return computerReceipt(value.operationId, requests.length < 2 ? observation : opened);
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const run = async (count: number) =>
      await definitions[0]!.execute(
        {
          computerSessionId,
          targetId: target.id,
          action: {
            type: "batch",
            actions: [
              { type: "keyboard", action: "press", value: "tab" },
              { type: "keyboard", action: "press", value: "cmd+n" },
              { type: "keyboard", action: "type", value: "hello" },
              { type: "keyboard", action: "press", value: "return" },
            ].slice(0, count),
          },
        },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
    const result = await run(4);

    expect(requests).toHaveLength(2);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      steps: [{ state: "completed" }, { state: "completed" }],
      observation: { target: { id: "window-opened" } },
      observationPrecedesStop: false,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text.split("\n").slice(0, 4)).toEqual([
      `Batch stopped on ${target.id} at action 2 of 4: action 2 completed (operation ${requests[1]!.operationId}) and opened another window.`,
      "Action 1 completed.",
      "Actions 3 to 4 were not run.",
      "Action 2 opened window-opened; act on that target with the observation below.",
    ]);

    // The last action opening a window completes the batch.
    requests.length = 0;
    const last = await run(2);
    expect(requests).toHaveLength(2);
    expect((last.content[0] as { text: string }).text.split("\n").slice(0, 2)).toEqual([
      `Batch completed on ${target.id}: 2 actions.`,
      "Action 2 opened window-opened; act on that target with the observation below.",
    ]);
  });

  test("reports the actions a Computer batch ran when it cannot read the window or reach the controller later", async () => {
    const target = computerTarget();
    const observation = computerObservation(target);
    const run = async (transport: Parameters<typeof partialTransport>[0]) => {
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          // This computer runs a batch one action at a time.
          getComputerSession: async () => ({ capabilities: { actionBatches: false } }) as never,
          getComputerActionReceipt: noRecordedReceipt,
          ...transport,
        }),
        workspaceId,
        sessionId,
        selectedTools: ["computer_act"],
        permissions: ["sessions:control"],
      });
      const result = await definitions[0]!.execute(
        {
          computerSessionId,
          targetId: target.id,
          action: {
            type: "batch",
            actions: [
              { type: "keyboard", action: "press", value: "5" },
              { type: "keyboard", action: "press", value: "6" },
            ],
          },
        },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      return { result, text: (result.content[0] as { text: string }).text };
    };

    // The first action completes without an observation, and reading the
    // window before the second fails: the second is not sent.
    let reads = 0;
    const unread = await run({
      observeComputerTarget: async () => {
        reads += 1;
        if (reads === 1) return observation;
        throw new Error("controller unavailable");
      },
      actInComputer: async (_workspaceId, _computerSessionId, value) => ({
        ...computerReceipt(value.operationId, observation),
        observation: null,
      }),
      getComputerActionReceipt: async () => {
        throw new OpenGeniApiError(404, "operation not found", { code: "resource_not_found" });
      },
    });
    expect(unread.result.isError).not.toBe(true);
    expect(unread.text.split("\n").slice(0, 4)).toEqual([
      expect.stringContaining("at action 2 of 2: action 2 failed"),
      "Error resource_unavailable (retryable): the window could not be read before this action, so it was not sent: controller unavailable",
      "Action 1 completed.",
      "The state below is from before action 2; observe the window again before sending it or later actions.",
    ]);

    // The second action's reply is lost and nothing is recorded under its
    // ID: it may have acted, and the state shown predates it.
    let acts = 0;
    let observes = 0;
    const lost = await run({
      observeComputerTarget: async () => {
        observes += 1;
        if (observes === 1) return observation;
        throw new Error("controller unavailable");
      },
      actInComputer: async (_workspaceId, _computerSessionId, value) => {
        acts += 1;
        if (acts === 1) return computerReceipt(value.operationId, observation);
        throw new Error("socket hang up");
      },
    });
    expect(lost.result.structuredContent).toMatchObject({
      steps: [{ state: "completed" }, { state: "outcome_unknown" }],
      observationPrecedesStop: true,
    });
    expect(lost.text.split("\n").slice(1, 4)).toEqual([
      "Error outcome_unknown: the request for this action failed: socket hang up",
      "Action 1 completed.",
      "The state below is from before action 2, which may have taken effect; observe the window again before sending it or later actions.",
    ]);
  });

  test("keeps pointer actions out of a Computer batch and shows the model one compact batch item", async () => {
    let called = false;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        actInComputer: async () => {
          called = true;
          throw new Error("must not dispatch");
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const environment = createAttemptToolEnvironment({
      scope: { accountId, workspaceId, sessionId, turnId, attemptId, executionGeneration: 7 },
      generation: 3,
      definitions,
    });
    const pointerBatch = {
      computerSessionId,
      targetId: "window-1",
      action: {
        type: "batch",
        actions: [{ type: "pointer", frameId: "frame-1", action: "click", x: 1, y: 2 }],
      },
    };
    await expect(
      environment.callModel({
        operationId: randomUUID(),
        modelName: "interaction__computer_act",
        subjectId: "model:test",
        arguments: pointerBatch,
      }),
    ).rejects.toThrow('"action.actions[0].type" must be one of "semantic", "keyboard"');
    const direct = await definitions[0]!.execute(pointerBatch, {
      operationId: randomUUID(),
      caller: { kind: "model", subjectId: "model:test" },
    });
    expect(called).toBe(false);
    expect(direct).toMatchObject({ isError: true });
    expect(JSON.stringify(direct.content)).toContain("run a pointer action on its own");

    const action = (definitions[0]!.inputSchema.properties as Record<string, any>).action;
    expect(action.properties.type.enum).toContain("batch");
    expect(action.properties.actions.items).toEqual({
      type: "object",
      properties: { type: { type: "string", enum: ["semantic", "keyboard"] } },
      description:
        "One semantic or keyboard action with the same fields as action; a semantic one can leave out type.",
    });
    expect(action.description).toContain("batch: actions");
  });

  test("accepts native opaque Computer observation fences through the model tool catalog", async () => {
    const target = computerTarget();
    const observation = {
      ...computerObservation(target),
      observationId: "o_native_1",
      frameId: "f_native_2",
    };
    let request: ComputerActionRequest | null = null;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeComputerTarget: async () => observation,
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          request = value;
          return computerReceipt(value.operationId, observation);
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const environment = createAttemptToolEnvironment({
      scope: {
        accountId,
        workspaceId,
        sessionId,
        turnId,
        attemptId,
        executionGeneration: 7,
      },
      generation: 3,
      definitions,
    });

    const result = await environment.callModel({
      operationId: randomUUID(),
      modelName: "interaction__computer_act",
      subjectId: "model:test",
      arguments: {
        computerSessionId,
        targetId: target.id,
        expectedObservationId: observation.observationId,
        action: {
          type: "pointer",
          frameId: observation.frameId,
          action: "click",
          x: 195,
          y: 270,
        },
      },
    });

    expect(request).toMatchObject({
      expectedObservationId: "o_native_1",
      expectedFrameId: "f_native_2",
    });
    expect(result.structuredContent).toMatchObject({ state: "completed" });
  });

  test("a launch fences on the target list and hands back the launched window", async () => {
    const target = computerTarget();
    const launchedWindow = { ...computerTarget(), id: "window-launched", title: "Untitled" };
    const launched = computerObservation(launchedWindow);
    let request: ComputerActionRequest | null = null;
    let observed = 0;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listComputerTargets: async () => ({ computerSessionId, targets: [target] }),
        observeComputerTarget: async () => {
          observed += 1;
          return computerObservation(target);
        },
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          request = value;
          return { ...computerReceipt(value.operationId, launched), targetId: value.targetId };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const environment = createAttemptToolEnvironment({
      scope: { accountId, workspaceId, sessionId, turnId, attemptId, executionGeneration: 7 },
      generation: 3,
      definitions,
    });
    const result = await environment.callModel({
      operationId: randomUUID(),
      modelName: "interaction__computer_act",
      subjectId: "model:test",
      arguments: {
        computerSessionId,
        targetId: target.id,
        action: { type: "launch", applicationId: "com.example.Editor" },
      },
    });
    // The launch reads no window: the target list gives its generation.
    expect(observed).toBe(0);
    expect(request).toMatchObject({
      targetId: target.id,
      expectedTargetGeneration: target.targetGeneration,
      expectedObservationId: null,
      expectedFrameId: null,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(
      "This action opened window-launched; act on that target with the observation below.",
    );
    expect(text).toContain('window window-launched "Untitled"');

    // A target missing from the list is read, as for any other action.
    await environment.callModel({
      operationId: randomUUID(),
      modelName: "interaction__computer_act",
      subjectId: "model:test",
      arguments: {
        computerSessionId,
        targetId: "window-gone",
        action: { type: "launch", applicationId: "com.example.Editor" },
      },
    });
    expect(observed).toBe(1);
  });

  test("computer_open with applicationId launches the app and observes its window in one call", async () => {
    const window = computerTarget();
    const screen: ComputerTarget = { ...computerTarget(), id: "screen-1", kind: "screen" };
    const appWindow = { ...computerTarget(), id: "window-calculator", title: "Calculator" };
    const session = {
      ...discoveredComputerSession(randomUUID(), sessionId),
      lifecycle: "active" as const,
      placement: { kind: "connected_machine" as const, sandboxId: randomUUID() },
      controller: {
        controllerId: "controller",
        controllerGeneration: "controller-1",
        placementInstanceId: "placement-1",
      },
      platform: "macos" as const,
      adapter: "opengeni.cua.macos.v1",
      seatId: "seat-1",
      displayId: "aqua",
      capabilities: {
        semanticObservation: true,
        appDiscovery: true,
        appLaunch: true,
        windowCapture: true,
        screenCapture: true,
        semanticActions: true,
        pointerInput: true,
        keyboardInput: true,
        clipboard: true,
        backgroundActions: true,
        parallelApps: true,
      },
    };
    const requests: ComputerActionRequest[] = [];
    let observed = 0;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listComputerSessions: async () => ({ revision: 0, sessions: [session] }),
        listComputerTargets: async () => ({ computerSessionId, targets: [window, screen] }),
        observeComputerTarget: async () => {
          observed += 1;
          return computerObservation(window);
        },
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          requests.push(value);
          return {
            ...computerReceipt(value.operationId, computerObservation(appWindow)),
            targetId: value.targetId,
          };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_open", "computer_act"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const environment = createAttemptToolEnvironment({
      scope: { accountId, workspaceId, sessionId, turnId, attemptId, executionGeneration: 7 },
      generation: 3,
      definitions,
    });
    const operationId = randomUUID();
    const open = (args: Record<string, unknown>, id = operationId) =>
      environment.callModel({
        operationId: id,
        modelName: "interaction__computer_open",
        subjectId: "model:test",
        arguments: { placement: session.placement, ...args },
      });
    const result = await open({ applicationId: "com.apple.calculator" });
    // The launch rides on the screen target, fenced from the target list.
    expect(observed).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      targetId: "screen-1",
      expectedTargetGeneration: screen.targetGeneration,
      expectedObservationId: null,
      expectedFrameId: null,
      action: { type: "launch", applicationId: "com.apple.calculator" },
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("2 targets:");
    expect(text).toContain(
      "This action opened window-calculator; act on that target with the observation below.",
    );
    expect(result.structuredContent).toMatchObject({
      launch: { state: "completed", observation: { target: { id: "window-calculator" } } },
    });

    // A retried call repeats the same launch operation; a plain open launches nothing.
    await open({ applicationId: "com.apple.calculator" });
    expect(requests[1]!.operationId).toBe(requests[0]!.operationId);
    const plain = await open({}, randomUUID());
    expect(requests).toHaveLength(2);
    expect(plain.structuredContent).not.toHaveProperty("launch");
  });

  test("computer_open with applicationId and includeScreenshot captures the app's window, and a failed launch keeps the open", async () => {
    const session: ComputerSession = {
      ...discoveredComputerSession(computerSessionId, sessionId),
      lifecycle: "active",
      controller: {
        controllerId: "synthetic-controller",
        controllerGeneration: "controller-1",
        placementInstanceId: "placement-1",
      },
      platform: "macos",
      adapter: "opengeni.cua.macos.v1",
      seatId: "seat-1",
      displayId: "aqua",
      capabilities: {
        semanticObservation: true,
        appDiscovery: true,
        appLaunch: true,
        windowCapture: true,
        screenCapture: true,
        semanticActions: true,
        pointerInput: true,
        keyboardInput: true,
        clipboard: true,
        backgroundActions: true,
        parallelApps: true,
      },
    };
    const screen: ComputerTarget = { ...computerTarget(), id: "screen-1", kind: "screen" };
    const appWindow: ComputerTarget = {
      ...computerTarget(),
      id: "window-calculator",
      title: "Calculator",
    };
    const image = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
    const captures: Array<{ targetId: string; options: unknown }> = [];
    let launchFails = false;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        getComputerSession: async () => session,
        listComputerTargets: async () => ({
          computerSessionId,
          controllerGeneration: "controller-1",
          targets: [screen, appWindow],
        }),
        observeComputerTarget: async (_w, _s, targetId) =>
          computerObservation(targetId === appWindow.id ? appWindow : screen),
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          if (launchFails) throw new Error("This Mac is locked. Unlock it to use desktop capture.");
          return { ...computerReceipt(value.operationId, computerObservation(appWindow)) };
        },
        captureComputerTarget: async (_workspaceId, _sessionId, targetId, _o, options) => {
          captures.push({ targetId, options });
          return {
            frameId: `frame-${captures.length}`,
            computerSessionId,
            controllerGeneration: "controller-1",
            targetId,
            targetGeneration: appWindow.targetGeneration,
            sequence: 0,
            mediaType: "image/jpeg",
            width: options?.region ? 400 : 640,
            height: options?.region ? 300 : 400,
            capturedAt: now,
            sha256: "0".repeat(64),
            ...(options?.region
              ? {
                  region: options.region,
                  regionFrame: options.regionFrame ?? { width: 1, height: 1 },
                }
              : {}),
            data: image,
          };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_open", "computer_observe"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const [open, observe] = definitions;
    const context = () => ({
      operationId: randomUUID(),
      caller: { kind: "model" as const, subjectId: "model:test" },
    });

    const launched = await open!.execute(
      { computerSessionId, applicationId: "com.apple.calculator", includeScreenshot: true },
      context(),
    );
    expect(launched.isError).toBeFalsy();
    // The launched app's window is photographed, not the screen.
    expect(captures).toEqual([{ targetId: "window-calculator", options: undefined }]);
    expect(launched.content[1]).toEqual({
      type: "text",
      text: "Screenshot of window-calculator: frameId frame-1, 640x400 pixels; use these pixels for pointer coordinates.",
    });
    expect(launched.structuredContent).toMatchObject({
      launch: { state: "completed", observation: { target: { id: "window-calculator" } } },
    });

    // That screenshot is the full frame a zoom without a target is measured on.
    await observe!.execute({ region: { x: 0, y: 0, width: 100, height: 100 } }, context());
    expect(captures[1]).toEqual({
      targetId: "window-calculator",
      options: {
        region: { x: 0, y: 0, width: 100, height: 100 },
        regionFrame: { width: 640, height: 400 },
      },
    });

    // A launch that cannot run says why on the opened computer, not as an error.
    launchFails = true;
    const failed = await open!.execute(
      { computerSessionId, applicationId: "com.apple.calculator" },
      context(),
    );
    expect(failed.isError).toBeFalsy();
    expect(failed.structuredContent).toMatchObject({ session: { id: computerSessionId } });
    expect(failed.structuredContent).not.toHaveProperty("launch");
    expect(failed.content[1]).toEqual({
      type: "text",
      text: "The computer opened, but com.apple.calculator could not be launched: This Mac is locked. Unlock it to use desktop capture.",
    });
  });

  test("finds an app's open window on each platform's target shape", () => {
    const target = (fields: Partial<ComputerTarget>): ComputerTarget => ({
      ...computerTarget(),
      focused: false,
      ...fields,
    });
    const screen = target({ id: "screen-1", kind: "screen", applicationId: null, title: "Screen" });
    // macOS: windows carry the app's bundle ID.
    const calculator = target({ id: "mac-window", applicationId: "com.apple.calculator" });
    expect(openComputerAppWindow([screen, calculator], "com.apple.Calculator")?.id).toBe(
      "mac-window",
    );
    expect(openComputerAppWindow([screen, calculator], "Calculator")?.id).toBe("mac-window");
    // Reverse-DNS IDs name the same app only in full.
    expect(openComputerAppWindow([screen, calculator], "com.example.calculator")).toBeNull();
    // Windows (CUA): the window names its process's executable.
    const notepad = target({
      id: "win-notepad",
      applicationId: "Notepad.exe",
      title: "Untitled - Notepad",
    });
    const calc = target({
      id: "win-calc",
      applicationId: "CalculatorApp.exe",
      title: "Calculator",
      processId: 7,
    });
    for (const id of ["notepad", "Notepad.exe", "C:\\Windows\\System32\\notepad.exe"])
      expect(openComputerAppWindow([screen, notepad, calc], id)?.id).toBe("win-notepad");
    expect(
      openComputerAppWindow(
        [screen, notepad, calc],
        "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
      ),
    ).toBeNull();
    // A window with an identity is never matched by its title.
    expect(openComputerAppWindow([screen, notepad, calc], "calculator")).toBeNull();
    expect(openComputerAppWindow([screen, notepad, calc], "calculatorapp")?.id).toBe("win-calc");
    // A window with no identity is matched only by the app's name as its
    // title, or its title's last part.
    const untitled = target({ id: "win-untitled", applicationId: null, title: "Calculator" });
    expect(openComputerAppWindow([screen, untitled], "calculator")?.id).toBe("win-untitled");
    const page = target({ id: "page", applicationId: null, title: "Calculator help - Browser" });
    expect(openComputerAppWindow([screen, page], "calculator")).toBeNull();
    // Linux (AT-SPI): an app target names the app; its windows share its process.
    const geditApp = target({
      id: "app-gedit",
      kind: "app",
      applicationId: null,
      title: "gedit",
      processId: 51,
    });
    const geditWindow = target({
      id: "linux-window",
      applicationId: null,
      title: "notes.txt (~/Documents)",
      processId: 51,
    });
    expect(openComputerAppWindow([screen, geditApp, geditWindow], "org.gnome.gedit")?.id).toBe(
      "linux-window",
    );
    expect(openComputerAppWindow([screen, geditApp, geditWindow], "gedit.desktop")?.id).toBe(
      "linux-window",
    );
    // Linux (CUA): the window names its window class.
    const cuaGedit = target({
      id: "cua-gedit",
      applicationId: "Gedit",
      title: "Untitled Document 1 - gedit",
    });
    expect(openComputerAppWindow([screen, cuaGedit], "gedit")?.id).toBe("cua-gedit");
    expect(openComputerAppWindow([screen, cuaGedit], "org.gnome.gedit")?.id).toBe("cua-gedit");
    const textEditor = target({ id: "cua-text", applicationId: "org.gnome.TextEditor" });
    expect(openComputerAppWindow([screen, textEditor], "org.gnome.TextEditor")?.id).toBe(
      "cua-text",
    );
    expect(openComputerAppWindow([screen, textEditor], "org.kde.TextEditor")).toBeNull();
    // A window of another app is never matched by its title, nor an unreadable one.
    const other = target({ id: "other", applicationId: "com.example.editor", title: "Notepad" });
    expect(openComputerAppWindow([screen, other], "notepad")).toBeNull();
    const away = target({ id: "away", applicationId: "com.apple.calculator", offScreen: true });
    expect(openComputerAppWindow([screen, away], "com.apple.calculator")).toBeNull();
    // The window used last wins over the focused one.
    const front = target({ id: "front", applicationId: "com.apple.calculator", focused: true });
    const last = target({ id: "last", applicationId: "com.apple.calculator", current: true });
    expect(openComputerAppWindow([front, last], "com.apple.calculator")?.id).toBe("last");
    expect(openComputerAppWindow([screen, notepad], "TextEdit")).toBeNull();
  });

  test("computer_open with applicationId observes an already-open window instead of launching another copy", async () => {
    const screen: ComputerTarget = {
      ...computerTarget(),
      id: "screen-1",
      kind: "screen",
      applicationId: null,
    };
    const notepad: ComputerTarget = {
      ...computerTarget(),
      id: "cua:window:7:1",
      applicationId: null,
      title: "Untitled - Notepad",
      focused: false,
    };
    let session = activeComputerSession();
    const launches: ComputerActionRequest[] = [];
    const observed: string[] = [];
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        getComputerSession: async () => session,
        listComputerTargets: async () => ({
          computerSessionId,
          controllerGeneration: "controller-1",
          targets: [screen, notepad],
        }),
        observeComputerTarget: async (_w, _s, targetId) => {
          observed.push(targetId);
          return computerObservation(targetId === notepad.id ? notepad : screen);
        },
        captureComputerTarget: async (_w, _s, targetId) => ({
          frameId: "frame-1",
          computerSessionId,
          controllerGeneration: "controller-1",
          targetId,
          targetGeneration: notepad.targetGeneration,
          sequence: 0,
          mediaType: "image/jpeg" as const,
          width: 640,
          height: 400,
          capturedAt: now,
          sha256: "0".repeat(64),
          data: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
        }),
        actInComputer: async (_w, _s, value) => {
          launches.push(value);
          return computerReceipt(value.operationId, computerObservation(notepad));
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_open", "computer_observe"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const context = () => ({
      operationId: randomUUID(),
      caller: { kind: "model" as const, subjectId: "model:test" },
    });
    const result = await definitions[0]!.execute(
      { computerSessionId, applicationId: "notepad.exe" },
      context(),
    );
    expect(launches).toHaveLength(0);
    expect(observed).toEqual([notepad.id]);
    expect(result.structuredContent).toMatchObject({ existing: { target: { id: notepad.id } } });
    expect(result.structuredContent).not.toHaveProperty("launch");
    expect((result.content[0] as { text: string }).text).toContain(
      `Not launched: the app is already open in ${notepad.id}; act on that target with the observation below.`,
    );
    // The open window is the current target for the next read.
    await definitions[1]!.execute({}, context());
    expect(observed.at(-1)).toBe(notepad.id);

    // A macOS launch finds the running app itself, so no window is guessed.
    session = { ...session, platform: "macos" };
    observed.length = 0;
    const mac = await definitions[0]!.execute(
      { computerSessionId, applicationId: "notepad.exe" },
      context(),
    );
    expect(launches).toHaveLength(1);
    expect(observed).toEqual([]);
    expect(mac.structuredContent).toMatchObject({ launch: { state: "completed" } });
    expect(mac.structuredContent).not.toHaveProperty("existing");
  });

  test("computer_open never reports a launch that ran, or may have run, as failed", async () => {
    const screen: ComputerTarget = {
      ...computerTarget(),
      id: "screen-1",
      kind: "screen",
      applicationId: null,
    };
    const appWindow: ComputerTarget = {
      ...computerTarget(),
      id: "window-app",
      applicationId: "com.example.app",
    };
    const session = activeComputerSession();
    let act: () => Promise<ComputerActionReceipt> = async () => {
      throw new Error("unset");
    };
    let recorded: () => Promise<ComputerActionReceipt> = async () => {
      throw new OpenGeniApiError(404, "Not found");
    };
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        getComputerSession: async () => session,
        listComputerTargets: async () => ({
          computerSessionId,
          controllerGeneration: "controller-1",
          targets: [screen],
        }),
        actInComputer: async () => await act(),
        getComputerActionReceipt: async () => await recorded(),
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_open"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const open = async () =>
      await definitions[0]!.execute(
        { computerSessionId, applicationId: "com.example.app" },
        { operationId: randomUUID(), caller: { kind: "model" as const, subjectId: "model:test" } },
      );
    const unknownNote =
      "The computer opened, but the launch of com.example.app has no known outcome: it may have started. Check computer_targets for its window before launching it again.";

    // A retry whose fence changed is refused; the first try's receipt answers.
    act = async () => {
      throw new OpenGeniApiError(409, "operation ID reused with another request", {
        code: "operation_conflict",
      });
    };
    recorded = async () => computerReceipt(randomUUID(), computerObservation(appWindow));
    const retried = await open();
    expect(retried.isError).toBeFalsy();
    expect(retried.structuredContent).toMatchObject({
      launch: { state: "completed", observation: { target: { id: "window-app" } } },
    });
    expect(retried.content).toHaveLength(1);

    // A lost reply with nothing recorded may still have launched the app.
    act = async () => {
      throw new OpenGeniApiError(504, "Gateway timeout", { outcomeUnknown: true });
    };
    recorded = async () => {
      throw new OpenGeniApiError(404, "Not found");
    };
    const lost = await open();
    expect(lost.isError).toBeFalsy();
    expect((lost.content[1] as { text: string }).text.startsWith(unknownNote)).toBe(true);

    // So may a launch the computer itself reports with an unknown outcome.
    act = async () => ({
      ...computerReceipt(randomUUID(), computerObservation(screen)),
      state: "outcome_unknown",
      observation: null,
      error: { code: "outcome_unknown", message: "The action timed out", retryable: false },
    });
    const timedOut = await open();
    expect(timedOut.content[1]).toEqual({ type: "text", text: unknownNote });

    // A launch that completed but read no window says the app started.
    act = async () => ({
      ...computerReceipt(randomUUID(), computerObservation(screen)),
      observation: null,
    });
    const unread = await open();
    expect(unread.content[1]).toEqual({
      type: "text",
      text: "The computer opened and com.example.app started, but its window could not be read. Check computer_targets for its window.",
    });

    // A definite refusal still says it could not launch.
    act = async () => {
      throw new OpenGeniApiError(422, "no installed application has bundle id com.example.app");
    };
    const refused = await open();
    expect((refused.content[1] as { text: string }).text).toContain(
      "The computer opened, but com.example.app could not be launched:",
    );
  });

  test("an action naming its observation is fenced from the target list without a re-read", async () => {
    const target = computerTarget();
    const observation = computerObservation(target);
    const requests: ComputerActionRequest[] = [];
    let observed = 0;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listComputerTargets: async () => ({ computerSessionId, targets: [target] }),
        observeComputerTarget: async () => {
          observed += 1;
          return observation;
        },
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          requests.push(value);
          return computerReceipt(value.operationId, observation);
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const environment = createAttemptToolEnvironment({
      scope: { accountId, workspaceId, sessionId, turnId, attemptId, executionGeneration: 7 },
      generation: 3,
      definitions,
    });
    const act = async (fences: Record<string, unknown>) =>
      await environment.callModel({
        operationId: randomUUID(),
        modelName: "interaction__computer_act",
        subjectId: "model:test",
        arguments: {
          computerSessionId,
          targetId: target.id,
          ...fences,
          action: { type: "semantic", locator: { kind: "ref", ref: "e1" }, action: "invoke" },
        },
      });
    // Reading the window again would retire the ref the caller holds.
    await act({ expectedObservationId: observation.observationId });
    expect(observed).toBe(0);
    expect(requests[0]).toMatchObject({
      expectedTargetGeneration: target.targetGeneration,
      expectedObservationId: observation.observationId,
    });
    // With no fences at all, the current observation supplies them.
    await act({});
    expect(observed).toBe(1);
    expect(requests[1]).toMatchObject({ expectedObservationId: observation.observationId });
  });

  test("reads only the exact ComputerSession native clipboard", async () => {
    const clipboard = {
      computerSessionId,
      controllerGeneration: "controller-1",
      text: "native clipboard",
      truncated: false,
      observedAt: now,
    };
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        readComputerClipboard: async () => clipboard,
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_clipboard"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      { computerSessionId },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );

    expect(definitions[0]).toMatchObject({
      codemodePath: ["interaction", "computer", "clipboard"],
      annotations: { readOnlyHint: true, idempotentHint: true },
    });
    expect(result.structuredContent).toEqual(clipboard);
  });

  test("updates a BrowserIdentity through the shared durable operation", async () => {
    const identityId = randomUUID();
    const operationId = randomUUID();
    let received:
      | { workspaceId: string; identityId: string; request: Record<string, unknown> }
      | undefined;
    const identity = {
      id: identityId,
      accountId,
      workspaceId,
      name: "Work",
      status: "archived" as const,
      version: 8,
      defaultRevisionId: null,
      headGeneration: 0,
      revisionCount: 0,
      createdBySubjectId: "user:test",
      createdAt: now,
      updatedAt: now,
    };
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        updateBrowserIdentity: async (receivedWorkspaceId, receivedIdentityId, request) => {
          received = {
            workspaceId: receivedWorkspaceId,
            identityId: receivedIdentityId,
            request,
          };
          return { identity, operationId: request.operationId, replayed: false };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_identity"],
      permissions: ["sessions:control"],
    });

    const result = await definitions[0]!.execute(
      { operation: "update", identityId, expectedVersion: 7, status: "archived" },
      { operationId, caller: { kind: "model", subjectId: "model:test" } },
    );

    expect(received).toEqual({
      workspaceId,
      identityId,
      request: { operationId, expectedVersion: 7, status: "archived" },
    });
    expect(result.structuredContent).toEqual({
      operation: "update",
      result: { identity, operationId, replayed: false },
    });
  });

  test("routes browser auth discovery through the canonical typed transport", async () => {
    let includeArchived: boolean | undefined;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        listSiteAuthConnections: async (_workspaceId, options) => {
          includeArchived = options?.includeArchived;
          return { revision: 7, connections: [] };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_auth"],
      permissions: ["sessions:control"],
    });
    const result = await definitions[0]!.execute(
      { operation: "list_connections", includeArchived: true },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );

    expect(includeArchived).toBe(true);
    expect(result.structuredContent).toEqual({
      operation: "list_connections",
      result: { revision: 7, connections: [] },
    });
  });

  test("advances provider-managed auth without exposing the hosted login URL", async () => {
    const run = externalAuthRun();
    let received:
      | { workspaceId: string; browserSessionId: string; authRunId: string; request: unknown }
      | undefined;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        advanceExternalBrowserAuthRun: async (
          receivedWorkspaceId,
          receivedBrowserSessionId,
          authRunId,
          request,
        ) => {
          received = {
            workspaceId: receivedWorkspaceId,
            browserSessionId: receivedBrowserSessionId,
            authRunId,
            request,
          };
          return {
            run,
            status: "needs_human",
            operationId: request.operationId,
            replayed: false,
          };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_auth"],
      permissions: ["sessions:control"],
    });
    const operationId = randomUUID();
    const result = await definitions[0]!.execute(
      {
        operation: "advance_external",
        browserSessionId,
        authRunId: run.id,
        expectedVersion: 2,
        action: "poll",
      },
      { operationId, caller: { kind: "model", subjectId: "model:test" } },
    );

    expect(received).toEqual({
      workspaceId,
      browserSessionId,
      authRunId: run.id,
      request: { operationId, expectedVersion: 2, action: "poll" },
    });
    expect(result.structuredContent).toEqual({
      operation: "advance_external",
      result: { run, status: "needs_human", operationId, replayed: false },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("hosted");
  });

  test("resumes the exact human interaction with a fresh target observation", async () => {
    const target = browserTarget();
    const observation = browserObservation(target);
    const intervention = completedBrowserIntervention(target);
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({ observeBrowserTarget: async () => observation }),
      workspaceId,
      sessionId,
      selectedTools: ["interaction_request_human"],
      permissions: ["sessions:control"],
      interventionResume: { toolCallId: "interaction-human-call", intervention },
    });
    expect(definitions[0]).toMatchObject({
      modelName: "interaction__interaction_request_human",
      codemodePath: ["interaction", "requestHuman"],
      approval: "human",
    });
    const result = await definitions[0]!.execute(
      { operation: "wait", interventionId: intervention.id },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );

    expect(result.structuredContent).toEqual({
      intervention,
      observation,
      observationErrorCode: null,
    });
  });

  test("uses the pointer action's exact frame instead of silently changing its authority", async () => {
    const target = computerTarget();
    const observation = computerObservation(target);
    let request: ComputerActionRequest | null = null;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeComputerTarget: async () => observation,
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          request = value;
          return computerReceipt(value.operationId, observation);
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    await definitions[0]!.execute(
      {
        computerSessionId,
        targetId: target.id,
        action: {
          type: "pointer",
          frameId: "frame-user-saw",
          action: "click",
          x: 10,
          y: 20,
        },
      },
      {
        operationId: randomUUID(),
        caller: { kind: "model", subjectId: "model:test" },
      },
    );

    expect(request).toMatchObject({ expectedFrameId: "frame-user-saw" });
  });

  test("preserves an explicitly fenced pointer frame without refreshing the observation", async () => {
    const target = computerTarget();
    const observation = computerObservation(target);
    let request: ComputerActionRequest | null = null;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeComputerTarget: async () => {
          throw new Error("explicit Computer fences must not trigger a fresh observation");
        },
        actInComputer: async (_workspaceId, _computerSessionId, value) => {
          request = value;
          return computerReceipt(value.operationId, observation);
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    });
    const result = await definitions[0]!.execute(
      {
        computerSessionId,
        targetId: target.id,
        expectedTargetGeneration: target.targetGeneration,
        action: { type: "pointer", frameId: "frame-user-saw", action: "click", x: 10, y: 20 },
      },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );

    expect(request).toMatchObject({
      expectedTargetGeneration: target.targetGeneration,
      expectedObservationId: null,
      expectedFrameId: "frame-user-saw",
    });
    expect(result.isError).not.toBe(true);
  });

  test("returns managed computer pixels as native image content", async () => {
    const target = computerTarget();
    const observation = computerObservation(target);
    const image = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeComputerTarget: async () => observation,
        captureComputerTarget: async () => ({
          frameId: "captured-frame",
          computerSessionId,
          controllerGeneration: target.controllerGeneration,
          targetId: target.id,
          targetGeneration: target.targetGeneration,
          sequence: 0,
          mediaType: "image/jpeg",
          width: 1024,
          height: 640,
          capturedAt: now,
          sha256: "0".repeat(64),
          data: image,
        }),
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_observe"],
      permissions: ["sessions:read"],
    });
    expect(definitions[0]!.outputSchema).toMatchObject({
      type: "object",
      properties: { capturedFrame: { type: "object" } },
    });
    const result = await definitions[0]!.execute(
      { computerSessionId, targetId: target.id },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );

    const capturedFrame = { width: 1024, height: 640 };
    expect(result.structuredContent).toMatchObject({ frameId: "captured-frame", capturedFrame });
    expect(result.content).toEqual([
      {
        type: "text",
        text: computerObservationText({ ...observation, frameId: "captured-frame", capturedFrame }),
      },
      { type: "image", data: Buffer.from(image).toString("base64"), mimeType: "image/jpeg" },
    ]);
  });

  test("zooms into a region of the window as its own pointer frame", async () => {
    const target = computerTarget();
    const observation = computerObservation(target);
    const image = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
    const captures: unknown[] = [];
    const zoomedFrameId = "native-frame:zoom.1600.0.960.1410.760.1116";
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeComputerTarget: async () => ({ ...observation, observationId: randomUUID() }),
        captureComputerTarget: async (_workspaceId, _computerSessionId, _targetId, _o, options) => {
          captures.push(options);
          return {
            frameId: options?.region ? zoomedFrameId : "regular-frame",
            computerSessionId,
            controllerGeneration: target.controllerGeneration,
            targetId: target.id,
            targetGeneration: target.targetGeneration,
            sequence: 0,
            mediaType: "image/jpeg" as const,
            width: options?.region ? 760 : 1024,
            height: options?.region ? 1116 : 564,
            capturedAt: now,
            sha256: "0".repeat(64),
            ...(options?.region
              ? {
                  region: { x: 640, y: 0, width: 384, height: 564 },
                  regionFrame: { width: 1024, height: 564 },
                }
              : {}),
            data: image,
          };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_observe"],
      permissions: ["sessions:read"],
    });
    const observe = definitions[0]!;
    const model = { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } };
    await observe.execute({ computerSessionId, targetId: target.id }, model as never);
    const zoomed = await observe.execute(
      { computerSessionId, targetId: target.id, region: { x: 640, y: 0, width: 384, height: 564 } },
      { ...model, operationId: randomUUID() } as never,
    );
    // The region is measured on the last full screenshot this attempt saw.
    expect(captures).toEqual([
      {},
      {
        region: { x: 640, y: 0, width: 384, height: 564 },
        regionFrame: { width: 1024, height: 564 },
      },
    ]);
    expect(zoomed.structuredContent).toMatchObject({
      frameId: zoomedFrameId,
      capturedFrame: {
        width: 760,
        height: 1116,
        region: { x: 640, y: 0, width: 384, height: 564 },
        regionFrame: { width: 1024, height: 564 },
      },
    });
    const text = (zoomed.content[0] as { text: string }).text;
    expect(text).toContain(
      `Zoomed screenshot 760x1116 pixels of the 1024x564 screenshot's region at 640,0 size 384x564 (2x); pointer x,y on frame ${zoomedFrameId} use these zoomed pixels.`,
    );
    // The elements were just read: the zoom lists only what changed.
    expect(text).toContain("No element changed since");
    expect(
      (observe.inputSchema as { properties: Record<string, unknown> }).properties,
    ).toHaveProperty("region");
  });

  test("says so when a server without zoom returns the full screenshot", async () => {
    const target = computerTarget();
    const observation = computerObservation(target);
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeComputerTarget: async () => ({ ...observation, observationId: randomUUID() }),
        captureComputerTarget: async () => ({
          frameId: "regular-frame",
          computerSessionId,
          controllerGeneration: target.controllerGeneration,
          targetId: target.id,
          targetGeneration: target.targetGeneration,
          sequence: 0,
          mediaType: "image/jpeg" as const,
          width: 640,
          height: 352,
          capturedAt: now,
          sha256: "0".repeat(64),
          data: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
        }),
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_observe"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      { computerSessionId, targetId: target.id, region: { x: 0, y: 0, width: 100, height: 100 } },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } } as never,
    );
    expect(result.structuredContent).toMatchObject({
      frameId: "regular-frame",
      capturedFrame: { width: 640, height: 352 },
    });
    expect((result.content[0] as { text: string }).text).toContain(
      "Screenshot 640x352 pixels; pointer x,y use these pixels.",
    );
    expect(result.content[1]).toEqual({
      type: "text",
      text: "Not zoomed: this Opengeni server does not support region, so this is the full screenshot of the target.",
    });
    expect(result.content[2]).toMatchObject({ type: "image" });
  });

  test("computer_open returns the screen's screenshot in the same call when includeScreenshot is set", async () => {
    const session: ComputerSession = {
      ...discoveredComputerSession(computerSessionId, sessionId),
      lifecycle: "active",
      controller: {
        controllerId: "synthetic-controller",
        controllerGeneration: "controller-1",
        placementInstanceId: "placement-1",
      },
      platform: "windows",
      adapter: "opengeni.windows.test.v1",
      seatId: "seat-1",
      displayId: "display-1",
      capabilities: {
        semanticObservation: true,
        appDiscovery: true,
        appLaunch: true,
        windowCapture: true,
        screenCapture: true,
        semanticActions: true,
        pointerInput: true,
        keyboardInput: true,
        clipboard: true,
        backgroundActions: true,
        parallelApps: true,
      },
    };
    const window = computerTarget();
    const screen: ComputerTarget = { ...computerTarget(), id: "screen-1", kind: "screen" };
    const image = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
    const captures: string[] = [];
    let captureFails = false;
    let targets: ComputerTarget[] = [window, screen];
    let frameGeneration: string | null = null;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        getComputerSession: async () => session,
        listComputerTargets: async () => ({
          computerSessionId,
          controllerGeneration: "controller-1",
          targets,
        }),
        captureComputerTarget: async (_workspaceId, capturedSessionId, targetId) => {
          captures.push(`${capturedSessionId}:${targetId}`);
          if (captureFails) throw new Error("synthetic capture failure");
          return {
            frameId: "open-frame",
            computerSessionId,
            controllerGeneration: "controller-1",
            targetId,
            targetGeneration:
              frameGeneration ?? targets.find((target) => target.id === targetId)!.targetGeneration,
            sequence: 0,
            mediaType: "image/jpeg",
            width: 1024,
            height: 640,
            capturedAt: now,
            sha256: "0".repeat(64),
            data: image,
          };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_open"],
      permissions: ["sessions:control"],
    });
    const context = () => ({
      operationId: randomUUID(),
      caller: { kind: "model" as const, subjectId: "model:test" },
    });

    const plain = await definitions[0]!.execute({ computerSessionId }, context());
    expect(plain.content).toHaveLength(1);
    expect(captures).toEqual([]);

    const visual = await definitions[0]!.execute(
      { computerSessionId, includeScreenshot: true },
      context(),
    );
    // The screen is captured, not the first-listed window.
    expect(captures).toEqual([`${computerSessionId}:screen-1`]);
    expect(visual.isError).toBeFalsy();
    expect(visual.structuredContent).toMatchObject({ session: { id: computerSessionId } });
    expect(visual.content).toEqual([
      plain.content[0],
      {
        type: "text",
        text: "Screenshot of screen-1: frameId open-frame, 1024x640 pixels; use these pixels for pointer coordinates.",
      },
      { type: "image", data: Buffer.from(image).toString("base64"), mimeType: "image/jpeg" },
    ]);

    // A failed capture keeps the opened computer's result and says why.
    captureFails = true;
    const failed = await definitions[0]!.execute(
      { computerSessionId, includeScreenshot: true },
      context(),
    );
    expect(failed.isError).toBeFalsy();
    expect(failed.content).toEqual([
      plain.content[0],
      {
        type: "text",
        text: "The computer opened, but its screenshot could not be captured: synthetic capture failure",
      },
    ]);
    captureFails = false;

    // Pixels of a screen that changed since it was listed are not returned.
    frameGeneration = "target-3";
    const changed = await definitions[0]!.execute(
      { computerSessionId, includeScreenshot: true },
      context(),
    );
    expect(changed.isError).toBeFalsy();
    expect(changed.content).toEqual([
      plain.content[0],
      {
        type: "text",
        text: "The computer opened, but its screen changed while it was captured; observe it for a current screenshot.",
      },
    ]);
    frameGeneration = null;

    // With several screens, the one showing the focused window is captured,
    // and the screen the computer works in comes before it.
    const left: ComputerTarget = {
      ...screen,
      id: "screen-left",
      focused: false,
      bounds: { x: 0, y: 0, width: 1024, height: 640 },
    };
    const right: ComputerTarget = {
      ...left,
      id: "screen-right",
      bounds: { x: 1024, y: 0, width: 1024, height: 640 },
    };
    const shown = { ...window, bounds: { x: 1200, y: 100, width: 400, height: 300 } };
    for (const [listed, expected] of [
      [[shown, left, right], "screen-right"],
      [[shown, { ...left, current: true as const }, right], "screen-left"],
    ] as const) {
      targets = [...listed];
      captures.length = 0;
      await definitions[0]!.execute({ computerSessionId, includeScreenshot: true }, context());
      expect(captures).toEqual([`${computerSessionId}:${expected}`]);
    }
  });

  test("observes an app target from its tree when it has no screenshot", async () => {
    const target: ComputerTarget = { ...computerTarget(), id: "app-1", kind: "app" };
    const observation = { ...computerObservation(target), frameId: null };
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeComputerTarget: async () => observation,
        captureComputerTarget: async () => {
          throw new Error("window capture is not available");
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_observe"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      { computerSessionId, targetId: target.id },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).not.toHaveProperty("capturedFrame");
    expect(result.content).toEqual([
      {
        type: "text",
        text: `${computerObservationText(observation)}\nNo screenshot of an app target; observe one of its windows or the screen for pixels.`,
      },
    ]);
  });

  test("still fails a window observation whose screenshot cannot be captured", async () => {
    const target = computerTarget();
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeComputerTarget: async () => computerObservation(target),
        captureComputerTarget: async () => {
          throw new Error("window capture is not available");
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["computer_observe"],
      permissions: ["sessions:read"],
    });
    await expect(
      definitions[0]!.execute(
        { computerSessionId, targetId: target.id },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      ),
    ).rejects.toThrow("window capture is not available");
  });

  test("returns browser pixels only when a still image is requested", async () => {
    const target = browserTarget();
    const observation = browserObservation(target);
    const image = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
    let captures = 0;
    let visual = false;
    let releaseObservation: ((value: typeof observation) => void) | undefined;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeBrowserTarget: async () =>
          visual
            ? await new Promise<typeof observation>((resolve) => {
                releaseObservation = resolve;
              })
            : observation,
        captureBrowserTarget: async () => {
          captures += 1;
          // The capture must start before the pending page read completes.
          expect(releaseObservation).toBeDefined();
          releaseObservation!(observation);
          return {
            frameId: "captured-browser-frame",
            browserSessionId,
            controllerGeneration: target.controllerGeneration,
            targetId: target.id,
            targetGeneration: target.targetGeneration,
            documentGeneration: target.documentGeneration!,
            sequence: 1,
            mediaType: "image/jpeg",
            width: 1,
            height: 1,
            deviceScaleFactor: 1,
            scrollX: 0,
            scrollY: 0,
            capturedAt: now,
            data: image,
          };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read"],
    });
    const context = {
      operationId: randomUUID(),
      caller: { kind: "model" as const, subjectId: "model:test" },
    };
    const semantic = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id },
      context,
    );
    expect(captures).toBe(0);
    expect(semantic.content).toHaveLength(1);
    visual = true;
    const visualResult = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id, includeScreenshot: true },
      context,
    );
    expect(captures).toBe(1);
    expect(visualResult.content).toHaveLength(2);
    const [visualText, visualImage] = visualResult.content;
    expect(visualText).toMatchObject({ type: "text" });
    expect((visualText as { text: string }).text.startsWith(`Tab ${target.id}`)).toBe(true);
    expect(visualImage).toEqual({
      type: "image",
      data: Buffer.from(image).toString("base64"),
      mimeType: "image/jpeg",
    });
    expect(visualResult.structuredContent).toMatchObject({
      agentView: { sourceKind: "snapshot", nodes: [] },
    });
    expect(visualResult.structuredContent).not.toHaveProperty("semantic");
    expect((visualResult.structuredContent as { agentView: object }).agentView).not.toHaveProperty(
      "omittedNodeCount",
    );
  });

  test("a failed page read waits for the parallel capture to settle", async () => {
    const started = Promise.withResolvers<void>();
    const capture =
      Promise.withResolvers<Awaited<ReturnType<InteractionTransport["captureBrowserTarget"]>>>();
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeBrowserTarget: async () => {
          throw new Error("synthetic page failure");
        },
        captureBrowserTarget: async () => {
          started.resolve();
          return await capture.promise;
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read"],
    });
    let settled = false;
    const pending = definitions[0]!.execute(
      { browserSessionId, targetId: "tab", includeScreenshot: true },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await started.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    capture.reject(new Error("synthetic capture failure"));
    await expect(pending).rejects.toThrow("synthetic page failure");
    expect(settled).toBe(true);
  });

  test("a synchronous capture refusal still settles the outstanding page read", async () => {
    const target = browserTarget();
    const observed = Promise.withResolvers<BrowserObservation>();
    const started = Promise.withResolvers<void>();
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeBrowserTarget: () => observed.promise,
        captureBrowserTarget: () => {
          started.resolve();
          throw new Error("synthetic synchronous capture refusal");
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read"],
    });
    let settled = false;
    const pending = definitions[0]!.execute(
      { browserSessionId, targetId: target.id, includeScreenshot: true },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await started.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    observed.resolve(browserObservation(target));
    await expect(pending).rejects.toThrow("synthetic synchronous capture refusal");
    expect(settled).toBe(true);
  });

  test.each([true, false])(
    "parallel visual reads retain generation reconciliation (stable=%s)",
    async (stable) => {
      const target = browserTarget();
      let reads = 0;
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          observeBrowserTarget: async () => {
            reads++;
            return browserObservation({
              ...target,
              documentGeneration: reads === 1 ? "before" : stable ? "captured" : "after",
            });
          },
          captureBrowserTarget: async () => ({
            frameId: "captured-frame",
            browserSessionId,
            controllerGeneration: target.controllerGeneration,
            targetId: target.id,
            targetGeneration: target.targetGeneration,
            documentGeneration: "captured",
            sequence: 1,
            mediaType: "image/jpeg",
            width: 1,
            height: 1,
            deviceScaleFactor: 1,
            scrollX: 0,
            scrollY: 0,
            capturedAt: now,
            data: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
          }),
        }),
        workspaceId,
        sessionId,
        selectedTools: ["browser_observe"],
        permissions: ["sessions:read"],
      });
      const pending = definitions[0]!.execute(
        { browserSessionId, targetId: target.id, includeScreenshot: true },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      if (stable)
        expect((await pending).structuredContent).toMatchObject({
          target: { documentGeneration: "captured" },
        });
      else await expect(pending).rejects.toThrow("browser target changed");
      expect(reads).toBe(2);
    },
  );

  test("defaults to a bounded, explicit compact browser view and preserves an exact full mode", async () => {
    const target = browserTarget();
    const observation = browserObservation(target);
    const roots = Array.from({ length: 150 }, (_, index) => ({
      ref: `element-${index}`,
      role: index === 149 ? "button" : "generic",
      name: index === 149 ? "Important action" : "x".repeat(8_000),
      states: [],
      actions: index === 149 ? ["click"] : [],
    }));
    observation.semantic = { kind: "snapshot", roots, nodeCount: roots.length };
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({ observeBrowserTarget: async () => observation }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read"],
    });
    const context = {
      operationId: randomUUID(),
      caller: { kind: "model" as const, subjectId: "model:test" },
    };
    const compact = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id },
      context,
    );
    expect(compact.structuredContent).toMatchObject({
      target: { targetGeneration: target.targetGeneration },
      frameId: observation.frameId,
      agentView: { sourceKind: "snapshot" },
    });
    const agentView = (
      compact.structuredContent as {
        agentView: {
          nodes: Array<{ ref: string }>;
          omittedNodeCount: number;
          clippedFieldCount: number;
        };
      }
    ).agentView;
    expect(agentView.nodes.some((node) => node.ref === "element-149")).toBe(true);
    expect(agentView.nodes.length).toBeLessThanOrEqual(60);
    expect(agentView.omittedNodeCount).toBe(150 - agentView.nodes.length);
    expect(agentView.clippedFieldCount).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(compact.structuredContent))).toBeLessThan(17_000);
    const again = await definitions[0]!.execute({ browserSessionId, targetId: target.id }, context);
    expect(again.structuredContent).toEqual(compact.structuredContent);
    const full = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id, view: "full" },
      context,
    );
    expect(full.structuredContent).toEqual(observation);
  });

  test("compact view folds redundant nodes and leaves out default fields", async () => {
    const target = browserTarget();
    const observation = browserObservation(target);
    observation.viewport = {
      width: 1280,
      height: 800,
      visualWidth: 1280,
      visualHeight: 800,
      deviceScaleFactor: 1,
      maxTouchPoints: 0,
    };
    const node = (
      ref: string,
      role: string,
      extra: { name?: string; actions?: string[]; children?: unknown[] } = {},
    ) => ({ ref, role, states: [], actions: [], ...extra });
    const roots = [
      node("main", "main", {
        children: [
          node("wrapper", "generic", {
            children: [
              node("submit", "button", {
                name: "Submit",
                actions: ["click"],
                children: [node("submit-text", "text", { name: "Submit" })],
              }),
              node("title", "heading", {
                name: "Title",
                children: [node("title-text", "text", { name: "Title" })],
              }),
              node("hello", "text", { name: "Hello" }),
            ],
          }),
        ],
      }),
    ];
    observation.semantic = { kind: "snapshot", roots: roots as never, nodeCount: 7 };
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({ observeBrowserTarget: async () => observation }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(result.structuredContent).toEqual({
      target: agentTarget(target),
      frameId: observation.frameId,
      viewport: { width: 1280, height: 800 },
      agentView: {
        sourceKind: "snapshot",
        nodes: [
          { ref: "main", role: "main", depth: 0 },
          { ref: "submit", role: "button", depth: 2, name: "Submit", actions: ["click"] },
          { ref: "title", role: "heading", depth: 2, name: "Title" },
          { ref: "hello", role: "text", depth: 2, name: "Hello" },
        ],
      },
    });
  });

  test("compact view leads with an opened menu, live messages and the focus group on a dense page", async () => {
    const target = browserTarget();
    const observation = browserObservation(target);
    const node = (
      ref: string,
      role: string,
      extra: { name?: string; actions?: string[]; states?: string[]; children?: unknown[] } = {},
    ) => ({ ref, role, states: [], actions: [], ...extra });
    const navigation = node("nav", "navigation", {
      name: "Site",
      children: Array.from({ length: 30 }, (_, index) =>
        node(`nav-${index}`, "link", { name: `Section ${index}`, actions: ["click"] }),
      ),
    });
    const rows = Array.from({ length: 400 }, (_, index) =>
      node(`row-${index}`, "row", {
        children: [
          node(`row-${index}-edit`, "button", { name: `Edit row ${index}`, actions: ["click"] }),
          node(`row-${index}-qty`, "button", { name: `${index} m`, actions: ["click"] }),
        ],
      }),
    );
    const inspector = node("inspector", "group", {
      name: "Row",
      children: [
        node("total", "text", { name: "Total 2 091 kr" }),
        node("more", "button", {
          name: "More",
          actions: ["click"],
          states: ["focused", "expanded", "hasPopup=menu"],
        }),
      ],
    });
    const roots = [
      node("document", "document", {
        name: "Calculation",
        children: [
          navigation,
          node("main", "main", { children: [node("grid", "grid", { children: rows }), inspector] }),
          node("empty-status", "status", { states: ["live=polite"] }),
          node("toast", "status", {
            states: ["live=polite"],
            children: [node("toast-text", "text", { name: "Row added" })],
          }),
          node("menu", "menu", {
            name: "More",
            children: [
              node("menu-open", "menuitem", { name: "Open tariff choices", actions: ["click"] }),
              node("menu-delete", "menuitem", { name: "Delete", actions: ["click"] }),
            ],
          }),
        ],
      }),
    ];
    observation.semantic = { kind: "snapshot", roots: roots as never, nodeCount: 900 };
    observation.focusedRef = "more";
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({ observeBrowserTarget: async () => observation }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    const view = (
      result.structuredContent as {
        agentView: {
          nodes: Array<{ ref: string }>;
          omittedNodeCount: number;
          omittedRegions: Array<{ role: string; name?: string; count: number }>;
        };
      }
    ).agentView;
    const shown = new Set(view.nodes.map((entry) => entry.ref));
    for (const ref of ["menu", "menu-open", "menu-delete", "toast", "toast-text", "total", "more"])
      expect(shown.has(ref)).toBe(true);
    expect(shown.has("empty-status")).toBe(false);
    expect(shown.has("nav-0")).toBe(false);
    expect(shown.has("row-0-edit")).toBe(true);
    expect(view.omittedRegions[0]).toMatchObject({ role: "main" });
    expect(view.omittedRegions).toContainEqual({ role: "navigation", name: "Site", count: 31 });
    const text = result.content.find((entry) => entry.type === "text");
    expect(text && "text" in text ? text.text : "").toContain(
      `elements not shown: ${view.omittedRegions[0]!.count} in main, 31 in navigation "Site"`,
    );
  });

  test("keeps a dense ten-thousand-node page within the compact output budget", async () => {
    const target = browserTarget();
    const observation = browserObservation(target);
    const roots = Array.from({ length: 10_000 }, (_, index) => ({
      ref: `element-${index}`,
      role: "button",
      name: `Action ${index} ${"x".repeat(1_024)}`,
      states: [],
      actions: ["click"],
    }));
    observation.semantic = { kind: "snapshot", roots, nodeCount: roots.length };
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({ observeBrowserTarget: async () => observation }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_observe"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    const beforeBytes = Buffer.byteLength(JSON.stringify(observation));
    const afterBytes = Buffer.byteLength(JSON.stringify(result.structuredContent));
    expect(beforeBytes).toBeGreaterThan(10_000_000);
    expect(afterBytes).toBeLessThan(17_000);
    expect(beforeBytes / afterBytes).toBeGreaterThan(500);
    const denseView = (
      result.structuredContent as {
        agentView: { nodes: unknown[]; omittedNodeCount: number };
      }
    ).agentView;
    expect(denseView.omittedNodeCount).toBe(10_000 - denseView.nodes.length);
    expect(
      (result.structuredContent as { agentView: { clippedFieldCount: number } }).agentView
        .clippedFieldCount,
    ).toBeGreaterThan(0);
  });

  test("reads bounded accessibility matches, count, and a scoped subtree", async () => {
    const target = browserTarget();
    const observation = browserObservation(target);
    observation.semantic = {
      kind: "snapshot",
      roots: [
        {
          ref: "root",
          role: "main",
          states: [],
          actions: [],
          children: [
            { ref: "alpha", role: "button", name: "Save draft", states: [], actions: ["click"] },
            { ref: "beta", role: "text", name: "Saved drafts", states: [], actions: [] },
          ],
        },
        { ref: "other", role: "button", name: "Delete draft", states: [], actions: ["click"] },
      ],
      nodeCount: 4,
    };
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({ observeBrowserTarget: async () => observation }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_read"],
      permissions: ["sessions:read"],
    });
    const context = {
      operationId: randomUUID(),
      caller: { kind: "model" as const, subjectId: "model:test" },
    };
    const matches = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id, scopeRef: "root", textContains: "draft" },
      context,
    );
    expect(matches.structuredContent).toMatchObject({
      source: "accessibility",
      mode: "matches",
      scopeFound: true,
      totalMatches: 2,
      nodes: [{ ref: "alpha" }, { ref: "beta" }],
    });
    const count = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id, mode: "count", role: "button" },
      context,
    );
    expect(count.structuredContent).toMatchObject({ totalMatches: 2, nodes: [] });
    const subtree = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id, mode: "subtree", ref: "root", limit: 2 },
      context,
    );
    expect(subtree.structuredContent).toMatchObject({
      totalMatches: 3,
      omittedMatches: 1,
      nodes: [{ ref: "root" }, { ref: "alpha" }],
    });
  });

  test("reads bounded DOM text and attributes using cheap causal state, without an AX scan", async () => {
    const target = browserTarget();
    let stateCalls = 0;
    let domRequest: unknown = null;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeBrowserTarget: async () => {
          throw new Error("unexpected AX scan");
        },
        getBrowserTargetState: async () => {
          stateCalls += 1;
          return {
            browserSessionId,
            controllerGeneration: target.controllerGeneration,
            targetId: target.id,
            targetGeneration: target.targetGeneration,
            documentGeneration: target.documentGeneration,
            frameId: "frame-2",
          };
        },
        readBrowserDom: async (_workspaceId, _browserSessionId, _targetId, request) => {
          domRequest = request;
          return {
            browserSessionId,
            controllerGeneration: target.controllerGeneration,
            targetId: target.id,
            targetGeneration: target.targetGeneration,
            documentGeneration: target.documentGeneration,
            frameId: "frame-2",
            kind: "element",
            count: 1,
            text: "Email",
            value: "user@example.test",
            attributes: { placeholder: "Enter email" },
            redacted: null,
            truncated: false,
          };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_read"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      {
        browserSessionId,
        targetId: target.id,
        mode: "dom",
        dom: {
          kind: "element",
          locator: { kind: "css", selector: "#email" },
          attributes: ["placeholder"],
        },
      },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(stateCalls).toBe(1);
    expect(domRequest).toMatchObject({
      expectedTargetGeneration: target.targetGeneration,
      expectedDocumentGeneration: target.documentGeneration,
      expectedFrameId: "frame-2",
      kind: "element",
      locator: { kind: "css", selector: "#email" },
      maxChars: 4_096,
    });
    expect(result.structuredContent).toMatchObject({
      source: "dom",
      kind: "element",
      value: "user@example.test",
      attributes: { placeholder: "Enter email" },
    });
  });

  test("captures screenshots without accessibility scans and returns image content", async () => {
    const target = browserTarget();
    const image = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
    let capturedOptions: unknown = null;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        observeBrowserTarget: async () => {
          throw new Error("unexpected accessibility scan");
        },
        captureBrowserTarget: async (
          _workspaceId,
          _browserSessionId,
          _targetId,
          _request,
          options,
        ) => {
          capturedOptions = options;
          return {
            frameId: "captured-browser-frame",
            browserSessionId,
            controllerGeneration: target.controllerGeneration,
            targetId: target.id,
            targetGeneration: target.targetGeneration,
            documentGeneration: target.documentGeneration!,
            sequence: 1,
            mediaType: "image/jpeg",
            width: 120,
            height: 200,
            deviceScaleFactor: 1,
            scrollX: 0,
            scrollY: 0,
            capturedAt: now,
            data: image,
          };
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_screenshot"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id, fullPage: true, quality: 40 },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(capturedOptions).toEqual({ fullPage: true, quality: 40 });
    expect(result.structuredContent).toMatchObject({
      kind: "browser_screenshot",
      fullPage: true,
      frameId: "captured-browser-frame",
      mediaType: "image/jpeg",
      width: 120,
      height: 200,
    });
    expect(result.content[1]).toEqual({
      type: "image",
      data: Buffer.from(image).toString("base64"),
      mimeType: "image/jpeg",
    });
  });

  test.each(["browser_screenshot", "browser_observe"] as const)(
    "%s preserves a known capture timeout without replay or partial success",
    async (toolName) => {
      let captures = 0;
      let observations = 0;
      const target = browserTarget();
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          observeBrowserTarget: async () => {
            observations += 1;
            return browserObservation(target);
          },
          captureBrowserTarget: async () => {
            captures += 1;
            throw new OpenGeniApiError(
              504,
              JSON.stringify({
                error: {
                  status: 504,
                  code: "upstream_unavailable",
                  message: "This tab did not produce a screenshot in time.",
                  retryable: true,
                  requestId: "capture-request-42",
                },
              }),
              { mutation: false },
            );
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: [toolName],
        permissions: ["sessions:read"],
      });
      const result = await definitions[0]!.execute(
        {
          browserSessionId,
          targetId: target.id,
          ...(toolName === "browser_observe" ? { includeScreenshot: true } : {}),
        },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
      expect(result).toEqual({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: {
                code: "upstream_unavailable",
                message:
                  "This tab did not produce a screenshot in time. Reference: capture-request-42.",
                retryable: true,
                requestId: "capture-request-42",
              },
            }),
          },
        ],
        structuredContent: {
          error: {
            code: "upstream_unavailable",
            message:
              "This tab did not produce a screenshot in time. Reference: capture-request-42.",
            retryable: true,
            requestId: "capture-request-42",
          },
        },
      });
      expect(captures).toBe(1);
      expect(observations).toBe(toolName === "browser_observe" ? 1 : 0);
    },
  );

  test.each([
    new Error("unexpected failure"),
    new OpenGeniApiError(504, "uncertain", { outcomeUnknown: true }),
  ])(
    "does not convert unexpected or uncertain read failures to definite results: %s",
    async (failure) => {
      const definitions = createInteractionAttemptToolDefinitions({
        transport: partialTransport({
          captureBrowserTarget: async () => {
            throw failure;
          },
        }),
        workspaceId,
        sessionId,
        selectedTools: ["browser_screenshot"],
        permissions: ["sessions:read"],
      });
      await expect(
        definitions[0]!.execute(
          { browserSessionId, targetId: browserTarget().id },
          { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
        ),
      ).rejects.toBe(failure);
    },
  );

  test("a known connected-machine read refusal retains its typed control details", async () => {
    let calls = 0;
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        captureBrowserTarget: async () => {
          calls += 1;
          throw new OpenGeniApiError(
            403,
            JSON.stringify({
              error: {
                code: "forbidden",
                message: "Screen access is not enabled.",
                retryable: false,
                outcomeUnknown: false,
                requestId: "api-read-42",
                details: {
                  interactionLayer: "connected_machine",
                  interactionSurface: "browser",
                  controlFailureCode: "consent_required",
                  controlRequestId: "control-read-42",
                },
              },
            }),
            { mutation: false },
          );
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_screenshot"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      { browserSessionId, targetId: browserTarget().id },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({
      outcomeUnknown: false,
      retryable: false,
      requestId: "api-read-42",
      details: {
        interactionLayer: "connected_machine",
        interactionSurface: "browser",
        controlFailureCode: "consent_required",
        controlRequestId: "control-read-42",
      },
    });
    expect(calls).toBe(1);
  });

  test("does not downgrade a failed browser mutation to a known read failure", async () => {
    const failure = new OpenGeniApiError(504, "mutation failed", { outcomeUnknown: false });
    let calls = 0;
    const target = browserTarget();
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        actInBrowser: async () => {
          calls += 1;
          throw failure;
        },
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_act"],
      permissions: ["sessions:control"],
    });
    await expect(
      definitions[0]!.execute(
        {
          browserSessionId,
          targetId: target.id,
          expectedTargetGeneration: target.targetGeneration,
          expectedDocumentGeneration: target.documentGeneration,
          expectedFrameId: null,
          action: { type: "scroll", deltaX: 0, deltaY: 100 },
        },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      ),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  test("rejects a screenshot before the 16 MiB Code Mode result journal can overflow", async () => {
    const target = browserTarget();
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        captureBrowserTarget: async () => ({
          frameId: "captured-browser-frame",
          browserSessionId,
          controllerGeneration: target.controllerGeneration,
          targetId: target.id,
          targetGeneration: target.targetGeneration,
          documentGeneration: target.documentGeneration!,
          sequence: 1,
          mediaType: "image/jpeg",
          width: 120,
          height: 200,
          deviceScaleFactor: 1,
          scrollX: 0,
          scrollY: 0,
          capturedAt: now,
          data: Buffer.alloc(8 * 1024 * 1024 + 1),
        }),
      }),
      workspaceId,
      sessionId,
      selectedTools: ["browser_screenshot"],
      permissions: ["sessions:read"],
    });
    const result = await definitions[0]!.execute(
      { browserSessionId, targetId: target.id },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "browser_screenshot_too_large", retryable: false } },
    });
    expect(JSON.stringify(result)).not.toContain("AAAAAA");
  });

  test("publishes every declared atomic name only once", () => {
    const definitions = createInteractionAttemptToolDefinitions({
      transport: partialTransport({
        callNativeComputerTool: async () => {
          throw new Error("must not call during catalog preparation");
        },
      }),
      workspaceId,
      sessionId,
    });
    expect(definitions.map((definition) => definition.identity.toolName)).toEqual([
      ...INTERACTION_ATTEMPT_TOOL_NAMES,
      ...CUA_DESKTOP_TOOLS.map((tool) => "cua_" + tool.name),
    ]);
    expect(new Set(definitions.map((definition) => definition.modelName)).size).toBe(
      definitions.length,
    );
  });

  test("browser tools keep working in the last used tab when ids are omitted", async () => {
    const target = browserTarget();
    const older = { ...discoveredBrowserSession(randomUUID(), sessionId), lastUsedAt: now };
    const latest = {
      ...discoveredBrowserSession(browserSessionId, sessionId),
      lastUsedAt: "2026-08-10T12:05:00.000Z",
    };
    const lookups: string[] = [];
    const acted: Array<{ browserSessionId: string; request: BrowserActionRequest }> = [];
    const definitions = createInteractionAttemptToolDefinitions({
      workspaceId,
      sessionId,
      selectedTools: ["browser_act", "browser_observe"],
      permissions: ["sessions:read", "sessions:control"],
      transport: partialTransport({
        listBrowserSessions: async (_workspace, options) => {
          lookups.push("sessions");
          expect(options).toMatchObject({ associatedSessionId: sessionId, includeTerminal: false });
          return { revision: 1, sessions: [older, latest] };
        },
        listBrowserTargets: async (_workspace, id) => {
          lookups.push(`targets:${id}`);
          return {
            revision: 1,
            targets: [{ ...target, id: "tab-0", selected: false }, target],
          } as never;
        },
        actInBrowser: async (_workspace, id, request) => {
          acted.push({ browserSessionId: id, request });
          return browserReceipt(request.operationId, browserObservation(target));
        },
      }),
    });
    const act = definitions.find((tool) => tool.modelName === "interaction__browser_act")!;
    expect(act.inputSchema.required).toEqual(["action"]);

    const first = await act.execute(
      { action: { type: "click", locator: "e1a2b3c4d" } },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(first.isError).toBeUndefined();
    await act.execute(
      {
        action: {
          type: "batch",
          actions: [
            { type: "fill", locator: "e00000001", value: "Ada" },
            { type: "drag", from: "e00000002", to: { kind: "ref", ref: "e00000003" } },
          ],
        },
      },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );

    // Only the first call looked the browser up; the second reused it.
    expect(lookups).toEqual(["sessions", `targets:${browserSessionId}`]);
    expect(acted.map((call) => [call.browserSessionId, call.request.targetId])).toEqual([
      [browserSessionId, target.id],
      [browserSessionId, target.id],
    ]);
    expect(acted[0]!.request.action).toEqual({
      type: "click",
      locator: { kind: "ref", ref: "e1a2b3c4d" },
    });
    expect(acted[1]!.request.action).toEqual({
      type: "batch",
      actions: [
        { type: "fill", locator: { kind: "ref", ref: "e00000001" }, value: "Ada" },
        {
          type: "drag",
          from: { kind: "ref", ref: "e00000002" },
          to: { kind: "ref", ref: "e00000003" },
        },
      ],
    });
  });

  test("closing a tab that is already gone keeps the current browser", async () => {
    const target = browserTarget();
    let sessionLookups = 0;
    const definitions = createInteractionAttemptToolDefinitions({
      workspaceId,
      sessionId,
      selectedTools: ["browser_tabs"],
      permissions: ["sessions:read", "sessions:control"],
      transport: partialTransport({
        listBrowserSessions: async () => {
          sessionLookups += 1;
          return { revision: 1, sessions: [discoveredBrowserSession(browserSessionId, sessionId)] };
        },
        listBrowserTargets: async () =>
          ({ browserSessionId, controllerGeneration: "generation-1", targets: [target] }) as never,
        closeBrowserTarget: async () => {
          throw new OpenGeniApiError(404, "browser target does not exist", {
            code: "not_found",
          });
        },
      }),
    });
    const tabs = definitions[0]!;
    const call = async (args: Record<string, unknown>) =>
      await tabs.execute(args, {
        operationId: randomUUID(),
        caller: { kind: "model", subjectId: "model:test" },
      });
    expect((await call({ operation: "list" })).isError).not.toBe(true);
    const closed = await call({ operation: "close", targetId: "gone-tab" });
    expect(closed.isError).toBe(true);
    expect(JSON.stringify(closed.structuredContent)).toContain("browser target does not exist");
    const listed = await call({ operation: "list" });
    expect(listed.isError).not.toBe(true);
    // The browser was remembered: no second session lookup.
    expect(sessionLookups).toBe(1);
  });

  test("an explicit tab becomes the current tab for later calls", async () => {
    const target = browserTarget();
    const other = randomUUID();
    const acted: Array<[string, string]> = [];
    const definitions = createInteractionAttemptToolDefinitions({
      workspaceId,
      sessionId,
      selectedTools: ["browser_act"],
      permissions: ["sessions:control"],
      transport: partialTransport({
        actInBrowser: async (_workspace, id, request) => {
          acted.push([id, request.targetId]);
          return browserReceipt(request.operationId, browserObservation(target));
        },
      }),
    });
    const act = definitions[0]!;
    const run = async (args: Record<string, unknown>) =>
      await act.execute(
        { ...args, action: { type: "press", key: "Enter" } },
        { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
      );
    await run({ browserSessionId: other, targetId: "tab-9" });
    await run({});
    await run({ targetId: "tab-3" });
    await run({});
    expect(acted).toEqual([
      [other, "tab-9"],
      [other, "tab-9"],
      [other, "tab-3"],
      [other, "tab-3"],
    ]);
  });

  test("omitting ids without an open browser fails clearly before dispatch", async () => {
    const definitions = createInteractionAttemptToolDefinitions({
      workspaceId,
      sessionId,
      selectedTools: ["browser_act"],
      permissions: ["sessions:control"],
      transport: partialTransport({
        listBrowserSessions: async () => ({ revision: 0, sessions: [] }),
        actInBrowser: async () => {
          throw new Error("must not dispatch");
        },
      }),
    });
    const result = await definitions[0]!.execute(
      { action: { type: "press", key: "Enter" } },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "browser_session_required",
          message: expect.stringContaining("browser_open"),
        },
      },
    });
  });

  test("browser_act shows an element ref as a locator shorthand", () => {
    const act = createInteractionAttemptToolDefinitions({
      workspaceId,
      sessionId,
      selectedTools: ["browser_act"],
      permissions: ["sessions:control"],
      transport: partialTransport({}),
    })[0]!;
    const action = (act.inputSchema.properties as Record<string, Record<string, unknown>>).action!;
    const locator = (action.properties as Record<string, { anyOf?: unknown[] }>).locator!;
    expect(locator.anyOf?.[0]).toEqual({
      type: "string",
      description:
        'An element ref, or role:name for the element with that role and exact name ("link:Sign in").',
    });
    expect(JSON.stringify(locator.anyOf?.[1])).toContain('"ref"');
  });
});

function browserTarget(): BrowserTarget {
  return {
    id: "tab-1",
    browserSessionId,
    controllerGeneration: "controller-1",
    targetGeneration: "target-4",
    documentGeneration: "document-9",
    kind: "page",
    title: "Example",
    url: "https://example.test/",
    selected: true,
    attached: true,
    createdAt: now,
  };
}

/** The model-facing tab projection: identity, page, selection and fences. */
function agentTarget(target: BrowserTarget) {
  return {
    id: target.id,
    kind: target.kind,
    title: target.title,
    url: target.url,
    selected: target.selected,
    controllerGeneration: target.controllerGeneration,
    targetGeneration: target.targetGeneration,
    documentGeneration: target.documentGeneration,
  };
}

function discoveredBrowserSession(id: string, associatedSessionId: string): BrowserSession {
  return {
    id,
    accountId,
    workspaceId,
    name: "Browser",
    lifecycle: "starting",
    placement: { kind: "sandbox_group", sandboxGroupId: randomUUID() },
    controller: null,
    driverId: "chromium",
    engine: "chromium",
    engineVersion: "1",
    headless: false,
    identityId: null,
    baseRevisionId: null,
    networkRouteId: null,
    linkedComputerSessionId: null,
    capabilities: {
      semanticObservation: true,
      screenshots: true,
      liveFrames: true,
      humanInput: true,
      tabs: true,
      downloads: true,
      uploads: true,
      clipboard: true,
      permissions: true,
      diagnostics: true,
      rawCdp: false,
      linkedComputer: true,
      privateCheckpoint: true,
      identityPublication: true,
      parallelTargets: true,
    },
    associations: [
      {
        sessionId: associatedSessionId,
        turnId: null,
        attemptId: null,
        relationship: "created",
        actorSubjectId: "model:test",
        lastUsedAt: now,
      },
    ],
    createdBySubjectId: "model:test",
    createdAt: now,
    lastUsedAt: now,
    failureCode: null,
  };
}

function discoveredComputerSession(id: string, associatedSessionId: string): ComputerSession {
  return {
    id,
    accountId,
    workspaceId,
    name: "Computer",
    lifecycle: "starting",
    placement: { kind: "sandbox_group", sandboxGroupId: randomUUID() },
    controller: null,
    platform: null,
    adapter: null,
    seatId: null,
    displayId: null,
    capabilities: null,
    associations: [
      {
        sessionId: associatedSessionId,
        turnId: null,
        attemptId: null,
        relationship: "created",
        actorSubjectId: "model:test",
        lastUsedAt: now,
      },
    ],
    createdBySubjectId: "model:test",
    createdAt: now,
    lastUsedAt: now,
    failureCode: null,
  };
}

function browserObservation(target: BrowserTarget): BrowserObservation {
  return {
    protocolVersion: 1,
    observationId: "observation-1",
    browserSessionId,
    target,
    frameId: "frame-2",
    semantic: {
      kind: "snapshot",
      roots: [],
      nodeCount: 0,
    },
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    diagnostics: {
      consoleErrorCount: 0,
      failedRequestCount: 0,
      downloadCount: 0,
      pageErrorCount: 0,
    },
    dialog: null,
    observedAt: now,
  };
}

function completedBrowserIntervention(target: BrowserTarget): InteractionIntervention {
  return {
    id: randomUUID(),
    accountId,
    workspaceId,
    resourceKind: "browser_session",
    resourceId: browserSessionId,
    targetId: target.id,
    controllerGeneration: target.controllerGeneration,
    targetGeneration: target.targetGeneration,
    documentGeneration: target.documentGeneration,
    kind: "mfa",
    reason: "Complete MFA in this exact tab.",
    status: "completed",
    authRunId: null,
    originatingSessionId: sessionId,
    originatingTurnId: turnId,
    originatingAttemptId: attemptId,
    originatingToolOperationId: randomUUID(),
    responseActorSubjectId: "user:test",
    version: 2,
    operationId: randomUUID(),
    expiresAt: "2026-08-10T12:15:00.000Z",
    createdAt: now,
    updatedAt: now,
    settledAt: now,
  };
}

function browserReceipt(
  operationId: string,
  observation: BrowserObservation,
): BrowserActionReceipt {
  return {
    protocolVersion: 1,
    operationId,
    browserSessionId,
    controllerGeneration: "controller-1",
    targetId: observation.target.id,
    state: "completed",
    dispatchedAt: now,
    settledAt: now,
    observation,
    error: null,
  };
}

function computerTarget(): ComputerTarget {
  return {
    id: "window-1",
    computerSessionId,
    controllerGeneration: "controller-1",
    targetGeneration: "target-2",
    kind: "window",
    applicationId: "test.app",
    processId: 42,
    title: "Example",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    focused: true,
  };
}

function computerObservation(target: ComputerTarget): ComputerObservation {
  return {
    protocolVersion: 1,
    observationId: randomUUID(),
    computerSessionId,
    target,
    frameId: "frame-current",
    semantic: { kind: "snapshot", roots: [], nodeCount: 0 },
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    observedAt: now,
  };
}

function computerReceipt(
  operationId: string,
  observation: ComputerObservation,
): ComputerActionReceipt {
  return {
    protocolVersion: 1,
    operationId,
    computerSessionId,
    controllerGeneration: "controller-1",
    targetId: observation.target.id,
    state: "completed",
    dispatchedAt: now,
    settledAt: now,
    observation,
    error: null,
  };
}

function externalAuthRun(): AuthRun {
  return {
    id: randomUUID(),
    accountId,
    workspaceId,
    siteAuthConnectionId: randomUUID(),
    browserSessionId,
    targetId: "tab-auth",
    controllerGeneration: "controller-1",
    targetGeneration: "target-auth",
    documentGeneration: "document-auth",
    purpose: "authenticate",
    methodId: "kernel-managed",
    authorityId: "kernel-managed",
    state: "awaiting_external_action",
    choices: [],
    externalAction: { kind: "human", label: "Finish sign-in", expiresAt: null },
    interventionId: randomUUID(),
    verifiedUrl: null,
    failureCode: null,
    version: 2,
    operationId: randomUUID(),
    createdBySubjectId: "model:test",
    createdAt: now,
    updatedAt: now,
    settledAt: null,
  };
}

/** A controller that has nothing recorded under the operation ID asked for. */
async function noRecordedReceipt(): Promise<never> {
  throw new OpenGeniApiError(404, "operation not found", { code: "resource_not_found" });
}

function activeComputerSession(): ComputerSession {
  return {
    ...discoveredComputerSession(computerSessionId, sessionId),
    lifecycle: "active",
    controller: {
      controllerId: "synthetic-controller",
      controllerGeneration: "controller-1",
      placementInstanceId: "placement-1",
    },
    platform: "windows",
    adapter: "opengeni.cua.windows.v1",
    seatId: "seat-1",
    displayId: "display-1",
    capabilities: {
      semanticObservation: true,
      appDiscovery: true,
      appLaunch: true,
      windowCapture: true,
      screenCapture: true,
      semanticActions: true,
      pointerInput: true,
      keyboardInput: true,
      clipboard: true,
      backgroundActions: true,
      parallelApps: true,
    },
  };
}

function partialTransport(value: Partial<InteractionTransport>): InteractionTransport {
  return value as InteractionTransport;
}

/** A browser that stops (is suspended) and resumes with its tab reopened as
 * tab-2. */
function stoppedBrowser(options: { running?: boolean } = {}) {
  let running = options.running ?? false;
  const suspended = discoveredBrowserSession(browserSessionId, sessionId);
  suspended.lifecycle = "suspended";
  const active = discoveredBrowserSession(browserSessionId, sessionId);
  active.lifecycle = "active";
  active.controller = {
    controllerId: "synthetic-controller",
    controllerGeneration: "controller-2",
    placementInstanceId: "placement-1",
  };
  const restored: BrowserTarget = {
    ...browserTarget(),
    id: "tab-2",
    controllerGeneration: "controller-2",
  };
  const resumes: string[] = [];
  const acted: string[] = [];
  const notActive = () => new OpenGeniApiError(409, "BrowserSession is not active");
  const transport: Partial<InteractionTransport> = {
    getBrowserSession: async () => (running ? active : suspended),
    resumeBrowserSession: async (_workspaceId, _browserSessionId, request) => {
      resumes.push(request.operationId);
      running = true;
      return { session: active, operation: { state: "completed", error: null } } as never;
    },
    listBrowserTargets: async () => {
      if (!running) throw notActive();
      return { browserSessionId, controllerGeneration: "controller-2", targets: [restored] };
    },
    observeBrowserTarget: async () => {
      if (!running) throw notActive();
      return browserObservation(restored);
    },
    actInBrowser: async (_workspaceId, _browserSessionId, request) => {
      if (!running || request.targetId !== "tab-2") throw notActive();
      acted.push(request.targetId);
      return {
        targetId: request.targetId,
        state: "completed",
        observation: browserObservation(restored),
      } as never;
    },
  };
  return {
    transport,
    suspended,
    restored,
    resumes,
    acted,
    notActive,
    running: () => running,
    stop: () => {
      running = false;
    },
  };
}

function unusedTransport(): InteractionTransport {
  return new Proxy({} as InteractionTransport, {
    get() {
      throw new Error("unexpected interaction transport call");
    },
  });
}

for (const mismatch of ["personal-profile", "machine", "identity"] as const) {
  test(`browser reuse respects requested authority: ${mismatch}`, async () => {
    const candidate = discoveredBrowserSession(randomUUID(), sessionId);
    const requestedMachine = { kind: "connected_machine" as const, sandboxId: randomUUID() };
    const requestedIdentity = randomUUID();
    if (mismatch === "personal-profile")
      candidate.placement = { kind: "attached_device", deviceId: randomUUID() };
    if (mismatch === "machine")
      candidate.placement = { kind: "connected_machine", sandboxId: randomUUID() };
    let created = false;
    const definitions = createInteractionAttemptToolDefinitions({
      workspaceId,
      sessionId,
      selectedTools: ["browser_open"],
      permissions: ["sessions:control"],
      transport: partialTransport({
        listBrowserSessions: async () => ({ revision: 0, sessions: [candidate] }),
        createBrowserSession: async () => {
          created = true;
          return { session: { lifecycle: "starting" } } as never;
        },
      }),
    });
    await definitions[0]!.execute(
      {
        mode: "reuse_or_create",
        ...(mismatch === "machine" ? { placement: requestedMachine } : {}),
        ...(mismatch === "identity" ? { identityId: requestedIdentity } : {}),
      },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );
    expect(created).toBe(true);
  });
}

describe("open reuses only a session on the chat's current machine", () => {
  const groupId = randomUUID();
  const oldMachine = randomUUID();
  const swappedMachine = randomUUID();
  const routes = [
    { name: "home", activeSandboxId: null, reused: "home" },
    { name: "the machine it was on before", activeSandboxId: oldMachine, reused: "old" },
    { name: "a machine it swapped to", activeSandboxId: swappedMachine, reused: null },
  ] as const;
  const context = () => ({
    operationId: randomUUID(),
    caller: { kind: "model" as const, subjectId: "model:test" },
  });
  const sessionRead = (activeSandboxId: string | null) => async () =>
    ({ id: sessionId, sandboxGroupId: groupId, activeSandboxId }) as never;

  for (const route of routes) {
    test(`computer_open when the chat is routed to ${route.name}`, async () => {
      const home = discoveredComputerSession(randomUUID(), sessionId);
      home.placement = { kind: "sandbox_group", sandboxGroupId: groupId };
      home.lastUsedAt = "2026-08-10T11:00:00.000Z";
      const old = discoveredComputerSession(randomUUID(), sessionId);
      old.placement = { kind: "connected_machine", sandboxId: oldMachine };
      const created = discoveredComputerSession(randomUUID(), sessionId);
      const createRequests: unknown[] = [];
      const definitions = createInteractionAttemptToolDefinitions({
        transport: {
          ...partialTransport({
            listComputerSessions: async () => ({ revision: 0, sessions: [home, old] }),
            createComputerSession: async (_workspaceId, request) => {
              createRequests.push(request);
              return { session: created } as never;
            },
          }),
          getSession: sessionRead(route.activeSandboxId),
        },
        workspaceId,
        sessionId,
        selectedTools: ["computer_open"],
        permissions: ["sessions:read", "sessions:control"],
      });
      const result = await definitions[0]!.execute({}, context());
      const opened = (result.structuredContent as { session: ComputerSession }).session;
      const expected = route.reused === "home" ? home : route.reused === "old" ? old : created;
      expect(opened.id).toBe(expected.id);
      expect(createRequests).toHaveLength(route.reused === null ? 1 : 0);
      expect(createRequests[0]).not.toHaveProperty("placement");
    });

    test(`browser_open when the chat is routed to ${route.name}`, async () => {
      const home = discoveredBrowserSession(randomUUID(), sessionId);
      home.placement = { kind: "sandbox_group", sandboxGroupId: groupId };
      home.lastUsedAt = "2026-08-10T11:00:00.000Z";
      const old = discoveredBrowserSession(randomUUID(), sessionId);
      old.placement = { kind: "connected_machine", sandboxId: oldMachine };
      let created = 0;
      const definitions = createInteractionAttemptToolDefinitions({
        transport: {
          ...partialTransport({
            listBrowserSessions: async () => ({ revision: 0, sessions: [home, old] }),
            getBrowserSession: async (_workspaceId, id) =>
              [home, old].find((candidate) => candidate.id === id)!,
            createBrowserSession: async () => {
              created += 1;
              return { session: { lifecycle: "starting" } } as never;
            },
          }),
          getSession: sessionRead(route.activeSandboxId),
        },
        workspaceId,
        sessionId,
        selectedTools: ["browser_open"],
        permissions: ["sessions:read", "sessions:control"],
      });
      const result = await definitions[0]!.execute({}, context());
      const opened = (result.structuredContent as { session: BrowserSession }).session;
      if (route.reused === null) {
        expect(created).toBe(1);
      } else {
        expect(created).toBe(0);
        expect(opened.id).toBe(route.reused === "home" ? home.id : old.id);
      }
    });
  }

  // A session on a named machine is reused only while the chat is routed
  // there. On any other route the server retires it on contact, so the open
  // creates instead, and that create says how to move the chat.
  for (const route of [
    { name: "that machine", activeSandboxId: oldMachine, reused: true },
    { name: "another machine", activeSandboxId: swappedMachine, reused: false },
    { name: "an unreadable route", activeSandboxId: undefined, reused: true },
  ] as const) {
    test(`computer_open naming a machine when the chat is routed to ${route.name}`, async () => {
      const old = discoveredComputerSession(randomUUID(), sessionId);
      old.placement = { kind: "connected_machine", sandboxId: oldMachine };
      const created = discoveredComputerSession(randomUUID(), sessionId);
      const createRequests: unknown[] = [];
      const definitions = createInteractionAttemptToolDefinitions({
        transport: {
          ...partialTransport({
            listComputerSessions: async () => ({ revision: 0, sessions: [old] }),
            createComputerSession: async (_workspaceId, request) => {
              createRequests.push(request);
              return { session: created } as never;
            },
          }),
          getSession:
            route.activeSandboxId === undefined
              ? async () => {
                  throw new Error("session read failed");
                }
              : sessionRead(route.activeSandboxId),
        },
        workspaceId,
        sessionId,
        selectedTools: ["computer_open"],
        permissions: ["sessions:read", "sessions:control"],
      });
      const placement = { kind: "connected_machine", sandboxId: oldMachine } as const;
      const result = await definitions[0]!.execute({ placement }, context());
      const opened = (result.structuredContent as { session: ComputerSession }).session;
      expect(opened.id).toBe(route.reused ? old.id : created.id);
      expect(createRequests).toEqual(route.reused ? [] : [expect.objectContaining({ placement })]);
    });

    test(`browser_open naming a machine when the chat is routed to ${route.name}`, async () => {
      const old = discoveredBrowserSession(randomUUID(), sessionId);
      old.placement = { kind: "connected_machine", sandboxId: oldMachine };
      let created = 0;
      const definitions = createInteractionAttemptToolDefinitions({
        transport: {
          ...partialTransport({
            listBrowserSessions: async () => ({ revision: 0, sessions: [old] }),
            getBrowserSession: async () => old,
            createBrowserSession: async () => {
              created += 1;
              return { session: { lifecycle: "starting" } } as never;
            },
          }),
          getSession:
            route.activeSandboxId === undefined
              ? async () => {
                  throw new Error("session read failed");
                }
              : sessionRead(route.activeSandboxId),
        },
        workspaceId,
        sessionId,
        selectedTools: ["browser_open"],
        permissions: ["sessions:read", "sessions:control"],
      });
      const result = await definitions[0]!.execute(
        { placement: { kind: "connected_machine", sandboxId: oldMachine } },
        context(),
      );
      if (route.reused) {
        expect(created).toBe(0);
        expect((result.structuredContent as { session: BrowserSession }).session.id).toBe(old.id);
      } else {
        expect(created).toBe(1);
      }
    });
  }

  // The chat's own sandbox group is usable from any route, so a session there
  // is reused while the chat works on a Connected Machine.
  test("computer_open naming the chat's own sandbox from a Connected Machine reuses it", async () => {
    const home = discoveredComputerSession(randomUUID(), sessionId);
    home.placement = { kind: "sandbox_group", sandboxGroupId: groupId };
    const definitions = createInteractionAttemptToolDefinitions({
      transport: {
        ...partialTransport({
          listComputerSessions: async () => ({ revision: 0, sessions: [home] }),
          createComputerSession: async () => {
            throw new Error("the home Desktop is reused");
          },
        }),
        getSession: sessionRead(swappedMachine),
      },
      workspaceId,
      sessionId,
      selectedTools: ["computer_open"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const result = await definitions[0]!.execute(
      { placement: { kind: "sandbox_group", sandboxGroupId: groupId } },
      context(),
    );
    expect((result.structuredContent as { session: ComputerSession }).session.id).toBe(home.id);
  });

  test("browser_open naming the chat's own sandbox from a Connected Machine reuses it", async () => {
    const home = discoveredBrowserSession(randomUUID(), sessionId);
    home.placement = { kind: "sandbox_group", sandboxGroupId: groupId };
    const definitions = createInteractionAttemptToolDefinitions({
      transport: {
        ...partialTransport({
          listBrowserSessions: async () => ({ revision: 0, sessions: [home] }),
          getBrowserSession: async () => home,
          createBrowserSession: async () => {
            throw new Error("the home browser is reused");
          },
        }),
        getSession: sessionRead(swappedMachine),
      },
      workspaceId,
      sessionId,
      selectedTools: ["browser_open"],
      permissions: ["sessions:read", "sessions:control"],
    });
    const result = await definitions[0]!.execute(
      { placement: { kind: "sandbox_group", sandboxGroupId: groupId } },
      context(),
    );
    expect((result.structuredContent as { session: BrowserSession }).session.id).toBe(home.id);
  });
});
