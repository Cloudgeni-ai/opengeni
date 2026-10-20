import { describe, expect, test } from "bun:test";
import { CUA_DESKTOP_TOOLS } from "@opengeni/contracts";
import { ComputerInteractionController } from "@opengeni/interaction";
import type { ToolResult } from "@trycua/cua-driver";
import { CuaComputerBackend } from "../src/cua/backend";
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
        ref: "s1:0",
        name: "Named field",
        actions: ["set_value"],
      });
      expect(observation.roots[1]).toMatchObject({ ref: "s1:1", actions: ["set_value"] });
      expect(observation.roots[1]!.name).toBeUndefined();
      await backend.dispatch({
        ...command(observation),
        action: {
          type: "semantic",
          action: "set_value",
          locator: { kind: "ref", ref: "s1:1" },
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
      ).rejects.toMatchObject({ code: "unsupported", dispatched: false });
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
      // CUA honours only its latest tokens: the ref is sent as the same
      // element's token from the latest observation.
      await backend.dispatch(command(first));
      expect(fixture.calls.filter((call) => call.name === "click").at(-1)?.args).toMatchObject({
        element_token: second.roots[0]!.ref,
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
      // An action without fences is checked against a fresh observation,
      // which mints new refs and retires the old ones in CUA; the ref the
      // model read is rebased to the same element in the fresh observation.
      const fresh = await backend.observe(target.id);
      expect(fresh.roots[0]!.ref).not.toBe(seen.roots[0]!.ref);
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
      ).toMatchObject({
        element_token: fresh.roots[0]!.ref,
      });
      // A ref action may name the observation its ref came from, even after
      // the window was read again.
      const again = await backend.observe(target.id);
      await backend.dispatch({ ...command(seen), targetId: again.target.id });
      expect(
        [...fixture.calls].reverse().find((call) => call.name === "click")?.args,
      ).toMatchObject({ element_token: again.roots[0]!.ref });
      // Other actions still need the latest observation.
      await expect(
        backend.dispatch({
          ...command(seen),
          action: { type: "semantic", locator: { kind: "role", role: "button" }, action: "invoke" },
        }),
      ).rejects.toMatchObject({ code: "observation_stale", dispatched: false });
      // Once anything in the window changed, even another element or only
      // the window's title (a Delete button can look the same for a different
      // row or document), an earlier ref is refused before any input, without
      // quoting any label.
      const clicks = fixture.calls.filter((call) => call.name === "click").length;
      for (const change of [
        async () => {
          fixture.fieldLabel = "Password again";
        },
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
        code: "driver_failed",
        dispatched: false,
        message:
          "Keys cannot reach the sheet open in this window while its app is in the background, so none were sent. Use the sheet's controls from this window's observation instead: set_value on a text field's ref, invoke on a button's ref",
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

  test("a launch observes the launched app's window, once it appears", async () => {
    // The launched app's window shows up in the second listing after launch.
    class LaunchFixture extends Fixture {
      launched = false;
      listings = 0;
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
        if (name === "list_windows" && this.launched && ++this.listings > 1) {
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

    // An app that opens no window leaves the action's own target observed.
    const fixture = new Fixture();
    const original = fixture.callTool.bind(fixture);
    fixture.callTool = async (name, json) =>
      name === "launch_app" ? result({ pid: 78, windows: [] }) : await original(name, json);
    const backend = await CuaComputerBackend.open(fixture);
    try {
      const target = (await backend.targets())[0]!;
      const observation = await backend.observe(target.id);
      const launched = await backend.dispatch({
        ...command(observation),
        action: { type: "launch", applicationId: "Menu Bar Helper" },
      });
      expect(launched?.target.id).toBe(target.id);
    } finally {
      await backend.close();
    }
  });

  test("an action that opens one window of its app observes that window", async () => {
    // After the action, list_windows adds the windows in `opens`, and CUA's
    // result says it saw new windows when `reported` is set.
    class OpeningFixture extends Fixture {
      acted = false;
      reported = true;
      opens: Array<{ pid: number; window_id: number; bounds: Record<string, number> }> = [];
      async callTool(name: string, argumentsJson: string): Promise<ToolResult> {
        const args = JSON.parse(argumentsJson) as Record<string, unknown>;
        const response = await super.callTool(name, argumentsJson);
        if (name === "click") {
          this.acted = true;
          if (this.reported)
            return {
              ...response,
              text: 'Clicked.\n\n🪟 Action opened new window(s): Fixture ("Untitled").',
            };
        }
        if (name === "list_windows" && this.acted) {
          const data = JSON.parse(response.structuredJson!);
          for (const window of this.opens)
            data.windows.push({ ...window, title: "Untitled", app_name: "Fixture" });
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
    const beside = { x: 300, y: 50, width: 200, height: 100 };
    const within = { x: 60, y: 60, width: 100, height: 50 };
    for (const { opens, reported, observed } of [
      // A new document window of the app.
      { opens: [{ pid: 42, window_id: 2, bounds: beside }], reported: true, observed: 2 },
      // Two candidates are never guessed between.
      {
        opens: [
          { pid: 42, window_id: 2, bounds: beside },
          { pid: 42, window_id: 3, bounds: beside },
        ],
        reported: true,
        observed: 1,
      },
      // A sheet is read through the window it is attached to.
      { opens: [{ pid: 42, window_id: 2, bounds: within }], reported: true, observed: 1 },
      // Another app's window is not this target's.
      { opens: [{ pid: 43, window_id: 2, bounds: beside }], reported: true, observed: 1 },
      // Without CUA's report, the windows are not listed again.
      { opens: [{ pid: 42, window_id: 2, bounds: beside }], reported: false, observed: 1 },
    ]) {
      const fixture = new OpeningFixture();
      fixture.opens = opens;
      fixture.reported = reported;
      const backend = await CuaComputerBackend.open(fixture);
      try {
        const target = (await backend.targets())[0]!;
        const observation = await backend.observe(target.id);
        const listings = fixture.calls.filter((call) => call.name === "list_windows").length;
        const after = await backend.dispatch(command(observation));
        expect(after?.target.id).toBe(
          `cua:window:${observed === 1 ? 42 : opens[0]!.pid}:${observed}`,
        );
        expect(fixture.calls.filter((call) => call.name === "list_windows").length).toBe(
          listings + (reported ? 1 : 0),
        );
      } finally {
        await backend.close();
      }
    }

    // The controller records the opened window's observation in the receipt.
    const fixture = new OpeningFixture();
    fixture.opens = [{ pid: 42, window_id: 2, bounds: beside }];
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
    const backend = await CuaComputerBackend.open(fixture);
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
      const other = await CuaComputerBackend.open(platformFixture, platform);
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
});
