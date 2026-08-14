import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createAttemptToolEnvironment } from "@opengeni/codemode";
import {
  BrowserSession as BrowserSessionSchema,
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
  test("opens managed Chromium headed by default for supported human sign-in", async () => {
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
      "browser_clipboard",
      "browser_debug",
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
    expect(environment.catalog.entries).toHaveLength(7);
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
    pendingFields: [],
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
