import { expect, test } from "bun:test";
import type {
  ComputerActionRequest,
  ComputerObservation,
  ComputerSession,
  ComputerSessionAttachment,
  ComputerSessionInputPosture,
  ComputerTarget,
} from "@opengeni/sdk/interaction";
import { ComputerViewer } from "../src/components/computer-viewer";
import type { ComputerFrameWebSocket } from "../src/hooks/use-computer-frame-stream";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent } from "./render-hook";

registerDom();

const computerSessionId = "44444444-4444-4444-8444-444444444444";
const now = "2026-08-10T12:00:00.000Z";
const target: ComputerTarget = {
  id: "screen-1",
  computerSessionId,
  controllerGeneration: "controller-1",
  targetGeneration: "target-1",
  kind: "screen",
  applicationId: null,
  processId: null,
  title: "Fixture screen",
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  focused: false,
};
const session: ComputerSession = {
  id: computerSessionId,
  accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceId: WORKSPACE_ID,
  name: "Fixture Desktop",
  lifecycle: "active",
  placement: { kind: "sandbox_group", sandboxGroupId: "66666666-6666-4666-8666-666666666666" },
  controller: {
    controllerId: "fixture-controller",
    controllerGeneration: "controller-1",
    placementInstanceId: "placement-1",
  },
  platform: "linux",
  adapter: "fixture.desktop.v1",
  seatId: "seat-1",
  displayId: ":101",
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
  associations: [
    {
      sessionId: SESSION_ID,
      turnId: null,
      attemptId: null,
      relationship: "using",
      actorSubjectId: "user:fixture",
      lastUsedAt: now,
    },
  ],
  createdBySubjectId: "user:fixture",
  createdAt: now,
  lastUsedAt: now,
  failureCode: null,
};

class FrameSocket extends EventTarget {
  binaryType = "arraybuffer";
  readyState = 1;
  close() {
    this.readyState = 3;
  }
  send() {}
}

