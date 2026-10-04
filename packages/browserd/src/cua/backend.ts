import { createHash, randomUUID } from "node:crypto";
import type { ComputerSessionCapabilities } from "@opengeni/contracts";
import {
  ComputerBackendError,
  type ComputerBackend,
  type ComputerBackendTarget,
  type ComputerBackendObservation,
  type ComputerBackendFrame,
  type ComputerBackendCaptureOptions,
  type ComputerBackendActionCommand,
  type ComputerBackendClipboard,
} from "../computer-backend";
import { callDesktop, Windows, WindowState, type CuaDesktopRuntime } from "./wire";
import { locate, projectElements } from "./projection";

type Target = { native: ComputerBackendTarget; pid: number; windowId: number };
type Frame = { targetId: string; width: number; height: number };
type Operation = {
  name: "click" | "drag" | "scroll" | "set_value" | "type_text" | "press_key";
  args: Record<string, unknown>;
};

/** CUA owns OS delivery. OpenGeni owns authority, receipts and public media.
 * Every call is serialized, including preview captures and shutdown. */
export class CuaComputerBackend implements ComputerBackend {
  readonly identity: { platform: "macos" | "windows"; adapterId: string };
  readonly initialCapabilities: ComputerSessionCapabilities;
  private readonly session = `opengeni-${randomUUID()}`;
  private readonly targetsById = new Map<string, Target>();
  private readonly observations = new Map<string, ComputerBackendObservation>();
  private readonly frames = new Map<string, Frame>();
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private pending = 0;

  private constructor(
    private readonly runtime: CuaDesktopRuntime,
    permissions: { accessibility: boolean; screen_recording: boolean },
    platform: "macos" | "windows",
  ) {
    this.identity = { platform, adapterId: `opengeni.cua.${platform}.v1` };
    this.initialCapabilities = {
      semanticObservation: permissions.accessibility,
      appDiscovery: true,
      appLaunch: false,
      windowCapture: permissions.screen_recording,
      screenCapture: false,
      semanticActions: permissions.accessibility,
      pointerInput:
        platform === "macos" && permissions.accessibility && permissions.screen_recording,
      keyboardInput: platform === "macos" && permissions.accessibility,
      clipboard: false,
      backgroundActions: permissions.accessibility,
      backgroundInput: platform === "macos" && permissions.accessibility,
      parallelApps: false,
    };
  }

  static async open(
    runtime: CuaDesktopRuntime,
    platform: "macos" | "windows" = "macos",
  ): Promise<CuaComputerBackend> {
    try {
      const permissions = await readPermissions(runtime, platform);
      const backend = new CuaComputerBackend(runtime, permissions, platform);
      await callDesktop(runtime, "start_session", { session: backend.session });
      return backend;
    } catch (error) {
      await runtime.shutdown();
      throw error;
    }
  }

  capabilities(): Promise<ComputerSessionCapabilities> {
    return this.run(async () => {
      const permissions = await readPermissions(this.runtime, this.identity.platform);
      const macos = this.identity.platform === "macos";
      return {
        ...this.initialCapabilities,
        semanticObservation: permissions.accessibility,
        semanticActions: permissions.accessibility,
        keyboardInput: macos && permissions.accessibility,
        backgroundActions: permissions.accessibility,
        backgroundInput: macos && permissions.accessibility,
        windowCapture: permissions.screen_recording,
        pointerInput: macos && permissions.accessibility && permissions.screen_recording,
      };
    });
  }

  targets(): Promise<ComputerBackendTarget[]> {
    return this.run(() => this.discover());
  }
  observe(targetId: string): Promise<ComputerBackendObservation> {
    return this.run(() => this.observeTarget(targetId));
  }
  capture(
    targetId: string,
    options?: ComputerBackendCaptureOptions,
  ): Promise<ComputerBackendFrame> {
    return this.run(() => this.captureTarget(targetId, options));
  }
  captureStill(
    targetId: string,
    options: ComputerBackendCaptureOptions,
  ): Promise<ComputerBackendFrame> {
    return this.capture(targetId, options);
  }
  startCapture(targetId: string, _options: ComputerBackendCaptureOptions): Promise<void> {
    return this.run(async () => {
      await this.target(targetId);
    });
  }
  stopCapture(_targetId: string): Promise<void> {
    return this.run(async () => {});
  }
  clipboard(): Promise<ComputerBackendClipboard> {
    return this.run(async () => {
      throw unsupported("CUA clipboard is not admitted by this adapter");
    });
  }
  validate(command: ComputerBackendActionCommand): Promise<void> {
    return this.run(async () => {
      await this.operations(command);
    });
  }

