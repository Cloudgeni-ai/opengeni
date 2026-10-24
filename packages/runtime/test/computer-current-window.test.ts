import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  ComputerActionReceipt,
  ComputerActionRequest,
  ComputerObservation,
  ComputerSession,
  ComputerTarget,
} from "@opengeni/contracts";
import { OpenGeniApiError, type InteractionTransport } from "@opengeni/sdk";
import {
  ComputerTargetResolutionError,
  CurrentComputerWindow,
} from "../src/computer-current-window";
import { createInteractionAttemptToolDefinitions } from "../src/interaction-tools";
import { computerActModelInputSchema } from "../src/interaction-tool-json-schema";

const accountId = randomUUID();
const workspaceId = randomUUID();
const sessionId = randomUUID();
const computerSessionId = randomUUID();
const now = "2026-10-24T01:00:00.000Z";
const model = { kind: "model", subjectId: "model:test" } as const;

describe("current computer window", () => {
  test("uses the latest live computer, then remembers the window a call used", async () => {
    let lookups = 0;
    const current = new CurrentComputerWindow({
      latestLiveSession: async () => {
        lookups += 1;
        return "c-1";
      },
    });
    expect(await current.session(undefined)).toEqual({ computerSessionId: "c-1", implicit: true });
    await expect(current.target({})).rejects.toMatchObject({ code: "computer_target_required" });
    current.use("c-1", "w-1");
    expect(await current.target({})).toEqual({
      computerSessionId: "c-1",
      implicit: true,
      targetId: "w-1",
      implicitTarget: true,
    });
    // Using the same computer without naming a window keeps the window.
    current.use("c-1");
    expect((await current.target({})).targetId).toBe("w-1");
    expect(lookups).toBe(2);
  });

  test("explicit identifiers win, and another computer has no remembered window", async () => {
    const current = new CurrentComputerWindow({ latestLiveSession: async () => null });
    current.use("c-1", "w-1");
    expect(await current.target({ targetId: "w-2" })).toMatchObject({
      computerSessionId: "c-1",
      targetId: "w-2",
      implicitTarget: false,
    });
    await expect(current.target({ computerSessionId: "c-2" })).rejects.toBeInstanceOf(
      ComputerTargetResolutionError,
    );
  });

  test("a session with no computer says to open one", async () => {
    const current = new CurrentComputerWindow({ latestLiveSession: async () => null });
    await expect(current.target({})).rejects.toMatchObject({
      code: "computer_session_required",
      message:
        "This session has no open computer. Call computer_open first, or pass computerSessionId.",
    });
  });

  test("a remembered computer that is gone is resolved afresh", async () => {
    const current = new CurrentComputerWindow({ latestLiveSession: async () => "c-2" });
    current.use("c-1", "w-1");
    current.failed(await current.session(undefined), "computer");
    expect(await current.session(undefined)).toEqual({ computerSessionId: "c-2", implicit: true });
  });

  test("a remembered computer gone under its remembered window is resolved afresh", async () => {
    const current = new CurrentComputerWindow({ latestLiveSession: async () => "c-2" });
    current.use("c-1", "w-1");
    current.failed(await current.target({}), "computer");
    expect(await current.session(undefined)).toEqual({ computerSessionId: "c-2", implicit: true });
  });

  test("an explicitly named computer that is gone is forgotten too", async () => {
    const current = new CurrentComputerWindow({ latestLiveSession: async () => "c-2" });
    current.use("c-1", "w-1");
    current.failed(await current.target({ computerSessionId: "c-1" }), "computer");
    expect(await current.session(undefined)).toEqual({ computerSessionId: "c-2", implicit: true });
  });

  test("a remembered window that is gone is forgotten, its computer kept", async () => {
    const current = new CurrentComputerWindow({ latestLiveSession: async () => "c-2" });
    current.use("c-1", "w-1");
    current.failed(await current.target({}), "window");
    expect(await current.session(undefined)).toEqual({ computerSessionId: "c-1", implicit: true });
    await expect(current.target({})).rejects.toMatchObject({ code: "computer_target_required" });
  });

  test("a remembered window that is gone keeps its explicitly named computer", async () => {
    const current = new CurrentComputerWindow({ latestLiveSession: async () => "c-2" });
    current.use("c-1", "w-1");
    current.failed(await current.target({ computerSessionId: "c-1" }), "window");
    expect(await current.session(undefined)).toEqual({ computerSessionId: "c-1", implicit: true });
    await expect(current.target({})).rejects.toMatchObject({ code: "computer_target_required" });
  });
});