test.each([undefined, false, true])(
  "paints canonical pixels and honors attachment input posture (%p)",
  async (inputAllowed) => {
    const actions: ComputerActionRequest[] = [];
    const sockets: FrameSocket[] = [];
    const urls: string[] = [];
    let painted = 0;
    const priorBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
    const priorContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: async () => ({ close() {} }),
    });
    HTMLCanvasElement.prototype.getContext = (() => ({
      drawImage: () => painted++,
    })) as unknown as typeof priorContext;
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [session] }),
      getComputerSession: async () => session,
      listComputerTargets: async () => ({
        computerSessionId,
        controllerGeneration: "controller-1",
        targets: [target],
      }),
      observeComputerTarget: async () => ({
        protocolVersion: 1,
        observationId: "observation-1",
        computerSessionId,
        target,
        frameId: null,
        semantic: null,
        screenshot: null,
        focusedRef: null,
        changedRegions: [],
        observedAt: now,
      }),
      attachComputerSession: async () => ({
        computerSessionId,
        controllerGeneration: "controller-1",
        targetId: target.id,
        ...(inputAllowed === undefined ? {} : { inputAllowed }),
        stream: {
          kind: "direct_websocket",
          url: "wss://computer.example.test/targets/screen-1/frames",
          protocols: ["opengeni.computer.v1", "opengeni.auth.fixture"],
        },
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      }),
      actInComputer: async (_workspaceId, _resourceId, request) => {
        actions.push(request);
        return {
          protocolVersion: 1,
          operationId: request.operationId,
          computerSessionId,
          controllerGeneration: "controller-1",
          targetId: target.id,
          state: "completed",
          dispatchedAt: now,
          settledAt: now,
          observation: null,
          error: null,
        };
      },
    });
    const rendered = await renderComponent(
      <ComputerViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        initialComputerSessionId={computerSessionId}
        webSocketFactory={(url, protocols) => {
          expect(protocols[0]).toBe("opengeni.computer.v1");
          urls.push(url);
          const socket = new FrameSocket();
          sockets.push(socket);
          return socket as unknown as ComputerFrameWebSocket;
        }}
      />,
    );
    try {
      await flush(40);
      expect(sockets).toHaveLength(1);
      await actRun(() => {
        sockets[0]!.dispatchEvent(new Event("open"));
        sockets[0]!.dispatchEvent(new MessageEvent("message", { data: frameMessage() }));
      });
      await flush(20);
      const canvas = rendered.container.querySelector<HTMLCanvasElement>("canvas")!;
      expect(painted).toBe(1);
      expect(canvas.className).not.toContain("invisible");
      expect(urls[0]).toContain("/frames");
      const keyboard = rendered.container.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='Desktop keyboard input']",
      )!;
      expect(keyboard.disabled).toBe(inputAllowed === false);
      canvas.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
      await actRun(() => {
        for (const type of ["pointerdown", "pointerup"]) {
          canvas.dispatchEvent(
            new MouseEvent(type, { bubbles: true, button: 0, clientX: 10, clientY: 20 }),
          );
        }
        keyboard.value = "fixture text";
        keyboard.dispatchEvent(new InputEvent("input", { bubbles: true }));
      });
      await flush(350);
      if (inputAllowed === false) expect(actions).toEqual([]);
      else {
        expect(actions).toHaveLength(2);
        expect(actions.find(({ action }) => action.type === "pointer")).toMatchObject({
          targetId: target.id,
          expectedTargetGeneration: "target-1",
          expectedObservationId: null,
          expectedFrameId: "frame-painted-1",
          action: { type: "pointer", frameId: "frame-painted-1", action: "click", x: 0, y: 0 },
        });
      }
    } finally {
      await rendered.unmount();
      HTMLCanvasElement.prototype.getContext = priorContext;
      if (priorBitmap) Object.defineProperty(globalThis, "createImageBitmap", priorBitmap);
      else Reflect.deleteProperty(globalThis, "createImageBitmap");
    }
  },
);

