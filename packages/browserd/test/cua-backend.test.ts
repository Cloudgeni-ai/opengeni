import { describe, expect, test } from "bun:test";
import {
  CUA_DESKTOP_TOOLS,
  CUA_WINDOWS_DESKTOP_TOOLS,
  parseSecretReference,
  referenceKey,
} from "@opengeni/contracts";
import { ComputerInteractionController } from "@opengeni/interaction";
import type { ToolResult } from "@trycua/cua-driver";
import { CuaComputerBackend, namedOperation } from "../src/cua/backend";
import { ComputerDriver } from "../src/computer-driver";
import { callDesktop, type CuaDesktopRuntime } from "../src/cua/wire";
import type {
  ComputerBackendActionCommand,
  ComputerBackendObservation,
} from "../src/computer-backend";

function result(data: Record<string, unknown>, isError = false): ToolResult {
  return {
    text: "",
    images: [],
    structuredJson: JSON.stringify(data),
    isError,
    degraded: false,
    rawJson: "{}",
  };
}

class Fixture implements CuaDesktopRuntime {
  listToolsJson?: () => Promise<string>;
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  snapshot = 0;
  captures = 0;
  live = true;
  stopped = false;
  applyLabel = "Apply";
  fieldLabel = "Password";
  title = "Fixture";
  mutation = result({ effect: "confirmed", route: "accessibility" });
  async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
    const args = JSON.parse(argumentsJson) as Record<string, unknown>;
    this.calls.push({ name, args });
    if (name === "check_permissions")
      return result({ accessibility: true, screen_recording: true });
    if (name === "start_session" || name === "end_session") return result({ status: "ok" });
    if (name === "list_windows")
      return result({
        windows: this.live
          ? [
              {
                pid: 42,
                window_id: 1,
                title: this.title,
                app_name: "Fixture",
                bounds: { x: 50, y: 50, width: 200, height: 100 },
              },
            ]
          : [],
      });
    if (name === "get_window_state") {
      const data: Record<string, unknown> = {
        pid: 42,
        window_id: 1,
        window_bounds: { x: 50, y: 50, width: 200, height: 100 },
      };
      if (args.include_accessibility_tree) {
        // The worker defaults to Markdown on every platform and returns
        // structured elements only when asked; the adapter needs both.
        expect(args.tree_format).toBe("both");
        expect(args.timeout_ms).toBe(this instanceof WindowsFixture ? 5_000 : undefined);
        const snapshot = ++this.snapshot;
        Object.assign(data, {
          snapshot_id: `s${snapshot}`,
          elements: [
            {
              element_index: 0,
              element_token: `s${snapshot}:0`,
              role: "AXButton",
              label: this.applyLabel,
              actions: ["AXPress"],
              frame: { x: 60, y: 60, w: 40, h: 20 },
            },
            {
              element_index: 1,
              element_token: `s${snapshot}:1`,
              role: "AXSecureTextField",
              label: this.fieldLabel,
              value: "must-not-leak",
              actions: [],
            },
          ],
        });
      }
      const response = result(data);
      if (args.include_screenshot) {
        Object.assign(data, {
          capture_id: `capture-${++this.captures}`,
          screenshot_width: 200,
          screenshot_height: 100,
          screenshot_frame_valid: true,
        });
        const png = Buffer.alloc(24);
        png.writeUInt32BE(0x89504e47, 0);
        png.writeUInt32BE(200, 16);
        png.writeUInt32BE(100, 20);
        response.images = [{ mimeType: "image/png", dataBase64: png.toString("base64") }];
        response.structuredJson = JSON.stringify(data);
      }
      return response;
    }
    return this.mutation;
  }
  async shutdown() {
    this.stopped = true;
  }
}

class LinuxPermissionsFixture extends Fixture {
  async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
    if (name === "check_permissions") return result({ atspi: true, x11: true });
    return await super.callTool(name, argumentsJson);
  }
}

class WindowsFixture extends Fixture {
  async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
    const response = await super.callTool(name, argumentsJson);
    if (name === "check_permissions") return result({ uia: true, post_message: true });
    if (name === "get_window_state") {
      const state = JSON.parse(response.structuredJson!);
      delete state.screenshot_frame_valid;
      if (state.elements) {
        state.elements = [
          {
            element_index: 0,
            element_token: `s${this.snapshot}:0`,
            role: "Button",
            label: "Apply",
            actions: ["invoke"],
          },
          {
            element_index: 1,
            element_token: `s${this.snapshot}:1`,
            role: "Edit",
            label: "Value",
            actions: ["set_value"],
            value: "synthetic value",
          },
          {
            element_index: 2,
            element_token: `s${this.snapshot}:2`,
            role: "Edit",
            label: "Read only",
            actions: [],
          },
          { element_index: 3, role: "Button", label: "No token", actions: ["invoke"] },
        ];
      }
      response.structuredJson = JSON.stringify(state);
    }
    return response;
  }
}

function command(observation: ComputerBackendObservation): ComputerBackendActionCommand {
  return {
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedObservationId: observation.observationId,
    expectedFrameId: null,
    action: {
      type: "semantic",
      locator: { kind: "ref", ref: observation.roots[0]!.ref },
      action: "invoke",
    },
  };
}