  dispatch(command: ComputerBackendActionCommand): Promise<ComputerBackendObservation | null> {
    return this.run(async () => {
      const operations = await this.operations(command);
      this.observations.delete(command.targetId);
      for (let index = 0; index < operations.length; index++) {
        const operation = operations[index]!;
        try {
          await callDesktop(this.runtime, operation.name, operation.args, true);
        } catch (error) {
          if (index > 0)
            throw new ComputerBackendError(
              "outcome_unknown",
              "CUA delivered only part of the input",
              false,
              true,
            );
          throw error;
        }
      }
      // Post-action observation failure cannot turn a delivered action into a
      // pre-dispatch rejection. The controller retains its completed receipt.
      try {
        return await this.observeTarget(command.targetId);
      } catch {
        return null;
      }
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.tail.then(async () => {
      try {
        await callDesktop(this.runtime, "end_session", { session: this.session });
      } finally {
        this.observations.clear();
        this.frames.clear();
        this.targetsById.clear();
        await this.runtime.shutdown();
      }
    });
    return this.closePromise;
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(
        new ComputerBackendError("unavailable", "CUA backend is closed", false, false),
      );
    if (this.pending >= 64)
      return Promise.reject(
        new ComputerBackendError("unavailable", "CUA backend queue is full", true, false),
      );
    this.pending++;
    const result = this.tail.then(operation).finally(() => {
      this.pending--;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async discover(): Promise<ComputerBackendTarget[]> {
    const { data } = await callDesktop(this.runtime, "list_windows", {});
    const windows = Windows.parse(data).windows;
    const live = new Set<string>();
    for (const window of windows) {
      const id = `cua:window:${window.pid}:${window.window_id}`;
      live.add(id);
      const old = this.targetsById.get(id);
      this.targetsById.set(id, {
        pid: window.pid,
        windowId: window.window_id,
        native: {
          id,
          targetGeneration: old?.native.targetGeneration ?? randomUUID(),
          kind: "window",
          applicationId: null,
          processId: window.pid,
          title: window.title || window.app_name,
          bounds: window.bounds,
          focused: false,
        },
      });
    }
    for (const id of this.targetsById.keys())
      if (!live.has(id)) {
        this.targetsById.delete(id);
        this.observations.delete(id);
        for (const [frameId, frame] of this.frames)
          if (frame.targetId === id) this.frames.delete(frameId);
      }
    return [...this.targetsById.values()].map((target) => target.native);
  }

  private async target(targetId: string): Promise<Target> {
    const target = this.targetsById.get(targetId);
    if (!target)
      throw new ComputerBackendError(
        "target_not_found",
        "CUA window is no longer present",
        false,
        false,
      );
    return target;
  }

  private args(target: Target): Record<string, unknown> {
    return { pid: target.pid, window_id: target.windowId, session: this.session };
  }

  private async observeTarget(targetId: string): Promise<ComputerBackendObservation> {
    const target = await this.target(targetId);
    if (
      this.initialCapabilities.windowCapture &&
      ![...this.frames.values()].some((frame) => frame.targetId === targetId)
    )
      await this.captureTarget(targetId);
    const { data } = await callDesktop(this.runtime, "get_window_state", {
      ...this.args(target),
      include_screenshot: false,
      include_accessibility_tree: true,
      max_elements: 2000,
      max_depth: 25,
    });
    const state = WindowState.parse(data);
    if (state.pid !== target.pid || state.window_id !== target.windowId || !state.snapshot_id)
      throw new ComputerBackendError(
        "target_stale",
        `CUA observation did not bind the requested window (snapshot=${state.snapshot_id ?? "missing"}, reason=${data.degraded_reason ?? "none"})`,
        false,
        false,
      );
    const roots = projectElements(state.elements, this.identity.platform);
    const observation: ComputerBackendObservation = {
      observationId: `${this.session}:${state.snapshot_id}`,
      target: { ...target.native, bounds: state.window_bounds ?? target.native.bounds },
      frameId:
        [...this.frames.entries()]
          .reverse()
          .find(([, frame]) => frame.targetId === targetId)?.[0] ?? null,
      roots,
      nodeCount: roots.length,
      focusedRef: roots.find((node) => node.states.includes("focused"))?.ref ?? null,
      changedRegions: [],
    };
    this.observations.delete(targetId);
    this.observations.set(targetId, observation);
    while (this.observations.size > 32)
      this.observations.delete(this.observations.keys().next().value!);
    return observation;
  }

  private async captureTarget(
    targetId: string,
    options?: ComputerBackendCaptureOptions,
  ): Promise<ComputerBackendFrame> {
    const target = await this.target(targetId);
    const bounds = target.native.bounds!;
    // PNG is intentionally retained; do not claim a JPEG encoder or scale the
    // pixels after CUA has minted its coordinate-bound capture authority.
    const longEdge = options
      ? Math.max(
          1,
          Math.floor(
            Math.max(bounds.width, bounds.height) *
              Math.min(options.maxWidth / bounds.width, options.maxHeight / bounds.height),
          ),
        )
      : 0;
    const { data, result } = await callDesktop(this.runtime, "get_window_state", {
      ...this.args(target),
      include_accessibility_tree: false,
      include_screenshot: true,
      max_image_dimension: longEdge,
    });
    const state = WindowState.parse(data);
    const image = result.images[0];
    if (
      state.pid !== target.pid ||
      state.window_id !== target.windowId ||
      !state.capture_id ||
      (this.identity.platform === "macos"
        ? state.screenshot_frame_valid !== true
        : state.screenshot_frame_valid === false || data.screenshot_error !== undefined) ||
      !state.screenshot_width ||
      !state.screenshot_height ||
      result.images.length !== 1 ||
      image?.mimeType !== "image/png" ||
      image.dataBase64.length > 90_000_000
    )
      throw new ComputerBackendError(
        "driver_failed",
        "CUA returned no exact window capture",
        false,
        false,
      );
    if (
      options &&
      (state.screenshot_width > options.maxWidth || state.screenshot_height > options.maxHeight)
    )
      throw new ComputerBackendError(
        "driver_failed",
        "CUA capture exceeded requested dimensions",
        false,
        false,
      );
    const bytes = Buffer.from(image.dataBase64, "base64");
    if (
      bytes.length < 24 ||
      bytes.length > 64 * 1024 * 1024 ||
      bytes.readUInt32BE(0) !== 0x89504e47 ||
      bytes.readUInt32BE(16) !== state.screenshot_width ||
      bytes.readUInt32BE(20) !== state.screenshot_height
    )
      throw new ComputerBackendError(
        "driver_failed",
        "CUA capture dimensions did not match its image",
        false,
        false,
      );
    const frameId = `${this.session}:${state.capture_id}`;
    this.frames.set(frameId, {
      targetId,
      width: state.screenshot_width,
      height: state.screenshot_height,
    });
    while (this.frames.size > 32) this.frames.delete(this.frames.keys().next().value!);
    return {
      frameId,
      targetId,
      targetGeneration: target.native.targetGeneration,
      width: state.screenshot_width,
      height: state.screenshot_height,
      mimeType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      data: bytes,
    };
  }

  private async operations(command: ComputerBackendActionCommand): Promise<Operation[]> {
    const target = await this.target(command.targetId);
    if (target.native.targetGeneration !== command.expectedTargetGeneration)
      throw new ComputerBackendError("target_stale", "CUA target generation changed", false, false);
    const args = this.args(target),
      action = command.action;
    if (this.identity.platform === "windows" && action.type !== "semantic")
      throw unsupported("The Windows CUA experiment admits advertised semantic actions only");
    if (action.type === "pointer") {
      const frame = this.frames.get(action.frameId);
      if (
        !frame ||
        frame.targetId !== command.targetId ||
        command.expectedFrameId !== action.frameId
      )
        throw new ComputerBackendError(
          "frame_stale",
          "CUA action requires a known coordinate mapping for this window",
          false,
          false,
        );
      if (
        !Number.isFinite(action.x) ||
        !Number.isFinite(action.y) ||
        action.x < 0 ||
        action.y < 0 ||
        action.x >= frame.width ||
        action.y >= frame.height
      )
        throw new ComputerBackendError(
          "invalid_action",
          "CUA coordinates are outside the captured image",
          false,
          false,
        );
      // Frames describe coordinates, not a requirement that the UI stay frozen.
      // CUA's window route uses its latest screenshot scale. Translate a click
      // from any retained viewer profile into that scale, without taking another
      // screenshot or rejecting ordinary repeated scroll/drag gestures.
      const latest = [...this.frames.values()]
        .reverse()
        .find((entry) => entry.targetId === command.targetId)!;
      const x = (action.x * latest.width) / frame.width,
        y = (action.y * latest.height) / frame.height;
      const delivery = { ...args, delivery_mode: "background" };
      if (action.action === "click" || action.action === "double_click")
        return [
          {
            name: "click",
            args: {
              ...delivery,
              x,
              y,
              button: action.button ?? "left",
              count: action.action === "double_click" ? 2 : 1,
            },
          },
        ];
      if (action.action === "drag") {
        if (
          action.endX === undefined ||
          action.endY === undefined ||
          !Number.isFinite(action.endX) ||
          !Number.isFinite(action.endY) ||
          action.endX < 0 ||
          action.endY < 0 ||
          action.endX >= frame.width ||
          action.endY >= frame.height
        )
          throw new ComputerBackendError(
            "invalid_action",
            "CUA drag endpoint is outside the captured window",
            false,
            false,
          );
        return [
          {
            name: "drag",
            args: {
              ...delivery,
              from_x: x,
              from_y: y,
              to_x: (action.endX * latest.width) / frame.width,
              to_y: (action.endY * latest.height) / frame.height,
              button: action.button ?? "left",
            },
          },
        ];
      }
      if (action.action === "scroll") {
        // Browser wheel deltas are CSS pixels; this CUA API takes wheel notches.
        // Keep both axes; one conventional 100-pixel wheel step maps to a notch.
        const steps: Operation[] = [];
        for (const [delta, negative, positive] of [
          [action.deltaX ?? 0, "left", "right"],
          [action.deltaY ?? 0, "up", "down"],
        ] as const) {
          if (!Number.isFinite(delta))
            throw new ComputerBackendError(
              "invalid_action",
              "CUA scroll delta must be finite",
              false,
              false,
            );
          if (delta !== 0)
            steps.push({
              name: "scroll",
              args: {
                ...delivery,
                x,
                y,
                direction: delta < 0 ? negative : positive,
                by: "line",
                amount: Math.min(50, Math.max(1, Math.round(Math.abs(delta) / 100))),
              },
            });
        }
        if (!steps.length)
          throw new ComputerBackendError(
            "invalid_action",
            "CUA scroll requires a nonzero delta",
            false,
            false,
          );
        return steps;
      }
      throw unsupported("CUA's move_cursor controls its overlay, not native hover input");
    }
    if (action.type !== "semantic" && action.type !== "keyboard")
      throw unsupported("This CUA operation is not admitted by the desktop adapter");
    const observed = this.observations.get(command.targetId);
    if (
      !observed ||
      !command.expectedObservationId ||
      observed.observationId !== command.expectedObservationId
    )
      throw new ComputerBackendError(
        "observation_stale",
        "CUA action requires the current semantic observation",
        false,
        false,
      );
    if (action.type === "semantic") {
      const node = locate(observed.roots, action.locator);
      if (!node.actions.includes(action.action))
        throw unsupported("CUA element does not advertise this semantic action");
      if (node.states.includes("disabled"))
        throw new ComputerBackendError("invalid_action", "CUA element is disabled", false, false);
      if (action.action === "set_value") {
        if (action.value === undefined)
          throw new ComputerBackendError(
            "invalid_action",
            "set_value requires a value",
            false,
            false,
          );
        return [
          {
            name: "set_value",
            args: {
              ...args,
              element_token: node.ref,
              value: String(action.value),
              ...(this.identity.platform === "windows" ? { delivery_mode: "background" } : {}),
            },
          },
        ];
      }
      return [
        {
          name: "click",
          args: {
            ...args,
            element_token: node.ref,
            // Both the pinned SDK and the current typed click contract use
            // right for a semantic context menu; invoke uses the default left.
            button: action.action === "show_menu" ? "right" : "left",
            delivery_mode: "background",
          },
        },
      ];
    }
    // Window-scoped delivery never falls back to the foreground desktop. An
    // observed focused element is carried when CUA supplies that information.
    const focused =
      observed.focusedRef && !observed.focusedRef.startsWith("read-only:")
        ? { element_token: observed.focusedRef }
        : {};
    if (action.action === "type")
      return [
        {
          name: "type_text",
          args: { ...args, ...focused, text: action.value, delivery_mode: "background" },
        },
      ];
    const keys = action.value.split("+").map((key) => key.toLowerCase());
    const key = keys.pop()!;
    const modifiers = keys.map(
      (modifier) => ({ meta: "cmd", control: "ctrl", alt: "option" })[modifier] ?? modifier,
    );
    if (modifiers.some((modifier) => !["cmd", "ctrl", "option", "shift", "fn"].includes(modifier)))
      throw unsupported("CUA keyboard modifier is unsupported");
    return [
      {
        name: "press_key",
        args: {
          ...args,
          ...focused,
          key: key === "enter" ? "return" : key,
          modifiers,
          delivery_mode: "background",
        },
      },
    ];
  }
}

async function readPermissions(runtime: CuaDesktopRuntime, platform: "macos" | "windows") {
  const { data } = await callDesktop(
    runtime,
    "check_permissions",
    platform === "windows" ? {} : { prompt: false, probe_direct_capture: false },
  );
  return {
    accessibility:
      platform === "windows"
        ? data.uia === true && data.post_message === true
        : data.accessibility === true,
    // Windows has no Screen Recording grant. Interactive-seat admission is
    // checked before opening the SDK; each target capture still must prove its
    // native capture ID, exact window identity, PNG dimensions and bytes.
    screen_recording: platform === "windows" || data.screen_recording === true,
  };
}

function unsupported(message: string): ComputerBackendError {
  return new ComputerBackendError("unsupported", message, false, false);
}