test.each([false, true])(
  "denied attachment disables semantic mutations with a painted frame (%p)",
  async (paintFrame) => {
    const fixture = await semanticFixture(async () => attachment(false));
    try {
      if (paintFrame) await fixture.paint();
      expect(fixture.rendered.container.textContent).not.toContain("App controls remain available");
      await actRun(() => fixture.controlsButton().click());
      const controls = fixture.rendered.container.querySelector("aside")!;
      expect(controls.textContent).toContain("View only");
      const invoke = [...controls.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Fixture button"),
      )!;
      const input = controls.querySelector<HTMLInputElement>(
        "input[aria-label='Set Fixture entry']",
      )!;
      const submit = controls.querySelector<HTMLButtonElement>("button[type='submit']")!;
      expect(invoke.disabled).toBe(true);
      expect(input.disabled).toBe(true);
      expect(submit.disabled).toBe(true);
      await actRun(() => {
        invoke.click();
        controls
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await flush();
      expect(fixture.actions).toEqual([]);
      expect(
        fixture.rendered.container.querySelector("button[aria-label='Refresh desktops']"),
      ).toBeTruthy();
    } finally {
      await fixture.close();
    }
  },
);

test("Refresh rechecks a denied live attachment and keeps controls disabled while pending", async () => {
  let attachmentCalls = 0;
  let resolveRefresh!: (value: ComputerSessionAttachment) => void;
  const freshAttachment = new Promise<ComputerSessionAttachment>((resolve) => {
    resolveRefresh = resolve;
  });
  const fixture = await semanticFixture(async (_workspace, _resource, _request, options) => {
    expect(options?.timeoutMs).toBe(15_000);
    attachmentCalls += 1;
    return attachmentCalls === 1 ? attachment(false) : await freshAttachment;
  });
  try {
    await fixture.paint();
    await actRun(() => fixture.controlsButton().click());
    const refresh = fixture.rendered.container.querySelector<HTMLButtonElement>(
      "button[aria-label='Refresh desktops']",
    )!;
    expect(refresh.disabled).toBe(false);
    await actRun(() => refresh.click());
    await flush(30);
    expect(attachmentCalls).toBe(2);
    expect(refresh.disabled).toBe(true);
    expect(refresh.getAttribute("aria-busy")).toBe("true");
    expect(
      fixture.rendered.container.querySelector<HTMLInputElement>(
        "input[aria-label='Set Fixture entry']",
      )!.disabled,
    ).toBe(true);
    expect(fixture.rendered.container.textContent).not.toContain("App controls remain available");
    expect(fixture.actions).toEqual([]);
    await actRun(() => resolveRefresh(attachment(true)));
    await flush(20);
    await fixture.paint();
    expect(refresh.disabled).toBe(false);
    const invoke = [...fixture.rendered.container.querySelectorAll("aside button")].find((button) =>
      button.textContent?.includes("Fixture button"),
    ) as HTMLButtonElement;
    expect(invoke.disabled).toBe(false);
    await actRun(() => invoke.click());
    await flush();
    expect(fixture.actions).toHaveLength(1);
    expect(fixture.actions[0]!.action).toEqual({
      type: "semantic",
      locator: { kind: "ref", ref: "button-1" },
      action: "invoke",
    });
  } finally {
    await fixture.close();
  }
});

test("failed input-posture refresh stays denied and exposes the attachment error", async () => {
  let attachmentCalls = 0;
  const fixture = await semanticFixture(async () => {
    attachmentCalls += 1;
    if (attachmentCalls > 1) throw new Error("Fixture authorization unavailable");
    return attachment(false);
  });
  try {
    await fixture.paint();
    await actRun(() => fixture.controlsButton().click());
    await actRun(() =>
      fixture.rendered.container
        .querySelector<HTMLButtonElement>("button[aria-label='Refresh desktops']")!
        .click(),
    );
    await flush(30);
    expect(fixture.rendered.container.textContent).toContain("Fixture authorization unavailable");
    expect(fixture.rendered.container.textContent).not.toContain("App controls remain available");
    expect(
      fixture.rendered.container.querySelector<HTMLInputElement>(
        "input[aria-label='Set Fixture entry']",
      )!.disabled,
    ).toBe(true);
    expect(fixture.actions).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test.each(["denied", "missing", "not_found", "unavailable", "stale_resource", "stale_controller"])(
  "initial app-only controls require current explicit permission (%s)",
  async (condition) => {
    let attachments = 0;
    const getComputerInputPosture =
      condition === "missing"
        ? undefined
        : async (): Promise<ComputerSessionInputPosture> => {
            if (condition === "not_found") throw new Error("404: fixture session not found");
            if (condition === "unavailable") throw new Error("Fixture source unavailable");
            return {
              computerSessionId:
                condition === "stale_resource"
                  ? "55555555-5555-4555-8555-555555555555"
                  : computerSessionId,
              controllerGeneration:
                condition === "stale_controller" ? "controller-old" : "controller-1",
              inputAllowed: condition !== "denied",
            };
          };
    const fixture = await semanticFixture(
      async () => {
        attachments++;
        return attachment(true);
      },
      { appOnly: true, ...(getComputerInputPosture ? { getComputerInputPosture } : {}) },
    );
    try {
      expect(attachments).toBe(0);
      expect(fixture.sockets).toEqual([]);
      expect(fixture.rendered.container.textContent).toContain("View only");
      expect(fixture.rendered.container.textContent).not.toContain("App controls remain available");
      if (!fixture.rendered.container.querySelector("aside")) {
        await actRun(() => fixture.controlsButton().click());
      }
      const controls = fixture.rendered.container.querySelector("aside")!;
      const invoke = [...controls.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Fixture button"),
      )!;
      expect(invoke.disabled).toBe(true);
      expect(
        controls.querySelector<HTMLInputElement>("input[aria-label='Set Fixture entry']")!.disabled,
      ).toBe(true);
      expect(controls.textContent).toContain("Fixture entry");
      await actRun(() => {
        invoke.click();
        controls
          .querySelector("form")!
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(fixture.actions).toEqual([]);
      expect(
        fixture.rendered.container.querySelector<HTMLButtonElement>(
          "button[aria-label='Refresh desktops']",
        )!.disabled,
      ).toBe(false);
    } finally {
      await fixture.close();
    }
  },
);

test("app-only Refresh recovers explicit permission then revokes it without opening a stream", async () => {
  let postureCalls = 0;
  let resolveRecovery!: (posture: ComputerSessionInputPosture) => void;
  const recovery = new Promise<ComputerSessionInputPosture>((resolve) => {
    resolveRecovery = resolve;
  });
  const posture = (inputAllowed: boolean): ComputerSessionInputPosture => ({
    computerSessionId,
    controllerGeneration: "controller-1",
    inputAllowed,
  });
  const fixture = await semanticFixture(
    async () => {
      throw new Error("An app must not open a stream");
    },
    {
      appOnly: true,
      getComputerInputPosture: async (_workspace, _resource, options) => {
        expect(options?.timeoutMs).toBe(15_000);
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        postureCalls++;
        return postureCalls === 1
          ? posture(false)
          : postureCalls === 2
            ? await recovery
            : posture(false);
      },
    },
  );
  try {
    if (!fixture.rendered.container.querySelector("aside")) {
      await actRun(() => fixture.controlsButton().click());
    }
    const invoke = () =>
      [...fixture.rendered.container.querySelectorAll("aside button")].find((button) =>
        button.textContent?.includes("Fixture button"),
      ) as HTMLButtonElement;
    const refresh = fixture.rendered.container.querySelector<HTMLButtonElement>(
      "button[aria-label='Refresh desktops']",
    )!;
    expect(invoke().disabled).toBe(true);
    await actRun(() => refresh.click());
    await flush(20);
    expect(postureCalls).toBe(2);
    expect(refresh.disabled).toBe(true);
    expect(refresh.getAttribute("aria-busy")).toBe("true");
    expect(invoke().disabled).toBe(true);
    await actRun(() => invoke().click());
    expect(fixture.actions).toEqual([]);
    await actRun(() => resolveRecovery(posture(true)));
    expect(refresh.disabled).toBe(false);
    expect(invoke().disabled).toBe(false);
    await actRun(() => invoke().click());
    await flush();
    expect(fixture.actions).toHaveLength(1);
    expect(fixture.actions[0]).toMatchObject({
      targetId: "app-1",
      expectedObservationId: "observation-1",
      action: { type: "semantic", action: "invoke", locator: { kind: "ref", ref: "button-1" } },
    });
    await actRun(() => refresh.click());
    await flush(20);
    expect(postureCalls).toBe(3);
    expect(invoke().disabled).toBe(true);
    await actRun(() => invoke().click());
    expect(fixture.actions).toHaveLength(1);
    expect(fixture.sockets).toEqual([]);
  } finally {
    await fixture.close();
  }
});

function attachment(inputAllowed: boolean): ComputerSessionAttachment {
  return {
    computerSessionId,
    controllerGeneration: "controller-1",
    targetId: target.id,
    inputAllowed,
    stream: {
      kind: "direct_websocket",
      url: "wss://computer.example.test/targets/screen-1/frames",
      protocols: ["opengeni.computer.v1", "opengeni.auth.fixture"],
    },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
}

async function semanticFixture(
  attachComputerSession: NonNullable<Parameters<typeof fakeClient>[0]["attachComputerSession"]>,
  options: {
    appOnly?: boolean;
    getComputerInputPosture?: NonNullable<
      Parameters<typeof fakeClient>[0]["getComputerInputPosture"]
    >;
  } = {},
) {
  const actions: ComputerActionRequest[] = [];
  const sockets: FrameSocket[] = [];
  const priorBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const priorContext = HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => ({ close() {} }),
  });
  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage() {},
  })) as unknown as typeof priorContext;
  const selectedTarget: ComputerTarget = options.appOnly
    ? { ...target, id: "app-1", kind: "app", applicationId: "fixture.application", processId: 100 }
    : target;
  const observation: ComputerObservation = {
    protocolVersion: 1,
    observationId: "observation-1",
    computerSessionId,
    target: selectedTarget,
    frameId: null,
    semantic: {
      kind: "snapshot",
      roots: [
        {
          ref: "button-1",
          role: "button",
          name: "Fixture button",
          states: [],
          actions: ["invoke"],
        },
        {
          ref: "entry-1",
          role: "entry",
          name: "Fixture entry",
          states: [],
          actions: ["set_value"],
          value: "observed",
        },
      ],
      nodeCount: 2,
    },
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    observedAt: now,
  };
  const client = fakeClient({
    listComputerSessions: async () => ({ revision: 1, sessions: [session] }),
    getComputerSession: async () => session,
    listComputerTargets: async () => ({
      computerSessionId,
      controllerGeneration: "controller-1",
      targets: [selectedTarget],
    }),
    observeComputerTarget: async () => observation,
    attachComputerSession,
    ...(options.getComputerInputPosture
      ? { getComputerInputPosture: options.getComputerInputPosture }
      : {}),
    actInComputer: async (_workspace, _resource, request) => {
      actions.push(request);
      return {
        protocolVersion: 1,
        operationId: request.operationId,
        computerSessionId,
        controllerGeneration: "controller-1",
        targetId: selectedTarget.id,
        state: "completed",
        dispatchedAt: now,
        settledAt: now,
        observation: null,
        error: null,
      };
    },
  });
  const rendered = await renderComponent(
    <ComputerViewer
      client={client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      initialComputerSessionId={computerSessionId}
      webSocketFactory={() => {
        const socket = new FrameSocket();
        sockets.push(socket);
        return socket as unknown as ComputerFrameWebSocket;
      }}
    />,
  );
  await flush(40);
  return {
    rendered,
    actions,
    client,
    sockets,
    controlsButton: () =>
      [...rendered.container.querySelectorAll("button")].find((button) =>
        button.textContent?.startsWith("Controls "),
      )!,
    async paint() {
      await actRun(() => {
        sockets.at(-1)!.dispatchEvent(new Event("open"));
        sockets.at(-1)!.dispatchEvent(new MessageEvent("message", { data: frameMessage() }));
      });
      await flush(20);
    },
    async close() {
      await rendered.unmount();
      HTMLCanvasElement.prototype.getContext = priorContext;
      if (priorBitmap) Object.defineProperty(globalThis, "createImageBitmap", priorBitmap);
      else Reflect.deleteProperty(globalThis, "createImageBitmap");
    },
  };
}

function frameMessage(): ArrayBuffer {
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ),
    (character) => character.charCodeAt(0),
  );
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      frameId: "frame-painted-1",
      computerSessionId,
      controllerGeneration: "controller-1",
      targetId: target.id,
      targetGeneration: "target-1",
      sequence: 1,
      mediaType: "image/png",
      width: 1,
      height: 1,
      capturedAt: now,
      sha256: new Bun.CryptoHasher("sha256").update(png).digest("hex"),
    }),
  );
  const message = new Uint8Array(4 + metadata.byteLength + png.byteLength);
  new DataView(message.buffer).setUint32(0, metadata.byteLength, false);
  message.set(metadata, 4);
  message.set(png, 4 + metadata.byteLength);
  return message.buffer;
}
