import { describe, expect, test } from "bun:test";
import type { ToolResult } from "@trycua/cua-driver";
import { CuaComputerBackend } from "../src/cua/backend";
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
  test("keeps tokens current, redacts protected values and never calls browser tools", async () => {
    const fixture = new Fixture(),
      backend = await CuaComputerBackend.open(fixture);
    try {
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

  test("maps window coordinates and permits repeated scroll/drag without new screenshots", async () => {
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
      expect(fixture.captures).toBe(capturesBeforeInput);
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