describe("CUA desktop boundary", () => {
  test("select presses a radio button, and is still refused on a plain button", async () => {
    class RadioFixture extends Fixture {
      async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
        const response = await super.callTool(name, argumentsJson);
        if (name !== "get_window_state" || !response.structuredJson) return response;
        const data = JSON.parse(response.structuredJson);
        if (data.elements)
          data.elements.push({
            ...data.elements[0],
            element_index: 2,
            element_token: `s${this.snapshot}:2`,
            role: "AXRadioButton",
            label: "Landscape",
          });
        response.structuredJson = JSON.stringify(data);
        return response;
      }
    }
    const fixture = new RadioFixture();
    const backend = await CuaComputerBackend.open(fixture, "macos");
    try {
      const target = (await backend.targets())[0]!;
      const observation = await backend.observe(target.id);
      const radio = observation.roots.find((node) => node.role === "radio")!;
      expect(radio.actions).toEqual(["invoke", "focus"]);
      await backend.dispatch({
        ...command(observation),
        action: { type: "semantic", action: "select", locator: { kind: "ref", ref: radio.ref } },
      });
      expect(fixture.calls.filter((call) => call.name === "click").at(-1)?.args).toMatchObject({
        element_token: "s1:2",
        button: "left",
      });
      const fresh = await backend.observe(target.id);
      await expect(
        backend.dispatch({
          ...command(fresh),
          action: { ...command(fresh).action, action: "select" } as never,
        }),
      ).rejects.toMatchObject({
        code: "unsupported",
        dispatched: false,
        message: "This element does not offer select; use one it offers: invoke, focus",
      });
    } finally {
      await backend.close();
    }
  });

  test("revives idle owned sessions and retires expired viewer controls before input", async () => {
    const fixture = new Fixture();
    const original = fixture.callTool.bind(fixture);
    const expired = new Set<string>();
    let refusedSession: string | null = null;
    fixture.listToolsJson = async () => JSON.stringify({ tools: CUA_DESKTOP_TOOLS });
    fixture.callTool = async (name, json) => {
      const args = JSON.parse(json);
      if (name === "start_session") {
        fixture.calls.push({ name, args });
        if (args.session === refusedSession)
          return result({ status: "refused", refusal: { code: "session_unavailable" } }, true);
        return result({ active: true, revived: expired.delete(args.session) });
      }
      if (expired.has(args.session)) throw new Error("expired session reached dispatch");
      if (name === "get_cursor_position") {
        fixture.calls.push({ name, args });
        return {
          ...result({ x: 1, y: 2 }),
          rawJson: JSON.stringify({ content: [], structuredContent: { x: 1, y: 2 } }),
        };
      }
      return original(name, json);
    };
    const backend = await CuaComputerBackend.open(fixture);
    try {
      const target = (await backend.targets())[0]!;
      const observation = await backend.observe(target.id);
      const frame = await backend.capture(target.id);
      const viewerSession = fixture.calls.find((call) => call.name === "start_session")!.args
        .session as string;
      expired.add(viewerSession);
      await expect(backend.dispatch(command(observation))).rejects.toMatchObject({
        code: "observation_stale",
        dispatched: false,
      });
      await expect(
        backend.dispatch({
          ...command(observation),
          expectedFrameId: frame.frameId,
          action: { type: "pointer", action: "click", frameId: frame.frameId, x: 10, y: 10 },
        }),
      ).rejects.toMatchObject({ code: "frame_stale", dispatched: false });
      expect(fixture.calls.filter((call) => call.name === "click")).toHaveLength(0);
      const refreshed = await backend.observe(target.id);
      expect(refreshed.target.targetGeneration).toBe(target.targetGeneration);
      await backend.dispatch(command(refreshed));
      expect(fixture.calls.filter((call) => call.name === "click")).toHaveLength(1);
      const native = {
        operationId: crypto.randomUUID(),
        tool: "get_cursor_position",
        arguments: {},
      };
      expect((await backend.callNative(native)).outcome).toBe("completed");
      // Native tools now own element reads: an ordinary observation lists none
      // and says why, instead of looking like an empty window.
      const nativeOwned = await backend.observe(target.id);
      expect(nativeOwned.roots).toEqual([]);
      expect(nativeOwned.readByNativeTools).toBe(true);
      const nativeSession = fixture.calls.find((call) => call.name === "get_cursor_position")!.args
        .session as string;
      expired.add(nativeSession);
      expect(
        (await backend.callNative({ ...native, operationId: crypto.randomUUID() })).outcome,
      ).toBe("completed");
      expect(fixture.calls.filter((call) => call.name === "get_cursor_position")).toHaveLength(2);
      // Quick cursor motion once per session, and again after CUA revives it.
      const motions = fixture.calls.filter((call) => call.name === "set_agent_cursor_motion");
      expect(motions.map((call) => call.args.session)).toEqual([
        viewerSession,
        viewerSession,
        nativeSession,
        nativeSession,
      ]);
      expect(motions[0]!.args).toMatchObject({
        timing: "fixed",
        glide_duration_ms: 150,
        dwell_after_click_ms: 0,
      });
      refusedSession = nativeSession;
      const computerSessionId = crypto.randomUUID();
      const controllerGeneration = "controller-fixture";
      const controller = new ComputerInteractionController({
        computerSessionId,
        controllerGeneration,
        driver: new ComputerDriver({ computerSessionId, controllerGeneration, client: backend }),
      });
      const rejected = await controller.runNative({
        ...native,
        operationId: crypto.randomUUID(),
        protocolVersion: 1,
        computerSessionId,
        controllerGeneration,
        targetId: null,
        actor: { kind: "agent", subjectId: "agent:fixture" },
      });
      expect(rejected.state).toBe("failed");
      expect(rejected.error?.code).toBe("driver_failed");
      expect(fixture.calls.filter((call) => call.name === "get_cursor_position")).toHaveLength(2);
    } finally {
      refusedSession = null;
      await backend.close();
    }
  });

  test("rejects one-pair continuation before any CUA discovery or input delivery", async () => {
    const fixture = new Fixture();
    const backend = await CuaComputerBackend.open(fixture, "macos");
    try {
      expect(backend.initialCapabilities.pointerClickContinuation === true).toBe(false);
      const before = fixture.calls.length;
      const continuation: ComputerBackendActionCommand = {
        targetId: "synthetic-window",
        expectedTargetGeneration: "generation-1",
        expectedObservationId: null,
        expectedFrameId: "painted-1",
        action: {
          type: "pointer",
          action: "click",
          clickCount: 2,
          frameId: "painted-1",
          x: 20,
          y: 10,
        },
      };
      await expect(backend.validate(continuation)).rejects.toMatchObject({
        code: "unsupported",
        dispatched: false,
      });
      await expect(backend.dispatch(continuation)).rejects.toMatchObject({
        code: "unsupported",
        dispatched: false,
      });
      expect(fixture.calls.slice(before).filter((call) => call.name !== "start_session")).toEqual(
        [],
      );
    } finally {
      await backend.close();
    }
  });

  test("Windows Edit values and value-label fallbacks stay redacted without password metadata", async () => {
    const fixture = new WindowsFixture();
    const original = fixture.callTool.bind(fixture);
    const secret = "synthetic protected value";
    fixture.callTool = async (name, args) => {
      const response = await original(name, args);
      if (name === "get_window_state" && JSON.parse(args).include_accessibility_tree) {
        const state = JSON.parse(response.structuredJson!);
        state.elements = [
          {
            element_index: 0,
            element_token: "s1:0",
            role: "Edit",
            label: "Named field",
            value: secret,
            actions: ["set_value"],
          },
          {
            element_index: 1,
            element_token: "s1:1",
            role: "Edit",
            label: secret,
            value: secret,
            actions: ["set_value"],
          },
          {
            element_index: 2,
            element_token: "s1:2",
            role: "Edit",
            label: "Value unavailable",
            actions: [],
          },
        ];
        response.structuredJson = JSON.stringify(state);
      }
      return response;
    };
    const backend = await CuaComputerBackend.open(fixture, "windows");
    try {
      const target = (await backend.targets())[0]!;
      const observation = await backend.observe(target.id);
      expect(JSON.stringify(observation)).not.toContain(secret);
      expect(observation.roots.map((node) => node.value)).toEqual([
        { redacted: true, reason: "policy" },
        { redacted: true, reason: "policy" },
        { redacted: true, reason: "policy" },
      ]);
      expect(observation.roots[0]).toMatchObject({
        ref: "e1",
        name: "Named field",
        actions: ["set_value"],
      });
      expect(observation.roots[1]).toMatchObject({ ref: "e2", actions: ["set_value"] });
      expect(observation.roots[1]!.name).toBeUndefined();
      await backend.dispatch({
        ...command(observation),
        action: {
          type: "semantic",
          action: "set_value",
          locator: { kind: "ref", ref: "e2" },
          value: "Replacement",
        },
      });
      expect(fixture.calls.find((call) => call.name === "set_value")?.args).toMatchObject({
        element_token: "s1:1",
        value: "Replacement",
        delivery_mode: "background",
      });
    } finally {
      await backend.close();
    }
  });

  test("Windows retains real platform identity and advertises UIA actions and ordinary input", async () => {
    const fixture = new WindowsFixture();
    const backend = await CuaComputerBackend.open(fixture, "windows");
    try {
      expect(backend.identity).toEqual({
        platform: "windows",
        adapterId: "opengeni.cua.windows.v1",
      });
      expect(await backend.capabilities()).toMatchObject({
        semanticObservation: true,
        semanticActions: true,
        backgroundActions: true,
        windowCapture: true,
        pointerInput: true,
        keyboardInput: true,
        backgroundInput: false,
      });
      expect(
        fixture.calls
          .filter((call) => call.name === "check_permissions")
          .every((call) => Object.keys(call.args).length === 0),
      ).toBe(true);
      const target = (await backend.targets())[0]!;
      const observation = await backend.observe(target.id);
      expect(observation.roots.map((node) => [node.role, node.actions])).toEqual([
        ["button", ["invoke"]],
        ["textbox", ["set_value"]],
        ["textbox", []],
        ["button", []],
      ]);
      await backend.dispatch(command(observation));
      const fresh = await backend.observe(target.id);
      await backend.dispatch({
        ...command(fresh),
        action: {
          type: "semantic",
          action: "set_value",
          locator: { kind: "ref", ref: fresh.roots[1]!.ref },
          value: "Synthetic Ω",
        },
      });
      expect(fixture.calls.find((call) => call.name === "set_value")?.args).toMatchObject({
        value: "Synthetic Ω",
        delivery_mode: "background",
        pid: 42,
        window_id: 1,
      });
      const latest = await backend.observe(target.id);
      await expect(
        backend.dispatch({
          ...command(latest),
          action: {
            type: "semantic",
            action: "set_value",
            locator: { kind: "ref", ref: latest.roots[2]!.ref },
            value: "Rejected",
          },
        }),
      ).rejects.toMatchObject({
        code: "unsupported",
        dispatched: false,
        message: "This element offers no actions; act on a nearby control or its window instead",
      });
      expect(fixture.calls.filter((call) => call.name === "set_value")).toHaveLength(1);
    } finally {
      await backend.close();
    }
  });

  test("Windows delivers pointer and keyboard input in the foreground with Windows modifiers", async () => {
    const fixture = new WindowsFixture();
    const backend = await CuaComputerBackend.open(fixture, "windows");
    try {
      const target = (await backend.targets())[0]!;
      const frame = await backend.capture(target.id);
      const observation = await backend.observe(target.id);
      await backend.dispatch({
        ...command(observation),
        expectedFrameId: frame.frameId,
        action: { type: "pointer", action: "click", frameId: frame.frameId, x: 120, y: 80 },
      });
      expect(fixture.calls.find((call) => call.name === "click")?.args).toMatchObject({
        pid: 42,
        window_id: 1,
        x: 120,
        y: 80,
        button: "left",
        count: 1,
        delivery_mode: "foreground",
      });
      await backend.dispatch({
        ...command(await backend.observe(target.id)),
        action: { type: "keyboard", action: "type", value: "Hello Ω" },
      });
      expect(fixture.calls.find((call) => call.name === "type_text")?.args).toMatchObject({
        text: "Hello Ω",
        delivery_mode: "foreground",
      });
      await backend.dispatch({
        ...command(await backend.observe(target.id)),
        action: { type: "keyboard", action: "press", value: "Meta+Shift+S" },
      });
      expect(fixture.calls.find((call) => call.name === "press_key")?.args).toMatchObject({
        key: "s",
        modifiers: ["win", "shift"],
        delivery_mode: "foreground",
      });
      await expect(
        backend.validate({
          ...command(await backend.observe(target.id)),
          action: { type: "keyboard", action: "press", value: "Fn+A" },
        }),
      ).rejects.toMatchObject({ code: "unsupported", dispatched: false });
    } finally {
      await backend.close();
    }
  });

  test("Windows capture requires exact native publication, including failed-image envelopes", async () => {
    for (const change of [
      { capture_id: undefined },
      { pid: 43 },
      { window_id: 2 },
      { screenshot_error: "synthetic capture failure" },
      { screenshot_frame_valid: false },
      { screenshot_width: 201 },
    ]) {
      const fixture = new WindowsFixture();
      const original = fixture.callTool.bind(fixture);
      fixture.callTool = async (name, args) => {
        const response = await original(name, args);
        if (name === "get_window_state")
          response.structuredJson = JSON.stringify({
            ...JSON.parse(response.structuredJson!),
            ...change,
          });
        return response;
      };
      const backend = await CuaComputerBackend.open(fixture, "windows");
      try {
        const target = (await backend.targets())[0]!;
        await expect(backend.capture(target.id)).rejects.toMatchObject({
          code: "driver_failed",
          dispatched: false,
        });
        expect(
          fixture.calls.some((call) => call.name === "click" || call.name === "set_value"),
        ).toBe(false);
      } finally {
        await backend.close();
      }
    }
  });

  test("reports a walk that ran out of time as an incomplete observation", async () => {
    const fixture = new Fixture();
    const original = fixture.callTool.bind(fixture);
    let partial = true;
    fixture.callTool = async (name, argumentsJson) => {
      const response = await original(name, argumentsJson);
      const args = JSON.parse(argumentsJson) as Record<string, unknown>;
      if (name === "get_window_state" && args.include_accessibility_tree && partial) {
        const state = JSON.parse(response.structuredJson!);
        Object.assign(state, {
          truncated: true,
          truncation_reason: "timeout",
          nodes_visited: 296,
          nodes_pending: 567,
        });
        response.structuredJson = JSON.stringify(state);
      }
      return response;
    };
    const backend = await CuaComputerBackend.open(fixture);
    try {
      const target = (await backend.targets())[0]!;
      const cut = await backend.observe(target.id);
      expect(cut.incomplete).toEqual({ reason: "time_budget", unreadCount: 567 });
      expect(cut.roots.length).toBeGreaterThan(0);
      partial = false;
      expect((await backend.observe(target.id)).incomplete).toBeUndefined();
    } finally {
      await backend.close();
    }
  });

  test("invokes controls and opens their menu through the native button contract", async () => {
    const fixture = new Fixture();
    const original = fixture.callTool.bind(fixture);
    let invoked = 0,
      menus = 0;
    fixture.callTool = async (name, argumentsJson) => {
      const response = await original(name, argumentsJson);
      const args = JSON.parse(argumentsJson) as Record<string, unknown>;
      if (name === "get_window_state" && args.include_accessibility_tree) {
        const state = JSON.parse(response.structuredJson!);
        state.elements[0].actions.push("AXShowMenu");
        response.structuredJson = JSON.stringify(state);
      }
      if (name === "click") {
        // Current CUA's typed click input refuses the old action field. Both
        // pinned Mac CUA and the current contract use right for AXShowMenu.
        if ("action" in args)
          return result({ status: "refused", refusal: { code: "invalid_arguments" } }, true);
        if (args.button === "right") menus++;
        else invoked++;
      }
      return response;
    };
    const backend = await CuaComputerBackend.open(fixture);
    try {
      const target = (await backend.targets())[0]!;
      await backend.dispatch(command(await backend.observe(target.id)));
      const observed = await backend.observe(target.id);
      const menu = command(observed);
      menu.action = {
        type: "semantic",
        locator: { kind: "ref", ref: observed.roots[0]!.ref },
        action: "show_menu",
      };
      await backend.dispatch(menu);
      expect({ invoked, menus }).toEqual({ invoked: 1, menus: 1 });
      expect(fixture.calls.filter((call) => call.name === "click")).toHaveLength(2);
    } finally {
      await backend.close();
    }
  });

  test("focuses a macOS control through CUA's element focus click", async () => {
    const fixture = new Fixture();
    const original = fixture.callTool.bind(fixture);
    const focused: Record<string, unknown>[] = [];
    fixture.callTool = async (name, argumentsJson) => {
      const args = JSON.parse(argumentsJson) as Record<string, unknown>;
      if (name === "click" && args.action === "focus") focused.push(args);
      return await original(name, argumentsJson);
    };
    const backend = await CuaComputerBackend.open(fixture);
    try {
      const target = (await backend.targets())[0]!;
      const observed = await backend.observe(target.id);
      expect(observed.roots[0]!.actions).toEqual(["invoke", "focus"]);
      expect(observed.roots[1]!.actions).toEqual(["set_value", "focus"]);
      const focus = command(observed);
      focus.action = {
        type: "semantic",
        locator: { kind: "ref", ref: observed.roots[0]!.ref },
        action: "focus",
      };
      await backend.dispatch(focus);
      // The ref is Opengeni's; CUA gets its own token of the latest snapshot.
      expect(focused).toEqual([
        expect.objectContaining({
          element_token: `${observed.observationId.split(":").pop()}:0`,
          action: "focus",
          delivery_mode: "background",
        }),
      ]);
    } finally {
      await backend.close();
    }
  });

  test("an element that cannot take the focus says what to do instead", async () => {
    const fixture = new LinuxPermissionsFixture();
    const backend = await CuaComputerBackend.open(fixture, "linux");
    try {
      const target = (await backend.targets())[0]!;
      const observed = await backend.observe(target.id);
      const focus = command(observed);
      focus.action = {
        type: "semantic",
        locator: { kind: "ref", ref: observed.roots[0]!.ref },
        action: "focus",
      };
      await expect(backend.dispatch(focus)).rejects.toMatchObject({
        code: "unsupported",
        message:
          "Elements cannot be focused on their own here: invoke the element, or set its value",
      });
    } finally {
      await backend.close();
    }
  });

  test("keeps tokens current, redacts protected values and never calls browser tools", async () => {
    const fixture = new Fixture(),
      backend = await CuaComputerBackend.open(fixture);
    try {
      expect(backend.initialCapabilities.backgroundInput).toBe(true);
      expect((await backend.capabilities()).backgroundInput).toBe(true);
      const target = (await backend.targets())[0]!;
      const first = await backend.observe(target.id);
      expect(JSON.stringify(first)).not.toContain("must-not-leak");
      const second = await backend.observe(target.id);
      // CUA honours only its latest tokens: the ref, the same in both
      // readings, is sent as its element's token from the latest one.
      expect(second.roots[0]!.ref).toBe(first.roots[0]!.ref);
      await backend.dispatch(command(first));
      expect(fixture.calls.filter((call) => call.name === "click").at(-1)?.args).toMatchObject({
        element_token: second.observationId.split(":").pop() + ":0",
      });
      const fresh = await backend.observe(target.id);
      await backend.validate(command(fresh));
      await backend.dispatch(command(fresh));
      // The same ref acts again while its element is unchanged, as a page ref
      // does in a browser.
      await backend.dispatch(command(fresh));
      expect(fixture.calls.filter((call) => call.name === "click")).toHaveLength(3);
      expect(
        fixture.calls.every((call) => !call.name.startsWith("browser_") && call.name !== "page"),
      ).toBe(true);
    } finally {
      await backend.close();
    }
    expect(fixture.stopped).toBe(true);
  });

  test("maps viewer coordinates into fresh action captures for repeated scroll/drag", async () => {
    const fixture = new Fixture(),
      backend = await CuaComputerBackend.open(fixture);
    try {
      const target = (await backend.targets())[0]!;
      const observation = await backend.observe(target.id);
      const frame = await backend.capture(target.id);
      const capturesBeforeInput = fixture.captures;
      const click: ComputerBackendActionCommand = {
        ...command(observation),
        expectedFrameId: frame.frameId,
        action: { type: "pointer", action: "click", frameId: frame.frameId, x: 120, y: 80 },
      };
      await backend.validate({
        ...click,
        action: {
          type: "pointer",
          action: "drag",
          frameId: frame.frameId,
          x: 120,
          y: 80,
          endX: 130,
          endY: 80,
        },
      });
      await expect(
        backend.validate({ ...click, expectedFrameId: "other-frame" }),
      ).rejects.toMatchObject({ code: "frame_stale" });
      await backend.dispatch(click);
      expect(fixture.calls.find((call) => call.name === "click")?.args).toMatchObject({
        x: 120,
        y: 80,
        delivery_mode: "background",
      });
      await backend.dispatch({
        ...click,
        action: {
          type: "pointer",
          action: "scroll",
          frameId: frame.frameId,
          x: 120,
          y: 80,
          deltaY: 200,
        },
      });
      await backend.dispatch({
        ...click,
        action: {
          type: "pointer",
          action: "drag",
          frameId: frame.frameId,
          x: 120,
          y: 80,
          endX: 130,
          endY: 80,
        },
      });
      expect(fixture.captures).toBe(capturesBeforeInput + 3);
      expect(fixture.calls.find((call) => call.name === "scroll")?.args).toMatchObject({
        direction: "down",
        amount: 2,
      });
      expect(fixture.calls.find((call) => call.name === "drag")?.args).toMatchObject({
        from_x: 120,
        to_x: 130,
      });
    } finally {
      await backend.close();
    }
  });

  test("refreshes target generations after disappearance and does not cross windows", async () => {
    const fixture = new Fixture(),
      backend = await CuaComputerBackend.open(fixture);
    try {
      const first = (await backend.targets())[0]!;
      const observation = await backend.observe(first.id);
      fixture.live = false;
      await backend.targets();
      await expect(backend.dispatch(command(observation))).rejects.toMatchObject({
        code: "target_not_found",
        dispatched: false,
      });
      fixture.live = true;
      expect((await backend.targets())[0]!.targetGeneration).not.toBe(first.targetGeneration);
      await expect(backend.dispatch(command(observation))).rejects.toMatchObject({
        code: "target_stale",
      });
    } finally {
      await backend.close();
    }
  });

  test("a ref from an earlier observation names the same element in the latest one; an unknown one says what is current", async () => {
    const fixture = new Fixture();
    const backend = await CuaComputerBackend.open(fixture);
    try {
      const target = (await backend.targets())[0]!;
      const seen = await backend.observe(target.id);
      // An action without fences is checked against a fresh observation. CUA
      // mints new tokens for it, but an element that stayed keeps its ref,
      // which now names the fresh token.
      const fresh = await backend.observe(target.id);
      expect(fresh.roots[0]!.ref).toBe(seen.roots[0]!.ref);
      expect(fresh.observationId).not.toBe(seen.observationId);
      await backend.dispatch({
        ...command(fresh),
        action: {
          type: "semantic",
          locator: { kind: "ref", ref: seen.roots[0]!.ref },
          action: "invoke",
        },
      });
      expect(
        [...fixture.calls].reverse().find((call) => call.name === "click")?.args,
      ).toMatchObject({ element_token: expect.stringMatching(/^s[0-9a-f]+:0$/u) });
      const freshToken = (
        [...fixture.calls].reverse().find((call) => call.name === "click")!.args as {
          element_token: string;
        }
      ).element_token;
      // A ref action may name the observation its ref came from, even after
      // the window was read again.
      const again = await backend.observe(target.id);
      await backend.dispatch({ ...command(seen), targetId: again.target.id });
      const againToken = (
        [...fixture.calls].reverse().find((call) => call.name === "click")!.args as {
          element_token: string;
        }
      ).element_token;
      expect(againToken).not.toBe(freshToken);
      // Other actions still need the latest observation.
      await expect(
        backend.dispatch({
          ...command(seen),
          action: { type: "semantic", locator: { kind: "role", role: "button" }, action: "invoke" },
        }),
      ).rejects.toMatchObject({ code: "observation_stale", dispatched: false });
      // Another element changing leaves a ref alone.
      fixture.fieldLabel = "Password again";
      const sibling = await backend.observe(target.id);
      expect(sibling.roots[0]!.ref).toBe(seen.roots[0]!.ref);
      expect(sibling.roots[1]!.ref).not.toBe(seen.roots[1]!.ref);
      fixture.fieldLabel = "Password";
      // Once its element changed, or the window's title did (a Delete button
      // can look the same for another document), an earlier ref is refused
      // before any input, without quoting any label.
      const clicks = fixture.calls.filter((call) => call.name === "click").length;
      for (const change of [
        async () => {
          fixture.applyLabel = "Apply all";
        },
        async () => {
          fixture.title = "Another document";
          await backend.targets();
        },
      ]) {
        const before = await backend.observe(target.id);
        await change();
        const changed = await backend.observe(target.id);
        await expect(
          backend.dispatch({
            ...command(changed),
            action: {
              type: "semantic",
              locator: { kind: "ref", ref: before.roots[0]!.ref },
              action: "invoke",
            },
          }),
        ).rejects.toMatchObject({
          code: "observation_stale",
          dispatched: false,
          message: `CUA ref ${before.roots[0]!.ref} is from an earlier observation, and the window has changed since; use a ref from the latest observation (${changed.observationId.split(":").pop()})`,
        });
      }
      expect(fixture.calls.filter((call) => call.name === "click").length).toBe(clicks);
      // CUA's own stale refusal says what the caller does, not CUA's tool names.
      fixture.mutation = result(
        {
          effect: "refused",
          refusal: {
            code: "stale_element_token",
            message: "element_token is stale; call get_window_state again to refresh",
          },
        },
        true,
      );
      await expect(
        backend.dispatch(command(await backend.observe(target.id))),
      ).rejects.toMatchObject({
        code: "observation_stale",
        dispatched: false,
        message:
          "CUA refused the element reference because the window was read again since; observe it again and act on a ref from that observation",
      });
      // An element CUA places in another window of the app that is not a
      // target here: say nothing was done, without CUA's own tool or a
      // window that cannot be observed.
      fixture.mutation = result(
        {
          effect: "refused",
          refusal: {
            code: "element_outside_target_window",
            message:
              "Background input refused (element_outside_target_window): the addressed element belongs to window 9, a separate window of this app, not to window 1; read window 9 with get_window_state and address the element there",
          },
        },
        true,
      );
      await expect(
        backend.dispatch(command(await backend.observe(target.id))),
      ).rejects.toMatchObject({
        code: "invalid_action",
        dispatched: false,
        message: `That element is in another window of this app, not in ${target.id}, so nothing was done`,
      });
      fixture.mutation = result({ effect: "confirmed", route: "accessibility" });
      fixture.applyLabel = "Apply";
      fixture.fieldLabel = "Password";
      fixture.title = "Fixture";
      await backend.targets();
      const latest = await backend.observe(target.id);
      await expect(
        backend.dispatch({
          ...command(latest),
          action: { type: "semantic", locator: { kind: "ref", ref: "s99:0" }, action: "invoke" },
        }),
      ).rejects.toMatchObject({
        code: "locator_not_found",
        message: `CUA ref s99:0 is not in a recent observation of this window; observe it again and use a ref from the latest observation (${latest.observationId.split(":").pop()})`,
      });
      // macOS accepts the usual names for the command key, and a shortcut goes
      // through CUA's hotkey, which reaches a background app's menus.
      await backend.dispatch({
        ...command(latest),
        action: { type: "keyboard", action: "press", value: "super+n" },
      });
      expect(
        [...fixture.calls].reverse().find((call) => call.name === "hotkey")?.args,
      ).toMatchObject({
        pid: 42,
        window_id: 1,
        keys: ["cmd", "n"],
        delivery_mode: "background",
      });
      // A single key is still a key press.
      await backend.dispatch({
        ...command(await backend.observe(target.id)),
        action: { type: "keyboard", action: "press", value: "Enter" },
      });
      expect(
        [...fixture.calls].reverse().find((call) => call.name === "press_key")?.args,
      ).toMatchObject({ key: "return", modifiers: [] });
      // A menu item macOS keeps disabled in the background is refused, clearly.
      fixture.mutation = result(
        {
          effect: "refused",
          refusal: {
            code: "background_unavailable",
            message: "Save is disabled while TextEdit is in the background",
          },
        },
        true,
      );
      await expect(
        backend.dispatch({
          ...command(await backend.observe(target.id)),
          action: { type: "keyboard", action: "press", value: "cmd+s" },
        }),
      ).rejects.toMatchObject({
        code: "unsupported",
        dispatched: false,
        message:
          "CUA hotkey refused the operation: Save is disabled while TextEdit is in the background",
      });
    } finally {
      await backend.close();
    }
  });

  test("a macOS sheet is reached through its window, and refusals say how", async () => {
    // A Save sheet has its own window id inside its document window, but its
    // controls are in the document window's tree. While the sheet has focus,
    // CUA refuses background keys to either window.
    class SheetFixture extends Fixture {
      sheet = true;
      showSheet = true;
      other = false;
      // Another window of the app that the sheet also lies within.
      decoy = { x: 90, y: 55, width: 130, height: 70 };
      async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
        const args = JSON.parse(argumentsJson) as Record<string, unknown>;
        if (name === "list_windows") {
          this.calls.push({ name, args });
          return result({
            windows: [
              {
                pid: 42,
                window_id: 1,
                title: "Untitled",
                app_name: "TextEdit",
                bounds: { x: 50, y: 50, width: 200, height: 100 },
              },
              ...(this.sheet
                ? [
                    {
                      pid: 42,
                      window_id: 2,
                      title: "Save",
                      app_name: "TextEdit",
                      bounds: { x: 101, y: 60, width: 100, height: 60 },
                    },
                    {
                      pid: 42,
                      window_id: 4,
                      title: "Decoy",
                      app_name: "TextEdit",
                      bounds: this.decoy,
                    },
                  ]
                : []),
              ...(this.other
                ? [
                    {
                      pid: 42,
                      window_id: 3,
                      title: "Other",
                      app_name: "TextEdit",
                      bounds: { x: 400, y: 50, width: 200, height: 100 },
                    },
                  ]
                : []),
            ],
          });
        }
        if (name === "get_window_state" && args.window_id === 2) {
          // CUA produces neither its pixels nor its accessibility tree.
          if (!args.include_accessibility_tree)
            return {
              text: "No content produced (neither AX tree nor screenshot succeeded)",
              images: [],
              isError: true,
              degraded: false,
              rawJson: "{}",
            };
          this.calls.push({ name, args });
          return result({
            pid: 42,
            window_id: 2,
            degraded_reason:
              "ax_window_unresolved: window_id 2 exists and is owned by pid 42, but none of the AXWindow elements reports it",
          });
        }
        const response = await super.callTool(name, argumentsJson);
        // The other window reads normally, without the sheet.
        if (name === "get_window_state" && args.window_id === 4) {
          const state = JSON.parse(response.structuredJson!);
          response.structuredJson = JSON.stringify({
            ...state,
            window_id: 4,
            window_bounds: this.decoy,
          });
        }
        if (name === "get_window_state" && args.window_id === 1 && this.sheet && this.showSheet) {
          const state = JSON.parse(response.structuredJson!);
          if (state.elements) {
            state.elements.push({
              element_index: 2,
              element_token: `s${this.snapshot}:2`,
              role: "AXSheet",
              label: "save",
              actions: ["AXRaise"],
              frame: { x: 101, y: 60, w: 100, h: 60 },
            });
            response.structuredJson = JSON.stringify(state);
          }
        }
        return response;
      }
    }
    const fixture = new SheetFixture();
    const backend = await CuaComputerBackend.open(fixture, "macos");
    try {
      await backend.targets();
      // The sheet's own window has no tree: point at the window it belongs to,
      // the one whose reading now shows the sheet, though another window of
      // the app holds it too and is centered on it exactly.
      fixture.decoy = { x: 76, y: 55, width: 150, height: 70 };
      await backend.targets();
      await expect(backend.observe("cua:window:42:2")).rejects.toMatchObject({
        code: "target_stale",
        message:
          "cua:window:42:2 is a sheet attached to the window cua:window:42:1, and its controls are read and used through that window: observe cua:window:42:1 and act on its refs",
      });
      // The other window was read too, and does not show the sheet.
      expect(
        (await backend.observe("cua:window:42:4")).roots.some((node) => node.role === "AXSheet"),
      ).toBe(false);
      // When no window shows it now, no parent is guessed.
      fixture.showSheet = false;
      await expect(backend.observe("cua:window:42:2")).rejects.toMatchObject({
        code: "target_stale",
        message:
          "cua:window:42:2 cannot be read on its own. If it is a sheet or panel of another window of this app, its controls are in that window's observation: observe the window it belongs to (one of cua:window:42:1, cua:window:42:4) and act on its refs",
      });
      fixture.showSheet = true;
      const keys = (value: string, observation: ComputerBackendObservation) =>
        backend.dispatch({
          ...command(observation),
          action: { type: "keyboard", action: "type", value },
        });
      const refused = (code: string) =>
        result({ effect: "refused", code, reason: "CUA's own reason" }, true);
      // Keys aimed at the document window while its sheet has focus.
      fixture.mutation = refused("window_not_key");
      await expect(
        keys("name.txt", await backend.observe("cua:window:42:1")),
      ).rejects.toMatchObject({
        code: "invalid_action",
        dispatched: false,
        message:
          "Keys cannot reach the sheet open in this window while its app is in the background, so none were sent. Use the sheet's controls from this window's observation instead: in a file dialog invoke a sidebar place or a folder to go into it and invoke a file to choose it; set_value on a text field, invoke on a button",
      });
      // Keys aimed at the sheet's own window, which cannot be observed, stop
      // before any input with the same direction.
      const dispatched = fixture.calls.length;
      await expect(
        backend.dispatch({
          targetId: "cua:window:42:2",
          expectedTargetGeneration: (await backend.targets()).find(
            (target) => target.id === "cua:window:42:2",
          )!.targetGeneration,
          expectedObservationId: null,
          expectedFrameId: null,
          action: { type: "keyboard", action: "press", value: "Enter" },
        }),
      ).rejects.toMatchObject({
        code: "target_stale",
        dispatched: false,
        message: expect.stringContaining("observe cua:window:42:1 and act on its refs"),
      });
      expect(fixture.calls.slice(dispatched).some((call) => call.name === "press_key")).toBe(false);
      // Without a sheet, another window of the app has focus: name it.
      fixture.sheet = false;
      fixture.other = true;
      await backend.targets();
      fixture.mutation = refused("window_not_key");
      await expect(keys("text", await backend.observe("cua:window:42:1"))).rejects.toMatchObject({
        dispatched: false,
        message:
          "Keys reach only the focused window of a background app, and another of its windows has focus (one of cua:window:42:3), so none were sent: act on that window, or close it first",
      });
      // An element CUA places in another window of the app that is a target
      // here: point at that target.
      fixture.mutation = result(
        {
          effect: "refused",
          refusal: {
            code: "element_outside_target_window",
            message:
              "Background input refused (element_outside_target_window): the addressed element belongs to window 3, a separate window of this app, not to window 1; read window 3 with get_window_state and address the element there",
          },
        },
        true,
      );
      await expect(
        backend.dispatch(command(await backend.observe("cua:window:42:1"))),
      ).rejects.toMatchObject({
        code: "invalid_action",
        dispatched: false,
        message:
          "That element is in another window of this app (cua:window:42:3), not in cua:window:42:1, so nothing was done: observe cua:window:42:3 and act on its refs there",
      });
      // There is no focus action; work happens in the background.
      await expect(
        backend.dispatch({
          ...command(await backend.observe("cua:window:42:1")),
          action: { type: "focus", targetId: "cua:window:42:1" },
        }),
      ).rejects.toMatchObject({
        code: "unsupported",
        message: expect.stringContaining("it has no focus action"),
      });
    } finally {
      await backend.close();
    }
  });

  test("invoking a file dialog's folder or file opens it, though macOS does not confirm it", async () => {
    // A folder or file of a file dialog's list opens (AXOpen) rather than
    // presses; macOS answers "cannot complete" even when it went in.
    class FileDialogFixture extends Fixture {
      opened = false;
      opens = true;
      override async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
        const args = JSON.parse(argumentsJson) as Record<string, unknown>;
        if (name === "click" && args.action === "open") {
          this.calls.push({ name, args });
          if (this.opens) this.opened = true;
          return result(
            {
              error: {
                code: "ax_action_failed",
                message: "AX action failed: AXUIElementPerformAction(AXOpen) returned -25205",
              },
            },
            true,
          );
        }
        const response = await super.callTool(name, argumentsJson);
        if (name === "get_window_state" && args.include_accessibility_tree) {
          const state = JSON.parse(response.structuredJson!);
          state.elements.push({
            element_index: 2,
            element_token: `${state.snapshot_id}:2`,
            role: "AXTextField",
            label: this.opened ? "pick-me.txt" : "Downloads",
            actions: ["AXOpen", "AXConfirm"],
          });
          response.structuredJson = JSON.stringify(state);
        }
        return response;
      }
    }
    const fixture = new FileDialogFixture();
    const backend = await CuaComputerBackend.open(fixture, "macos");
    try {
      const target = (await backend.targets())[0]!;
      const open = async () => {
        const observation = await backend.observe(target.id);
        const item = observation.roots.find(
          (node) => node.name === (fixture.opened ? "pick-me.txt" : "Downloads"),
        )!;
        expect(item.actions).toContain("invoke");
        expect(item.actions).not.toContain("set_value");
        return backend.dispatch({
          ...command(observation),
          action: { type: "semantic", locator: { kind: "ref", ref: item.ref }, action: "invoke" },
        });
      };
      // It went into the folder: the reading after it shows that.
      const after = await open();
      expect(after?.roots.some((node) => node.name === "pick-me.txt")).toBe(true);
      expect(fixture.calls.filter((call) => call.name === "click").at(-1)?.args).toMatchObject({
        action: "open",
        button: "left",
      });
      // Nothing changed: the outcome is unknown, not a success.
      fixture.opens = false;
      await expect(open()).rejects.toMatchObject({
        code: "outcome_unknown",
        dispatched: true,
        message: expect.stringContaining(
          "macOS did not confirm the action, and the window reads the same as before",
        ),
      });
      // A button still presses.
      await backend.dispatch(command(await backend.observe(target.id)));
      expect(fixture.calls.filter((call) => call.name === "click").at(-1)?.args).not.toHaveProperty(
        "action",
      );
    } finally {
      await backend.close();
    }
  });

  test("the reading after an action waits for the work it started, such as a save", async () => {
    // Pressing Apply disables it as "Saving..." and shows "Loading…" text for
    // two readings; the third shows the result.
    class SavingFixture extends Fixture {
      pressed = false;
      busyReads = 2;
      /** A "Loading…" text the page shows before the press, too. */
      loadingBefore = false;
      /** How the save shows: the button's own label, or (as Chrome on macOS
       * does) a disabled button folded into the web area with the others the
       * save disables, so the web area reads "Saving... | Delete". */
      shows: "label" | "folded" = "label";
      /** The press reveals a long preview cut short with "…" instead. */
      preview = false;
      reads = 0;
      override async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
        const args = JSON.parse(argumentsJson) as Record<string, unknown>;
        if (name === "click") this.pressed = true;
        const response = await super.callTool(name, argumentsJson);
        if (name !== "get_window_state" || !args.include_accessibility_tree) return response;
        const state = JSON.parse(response.structuredJson!);
        const extra: Record<string, unknown>[] = [];
        if (this.pressed) this.reads++;
        const busy = this.pressed && this.reads <= this.busyReads;
        if (this.preview) {
          if (this.pressed)
            extra.push({
              role: "AXStaticText",
              label: "Quarterly report: revenue grew in every region and…",
              actions: [],
            });
        } else if (busy && this.shows === "folded") {
          extra.push({ role: "AXWebArea", label: "Billing", actions: [] });
          state.tree_markdown =
            '- [2] AXWebArea "Billing"\n  - AXButton "Saving..."\n  - AXButton "Delete"\n';
        } else if (busy) {
          Object.assign(state.elements[0], { label: "Saving...", enabled: false });
          extra.push({ role: "AXStaticText", label: "Loading billing details…", actions: [] });
        } else if (this.pressed) {
          extra.push({ role: "AXStaticText", label: "Saved: CF-1", actions: [] });
        }
        if (this.loadingBefore)
          extra.push({ role: "AXStaticText", label: "Loading news…", actions: [] });
        extra.forEach((element, index) =>
          state.elements.push({
            ...element,
            element_index: 2 + index,
            element_token: `${state.snapshot_id}:${2 + index}`,
          }),
        );
        response.structuredJson = JSON.stringify(state);
        return response;
      }
    }
    const names = (observation: ComputerBackendObservation | null) =>
      (observation?.roots ?? []).map((node) => node.name);

    const fixture = new SavingFixture();
    const backend = await CuaComputerBackend.open(fixture, "macos");
    try {
      const target = (await backend.targets())[0]!;
      const after = await backend.dispatch(command(await backend.observe(target.id)));
      expect(names(after)).toContain("Saved: CF-1");
      expect(names(after)).not.toContain("Saving...");
      expect(fixture.reads).toBe(3);
    } finally {
      await backend.close();
    }

    // A sign of work the page already showed before the action does not hold
    // the reading: an action on a page that is not busy reads it once.
    const idle = new SavingFixture();
    idle.busyReads = 0;
    idle.loadingBefore = true;
    const idleBackend = await CuaComputerBackend.open(idle, "macos");
    try {
      const target = (await idleBackend.targets())[0]!;
      const after = await idleBackend.dispatch(command(await idleBackend.observe(target.id)));
      expect(names(after)).toContain("Saved: CF-1");
      expect(idle.reads).toBe(1);
    } finally {
      await idleBackend.close();
    }

    // Chrome on macOS folds the disabled "Saving..." button, and the other
    // buttons the save disables, into the page's web area: its description
    // reads "Saving... | Delete".
    const folded = new SavingFixture();
    folded.shows = "folded";
    const foldedBackend = await CuaComputerBackend.open(folded, "macos");
    try {
      const target = (await foldedBackend.targets())[0]!;
      const after = await foldedBackend.dispatch(command(await foldedBackend.observe(target.id)));
      expect(names(after)).toContain("Saved: CF-1");
      expect(folded.reads).toBe(3);
    } finally {
      await foldedBackend.close();
    }

    // A long text cut short with "…" is content, not work in progress: the
    // press that reveals it reads the window once.
    const preview = new SavingFixture();
    preview.preview = true;
    const previewBackend = await CuaComputerBackend.open(preview, "macos");
    try {
      const target = (await previewBackend.targets())[0]!;
      const after = await previewBackend.dispatch(command(await previewBackend.observe(target.id)));
      expect(names(after)).toContain("Quarterly report: revenue grew in every region and…");
      expect(preview.reads).toBe(1);
    } finally {
      await previewBackend.close();
    }
  });

  test("a press macOS did not confirm, which closed its window, reads the window it opened", async () => {
    // Excel's start gallery: pressing "Blank Workbook" closes the gallery and
    // opens the workbook, and macOS answers the press with -25205.
    class GalleryFixture extends Fixture {
      pressed = false;
      opens = true;
      override async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
        const args = JSON.parse(argumentsJson) as Record<string, unknown>;
        if (name === "click" && args.element_token !== undefined) {
          this.calls.push({ name, args });
          this.pressed = true;
          return result(
            {
              error: {
                code: "ax_action_failed",
                message: "AX action failed: AXUIElementPerformAction(AXPress) returned -25205",
              },
            },
            true,
          );
        }
        if (name === "list_windows" && this.pressed) {
          this.calls.push({ name, args });
          return result({
            windows: this.opens
              ? [
                  {
                    pid: 42,
                    window_id: 5,
                    title: "Book1",
                    app_name: "Fixture",
                    bounds: { x: 50, y: 50, width: 200, height: 100 },
                  },
                ]
              : [],
          });
        }
        if (name === "get_window_state" && this.pressed && args.window_id === 1) {
          this.calls.push({ name, args });
          return result({ error: { code: "window_not_found", message: "no such window" } }, true);
        }
        const response = await super.callTool(name, argumentsJson);
        if (name === "get_window_state" && args.window_id === 5) {
          const state = JSON.parse(response.structuredJson!);
          response.structuredJson = JSON.stringify({ ...state, window_id: 5 });
        }
        return response;
      }
    }
    for (const opens of [true, false]) {
      const fixture = new GalleryFixture();
      fixture.opens = opens;
      const backend = await CuaComputerBackend.open(fixture, "macos");
      try {
        const target = (await backend.targets())[0]!;
        const pressing = backend.dispatch(command(await backend.observe(target.id)));
        if (opens) expect((await pressing)?.target.id).toBe("cua:window:42:5");
        else
          await expect(pressing).rejects.toMatchObject({
            code: "outcome_unknown",
            dispatched: true,
            message:
              "macOS did not confirm the action, but cua:window:42:1 has closed since, so it likely took effect; list the app's windows and observe the one to act on",
          });
      } finally {
        await backend.close();
      }
    }
  });

  test("a launch observes the launched app's window, once it appears", async () => {
    // The launched app's window shows up in the second listing after launch.
    class LaunchFixture extends Fixture {
      launched = false;
      listings = 0;
      /** Listings after launch that still lack the app's window. */
      listingsBeforeWindow = 1;
      reportWindows = false;
      // Linux reports the launcher process; the app's window belongs to its
      // child, and an unrelated window appears at the same time.
      linux = false;
      async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
        const args = JSON.parse(argumentsJson) as Record<string, unknown>;
        if (name === "check_permissions" && this.linux) return result({ atspi: true, x11: true });
        if (name === "launch_app") {
          this.calls.push({ name, args });
          this.launched = true;
          if (this.linux) return result({ launcher_pid: 76 });
          const window = { pid: 77, window_id: 9, title: "Untitled", app_name: "TextEdit" };
          return result({
            pid: 77,
            windows: this.reportWindows
              ? [{ ...window, bounds: { x: 0, y: 0, width: 300, height: 200 } }]
              : [],
          });
        }
        const response = await super.callTool(name, argumentsJson);
        if (
          name === "list_windows" &&
          this.launched &&
          ++this.listings > this.listingsBeforeWindow
        ) {
          const data = JSON.parse(response.structuredJson!);
          // Another app opens a window at the same time, listed first.
          if (this.linux)
            data.windows.push({
              pid: 99,
              window_id: 3,
              title: "Unrelated",
              app_name: "Other",
              bounds: { x: 0, y: 0, width: 300, height: 200 },
            });
          data.windows.push({
            pid: 77,
            window_id: 9,
            title: "Untitled",
            app_name: "TextEdit",
            bounds: { x: 0, y: 0, width: 300, height: 200 },
          });
          response.structuredJson = JSON.stringify(data);
        }
        if (name === "get_window_state" && args.pid === 77) {
          const data = JSON.parse(response.structuredJson!);
          Object.assign(data, { pid: 77, window_id: 9 });
          response.structuredJson = JSON.stringify(data);
        }
        return response;
      }
    }
    for (const [reportWindows, linux] of [
      [false, false],
      [true, false],
      [false, true],
    ] as const) {
      const fixture = new LaunchFixture();
      fixture.reportWindows = reportWindows;
      fixture.linux = linux;
      // The app (77) runs as a child of the launcher (76); 99 is unrelated.
      const parents = new Map([
        [77, 76],
        [76, 1],
        [99, 1],
      ]);
      const backend = await CuaComputerBackend.open(fixture, linux ? "linux" : "macos", {
        parentPid: (pid) => parents.get(pid) ?? null,
      });
      try {
        const target = (await backend.targets())[0]!;
        const observation = await backend.observe(target.id);
        const launched = await backend.dispatch({
          ...command(observation),
          action: { type: "launch", applicationId: "com.apple.TextEdit" },
        });
        expect(launched?.target.id).toBe("cua:window:77:9");
        expect(launched?.target.title).toBe("Untitled");
        expect((await backend.targets()).map((listed) => listed.id)).toContain("cua:window:77:9");
      } finally {
        await backend.close();
      }
    }

    // A window already there is observed at once, and a cold app's window,
    // seconds late on macOS, is waited for instead of observing the action's
    // own target. Neither waits out the whole window wait.
    for (const [listingsBeforeWindow, atLeast, below] of [
      [0, 0, 250],
      [7, 1_000, 4_000],
    ] as const) {
      const fixture = new LaunchFixture();
      fixture.listingsBeforeWindow = listingsBeforeWindow;
      const backend = await CuaComputerBackend.open(fixture);
      try {
        const target = (await backend.targets())[0]!;
        const observation = await backend.observe(target.id);
        const started = performance.now();
        const launched = await backend.dispatch({
          ...command(observation),
          action: { type: "launch", applicationId: "com.apple.TextEdit" },
        });
        const elapsed = performance.now() - started;
        expect(launched?.target.id).toBe("cua:window:77:9");
        expect(elapsed).toBeGreaterThanOrEqual(atLeast);
        expect(elapsed).toBeLessThan(below);
      } finally {
        await backend.close();
      }
    }

    // The controller records the launched window's observation in the receipt.
    {
      const fixture = new LaunchFixture();
      fixture.reportWindows = true;
      const backend = await CuaComputerBackend.open(fixture);
      try {
        const computerSessionId = crypto.randomUUID();
        const controllerGeneration = "controller-fixture";
        const controller = new ComputerInteractionController({
          computerSessionId,
          controllerGeneration,
          driver: new ComputerDriver({ computerSessionId, controllerGeneration, client: backend }),
        });
        const target = (await backend.targets())[0]!;
        const observation = await controller.observe(target.id);
        const receipt = await controller.run({
          protocolVersion: 1,
          operationId: crypto.randomUUID(),
          computerSessionId,
          controllerGeneration,
          targetId: target.id,
          expectedTargetGeneration: observation.target.targetGeneration,
          expectedObservationId: null,
          expectedFrameId: null,
          actor: { kind: "agent", subjectId: "agent:fixture" },
          action: { type: "launch", applicationId: "com.apple.TextEdit" },
        });
        expect(receipt.state).toBe("completed");
        expect(receipt.targetId).toBe(target.id);
        expect(receipt.observation?.target.id).toBe("cua:window:77:9");
      } finally {
        await backend.close();
      }
    }

    // A macOS app that keeps running without a window is launched once more,
    // which CUA sends as a reopen, and the window that answers is observed.
    {
      class ReopenFixture extends LaunchFixture {
        override listingsBeforeWindow = Number.POSITIVE_INFINITY;
        override async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
          const launches = this.calls.filter((call) => call.name === "launch_app").length;
          const response = await super.callTool(name, argumentsJson);
          // The window answers the second launch, the reopen.
          if (name === "launch_app" && launches === 1) this.listingsBeforeWindow = this.listings;
          return response;
        }
      }
      const fixture = new ReopenFixture();
      const backend = await CuaComputerBackend.open(fixture, "macos");
      try {
        const target = (await backend.targets())[0]!;
        const observation = await backend.observe(target.id);
        const started = performance.now();
        const launched = await backend.dispatch({
          ...command(observation),
          action: { type: "launch", applicationId: "com.apple.TextEdit" },
        });
        expect(launched?.target.id).toBe("cua:window:77:9");
        expect(fixture.calls.filter((call) => call.name === "launch_app")).toHaveLength(2);
        // The reopen waits for a slow first window, and then answers at once.
        expect(performance.now() - started).toBeGreaterThanOrEqual(2_000);
        expect(performance.now() - started).toBeLessThan(4_000);
      } finally {
        await backend.close();
      }
    }

    // An app that opens no window leaves the action's own target observed.
    const fixture = new Fixture();
    const original = fixture.callTool.bind(fixture);
    fixture.callTool = async (name, json) =>
      name === "launch_app" ? result({ pid: 78, windows: [] }) : await original(name, json);
    const backend = await CuaComputerBackend.open(fixture, "macos", { launchWindowWaitMs: 300 });
    try {
      const target = (await backend.targets())[0]!;
      const observation = await backend.observe(target.id);
      const started = Date.now();
      const launched = await backend.dispatch({
        ...command(observation),
        action: { type: "launch", applicationId: "Menu Bar Helper" },
      });
      expect(launched?.target.id).toBe(target.id);
      // It waits out the window wait, and no longer.
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await backend.close();
    }

    // The wait does not hold the queue: previews and observations run between
    // window searches, and closing ends the wait.
    const windowless = new Fixture();
    const listed = windowless.callTool.bind(windowless);
    windowless.callTool = async (name, json) =>
      name === "launch_app" ? result({ pid: 78, windows: [] }) : await listed(name, json);
    const waiting = await CuaComputerBackend.open(windowless);
    try {
      const target = (await waiting.targets())[0]!;
      const before = await waiting.observe(target.id);
      const started = performance.now();
      const launching = waiting.dispatch({
        ...command(before),
        action: { type: "launch", applicationId: "Menu Bar Helper" },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await waiting.observe(target.id);
      expect(performance.now() - started).toBeLessThan(1_000);
      await waiting.close();
      await launching;
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await waiting.close();
    }
  }, 20_000);

  test("a launch observes the app's own window before a window lying within it", async () => {
    // A document app launching to its Open panel reports the panel's
    // accessory view first; it lies within the panel and cannot be read.
    const accessory = { pid: 77, window_id: 8, title: "Accessory View", app_name: "Editor" };
    const panel = { pid: 77, window_id: 9, title: "Open", app_name: "Editor" };
    const fixture = new Fixture();
    const original = fixture.callTool.bind(fixture);
    let launched = false;
    fixture.callTool = async (name, json) => {
      const args = JSON.parse(json) as Record<string, unknown>;
      if (name === "launch_app") {
        launched = true;
        return result({ pid: 77, windows: [accessory, panel] });
      }
      const response = await original(name, json);
      if (name === "list_windows" && launched) {
        const data = JSON.parse(response.structuredJson!);
        data.windows.push(
          { ...accessory, bounds: { x: 120, y: 300, width: 300, height: 40 } },
          { ...panel, bounds: { x: 100, y: 100, width: 500, height: 400 } },
        );
        response.structuredJson = JSON.stringify(data);
      }
      if (name === "get_window_state" && args.pid === 77) {
        const data = JSON.parse(response.structuredJson!);
        Object.assign(data, { pid: 77, window_id: args.window_id });
        response.structuredJson = JSON.stringify(data);
      }
      return response;
    };
    const backend = await CuaComputerBackend.open(fixture);
    try {
      const target = (await backend.targets())[0]!;
      const observation = await backend.observe(target.id);
      const after = await backend.dispatch({
        ...command(observation),
        action: { type: "launch", applicationId: "com.example.Editor" },
      });
      expect(after?.target.id).toBe("cua:window:77:9");
    } finally {
      await backend.close();
    }
  });

  test("an action that opens one window of its app observes that window", async () => {
    // After the action, list_windows adds the windows in `opens`, and the
    // action's result carries CUA's `report` of the windows it opened. With
    // `closes`, the acted window closes and the new one is listed only from
    // the second listing after the action.
    type Opened = { pid: number; window_id: number; title: string; bounds: Record<string, number> };
    class OpeningFixture extends Fixture {
      acted = false;
      closes = false;
      unreadable = false;
      listingsAfter = 0;
      report = "";
      opens: Opened[] = [];
      async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
        const args = JSON.parse(argumentsJson) as Record<string, unknown>;
        if (
          name === "get_window_state" &&
          args.window_id === 1 &&
          (!this.live || (this.unreadable && this.acted))
        )
          return { ...result({}, true), structuredJson: null, text: "window 1 is gone" } as never;
        const response = await super.callTool(name, argumentsJson);
        if (name === "click") {
          this.acted = true;
          if (this.closes) this.live = false;
          return { ...response, text: `Clicked.${this.report}` };
        }
        if (name === "list_windows" && this.acted && (!this.closes || ++this.listingsAfter > 1)) {
          const data = JSON.parse(response.structuredJson!);
          for (const window of this.opens) data.windows.push({ ...window, app_name: "Fixture" });
          response.structuredJson = JSON.stringify(data);
        }
        if (name === "get_window_state" && args.window_id !== 1) {
          const data = JSON.parse(response.structuredJson!);
          Object.assign(data, { pid: args.pid, window_id: args.window_id });
          response.structuredJson = JSON.stringify(data);
        }
        return response;
      }
    }
    const opened = (title: string) => `\n\n🪟 Action opened new window(s): Fixture ("${title}").`;
    const beside = { x: 300, y: 50, width: 200, height: 100 };
    const within = { x: 60, y: 60, width: 100, height: 50 };
    const document = { pid: 42, window_id: 2, title: "Untitled", bounds: beside };
    for (const { opens, report, observed } of [
      // A new document window of the app, named by CUA's report.
      { opens: [document], report: opened("Untitled"), observed: 2 },
      // An untitled window is named by its app.
      {
        opens: [{ ...document, title: "" }],
        report: "\n\n🪟 Action opened new window(s): Fixture.",
        observed: 2,
      },
      // A window that appeared without CUA reporting it is not the action's.
      { opens: [document], report: "", observed: 1 },
      // Nor is one CUA's report does not name.
      { opens: [{ ...document, title: "Unrelated" }], report: opened("Untitled"), observed: 1 },
      // A window the previous action opened late is not this action's.
      {
        opens: [document],
        report:
          '\n\n🪟 After the previous action returned, it opened new window(s): Fixture ("Untitled").',
        observed: 1,
      },
      // A sheet is read through the window it is attached to, and a window
      // appearing beside it is not the action's.
      {
        opens: [
          { pid: 42, window_id: 2, title: "Save", bounds: within },
          { ...document, window_id: 3, title: "Unrelated" },
        ],
        report: opened("Save"),
        observed: 1,
      },
      // Two candidates are never guessed between.
      {
        opens: [document, { ...document, window_id: 3 }],
        report: opened("Untitled"),
        observed: 1,
      },
      // Another app's window is not this target's.
      { opens: [{ ...document, pid: 43 }], report: opened("Untitled"), observed: 1 },
    ]) {
      const fixture = new OpeningFixture();
      fixture.opens = opens;
      fixture.report = report;
      const backend = await CuaComputerBackend.open(fixture);
      try {
        const target = (await backend.targets())[0]!;
        const observation = await backend.observe(target.id);
        const listings = fixture.calls.filter((call) => call.name === "list_windows").length;
        const after = await backend.dispatch(command(observation));
        expect(after?.target.id).toBe(`cua:window:42:${observed}`);
        // Windows are listed again only for a reported new window.
        expect(fixture.calls.filter((call) => call.name === "list_windows").length).toBe(
          listings + (report.includes("Action opened") ? 1 : 0),
        );
      } finally {
        await backend.close();
      }
    }

    // The acted window closes and a window of its app appears unreported:
    // closing proves nothing about where that window came from, so nothing
    // is observed in its place.
    {
      const fixture = new OpeningFixture();
      fixture.opens = [document];
      fixture.closes = true;
      const backend = await CuaComputerBackend.open(fixture);
      try {
        const target = (await backend.targets())[0]!;
        const observation = await backend.observe(target.id);
        expect(await backend.dispatch(command(observation))).toBeNull();
      } finally {
        await backend.close();
      }
    }

    // The acted window cannot be read after the action but is still listed,
    // and an unrelated window of its app appears unreported: that window is
    // not the action's, so nothing is observed in its place.
    {
      const fixture = new OpeningFixture();
      fixture.opens = [{ ...document, title: "Unrelated" }];
      fixture.unreadable = true;
      const backend = await CuaComputerBackend.open(fixture);
      try {
        const target = (await backend.targets())[0]!;
        const observation = await backend.observe(target.id);
        expect(await backend.dispatch(command(observation))).toBeNull();
      } finally {
        await backend.close();
      }
    }

    // The controller records the opened window's observation in the receipt.
    const fixture = new OpeningFixture();
    fixture.opens = [document];
    fixture.report = opened("Untitled");
    const backend = await CuaComputerBackend.open(fixture);
    try {
      const computerSessionId = crypto.randomUUID();
      const controllerGeneration = "controller-fixture";
      const controller = new ComputerInteractionController({
        computerSessionId,
        controllerGeneration,
        driver: new ComputerDriver({ computerSessionId, controllerGeneration, client: backend }),
      });
      const target = (await backend.targets())[0]!;
      const observation = await controller.observe(target.id);
      const receipt = await controller.run({
        protocolVersion: 1,
        operationId: crypto.randomUUID(),
        computerSessionId,
        controllerGeneration,
        targetId: target.id,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedObservationId: observation.observationId,
        expectedFrameId: null,
        actor: { kind: "agent", subjectId: "agent:fixture" },
        action: {
          type: "semantic",
          locator: {
            kind: "ref",
            ref:
              observation.semantic?.kind === "snapshot" ? observation.semantic.roots[0]!.ref : "",
          },
          action: "invoke",
        },
      });
      expect(receipt.state).toBe("completed");
      expect(receipt.targetId).toBe(target.id);
      expect(receipt.observation?.target.id).toBe("cua:window:42:2");
    } finally {
      await backend.close();
    }
  });

  test("apps launch in the background by each platform's own app name", async () => {
    const fixture = new Fixture();
    const original = fixture.callTool.bind(fixture);
    fixture.callTool = async (name, json) =>
      name === "launch_app"
        ? (fixture.calls.push({ name, args: JSON.parse(json) as Record<string, unknown> }),
          result({ pid: 42, bundle_id: "com.apple.TextEdit", windows: [] }))
        : await original(name, json);
    // These apps open no window here, so the launch need not wait for one.
    const backend = await CuaComputerBackend.open(fixture, "macos", { launchWindowWaitMs: 50 });
    try {
      expect((await backend.capabilities()).appLaunch).toBe(true);
      const target = (await backend.targets())[0]!;
      for (const applicationId of ["com.apple.TextEdit", "TextEdit.app", "System Settings"]) {
        const observation = await backend.observe(target.id);
        const launch = {
          ...command(observation),
          action: { type: "launch" as const, applicationId },
        };
        await backend.validate(launch);
        expect(await backend.dispatch(launch)).not.toBeNull();
      }
      expect(
        fixture.calls.filter((call) => call.name === "launch_app").map((call) => call.args),
      ).toEqual([
        { bundle_id: "com.apple.TextEdit" },
        { name: "TextEdit" },
        { name: "System Settings" },
      ]);

      // Once the app runs, the launch succeeded even if listing its windows fails.
      const observed = await backend.observe(target.id);
      fixture.callTool = async (name, json) =>
        name === "launch_app"
          ? result({ pid: 78 })
          : name === "list_windows"
            ? result({ error: { code: "internal", message: "list failed" } }, true)
            : await original(name, json);
      await expect(
        backend.dispatch({
          ...command(observed),
          action: { type: "launch", applicationId: "Notes" },
        }),
      ).resolves.toBeDefined();

      // A lost response or no reported process may still have launched it.
      for (const lost of [
        async () => {
          throw new Error("lost after delivery");
        },
        async () => result({ windows: [] }),
        async () => result({ error: { code: "internal", message: "launch stalled" } }, true),
      ]) {
        fixture.callTool = async (name, json) =>
          name === "launch_app" ? await lost() : await original(name, json);
        const before = await backend.observe(target.id);
        await expect(
          backend.dispatch({
            ...command(before),
            action: { type: "launch", applicationId: "Notes" },
          }),
        ).rejects.toMatchObject({ code: "outcome_unknown", dispatched: true });
      }
      // An explicit refusal is a definite failure: nothing launched.
      fixture.callTool = async (name, json) =>
        name === "launch_app"
          ? result(
              { effect: "refused", refusal: { code: "unsupported", message: "no such app" } },
              true,
            )
          : await original(name, json);
      const refusedFrom = await backend.observe(target.id);
      await expect(
        backend.dispatch({
          ...command(refusedFrom),
          action: { type: "launch", applicationId: "Nope" },
        }),
      ).rejects.toMatchObject({ code: "unsupported", dispatched: false });
    } finally {
      await backend.close();
    }
    for (const [platform, platformFixture, launches] of [
      [
        "windows",
        new WindowsFixture(),
        [
          ["Notepad", { name: "Notepad" }],
          [
            "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
            {
              aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
            },
          ],
          ["C:\\Program Files\\App\\app.exe", { path: "C:\\Program Files\\App\\app.exe" }],
          ["\\\\server\\share\\tool.exe", { path: "\\\\server\\share\\tool.exe" }],
          ["C:\\Tools\\Acme!\\tool.exe", { path: "C:\\Tools\\Acme!\\tool.exe" }],
          ["\\\\server\\Tools!\\tool.exe", { path: "\\\\server\\Tools!\\tool.exe" }],
        ],
      ],
      [
        "linux",
        new LinuxPermissionsFixture(),
        [
          ["gedit", { name: "gedit" }],
          ["org.gnome.Calculator", { name: "org.gnome.Calculator" }],
        ],
      ],
    ] as const) {
      const platformCall = platformFixture.callTool.bind(platformFixture);
      platformFixture.callTool = async (name, json) =>
        name === "launch_app"
          ? (platformFixture.calls.push({
              name,
              args: JSON.parse(json) as Record<string, unknown>,
            }),
            // Linux reports the launcher process it started the app through.
            result(platform === "linux" ? { launcher_pid: 92 } : { pid: 42, windows: [] }))
          : await platformCall(name, json);
      const other = await CuaComputerBackend.open(platformFixture, platform, {
        launchWindowWaitMs: 50,
      });
      try {
        expect((await other.capabilities()).appLaunch).toBe(true);
        const target = (await other.targets())[0]!;
        for (const [applicationId] of launches) {
          const launch = {
            ...command(await other.observe(target.id)),
            action: { type: "launch" as const, applicationId },
          };
          await other.validate(launch);
          await other.dispatch(launch);
        }
        expect(
          platformFixture.calls
            .filter((call) => call.name === "launch_app")
            .map((call) => call.args),
        ).toEqual(launches.map(([, args]) => args));
      } finally {
        await other.close();
      }
    }
  });

  test("another CUA worker's overlay is not a target", async () => {
    const fixture = new Fixture();
    const original = fixture.callTool.bind(fixture);
    fixture.callTool = async (name, argumentsJson) => {
      const response = await original(name, argumentsJson);
      if (name !== "list_windows") return response;
      const data = JSON.parse(response.structuredJson!);
      data.windows.unshift({
        pid: 77,
        window_id: 9,
        title: "",
        app_name: "cua-driver",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      });
      response.structuredJson = JSON.stringify(data);
      return response;
    };
    const backend = await CuaComputerBackend.open(fixture);
    try {
      expect((await backend.targets()).map((target) => target.id)).toEqual(["cua:window:42:1"]);
    } finally {
      await backend.close();
    }
  });

  test("a window that is not on screen says so when it cannot be read", async () => {
    // CUA lists the window off screen and, as for a hidden window, produces
    // neither pixels nor a tree for it.
    class OffScreenFixture extends Fixture {
      onScreen = true;
      async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
        if (name === "get_window_state" && !this.onScreen)
          return {
            ...result({}, true),
            structuredJson: null,
            text: "No content produced (neither AX tree nor screenshot succeeded)",
          } as never;
        const response = await super.callTool(name, argumentsJson);
        if (name === "list_windows") {
          const data = JSON.parse(response.structuredJson!);
          for (const window of data.windows) window.is_on_screen = this.onScreen;
          response.structuredJson = JSON.stringify(data);
        }
        return response;
      }
    }
    const fixture = new OffScreenFixture();
    const backend = await CuaComputerBackend.open(fixture);
    try {
      const target = (await backend.targets())[0]!;
      expect(target).not.toHaveProperty("offScreen");
      // The window leaves the screen after it was listed.
      fixture.onScreen = false;
      for (const read of [() => backend.observe(target.id), () => backend.capture(target.id)])
        await expect(read()).rejects.toMatchObject({
          code: "unsupported",
          dispatched: false,
          message: expect.stringContaining("not on screen"),
        });
      // Once listed off screen, it is refused without asking CUA to read it.
      const reads = () => fixture.calls.filter((call) => call.name === "get_window_state").length;
      const before = reads();
      await expect(backend.observe(target.id)).rejects.toMatchObject({ code: "unsupported" });
      expect(reads()).toBe(before);
      // The listing marks it, so a caller need not try it to find out.
      expect((await backend.targets())[0]).toMatchObject({ id: target.id, offScreen: true });
      // Back on screen, it is read again.
      fixture.onScreen = true;
      expect((await backend.observe(target.id)).nodeCount).toBeGreaterThan(0);
      // The same failure for a window on screen stays a driver failure.
      const original = fixture.callTool.bind(fixture);
      fixture.callTool = async (name, argumentsJson) =>
        name === "get_window_state"
          ? ({ ...result({}, true), structuredJson: null, text: "No content" } as never)
          : original(name, argumentsJson);
      await expect(backend.observe(target.id)).rejects.toMatchObject({ code: "driver_failed" });
    } finally {
      await backend.close();
    }
  });

  test("macOS lists only windows a person can see and brings minimized ones back to read", async () => {
    // A minimized window, a headless browser's page window (on no Space), a
    // popover its app keeps ordered out, and a full-screen window on another
    // Space, as CUA lists them.
    class MacFixture extends Fixture {
      minimized = true;
      async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
        if (name === "get_window_state" && this.minimized)
          return { ...result({}, true), structuredJson: null, text: "No content" } as never;
        const response = await super.callTool(name, argumentsJson);
        if (name !== "list_windows") return response;
        const bounds = { x: 0, y: 1079, width: 1280, height: 720 };
        response.structuredJson = JSON.stringify({
          windows: [
            {
              ...JSON.parse(response.structuredJson!).windows[0],
              is_on_screen: !this.minimized,
              space_ids: [1],
              on_current_space: true,
            },
            { pid: 60, window_id: 2, title: "Dashboard", app_name: "Google Chrome", bounds },
            { pid: 61, window_id: 3, title: "", app_name: "Safari", bounds },
            { pid: 62, window_id: 4, title: "Notes", app_name: "TextEdit", bounds },
          ].map((window, index) =>
            index === 0
              ? window
              : {
                  ...window,
                  is_on_screen: false,
                  space_ids: [null, [1], [801]][index - 1],
                  on_current_space: [null, true, false][index - 1],
                },
          ),
        });
        return response;
      }
    }
    const fixture = new MacFixture();
    const asked: number[][] = [];
    const restored: unknown[] = [];
    let presenceFails = false;
    const backend = await CuaComputerBackend.open(fixture, "macos", {
      macWindows: {
        async presence(windows) {
          if (presenceFails) throw new Error("helper unavailable");
          asked.push(windows.map((window) => window.processId));
          return windows.map((window) =>
            window.processId === 61
              ? "not_shown"
              : window.processId === 42 && fixture.minimized
                ? "minimized"
                : "unknown",
          );
        },
        async restore(window) {
          restored.push(window);
          const before = fixture.minimized ? "minimized" : "unknown";
          fixture.minimized = false;
          return before;
        },
      },
    });
    try {
      const targets = await backend.targets();
      // The browser's page window and the popover are never seen, so never
      // listed; the minimized window is listed as readable; only the window
      // on another Space is marked.
      expect(targets.map((target) => [target.id, target.offScreen ?? false])).toEqual([
        ["cua:window:42:1", false],
        ["cua:window:62:4", true],
      ]);
      // Only windows on this Space are asked about, and a never-shown window
      // only once.
      expect(asked).toEqual([[42, 61]]);
      await backend.targets();
      expect(asked).toEqual([[42, 61], [42]]);

      // Reading the minimized window restores it first, then reads it.
      expect((await backend.observe("cua:window:42:1")).nodeCount).toBeGreaterThan(0);
      expect(restored).toEqual([
        { processId: 42, title: "Fixture", bounds: { x: 50, y: 50, width: 200, height: 100 } },
      ]);
      // A window on another Space is refused without restoring anything.
      await expect(backend.observe("cua:window:62:4")).rejects.toMatchObject({
        code: "unsupported",
        message: expect.stringContaining("not on screen"),
      });
      expect(restored).toHaveLength(1);

      // Minimized again, but a restore that does not happen leaves it unread.
      fixture.minimized = true;
      await backend.targets();
      const restore = backend["macWindows"]!.restore;
      backend["macWindows"]!.restore = async () => "unknown";
      await expect(backend.observe("cua:window:42:1")).rejects.toMatchObject({
        code: "unsupported",
      });
      backend["macWindows"]!.restore = restore;

      // Without the helper's answer, windows keep their listing: off screen.
      presenceFails = true;
      expect(
        (await backend.targets()).map((target) => [target.id, target.offScreen ?? false]),
      ).toEqual([
        ["cua:window:42:1", true],
        ["cua:window:62:4", true],
      ]);
    } finally {
      await backend.close();
    }
  });

  test("Windows and Linux still read a window listed off screen", async () => {
    for (const [platform, fixture] of [
      ["windows", new WindowsFixture()],
      ["linux", new LinuxPermissionsFixture()],
    ] as const) {
      const original = fixture.callTool.bind(fixture);
      fixture.callTool = async (name, argumentsJson) => {
        const response = await original(name, argumentsJson);
        if (name !== "list_windows") return response;
        const data = JSON.parse(response.structuredJson!);
        for (const window of data.windows) window.is_on_screen = false;
        response.structuredJson = JSON.stringify(data);
        return response;
      };
      const backend = await CuaComputerBackend.open(fixture, platform);
      try {
        const target = (await backend.targets())[0]!;
        expect(target).not.toHaveProperty("offScreen");
        expect((await backend.observe(target.id)).nodeCount).toBeGreaterThan(0);
      } finally {
        await backend.close();
      }
    }
  });

  test("unknown/partial delivery stays unknown; explicit refusal alone is safe", async () => {
    const fixture = new Fixture();
    for (const effect of ["partial", "suspected_noop", undefined]) {
      fixture.mutation = result({ effect }, true);
      await expect(callDesktop(fixture, "click", {}, true)).rejects.toMatchObject({
        code: "outcome_unknown",
        dispatched: true,
        retryable: false,
      });
    }
    fixture.mutation = result({ effect: "refused", code: "capture_not_found" }, true);
    await expect(callDesktop(fixture, "click", {}, true)).rejects.toMatchObject({
      code: "frame_stale",
      dispatched: false,
    });
    // A value write CUA did not apply (and restored) changed nothing: a
    // definite failure. One that left the control changed stays unknown.
    fixture.mutation = result({ effect: "not_applied", code: "write_not_applied" }, true);
    await expect(callDesktop(fixture, "set_value", {}, true)).rejects.toMatchObject({
      code: "driver_failed",
      dispatched: false,
    });
    for (const [effect, code] of [
      ["cleared", "write_cleared"],
      ["partial", "value_not_reached"],
    ]) {
      fixture.mutation = result({ effect, code }, true);
      await expect(callDesktop(fixture, "set_value", {}, true)).rejects.toMatchObject({
        code: "outcome_unknown",
        dispatched: true,
      });
    }
    // A failure CUA reports only as text keeps CUA's reason.
    fixture.mutation = {
      text: "Failed to launch: The system cannot find the file specified.",
      images: [],
      isError: true,
      degraded: false,
      rawJson: "{}",
    };
    await expect(callDesktop(fixture, "launch_app", {}, "caller-settles")).rejects.toMatchObject({
      code: "outcome_unknown",
      message:
        "CUA launch_app did not return a valid result: Failed to launch: The system cannot find the file specified.",
    });
    // The failure carries CUA's own reason and hint, not only that it refused.
    fixture.mutation = result(
      {
        effect: "refused",
        refusal: {
          code: "no_text_target",
          message: "type_text did not synthesize character events",
        },
        hint: "Use press_key for single keys.",
      },
      true,
    );
    await expect(callDesktop(fixture, "type_text", {}, true)).rejects.toMatchObject({
      message:
        "CUA type_text refused the operation: type_text did not synthesize character events Use press_key for single keys.",
      dispatched: false,
    });
    // The reason is passed on exactly as written, trailing whitespace too, so
    // the driver can still recognize a typed value at its end.
    fixture.mutation = result(
      {
        effect: "refused",
        refusal: { code: "no_text_target", message: "could not type ab cd \n" },
      },
      true,
    );
    await expect(callDesktop(fixture, "type_text", {}, true)).rejects.toMatchObject({
      message: "CUA type_text refused the operation: could not type ab cd \n",
    });
    fixture.callTool = async () => {
      throw new Error("lost after delivery");
    };
    await expect(callDesktop(fixture, "click", {}, true)).rejects.toMatchObject({
      code: "outcome_unknown",
      dispatched: true,
    });
  });

  test("waits for admitted actions before shutdown and rejects later requests", async () => {
    const fixture = new Fixture(),
      backend = await CuaComputerBackend.open(fixture);
    const observation = await backend.observe((await backend.targets())[0]!.id);
    const original = fixture.callTool.bind(fixture);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    fixture.callTool = async (name, args) => {
      if (name === "click") await blocked;
      return original(name, args);
    };
    const action = backend.dispatch(command(observation));
    const closing = backend.close();
    expect(fixture.stopped).toBe(false);
    await expect(backend.targets()).rejects.toMatchObject({ code: "unavailable" });
    release();
    await action;
    await closing;
    await backend.close();
    expect(fixture.calls.filter((call) => call.name === "end_session")).toHaveLength(1);
    expect(fixture.stopped).toBe(true);
  });

  describe("a batch runs as one run_steps call", () => {
    class BatchFixture extends Fixture {
      override listToolsJson = async () => JSON.stringify({ tools: CUA_DESKTOP_TOOLS });
      /** What run_steps answers; null runs every step. */
      reply: Record<string, unknown> | null = null;
      /** Window-change lines of the last step. */
      windowChanges: string[] = [];
      opens: { pid: number; window_id: number; title: string }[] = [];
      ran = false;
      async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
        const args = JSON.parse(argumentsJson) as Record<string, unknown>;
        if (name === "run_steps") {
          this.calls.push({ name, args });
          this.ran = true;
          const steps = args.steps as unknown[];
          if (this.reply) return result(this.reply, true);
          return result({
            ok: true,
            total: steps.length,
            executed: steps.length,
            failed_step: null,
            steps: steps.map((_, index) => ({
              index,
              ok: true,
              message: "done",
              ...(index === steps.length - 1 && this.windowChanges.length
                ? { window_changes: this.windowChanges }
                : {}),
            })),
          });
        }
        const response = await super.callTool(name, argumentsJson);
        if (name === "list_windows" && this.ran) {
          const data = JSON.parse(response.structuredJson!);
          for (const window of this.opens)
            data.windows.push({
              ...window,
              app_name: "Fixture",
              bounds: { x: 300, y: 50, width: 200, height: 100 },
            });
          response.structuredJson = JSON.stringify(data);
        }
        if (name === "get_window_state" && args.window_id !== 1) {
          const data = JSON.parse(response.structuredJson!);
          Object.assign(data, { pid: args.pid, window_id: args.window_id });
          response.structuredJson = JSON.stringify(data);
        }
        return response;
      }
    }
    const batch = (observation: ComputerBackendObservation): ComputerBackendActionCommand => ({
      ...command(observation),
      action: {
        type: "batch",
        actions: [
          {
            type: "semantic",
            locator: { kind: "ref", ref: observation.roots[0]!.ref },
            action: "invoke",
          },
          { type: "keyboard", action: "type", value: "hello" },
          { type: "keyboard", action: "press", value: "enter" },
        ],
      },
    });
    const open = async (fixture: BatchFixture) => {
      const backend = await CuaComputerBackend.open(fixture);
      const target = (await backend.targets())[0]!;
      return { backend, observation: await backend.observe(target.id) };
    };
    const mutations = (fixture: Fixture) =>
      fixture.calls.filter((call) =>
        ["click", "type_text", "press_key", "hotkey", "set_value"].includes(call.name),
      );

    test("every action is checked against the batch's observation and sent at once", async () => {
      const fixture = new BatchFixture();
      const { backend, observation } = await open(fixture);
      try {
        expect(backend.initialCapabilities.actionBatches).toBe(true);
        expect((await backend.capabilities()).actionBatches).toBe(true);
        await backend.validate(batch(observation));
        const after = await backend.dispatch(batch(observation));
        expect(after?.target.id).toBe("cua:window:42:1");
        const calls = fixture.calls.filter((call) => call.name === "run_steps");
        expect(calls).toHaveLength(1);
        expect(mutations(fixture)).toHaveLength(0);
        const { steps, ...window } = calls[0]!.args as {
          steps: { tool: string; args: Record<string, unknown> }[];
        };
        // A stale token stops the batch: CUA does not act on a lookalike.
        expect(window).toMatchObject({ pid: 42, window_id: 1, refind_stale: false });
        expect(steps.map((step) => step.tool)).toEqual(["click", "type_text", "press_key"]);
        expect(steps[0]!.args.element_token).toBe(
          `${observation.observationId.split(":").pop()}:0`,
        );
        // Earlier actions may have moved the focus: later keys go where it is.
        expect(steps[1]!.args).not.toHaveProperty("element_token");
        expect(steps[1]!.args.text).toBe("hello");
        expect(steps[2]!.args).toMatchObject({ key: "return", modifiers: [] });
      } finally {
        await backend.close();
      }
    });

    test("a CUA whose run_steps cannot stop at a stale token runs batches one action at a time", async () => {
      for (const listToolsJson of [
        async () => JSON.stringify({ tools: CUA_WINDOWS_DESKTOP_TOOLS }),
        undefined,
      ]) {
        const fixture = new BatchFixture();
        fixture.listToolsJson = listToolsJson as BatchFixture["listToolsJson"];
        const backend = await CuaComputerBackend.open(fixture);
        try {
          expect(backend.initialCapabilities.actionBatches).toBe(false);
          expect((await backend.capabilities()).actionBatches).toBe(false);
        } finally {
          await backend.close();
        }
      }
    });

    test("a batch whose last action opened a window observes that window", async () => {
      const fixture = new BatchFixture();
      fixture.opens = [{ pid: 42, window_id: 2, title: "Untitled" }];
      fixture.windowChanges = ['🪟 Action opened new window(s): Fixture ("Untitled").'];
      const { backend, observation } = await open(fixture);
      try {
        expect((await backend.dispatch(batch(observation)))?.target.id).toBe("cua:window:42:2");
      } finally {
        await backend.close();
      }
      // Without CUA's report, a window that appeared is not the batch's.
      const unreported = new BatchFixture();
      unreported.opens = [{ pid: 42, window_id: 2, title: "Untitled" }];
      const second = await open(unreported);
      try {
        expect((await second.backend.dispatch(batch(second.observation)))?.target.id).toBe(
          "cua:window:42:1",
        );
      } finally {
        await second.backend.close();
      }
    });

    test("an action that fails the batch's checks sends nothing", async () => {
      const fixture = new BatchFixture();
      const { backend, observation } = await open(fixture);
      try {
        const invalid = batch(observation);
        if (invalid.action.type !== "batch") throw new Error("not a batch");
        invalid.action.actions[1] = {
          type: "semantic",
          locator: { kind: "ref", ref: "s404:404" },
          action: "invoke",
        };
        const failure = await backend.dispatch(invalid).catch((error: unknown) => error);
        expect(failure).toMatchObject({ dispatched: false });
        expect(String((failure as Error).message)).toStartWith("Action 2 of the batch: ");
        expect(fixture.ran).toBe(false);
      } finally {
        await backend.close();
      }
    });

    test("a later action may name an element an earlier one brings up, and CUA waits for it", async () => {
      const fixture = new BatchFixture();
      const { backend, observation } = await open(fixture);
      try {
        const crossing = batch(observation);
        if (crossing.action.type !== "batch") throw new Error("not a batch");
        crossing.action.actions = [
          crossing.action.actions[0]!,
          {
            type: "semantic",
            locator: { kind: "role", role: "textbox", name: "Seats" },
            action: "set_value",
            value: 12,
          },
          { type: "semantic", locator: { kind: "label", text: "Save changes" }, action: "invoke" },
        ];
        await backend.validate(crossing);
        await backend.dispatch(crossing);
        const calls = fixture.calls.filter((call) => call.name === "run_steps");
        expect(calls).toHaveLength(1);
        const { steps } = calls[0]!.args as {
          steps: { tool: string; args: Record<string, unknown>; [key: string]: unknown }[];
        };
        expect(steps.map((step) => step.tool)).toEqual(["click", "set_value", "click"]);
        expect(steps[0]!.args.element_token).toBeDefined();
        expect(steps[0]).not.toHaveProperty("wait_for");
        expect(steps[1]!.args).not.toHaveProperty("element_token");
        expect(steps[1]).toMatchObject({
          args: { pid: 42, window_id: 1, role: "textfield", name: "Seats", value: "12" },
          timeout_ms: 1_000,
          wait_for: {
            role: "textfield",
            name: "Seats",
            pid: 42,
            window_id: 1,
            enabled: true,
            timeout_ms: 10_000,
          },
        });
        expect(steps[2]).toMatchObject({
          args: { name: "Save changes", button: "left", delivery_mode: "background" },
          wait_for: { name: "Save changes", enabled: true },
        });
        expect(steps[2]!.args).not.toHaveProperty("role");
      } finally {
        await backend.close();
      }
    });

    test("after a step found by name, later elements are found by name too", async () => {
      // CUA's lookup re-reads the window, which retires the tokens of the
      // batch's observation, so a later token would stop the batch as stale.
      const fixture = new BatchFixture();
      const { backend, observation } = await open(fixture);
      try {
        const apply = observation.roots[0]!;
        const crossing: ComputerBackendActionCommand = {
          ...batch(observation),
          action: {
            type: "batch",
            actions: [
              { type: "keyboard", action: "press", value: "enter" },
              {
                type: "semantic",
                locator: { kind: "role", role: "textbox", name: "Seats", exact: true },
                action: "set_value",
                value: "4",
              },
              { type: "semantic", locator: { kind: "ref", ref: apply.ref }, action: "invoke" },
            ],
          },
        };
        await backend.dispatch(crossing);
        const { steps } = fixture.calls.find((call) => call.name === "run_steps")!.args as {
          steps: { tool: string; args: Record<string, unknown> }[];
        };
        expect(steps[1]!.args).toMatchObject({ role: "textfield", name: "Seats", exact: true });
        expect(steps[2]!.args).toMatchObject({ role: "button", name: "Apply", exact: true });
        expect(steps[2]!.args).not.toHaveProperty("element_token");
      } finally {
        await backend.close();
      }
    });

    test("after a step found by name, an element CUA cannot find by its shown name is refused up front", async () => {
      const crossing = (observation: ComputerBackendObservation): ComputerBackendActionCommand => ({
        ...batch(observation),
        action: {
          type: "batch",
          actions: [
            { type: "keyboard", action: "press", value: "enter" },
            {
              type: "semantic",
              locator: { kind: "role", role: "textbox", name: "Seats" },
              action: "set_value",
              value: "4",
            },
            {
              type: "semantic",
              locator: { kind: "ref", ref: observation.roots[0]!.ref },
              action: "invoke",
            },
          ],
        },
      });
      // Shown without Chrome's live memory figure, which CUA's lookup matches.
      const memory = new BatchFixture();
      memory.applyLabel = "Inbox - Memory usage - 85.2 MB";
      const first = await open(memory);
      try {
        expect(first.observation.roots[0]!.name).toBe("Inbox");
        const failure = await first.backend
          .dispatch(crossing(first.observation))
          .catch((error: unknown) => error);
        expect(failure).toMatchObject({ dispatched: false });
        expect(String((failure as Error).message)).toContain("no label of its own");
        expect(memory.ran).toBe(false);
      } finally {
        await first.backend.close();
      }
      // Two buttons by the same name: the lookup could not tell them apart.
      class TwinFixture extends BatchFixture {
        override async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
          const response = await super.callTool(name, argumentsJson);
          if (name !== "get_window_state" || !response.structuredJson) return response;
          const data = JSON.parse(response.structuredJson);
          if (data.elements)
            data.elements.push({
              ...data.elements[0],
              element_index: 2,
              element_token: `${data.snapshot_id}:2`,
              frame: { x: 120, y: 60, w: 40, h: 20 },
            });
          response.structuredJson = JSON.stringify(data);
          return response;
        }
      }
      const twins = new TwinFixture();
      const second = await open(twins);
      try {
        const failure = await second.backend
          .dispatch(crossing(second.observation))
          .catch((error: unknown) => error);
        expect(failure).toMatchObject({ dispatched: false });
        expect(String((failure as Error).message)).toContain("Several elements here");
        expect(twins.ran).toBe(false);
      } finally {
        await second.backend.close();
      }
    });

    test("a named step uses the lookup's role names, except AT-SPI roles on Linux", () => {
      const args = { pid: 7, window_id: 3, session: "s" };
      const fill = {
        type: "semantic",
        locator: { kind: "role", role: "text", name: "Email" },
        action: "set_value",
        value: "a@b.c",
      } as const;
      expect(namedOperation("macos", args, fill, null)?.args).toMatchObject({
        role: "statictext",
        name: "Email",
      });
      expect(namedOperation("linux", args, fill, null)?.args).toMatchObject({
        role: "text",
        name: "Email",
      });
      expect(namedOperation("linux", args, fill, null)?.args).not.toHaveProperty("exact");
      // A number field is a spinbutton here and an incrementor to the lookup.
      expect(
        namedOperation(
          "macos",
          args,
          { ...fill, locator: { kind: "role", role: "spinbutton", name: "Seats" }, value: "42" },
          null,
        )?.args,
      ).toMatchObject({ role: "incrementor", name: "Seats", value: "42" });
      // A ref names nothing on its own: without the observed element it stays refused.
      expect(
        namedOperation(
          "macos",
          args,
          { type: "semantic", locator: { kind: "ref", ref: "s1:9" }, action: "invoke" },
          null,
        ),
      ).toBeNull();
    });

    test("an element not yet seen is refused first in a batch, by ref, or for other actions", async () => {
      const fixture = new BatchFixture();
      const { backend, observation } = await open(fixture);
      try {
        const missing = { kind: "role", role: "button", name: "Not there" } as const;
        const variants: ComputerBackendActionCommand["action"][] = [
          { type: "batch", actions: [{ type: "semantic", locator: missing, action: "invoke" }] },
          {
            type: "batch",
            actions: [
              { type: "keyboard", action: "press", value: "enter" },
              {
                type: "semantic",
                locator: { kind: "identifier", value: "nope" },
                action: "invoke",
              },
            ],
          },
          {
            type: "batch",
            actions: [
              { type: "keyboard", action: "press", value: "enter" },
              { type: "semantic", locator: missing, action: "expand" },
            ],
          },
        ];
        for (const action of variants) {
          const failure = await backend
            .dispatch({ ...batch(observation), action })
            .catch((error: unknown) => error);
          expect(failure).toMatchObject({ code: "locator_not_found", dispatched: false });
        }
        expect(fixture.ran).toBe(false);
      } finally {
        await backend.close();
      }
    });

    describe("a button that is a link here, or a link that is a button", () => {
      /** The fixture's window, with a link for each of `links` after its
       * button "Apply" and its password field. */
      class LinkFixture extends BatchFixture {
        links: string[] = [];
        /** The element CUA reports it used for a step of a run that ran. */
        standIns: Record<number, { role: string; name: string }> = {};
        override async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
          const response = await super.callTool(name, argumentsJson);
          if (name === "run_steps" && !this.reply) {
            const data = JSON.parse(response.structuredJson!);
            for (const step of data.steps)
              if (this.standIns[step.index]) step.target = { stand_in: this.standIns[step.index] };
            response.structuredJson = JSON.stringify(data);
          }
          if (name !== "get_window_state" || !response.structuredJson) return response;
          const data = JSON.parse(response.structuredJson);
          if (data.elements)
            for (const [offset, label] of this.links.entries())
              data.elements.push({
                element_index: 2 + offset,
                element_token: `${data.snapshot_id}:${2 + offset}`,
                role: "AXLink",
                label,
                actions: ["AXPress"],
                frame: { x: 110 + offset * 10, y: 60, w: 40, h: 20 },
              });
          response.structuredJson = JSON.stringify(data);
          return response;
        }
      }
      const named = (
        observation: ComputerBackendObservation,
        role: string,
        name: string,
        action: "invoke" | "set_value" = "invoke",
      ): ComputerBackendActionCommand => ({
        ...command(observation),
        action: {
          type: "semantic",
          locator: { kind: "role", role, name, exact: true },
          action,
          ...(action === "set_value" ? { value: "x" } : {}),
        } as ComputerBackendActionCommand["action"],
      });
      const token = (observation: ComputerBackendObservation, index: number) =>
        `${observation.observationId.split(":").pop()}:${index}`;
      const asBatch = (
        first: ComputerBackendActionCommand,
        ...rest: ComputerBackendActionCommand["action"][]
      ): ComputerBackendActionCommand => ({
        ...first,
        action: {
          type: "batch",
          actions: [first.action, ...rest],
        } as ComputerBackendActionCommand["action"],
      });
      const enter = {
        type: "keyboard",
        action: "press",
        value: "enter",
      } as ComputerBackendActionCommand["action"];

      test("a batch's first action naming a button shown as a link goes to CUA by role and name", async () => {
        const fixture = new LinkFixture();
        fixture.links = ["Edit billing"];
        fixture.standIns = { 0: { role: "AXLink", name: "Edit billing" } };
        const { backend, observation } = await open(fixture);
        try {
          const reported: unknown[] = [];
          await backend.dispatch(
            asBatch(named(observation, "button", "Edit billing"), enter),
            (standIn) => reported.push(standIn),
          );
          const steps = fixture.calls.find((call) => call.name === "run_steps")!.args.steps as {
            tool: string;
            args: Record<string, unknown>;
            wait_for?: Record<string, unknown>;
          }[];
          // CUA decides, once the window has settled, whether the link is the
          // one meant; nothing is retargeted from the batch's observation.
          expect(steps[0]!.tool).toBe("click");
          expect(steps[0]!.args.element_token).toBeUndefined();
          expect(steps[0]!.args).toMatchObject({
            role: "button",
            name: "Edit billing",
            exact: true,
          });
          expect(steps[0]!.wait_for).toMatchObject({ role: "button", name: "Edit billing" });
          expect(reported).toEqual([
            { actionIndex: 0, requestedRole: "button", role: "link", name: "Edit billing" },
          ]);
        } finally {
          await backend.close();
        }
      });

      test("a first action with nothing alike, a value write or a single action fails at once", async () => {
        const fixture = new LinkFixture();
        fixture.links = ["Edit billing"];
        const { backend, observation } = await open(fixture);
        try {
          for (const attempt of [
            // Nothing of either role has the name.
            asBatch(named(observation, "button", "Upgrade"), enter),
            // A value is not pressed: no stand-in.
            asBatch(named(observation, "button", "Edit billing", "set_value")),
            // One action on its own keeps its immediate answer.
            named(observation, "button", "Edit billing"),
          ]) {
            const failure = await backend.dispatch(attempt).catch((error: unknown) => error);
            expect(failure).toMatchObject({ code: "locator_not_found", dispatched: false });
          }
          expect(fixture.ran).toBe(false);
          expect(mutations(fixture)).toHaveLength(0);
          // A button of the name is acted on by its token, as before.
          await backend.dispatch(asBatch(named(observation, "button", "Apply"), enter));
          const steps = fixture.calls.find((call) => call.name === "run_steps")!.args.steps as {
            args: Record<string, unknown>;
          }[];
          expect(steps[0]!.args.element_token).toBe(token(observation, 0));
        } finally {
          await backend.close();
        }
      });

      const upgrade = (observation: ComputerBackendObservation) => ({
        ...batch(observation),
        action: {
          type: "batch",
          actions: [
            { type: "keyboard", action: "press", value: "enter" },
            {
              type: "semantic",
              locator: { kind: "role", role: "button", name: "Upgrade", exact: true },
              action: "invoke",
            },
          ],
        } as ComputerBackendActionCommand["action"],
      });

      test("a stand-in CUA used for a later action is reported once that action ran", async () => {
        const used = { role: "AXLink", name: "Upgrade" };
        const fixture = new LinkFixture();
        fixture.standIns = { 1: used };
        const { backend, observation } = await open(fixture);
        try {
          const reported: unknown[] = [];
          await backend.dispatch(upgrade(observation), (standIn) => reported.push(standIn));
          expect(reported).toEqual([
            { actionIndex: 1, requestedRole: "button", role: "link", name: "Upgrade" },
          ]);
        } finally {
          await backend.close();
        }
        // The batch stopped at that action: nothing is reported for it.
        const stopped = new LinkFixture();
        stopped.reply = {
          ok: false,
          total: 2,
          executed: 2,
          failed_step: 1,
          steps: [
            { index: 0, ok: true, message: "ok" },
            {
              index: 1,
              ok: false,
              phase: "action",
              message: "did not confirm",
              target: { stand_in: used },
            },
          ],
        };
        const second = await open(stopped);
        try {
          const reported: unknown[] = [];
          await second.backend
            .dispatch(upgrade(second.observation), (standIn) => reported.push(standIn))
            .catch(() => undefined);
          expect(reported).toEqual([]);
        } finally {
          await second.backend.close();
        }
      });

      test("the receipt names each stand-in, without a typed secret", async () => {
        const secret = "synthetic-pin-4711";
        const fixture = new LinkFixture();
        fixture.standIns = { 1: { role: "AXLink", name: `Upgrade ${secret}` } };
        const backend = await CuaComputerBackend.open(fixture);
        try {
          const computerSessionId = crypto.randomUUID();
          const controllerGeneration = "controller-fixture";
          const controller = new ComputerInteractionController({
            computerSessionId,
            controllerGeneration,
            driver: new ComputerDriver({
              computerSessionId,
              controllerGeneration,
              client: backend,
            }),
          });
          const target = (await backend.targets())[0]!;
          const observation = await controller.observe(target.id);
          const raw = "{{" + "secret:Card/pin}}";
          const receipt = await controller.run({
            protocolVersion: 1,
            operationId: crypto.randomUUID(),
            computerSessionId,
            controllerGeneration,
            targetId: target.id,
            expectedTargetGeneration: observation.target.targetGeneration,
            expectedObservationId: observation.observationId,
            expectedFrameId: null,
            actor: { kind: "agent", subjectId: "agent:fixture" },
            action: {
              type: "batch",
              actions: [
                { type: "keyboard", action: "type", value: raw },
                {
                  type: "semantic",
                  locator: { kind: "role", role: "button", name: "Upgrade", exact: true },
                  action: "invoke",
                },
              ],
            },
            secretValues: { [referenceKey(parseSecretReference(raw))]: secret },
          });
          expect(receipt.state).toBe("completed");
          expect(receipt.roleStandIns).toEqual([
            { actionIndex: 1, requestedRole: "button", role: "link", name: "Upgrade [secret]" },
          ]);
          expect(JSON.stringify(receipt)).not.toContain(secret);
        } finally {
          await backend.close();
        }
      });
    });

    test("a batch CUA stopped says how far it got", async () => {
      const step = (index: number, fields: Record<string, unknown>) => ({
        ok: true,
        total: 3,
        executed: index + 1,
        failed_step: index,
        steps: [
          ...Array.from({ length: index }, (_, done) => ({ index: done, ok: true, message: "ok" })),
          { index, ok: false, ...fields },
        ],
      });
      for (const { reply, expected, details } of [
        // Nothing ran: refused before the first step.
        {
          reply: { ok: false, code: "invalid_batch", executed: 0, failed_step: 1, detail: "bad" },
          expected: { code: "invalid_action", dispatched: false },
          details: undefined,
        },
        // The first step's element was never found: nothing ran.
        {
          reply: step(0, { phase: "find", code: "not_found", message: "no such element" }),
          expected: { code: "driver_failed", dispatched: false },
          details: undefined,
        },
        // The first step was refused with a refusal code: nothing ran.
        {
          reply: step(0, { phase: "action", code: "stale_element_token", message: "stale" }),
          expected: { code: "observation_stale", dispatched: false },
          details: undefined,
        },
        // A later action failed without proof it did nothing.
        {
          reply: step(1, { phase: "action", message: "did not confirm" }),
          expected: { code: "outcome_unknown", dispatched: true },
          details: { batchActionsCompleted: 1, batchStoppedActionState: "outcome_unknown" },
        },
        // Keys of a later action were refused before any was sent: the
        // failure says what to do, not CUA's own options.
        {
          reply: step(1, {
            phase: "action",
            code: "window_not_key",
            message: "CUA's own reason, naming its own delivery options",
          }),
          expected: {
            code: "invalid_action",
            dispatched: true,
            message:
              "CUA stopped the batch at action 2: Keys reach only the focused window of a background app, and another of its windows has focus, so none were sent: act on that window, or close it first",
          },
          details: { batchActionsCompleted: 1, batchStoppedActionState: "failed" },
        },
        // A later action was refused: the earlier ones still ran.
        {
          reply: step(2, { phase: "action", code: "stale_element_token", message: "stale" }),
          expected: { code: "observation_stale", dispatched: true },
          details: { batchActionsCompleted: 2, batchStoppedActionState: "failed" },
        },
        // A later value write CUA did not apply changed nothing.
        {
          reply: step(1, {
            phase: "action",
            code: "write_not_applied",
            message: "set_value did not take",
          }),
          expected: { code: "driver_failed", dispatched: true },
          details: { batchActionsCompleted: 1, batchStoppedActionState: "failed" },
        },
        // An element of another window of the app was refused before
        // anything was sent: the failure names that window as a target.
        {
          reply: step(1, {
            phase: "action",
            code: "element_outside_target_window",
            message:
              "Background input refused (element_outside_target_window): the addressed element belongs to window 7, a separate window of this app, not to window 1; read window 7 with get_window_state and address the element there",
          }),
          expected: {
            code: "invalid_action",
            dispatched: true,
            message:
              "CUA stopped the batch at action 2: That element is in another window of this app, not in cua:window:42:1, so nothing was done",
          },
          details: { batchActionsCompleted: 1, batchStoppedActionState: "failed" },
        },
        // Pointer or key input to an element of a bubble the window shows was
        // refused before anything was sent: say what reaches it.
        {
          reply: step(1, {
            phase: "action",
            code: "element_in_attached_window",
            message: "CUA's own reason, naming its own tools",
          }),
          expected: {
            code: "invalid_action",
            dispatched: true,
            message:
              "CUA stopped the batch at action 2: That element is in a bubble or popover shown over this window, which takes only invoke and set_value on its ref; pointer and key input would land on the window under it, so none was sent",
          },
          details: { batchActionsCompleted: 1, batchStoppedActionState: "failed" },
        },
        // One that could not be proven to be in the window at all keeps
        // CUA's own reason, and is still a definite refusal.
        {
          reply: step(0, {
            phase: "action",
            code: "element_outside_target_window",
            message: "the addressed element could not be proven to belong to window 1",
          }),
          expected: {
            code: "invalid_action",
            dispatched: false,
            message:
              "CUA stopped the batch at action 1: the addressed element could not be proven to belong to window 1",
          },
          details: undefined,
        },
      ]) {
        const fixture = new BatchFixture();
        fixture.reply = reply;
        const { backend, observation } = await open(fixture);
        try {
          const failure = await backend.dispatch(batch(observation)).catch((error) => error);
          expect(failure).toMatchObject(expected);
          expect(failure.details).toEqual(details);
        } finally {
          await backend.close();
        }
      }
    });

    test("the receipt of a stopped batch keeps how many actions completed", async () => {
      const fixture = new BatchFixture();
      fixture.reply = {
        ok: false,
        total: 3,
        executed: 2,
        failed_step: 1,
        steps: [
          { index: 0, ok: true, message: "ok" },
          { index: 1, ok: false, phase: "action", message: "did not confirm" },
        ],
      };
      const backend = await CuaComputerBackend.open(fixture);
      try {
        const computerSessionId = crypto.randomUUID();
        const controllerGeneration = "controller-fixture";
        const controller = new ComputerInteractionController({
          computerSessionId,
          controllerGeneration,
          driver: new ComputerDriver({ computerSessionId, controllerGeneration, client: backend }),
        });
        const target = (await backend.targets())[0]!;
        const observation = await controller.observe(target.id);
        const ref =
          observation.semantic?.kind === "snapshot" ? observation.semantic.roots[0]!.ref : "";
        const receipt = await controller.run({
          protocolVersion: 1,
          operationId: crypto.randomUUID(),
          computerSessionId,
          controllerGeneration,
          targetId: target.id,
          expectedTargetGeneration: observation.target.targetGeneration,
          expectedObservationId: observation.observationId,
          expectedFrameId: null,
          actor: { kind: "agent", subjectId: "agent:fixture" },
          action: {
            type: "batch",
            actions: [
              { type: "semantic", locator: { kind: "ref", ref }, action: "invoke" },
              { type: "keyboard", action: "type", value: "hello" },
              { type: "keyboard", action: "press", value: "enter" },
            ],
          },
        });
        expect(receipt.state).toBe("outcome_unknown");
        expect(receipt.error).toMatchObject({
          code: "outcome_unknown",
          details: { batchActionsCompleted: 1, batchStoppedActionState: "outcome_unknown" },
        });
      } finally {
        await backend.close();
      }
    });

    describe("a web date field is filled by typing each of its parts", () => {
      /** A page with one datetime-local field (day, month, year, hours,
       * minutes), which reads `afterRun` once run_steps ran. */
      class DateFixture extends BatchFixture {
        value: string | undefined = undefined;
        afterRun = "2027-03-07T14:05";
        /** What the parts read once run_steps ran, when Chrome leaves the
         * field itself without a value. */
        partsAfterRun: string[] | null = null;
        async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
          const response = await super.callTool(name, argumentsJson);
          if (name === "run_steps" && !this.reply && !this.partsAfterRun)
            this.value = this.afterRun;
          const ran = this.ran && !this.reply;
          const args = JSON.parse(argumentsJson) as Record<string, unknown>;
          if (name !== "get_window_state" || !args.include_accessibility_tree) return response;
          const data = JSON.parse(response.structuredJson!);
          const s = data.snapshot_id as string;
          const parts = ["Day", "Month", "Year", "Hours", "Minutes"];
          data.elements = [
            { element_index: 0, role: "AXWebArea", label: "Page", actions: [] },
            {
              element_index: 1,
              element_token: `${s}:1`,
              parent_index: 0,
              role: "AXDateField",
              label: "Meeting",
              ...(this.value === undefined ? {} : { value: this.value }),
              actions: ["AXPress"],
            },
            ...parts.map((part, index) => ({
              element_index: 2 + index,
              element_token: `${s}:${2 + index}`,
              parent_index: 1,
              role: "AXIncrementor",
              label: `${part} Meeting`,
              value: (ran && this.partsAfterRun?.[index]) || "--",
              actions: ["AXIncrement", "AXDecrement"],
            })),
          ];
          response.structuredJson = JSON.stringify(data);
          return response;
        }
      }
      const setDate = (
        observation: ComputerBackendObservation,
        ref: string,
        value: string,
      ): ComputerBackendActionCommand => ({
        ...command(observation),
        action: { type: "semantic", locator: { kind: "ref", ref }, action: "set_value", value },
      });
      const field = (observation: ComputerBackendObservation) =>
        observation.roots.find((node) => node.role === "AXDateField")!;

      test("set_value presses the field, then reaches and types each part, as one run_steps", async () => {
        const fixture = new DateFixture();
        const { backend, observation } = await open(fixture);
        try {
          expect(field(observation).actions).toContain("set_value");
          const after = await backend.dispatch(
            setDate(observation, field(observation).ref, "2027-03-07T14:05"),
          );
          expect(field(after!).value).toBe("2027-03-07T14:05");
          const calls = fixture.calls.filter((call) => call.name === "run_steps");
          expect(calls).toHaveLength(1);
          expect(mutations(fixture)).toHaveLength(0);
          const steps = calls[0]!.args.steps as { tool: string; args: Record<string, unknown> }[];
          const s = observation.observationId.split(":").pop();
          expect(steps[0]).toMatchObject({
            tool: "click",
            args: { element_token: `${s}:1`, delivery_mode: "background" },
          });
          // Each part is reached from the first: four Lefts, then Rights.
          const compact = steps
            .slice(1)
            .map((step) =>
              step.tool === "type_text" ? String(step.args.text) : String(step.args.key)[0],
            )
            .join(" ");
          expect(compact).toBe(
            [
              "l l l l 07",
              "l l l l r 03",
              "l l l l r r 2027",
              "l l l l r r r 14",
              "l l l l r r r r 05",
            ].join(" "),
          );
        } finally {
          await backend.close();
        }
      });

      test("a value in another form is refused before any key is sent", async () => {
        const fixture = new DateFixture();
        const { backend, observation } = await open(fixture);
        try {
          const failure = await backend
            .dispatch(setDate(observation, field(observation).ref, "03/07/2027 2:05 PM"))
            .catch((error: unknown) => error);
          expect(failure).toMatchObject({
            code: "invalid_action",
            dispatched: false,
            message: "This date or time field takes its whole value in the form YYYY-MM-DDTHH:MM",
          });
          expect(fixture.ran).toBe(false);
        } finally {
          await backend.close();
        }
      });

      test("a part of the field points to the field", async () => {
        const fixture = new DateFixture();
        const { backend, observation } = await open(fixture);
        try {
          const day = observation.roots.find((node) => node.name === "Day Meeting")!;
          for (const action of ["set_value", "focus"] as const) {
            const failure = await backend
              .dispatch({
                ...setDate(observation, day.ref, "07"),
                action: {
                  type: "semantic",
                  locator: { kind: "ref", ref: day.ref },
                  action,
                  value: "07",
                },
              })
              .catch((error: unknown) => error);
            expect(failure).toMatchObject({
              code: "unsupported",
              dispatched: false,
              message: `This is one part of the date or time field ${field(observation).ref} ("Meeting"), which is filled as a whole: set_value on ${field(observation).ref} with its value in the form YYYY-MM-DDTHH:MM`,
            });
          }
        } finally {
          await backend.close();
        }
      });

      test("a field that reads another value afterwards says so", async () => {
        const fixture = new DateFixture();
        fixture.afterRun = "0012-03-07T14:05";
        const { backend, observation } = await open(fixture);
        try {
          const failure = await backend
            .dispatch(setDate(observation, field(observation).ref, "2027-03-07T14:05"))
            .catch((error: unknown) => error);
          expect(failure).toMatchObject({
            code: "driver_failed",
            dispatched: true,
            message: `The keys were typed, but the date field ${field(observation).ref} reads "0012-03-07T14:05" instead of the value it was given; observe it and set its value again`,
          });
        } finally {
          await backend.close();
        }
      });

      test("a field Chrome left without a value reads what its parts read", async () => {
        const fixture = new DateFixture();
        fixture.partsAfterRun = ["07", "03", "2027", "14", "05"];
        const { backend, observation } = await open(fixture);
        try {
          const after = await backend.dispatch(
            setDate(observation, field(observation).ref, "2027-03-07T14:05"),
          );
          expect(field(after!).value).toBe("2027-03-07T14:05");
        } finally {
          await backend.close();
        }
      });

      test("a field whose parts read nothing either still says it reads empty", async () => {
        const fixture = new DateFixture();
        fixture.partsAfterRun = ["", "", "", "", ""];
        const { backend, observation } = await open(fixture);
        try {
          const failure = await backend
            .dispatch(setDate(observation, field(observation).ref, "2027-03-07T14:05"))
            .catch((error: unknown) => error);
          expect(failure).toMatchObject({
            code: "driver_failed",
            dispatched: true,
            message: `The keys were typed, but the date field ${field(observation).ref} reads empty instead of the value it was given; observe it and set its value again`,
          });
        } finally {
          await backend.close();
        }
      });

      test("a batch whose actions all ran reports only its last as unknown when a field is wrong", async () => {
        const fixture = new DateFixture();
        fixture.afterRun = "0012-03-07T14:05";
        const { backend, observation } = await open(fixture);
        try {
          const one = setDate(observation, field(observation).ref, "2027-03-07T14:05").action;
          const failure = await backend
            .dispatch({
              ...command(observation),
              action: {
                type: "batch",
                actions: [one, { type: "keyboard", action: "press", value: "tab" }] as never,
              },
            })
            .catch((error: unknown) => error);
          expect(failure).toMatchObject({
            code: "driver_failed",
            dispatched: true,
            message: `All 2 actions of the batch ran, but the date field ${field(observation).ref} reads "0012-03-07T14:05" instead of the value it was given; observe it and set its value again`,
            details: { batchActionsCompleted: 1, batchStoppedActionState: "outcome_unknown" },
          });
        } finally {
          await backend.close();
        }
      });

      test("a batch longer than one run_steps call runs in several, and reports by action", async () => {
        const fixture = new DateFixture();
        const { backend, observation } = await open(fixture);
        try {
          const one = setDate(observation, field(observation).ref, "2027-03-07T14:05").action;
          const many: ComputerBackendActionCommand = {
            ...command(observation),
            action: { type: "batch", actions: [one, one, one] as never },
          };
          await backend.dispatch(many);
          const calls = fixture.calls.filter((call) => call.name === "run_steps");
          expect(calls.map((call) => (call.args.steps as unknown[]).length)).toEqual([64, 44]);
          // Stopped inside the second action's input: it ran in part.
          const stopping = new DateFixture();
          stopping.reply = {
            ok: true,
            total: 64,
            executed: 41,
            failed_step: 40,
            steps: [
              ...Array.from({ length: 40 }, (_, index) => ({ index, ok: true, message: "ok" })),
              {
                index: 40,
                ok: false,
                phase: "action",
                code: "stale_element_token",
                message: "stale",
              },
            ],
          };
          const second = await open(stopping);
          try {
            const failure = await second.backend
              .dispatch({ ...many, ...command(second.observation), action: many.action })
              .catch((error: unknown) => error);
            expect(failure).toMatchObject({
              code: "outcome_unknown",
              dispatched: true,
              details: { batchActionsCompleted: 1, batchStoppedActionState: "outcome_unknown" },
            });
            expect(String((failure as Error).message)).toStartWith(
              "CUA stopped the batch at action 2: ",
            );
          } finally {
            await second.backend.close();
          }
        } finally {
          await backend.close();
        }
      });
    });

    describe("a text field that does not take set_value says so", () => {
      /** A field that reads `text`, and takes what set_value writes only
       * when `takes` (Chrome ignores a number written to a web text field
       * as a number). Enter submits the form and empties it. */
      class TextFixture extends BatchFixture {
        text = "";
        takes = false;
        /** Readings that still show the value from before the last write. */
        lateReads = 0;
        previous = "";
        async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
          const args = JSON.parse(argumentsJson) as Record<string, unknown>;
          const steps =
            name === "run_steps"
              ? (args.steps as { tool: string; args: Record<string, unknown> }[])
              : [{ tool: name, args }];
          for (const step of steps) {
            if (step.tool === "set_value" && this.takes) {
              this.previous = this.text;
              this.text = String(step.args.value);
            }
            if (step.tool === "press_key" && step.args.key === "enter") this.text = "";
          }
          const response = await super.callTool(name, argumentsJson);
          if (name !== "get_window_state" || !args.include_accessibility_tree) return response;
          const data = JSON.parse(response.structuredJson!);
          const s = data.snapshot_id as string;
          const shown = this.lateReads > 0 ? this.previous : this.text;
          if (this.lateReads > 0) this.lateReads -= 1;
          data.elements = [
            {
              element_index: 0,
              element_token: `${s}:0`,
              role: "AXTextField",
              label: "CVC",
              value: shown,
              actions: ["AXConfirm"],
            },
          ];
          response.structuredJson = JSON.stringify(data);
          return response;
        }
      }
      const setText = (
        observation: ComputerBackendObservation,
        value: string,
      ): ComputerBackendActionCommand["action"] => ({
        type: "semantic",
        locator: { kind: "ref", ref: observation.roots[0]!.ref },
        action: "set_value",
        value,
      });

      test("set_value that the field ignores fails without repeating the value", async () => {
        const fixture = new TextFixture();
        const { backend, observation } = await open(fixture);
        try {
          expect(observation.roots[0]).toMatchObject({ role: "textbox" });
          const failure = await backend
            .dispatch({ ...command(observation), action: setText(observation, "312") })
            .catch((error: unknown) => error);
          expect(failure).toMatchObject({
            code: "driver_failed",
            dispatched: true,
            message: `The value was written, but the text field ${observation.roots[0]!.ref} still reads empty: the app did not take the value; invoke the field and type the text instead`,
          });
          expect(String((failure as Error).message)).not.toContain("312");
        } finally {
          await backend.close();
        }
      });

      test("a field that takes the value, or already read it, passes", async () => {
        const fixture = new TextFixture();
        fixture.takes = true;
        const { backend, observation } = await open(fixture);
        try {
          const after = await backend.dispatch({
            ...command(observation),
            action: setText(observation, "312"),
          });
          expect(after!.roots[0]!.value).toBe("312");
          fixture.takes = false;
          await backend.dispatch({ ...command(after!), action: setText(after!, "312") });
        } finally {
          await backend.close();
        }
      });

      test("a field that shows the value a moment late passes", async () => {
        const fixture = new TextFixture();
        fixture.takes = true;
        const { backend, observation } = await open(fixture);
        try {
          fixture.lateReads = 1;
          const after = await backend.dispatch({
            ...command(observation),
            action: setText(observation, "312"),
          });
          expect(after!.roots[0]!.value).toBe("312");
        } finally {
          await backend.close();
        }
      });

      test("in a batch, a field a later step may submit or clear is not judged", async () => {
        const fixture = new TextFixture();
        fixture.takes = true;
        const { backend, observation } = await open(fixture);
        try {
          await backend.dispatch({
            ...command(observation),
            action: {
              type: "batch",
              actions: [
                setText(observation, "hello"),
                { type: "keyboard", action: "press", value: "enter" },
              ] as never,
            },
          });
          fixture.takes = false;
          const fresh = await backend.observe(observation.target.id);
          const failure = await backend
            .dispatch({
              ...command(fresh),
              action: {
                type: "batch",
                actions: [setText(fresh, "312"), setText(fresh, "313")] as never,
              },
            })
            .catch((error: unknown) => error);
          expect(failure).toMatchObject({
            code: "driver_failed",
            dispatched: true,
            details: { batchActionsCompleted: 1, batchStoppedActionState: "outcome_unknown" },
          });
          expect(String((failure as Error).message)).toStartWith(
            "All 2 actions of the batch ran, but the text field ",
          );
        } finally {
          await backend.close();
        }
      });
    });

    describe("a web number field takes set_value and says when it did not", () => {
      /** Chrome's `<input type=number>` "Seats" as macOS reads it: an
       * AXIncrementor in web content, next to a date field whose parts are
       * AXIncrementors too. `shows` is what it reads after a write. */
      class NumberFixture extends BatchFixture {
        value = "5";
        shows: ((written: string) => string) | null = (written) => written;
        /** A range input "Volume" from 0 to 100 in steps of 7. */
        volume = "14";
        /** Whether the window reads Volume's value, as many native sliders don't. */
        volumeReadable = true;
        async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
          const args = JSON.parse(argumentsJson) as Record<string, unknown>;
          const steps =
            name === "run_steps"
              ? (args.steps as { tool: string; args: Record<string, unknown> }[])
              : [{ tool: name, args }];
          for (const step of steps)
            if (step.tool === "set_value" && String(step.args.element_token).endsWith(":4"))
              this.volume = String(
                Math.min(98, Math.max(0, Math.round(Number(step.args.value) / 7) * 7)),
              );
            else if (step.tool === "set_value" && this.shows)
              this.value = this.shows(String(step.args.value));
          const response = await super.callTool(name, argumentsJson);
          if (name !== "get_window_state" || !args.include_accessibility_tree) return response;
          const data = JSON.parse(response.structuredJson!);
          const s = data.snapshot_id as string;
          data.elements = [
            { element_index: 0, role: "AXWebArea", label: "Page", actions: [] },
            {
              element_index: 1,
              element_token: `${s}:1`,
              parent_index: 0,
              role: "AXIncrementor",
              label: "Seats",
              value: this.value,
              actions: ["AXPress", "AXShowMenu", "AXIncrement", "AXDecrement"],
            },
            {
              element_index: 2,
              element_token: `${s}:2`,
              parent_index: 0,
              role: "AXDateField",
              label: "Start",
              actions: ["AXPress"],
            },
            {
              element_index: 3,
              element_token: `${s}:3`,
              parent_index: 2,
              role: "AXIncrementor",
              label: "Day Start",
              value: "--",
              actions: ["AXIncrement", "AXDecrement"],
            },
            {
              element_index: 4,
              element_token: `${s}:4`,
              parent_index: 0,
              role: "AXSlider",
              label: "Volume",
              ...(this.volumeReadable ? { value: this.volume } : {}),
              actions: ["AXIncrement", "AXDecrement"],
            },
          ];
          response.structuredJson = JSON.stringify(data);
          return response;
        }
      }
      const seats = (observation: ComputerBackendObservation) =>
        observation.roots.find((node) => node.name === "Seats")!;
      const setSeats = (
        observation: ComputerBackendObservation,
        value: string,
      ): ComputerBackendActionCommand => ({
        ...command(observation),
        action: {
          type: "semantic",
          locator: { kind: "ref", ref: seats(observation).ref },
          action: "set_value",
          value,
        },
      });

      test("it is a spinbutton that offers set_value; a date part stays as it was", async () => {
        const { backend, observation } = await open(new NumberFixture());
        try {
          expect(seats(observation)).toMatchObject({
            role: "spinbutton",
            value: "5",
            actions: ["invoke", "set_value", "focus"],
          });
          expect(observation.roots.find((node) => node.name === "Day Start")).toMatchObject({
            role: "AXIncrementor",
            actions: [],
          });
        } finally {
          await backend.close();
        }
      });

      test("a number it shows, as a number, passes", async () => {
        const fixture = new NumberFixture();
        // Chrome reads 7.50 back as the number 7.5.
        fixture.shows = (written) => String(Number(written));
        const { backend, observation } = await open(fixture);
        try {
          const after = await backend.dispatch(setSeats(observation, "42"));
          expect(seats(after!).value).toBe("42");
          const again = await backend.dispatch(setSeats(after!, "7.50"));
          expect(seats(again!).value).toBe("7.5");
          // The value goes to the field as it was given.
          expect(JSON.stringify(fixture.calls)).toContain('"value":"7.50"');
        } finally {
          await backend.close();
        }
      });

      test("a write it emptied, or did not take, fails", async () => {
        const fixture = new NumberFixture();
        fixture.shows = () => "";
        const { backend, observation } = await open(fixture);
        try {
          const emptied = await backend
            .dispatch(setSeats(observation, "42"))
            .catch((error: unknown) => error);
          expect(emptied).toMatchObject({
            code: "driver_failed",
            dispatched: true,
            message: `The value was written, but the number field ${seats(observation).ref} reads empty instead of the value it was given; give it a plain number, such as 42 or 7.5`,
          });
          fixture.shows = null;
          fixture.value = "5";
          const fresh = await backend.observe(observation.target.id);
          const ignored = await backend
            .dispatch(setSeats(fresh, "42"))
            .catch((error: unknown) => error);
          expect(String((ignored as Error).message)).toContain(
            `the number field ${seats(fresh).ref} reads "5" instead of the value it was given`,
          );
          // Emptying it on purpose is what it was asked.
          fixture.shows = (written) => written;
          await backend.dispatch(setSeats(fresh, ""));
        } finally {
          await backend.close();
        }
      });

      test("a slider its steps or range stop short of the value fails", async () => {
        const fixture = new NumberFixture();
        const { backend, observation } = await open(fixture);
        const setVolume = (current: ComputerBackendObservation, value: string) =>
          backend.dispatch({
            ...command(current),
            action: {
              type: "semantic",
              locator: { kind: "role", role: "slider", name: "Volume" },
              action: "set_value",
              value,
            },
          });
        try {
          const after = await setVolume(observation, "28");
          expect(after!.roots.find((node) => node.name === "Volume")!.value).toBe("28");
          for (const [value, reads] of [
            ["30", "28"],
            ["150", "98"],
          ]) {
            const failure = await setVolume(
              await backend.observe(observation.target.id),
              value!,
            ).catch((error: unknown) => error);
            expect(String((failure as Error).message)).toContain(
              `the slider ${observation.roots.find((node) => node.name === "Volume")!.ref} reads "${reads}" instead of the value it was given; give it a value within its range that its steps reach`,
            );
          }
        } finally {
          await backend.close();
        }
      });

      test("a slider whose value the window does not read is not checked", async () => {
        const fixture = new NumberFixture();
        fixture.volumeReadable = false;
        const { backend, observation } = await open(fixture);
        try {
          const after = await backend.dispatch({
            ...command(observation),
            action: {
              type: "semantic",
              locator: {
                kind: "ref",
                ref: observation.roots.find((node) => node.name === "Volume")!.ref,
              },
              action: "set_value",
              value: "28",
            },
          });
          expect(after!.roots.find((node) => node.name === "Volume")!.value).toBeUndefined();
          expect(fixture.volume).toBe("28");
        } finally {
          await backend.close();
        }
      });
    });

    test("a stopped batch's message does not show a typed secret CUA clipped", async () => {
      const secret = `synthetic-${"0123456789".repeat(44)}`;
      // CUA keeps the first 300 characters of a step's text, marks the cut
      // and adds its own advice after it.
      const message = `${`Typed ${secret}`.slice(0, 300)}... To run it, send the batch again.`;
      const fixture = new BatchFixture();
      fixture.reply = {
        ok: false,
        total: 2,
        executed: 2,
        failed_step: 1,
        steps: [
          { index: 0, ok: true, message: "ok" },
          { index: 1, ok: false, phase: "action", message, hint: `Check ${secret}` },
        ],
      };
      const backend = await CuaComputerBackend.open(fixture);
      try {
        const computerSessionId = crypto.randomUUID();
        const controllerGeneration = "controller-fixture";
        const controller = new ComputerInteractionController({
          computerSessionId,
          controllerGeneration,
          driver: new ComputerDriver({ computerSessionId, controllerGeneration, client: backend }),
        });
        const target = (await backend.targets())[0]!;
        const observation = await controller.observe(target.id);
        const ref =
          observation.semantic?.kind === "snapshot" ? observation.semantic.roots[0]!.ref : "";
        const raw = "{{secret:Desk/token}}";
        const receipt = await controller.run({
          protocolVersion: 1,
          operationId: crypto.randomUUID(),
          computerSessionId,
          controllerGeneration,
          targetId: target.id,
          expectedTargetGeneration: observation.target.targetGeneration,
          expectedObservationId: observation.observationId,
          expectedFrameId: null,
          actor: { kind: "agent", subjectId: "agent:fixture" },
          action: {
            type: "batch",
            actions: [
              { type: "semantic", locator: { kind: "ref", ref }, action: "invoke" },
              { type: "keyboard", action: "type", value: raw },
            ],
          },
          secretValues: { [referenceKey(parseSecretReference(raw))]: secret },
        });
        expect(receipt.state).toBe("outcome_unknown");
        expect(receipt.error?.message).toBe(
          "CUA stopped the batch at action 2: Typed [secret]... To run it, send the batch again. Check [secret]",
        );
        expect(JSON.stringify(receipt)).not.toContain(secret.slice(0, 12));
      } finally {
        await backend.close();
      }
    });
  });
});
