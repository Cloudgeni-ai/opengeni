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
                title: "Fixture",
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
        // New worker defaults to Markdown; the Mac adapter needs structured elements.
        if (!(this instanceof WindowsFixture)) expect(args.tree_format).toBe("elements");
        const snapshot = ++this.snapshot;
        Object.assign(data, {
          snapshot_id: `s${snapshot}`,
          elements: [
            {
              element_index: 0,
              element_token: `s${snapshot}:0`,
              role: "AXButton",
              label: "Apply",
              actions: ["AXPress"],
            },
            {
              element_index: 1,
              element_token: `s${snapshot}:1`,
              role: "AXSecureTextField",
              label: "Password",
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

  test("Windows retains real platform identity and only advertises native UIA actions", async () => {
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
        pointerInput: false,
        keyboardInput: false,
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
      await expect(
        backend.dispatch({
          ...command(latest),
          action: { type: "keyboard", action: "type", value: "Rejected" },
        }),
      ).rejects.toMatchObject({ code: "unsupported", dispatched: false });
      expect(fixture.calls.filter((call) => call.name === "set_value")).toHaveLength(1);
      expect(fixture.calls.filter((call) => call.name === "type_text")).toHaveLength(0);
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
      await backend.observe(target.id);
      await expect(backend.dispatch(command(first))).rejects.toMatchObject({
        code: "observation_stale",
        dispatched: false,
      });
      const fresh = await backend.observe(target.id);
      await backend.validate(command(fresh));
      await backend.dispatch(command(fresh));
      await expect(backend.dispatch(command(fresh))).rejects.toMatchObject({
        code: "observation_stale",
      });
      expect(fixture.calls.filter((call) => call.name === "click")).toHaveLength(1);
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