describe("computer tools without identifiers", () => {
  test("observe then act on the current window, with a bare ref inside a batch", async () => {
    const target = computerTarget("window-1");
    const requests: ComputerActionRequest[] = [];
    const observed: string[] = [];
    const tools = definitions({
      listComputerSessions: async () => ({ revision: 1, sessions: [computerSession()] }),
      captureComputerTarget: async (_workspace, computer, targetId) => {
        observed.push(`${computer}/${targetId}`);
        return {
          frameId: "frame-1",
          targetGeneration: target.targetGeneration,
          width: 8,
          height: 8,
          mediaType: "image/png",
          data: PIXEL_PNG,
        } as never;
      },
      observeComputerTarget: async () => observation(target),
      getComputerSession: async () =>
        ({ ...computerSession(), capabilities: { actionBatches: false } }) as never,
      getComputerActionReceipt: async () => {
        throw new OpenGeniApiError(404, "operation not found", { code: "resource_not_found" });
      },
      actInComputer: async (_workspace, computer, value) => {
        expect(computer).toBe(computerSessionId);
        requests.push(value);
        return receipt(value.operationId, observation(target));
      },
    });
    // The first call names the window, as computer_open's targets show it.
    const first = await tools.computer_observe!.execute(
      { targetId: "window-1" },
      { operationId: randomUUID(), caller: model },
    );
    expect(first.isError).not.toBe(true);
    expect(observed).toEqual([`${computerSessionId}/window-1`]);
    const acted = await tools.computer_act!.execute(
      {
        action: {
          type: "batch",
          actions: [
            { type: "semantic", locator: "e7", action: "invoke" },
            { type: "keyboard", action: "type", value: "Ada" },
          ],
        },
      },
      { operationId: randomUUID(), caller: model },
    );
    expect(acted.isError).not.toBe(true);
    expect(requests.map((request) => request.targetId)).toEqual(["window-1", "window-1"]);
    expect(requests[0]!.action).toEqual({
      type: "semantic",
      locator: { kind: "ref", ref: "e7" },
      action: "invoke",
    });
  });

  test("an action that opens a window makes it the current window", async () => {
    const opened = computerTarget("window-2");
    const targets: string[] = [];
    const tools = definitions({
      listComputerSessions: async () => ({ revision: 1, sessions: [computerSession()] }),
      listComputerTargets: async () =>
        ({ computerSessionId, targets: [computerTarget("window-1"), opened] }) as never,
      actInComputer: async (_workspace, _computer, value) => {
        targets.push(value.targetId);
        return receipt(value.operationId, observation(opened), "window-1");
      },
    });
    const invoke = (fields: Record<string, unknown>) =>
      tools.computer_act!.execute(
        {
          ...fields,
          expectedObservationId: randomUUID(),
          action: { type: "semantic", locator: "e1", action: "invoke" },
        },
        { operationId: randomUUID(), caller: model },
      );
    expect((await invoke({ targetId: "window-1" })).isError).not.toBe(true);
    expect((await invoke({})).isError).not.toBe(true);
    expect(targets).toEqual(["window-1", "window-2"]);
  });

  test("omitting the window before any window was used says how to name one", async () => {
    const tools = definitions({
      listComputerSessions: async () => ({ revision: 1, sessions: [computerSession()] }),
    });
    const result = await tools.computer_act!.execute(
      { action: { type: "keyboard", action: "press", value: "Enter" } },
      { operationId: randomUUID(), caller: model },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: {
        code: "computer_target_required",
        message:
          "No window of this computer has been used yet in this turn. Pass targetId from computer_open or computer_targets.",
        retryable: false,
      },
    });
  });

  test("a computer found gone under its remembered window is not kept as current", async () => {
    const other = randomUUID();
    const listed: string[] = [];
    let gone = false;
    const tools = definitions({
      listComputerSessions: async () => ({
        revision: 1,
        sessions: [{ ...computerSession(), id: other }],
      }),
      getComputerSession: async () => computerSession() as never,
      observeComputerTarget: async () => {
        if (gone)
          throw new OpenGeniApiError(404, JSON.stringify({ message: "ComputerSession not found" }));
        return observation(computerTarget("window-1"));
      },
      actInComputer: async (_workspace, _computer, value) => {
        if (gone)
          throw new OpenGeniApiError(404, JSON.stringify({ message: "ComputerSession not found" }));
        return receipt(value.operationId, observation(computerTarget("window-1")));
      },
      listComputerTargets: async (_workspace, computer) => {
        listed.push(computer);
        return { computerSessionId: computer, targets: [] } as never;
      },
    });
    await tools.computer_open!.execute(
      { computerSessionId },
      { operationId: randomUUID(), caller: model },
    );
    const invoke = (fields: Record<string, unknown>) =>
      tools.computer_act!.execute(
        {
          ...fields,
          expectedObservationId: randomUUID(),
          action: { type: "semantic", locator: "e1", action: "invoke" },
        },
        { operationId: randomUUID(), caller: model },
      );
    expect((await invoke({ targetId: "window-1" })).isError).not.toBe(true);
    gone = true;
    // The remembered window's computer has ended: the next call without
    // identifiers resolves the computer afresh instead of asking for a window.
    expect((await invoke({})).isError).toBe(true);
    listed.length = 0;
    await tools.computer_targets!.execute({}, { operationId: randomUUID(), caller: model });
    expect(listed).toEqual([other]);
  });

  test("computer_targets uses the computer computer_open returned", async () => {
    const listed: string[] = [];
    const other = randomUUID();
    const tools = definitions({
      getComputerSession: async () => ({ ...computerSession(), id: other }) as never,
      listComputerTargets: async (_workspace, computer) => {
        listed.push(computer);
        return { computerSessionId: computer, targets: [] } as never;
      },
    });
    await tools.computer_open!.execute(
      { computerSessionId: other },
      { operationId: randomUUID(), caller: model },
    );
    await tools.computer_targets!.execute({}, { operationId: randomUUID(), caller: model });
    expect(listed).toEqual([other, other]);
  });

  test("without memory, a computer left on a machine the chat moved away from is not used", async () => {
    const sandboxGroupId = randomUUID();
    const machine = randomUUID();
    const listed: string[] = [];
    const here = { ...computerSession(), id: randomUUID(), lastUsedAt: "2026-10-24T00:00:00.000Z" };
    here.placement = { kind: "connected_machine", sandboxId: machine };
    const left = { ...computerSession(), lastUsedAt: "2026-10-24T00:30:00.000Z" };
    left.placement = { kind: "sandbox_group", sandboxGroupId };
    const tools = definitions({
      getSession: async () => ({ activeSandboxId: machine, sandboxGroupId }) as never,
      listComputerSessions: async () => ({ revision: 1, sessions: [left, here] }),
      listComputerTargets: async (_workspace, computer) => {
        listed.push(computer);
        return { computerSessionId: computer, targets: [] } as never;
      },
    });
    await tools.computer_targets!.execute({}, { operationId: randomUUID(), caller: model });
    expect(listed).toEqual([here.id]);
  });

  test("browser tools likewise skip a browser left on a machine the chat moved away from", async () => {
    const sandboxGroupId = randomUUID();
    const machine = randomUUID();
    const browser = (placement: unknown, lastUsedAt: string) => ({
      id: randomUUID(),
      lifecycle: "active",
      placement,
      lastUsedAt,
      associations: [{ sessionId, lastUsedAt }],
    });
    const here = browser({ kind: "connected_machine", sandboxId: machine }, now);
    const left = browser({ kind: "sandbox_group", sandboxGroupId }, "2026-10-24T01:30:00.000Z");
    const external = browser(
      { kind: "external_provider", providerId: "provider", placementId: "placement" },
      "2026-10-24T01:20:00.000Z",
    );
    const listed: string[] = [];
    const options = {
      transport: {
        getSession: async () => ({ activeSandboxId: machine, sandboxGroupId }),
        listBrowserSessions: async () => ({ revision: 1, sessions: list }),
        listBrowserTargets: async (_workspace: string, id: string) => {
          listed.push(id);
          return { browserSessionId: id, controllerGeneration: "controller-1", targets: [] };
        },
      } as unknown as InteractionTransport,
      workspaceId,
      sessionId,
      selectedTools: ["browser_tabs"] as const,
      permissions: ["sessions:read", "sessions:control"],
    };
    const [tabs] = createInteractionAttemptToolDefinitions({
      ...options,
      selectedTools: [...options.selectedTools],
    });
    let list = [left, here];
    await tabs!.execute({ operation: "list" }, { operationId: randomUUID(), caller: model });
    expect(listed).toEqual([here.id]);
    // A browser on an external provider is on neither machine, so it stays
    // the current one when it was used last.
    list = [left, external, here];
    const [again] = createInteractionAttemptToolDefinitions({
      ...options,
      selectedTools: [...options.selectedTools],
    });
    await again!.execute({ operation: "list" }, { operationId: randomUUID(), caller: model });
    expect(listed).toEqual([here.id, external.id]);
  });

  test("computer_act's model schema takes a bare ref as a locator and leaves ids optional", () => {
    const act = createInteractionAttemptToolDefinitions({
      transport: {} as InteractionTransport,
      workspaceId,
      sessionId,
      selectedTools: ["computer_act"],
      permissions: ["sessions:control"],
    })[0]!;
    const schema = act.inputSchema as {
      required?: string[];
      properties: { action: { properties: { locator: { anyOf: Array<{ type?: string }> } } } };
    };
    expect(schema.required ?? []).toEqual(["action"]);
    expect(schema.properties.action.properties.locator.anyOf[0]).toEqual({
      type: "string",
      description: "An element ref.",
    });
    // The model view is computed once from the tool's schema.
    expect(computerActModelInputSchema(act.inputSchema)).toBeDefined();
  });
});

