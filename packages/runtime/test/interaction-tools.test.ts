import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import type {
  BrowserActionRequest,
  BrowserActionReceipt,
  BrowserObservation,
  BrowserTarget,
  ComputerActionRequest,
  ComputerActionReceipt,
  ComputerObservation,
  ComputerTarget,
} from "@opengeni/contracts";
import type { InteractionTransport } from "@opengeni/sdk";
import {
  INTERACTION_ATTEMPT_TOOL_NAMES,
  createInteractionAttemptToolDefinitions,
} from "../src/interaction-tools";

const accountId = randomUUID();
const workspaceId = randomUUID();
const sessionId = randomUUID();
const turnId = randomUUID();
const attemptId = randomUUID();
const browserSessionId = randomUUID();
const computerSessionId = randomUUID();
const now = "2026-08-10T12:00:00.000Z";

describe("interaction attempt tools", () => {
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
      "browser_debug",
      "computer_targets",
      "computer_observe",
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
    expect(environment.catalog.entries).toHaveLength(5);
    expect(environment.catalog.entries[0]).toMatchObject({
      identity: { serverId: "interaction", toolName: "interaction_discover" },
      modelName: "interaction__interaction_discover",
      codemodePath: ["interaction", "discover"],
      source: "interaction",
      approval: "none",
      annotations: { readOnlyHint: true, idempotentHint: true },
    });
    expect(environment.catalog.entries[0]!.inputSchema).toMatchObject({ type: "object" });
    expect(environment.catalog.entries[0]!.outputSchema).toMatchObject({ type: "object" });
  });

  test("keeps model and Codemode Browser actions on the same durable operation and fences", async () => {
    const target = browserTarget();
    const observation = browserObservation(target);
    let request: BrowserActionRequest | null = null;
    const transport = partialTransport({
      observeBrowserTarget: async () => observation,
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
      expectedTargetGeneration: target.targetGeneration,
      expectedDocumentGeneration: target.documentGeneration,
      expectedFrameId: observation.frameId,
      action: { type: "scroll", deltaX: 0, deltaY: 480 },
    });
    expect(result.structuredContent).toMatchObject({
      operationId,
      browserSessionId,
      state: "completed",
    });
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

  test("keeps semantic Computer actions observation-fenced but free of pixel frame authority", async () => {
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
    const operationId = randomUUID();
    const result = await definitions[0]!.execute(
      {
        computerSessionId,
        targetId: target.id,
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
        action: { type: "pointer", frameId: "frame-user-saw", action: "click", x: 10, y: 20 },
      },
      { operationId: randomUUID(), caller: { kind: "model", subjectId: "model:test" } },
    );

    expect(request).toMatchObject({ expectedFrameId: "frame-user-saw" });
  });

  test("publishes every declared atomic name only once", () => {
    const definitions = createInteractionAttemptToolDefinitions({
      transport: unusedTransport(),
      workspaceId,
      sessionId,
    });
    expect(definitions.map((definition) => definition.identity.toolName)).toEqual([
      ...INTERACTION_ATTEMPT_TOOL_NAMES,
    ]);
    expect(new Set(definitions.map((definition) => definition.modelName)).size).toBe(
      definitions.length,
    );
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

function partialTransport(value: Partial<InteractionTransport>): InteractionTransport {
  return value as InteractionTransport;
}

function unusedTransport(): InteractionTransport {
  return new Proxy({} as InteractionTransport, {
    get() {
      throw new Error("unexpected interaction transport call");
    },
  });
}