const PIXEL_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGP4z8DwnxRmGBwmAADsSDzdHHtxMgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function definitions(transport: Partial<InteractionTransport>) {
  const tools = createInteractionAttemptToolDefinitions({
    transport: transport as InteractionTransport,
    workspaceId,
    sessionId,
    selectedTools: [
      "computer_open",
      "computer_targets",
      "computer_observe",
      "computer_act",
      "computer_clipboard",
    ],
    permissions: ["sessions:read", "sessions:control"],
  });
  return Object.fromEntries(tools.map((tool) => [tool.identity.toolName, tool]));
}

function computerSession(): ComputerSession {
  return {
    id: computerSessionId,
    accountId,
    workspaceId,
    name: "Computer",
    lifecycle: "active",
    placement: { kind: "sandbox_group", sandboxGroupId: randomUUID() },
    controller: null,
    platform: null,
    adapter: null,
    seatId: null,
    displayId: null,
    capabilities: null,
    associations: [
      {
        sessionId,
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
  } as ComputerSession;
}

function computerTarget(id: string): ComputerTarget {
  return {
    id,
    computerSessionId,
    controllerGeneration: "controller-1",
    targetGeneration: `generation-${id}`,
    kind: "window",
    applicationId: "test.app",
    processId: 42,
    title: id,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    focused: true,
  };
}

function observation(target: ComputerTarget): ComputerObservation {
  return {
    protocolVersion: 1,
    observationId: randomUUID(),
    computerSessionId,
    target,
    frameId: "frame-1",
    semantic: { kind: "snapshot", roots: [], nodeCount: 0 },
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    observedAt: now,
  };
}

function receipt(
  operationId: string,
  observed: ComputerObservation,
  targetId = observed.target.id,
): ComputerActionReceipt {
  return {
    protocolVersion: 1,
    operationId,
    computerSessionId,
    controllerGeneration: "controller-1",
    targetId,
    state: "completed",
    dispatchedAt: now,
    settledAt: now,
    observation: observed,
    error: null,
  };
}
