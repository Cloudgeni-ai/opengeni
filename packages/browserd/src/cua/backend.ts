import { CuaNativeTools } from "./native-tools";
import type { ComputerNativeCallRequest } from "@opengeni/contracts";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  ComputerLocator,
  ComputerSessionCapabilities,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
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
import {
  callDesktop,
  CuaFailure,
  walkIncompleteness,
  Windows,
  WindowState,
  type CuaDesktopRuntime,
} from "./wire";
import { locate, projectElements, unindexedTextByElement } from "./projection";

type Target = { native: ComputerBackendTarget; pid: number; windowId: number };
type Frame = {
  targetId: string;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
};
type Operation = {
  name: "click" | "drag" | "scroll" | "set_value" | "type_text" | "press_key" | "hotkey";
  args: Record<string, unknown>;
};

/** Every CUA action waits for the agent cursor to reach its target, and the
 * default timing makes each move take at least 600 ms. Keep the cursor visible
 * but quick, without a pause after each click. */
const CURSOR_MOTION = { timing: "fixed", glide_duration_ms: 150, dwell_after_click_ms: 0 };

/** CUA owns OS delivery. Opengeni owns authority, receipts and public media.
 * Every call is serialized, including preview captures and shutdown. */
export class CuaComputerBackend implements ComputerBackend {
  readonly identity: { platform: "macos" | "windows" | "linux"; adapterId: string };
  readonly initialCapabilities: ComputerSessionCapabilities;
  private readonly session = `opengeni-${randomUUID()}`;
  private readonly nativeSession = `opengeni-${randomUUID()}`;
  private nativeSessionStarted = false;
  private readonly cursorMotionSet = new Set<string>();
  private readonly targetsById = new Map<string, Target>();
  private readonly observations = new Map<string, ComputerBackendObservation>();
  /** Recent semantic observations per window, newest last. A ref names the
   * observation the model read it from; an action that omits its fence is
   * checked against a fresh observation, which mints new refs, so the ref is
   * resolved in the observation it came from and CUA validates its token. */
  private readonly recentObservations = new Map<string, ComputerBackendObservation[]>();
  private readonly frames = new Map<string, Frame>();
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private pending = 0;
  private nativeTools: CuaNativeTools | null = null;
  private nativeObservations = false;
  /** Windows CUA could not read because they are sheets of another window. */
  private readonly unreadableSheets = new Set<string>();

  private constructor(
    private readonly runtime: CuaDesktopRuntime,
    permissions: { accessibility: boolean; screen_recording: boolean },
    platform: "macos" | "windows" | "linux",
    private readonly parentPid: (pid: number) => number | null,
  ) {
    this.identity = { platform, adapterId: `opengeni.cua.${platform}.v1` };
    this.initialCapabilities = {
      semanticObservation: permissions.accessibility,
      appDiscovery: true,
      // CUA launches apps in the background without taking focus.
      appLaunch: true,
      windowCapture: permissions.screen_recording,
      screenCapture: false,
      semanticActions: permissions.accessibility,
      pointerInput: permissions.accessibility && permissions.screen_recording,
      keyboardInput: permissions.accessibility,
      clipboard: false,
      backgroundActions: permissions.accessibility,
      backgroundInput: platform === "macos" && permissions.accessibility,
      parallelApps: false,
    };
  }

  static async open(
    runtime: CuaDesktopRuntime,
    platform: "macos" | "windows" | "linux" = "macos",
    options: {
      /** A process's parent, to tie a Linux launcher's app to its window.
       * CUA runs in this process, so it sees the same processes. */
      parentPid?: (pid: number) => number | null;
    } = {},
  ): Promise<CuaComputerBackend> {
    try {
      const permissions = await readPermissions(runtime, platform);
      const backend = new CuaComputerBackend(
        runtime,
        permissions,
        platform,
        options.parentPid ?? procParentPid,
      );
      await backend.startSession(backend.session);
      return backend;
    } catch (error) {
      await runtime.shutdown();
      throw error;
    }
  }

  validateNative(request: ComputerNativeCallRequest): Promise<void> {
    return this.run(async () => {
      this.nativeTools ??= new CuaNativeTools(
        this.runtime,
        this.nativeSession,
        this.identity.platform,
      );
      await this.nativeTools.validate(request);
    });
  }
  callNative(request: ComputerNativeCallRequest) {
    return this.run(async () => {
      this.nativeTools ??= new CuaNativeTools(
        this.runtime,
        this.nativeSession,
        this.identity.platform,
      );
      await this.nativeTools.validate(request);
      // CUA reclaims idle sessions independently of ComputerSession. Reassert
      // the same owned label before dispatch; active snapshots stay intact and
      // revived sessions reject their expired tokens through CUA's own checks.
      await this.startSession(this.nativeSession);
      this.nativeSessionStarted = true;
      this.nativeObservations = true;
      this.observations.clear();
      return await this.nativeTools.call(request);
    });
  }

  capabilities(): Promise<ComputerSessionCapabilities> {
    return this.run(async () => {
      const permissions = await readPermissions(this.runtime, this.identity.platform);
      const macos = this.identity.platform === "macos";
      return {
        ...this.initialCapabilities,
        semanticObservation: permissions.accessibility,
        semanticActions: permissions.accessibility,
        keyboardInput: permissions.accessibility,
        backgroundActions: permissions.accessibility,
        backgroundInput: macos && permissions.accessibility,
        windowCapture: permissions.screen_recording,
        pointerInput: permissions.accessibility && permissions.screen_recording,
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
      if (command.action.type === "launch") {
        await this.target(command.targetId);
        return;
      }
      await this.operations(command);
    });
  }

  dispatch(command: ComputerBackendActionCommand): Promise<ComputerBackendObservation | null> {
    return this.run(async () => {
      if (command.action.type === "launch") {
        await this.target(command.targetId);
        const launched = await this.launch(command.action.applicationId);
        // The app is running: the launch succeeded whatever happens next. Its
        // windows become targets when discovery works. The receipt observes
        // the launched app's window, so the caller can act on it directly,
        // or the action's own target when no window of the app is found.
        try {
          for (const windowTarget of await this.launchedWindows(launched)) {
            const reading = await this.observeTarget(windowTarget).catch(() => null);
            if (reading) return reading;
          }
          return await this.observeTarget(command.targetId);
        } catch {
          return null;
        }
      }
      // Passive previews never change the native action frame. Human pointer
      // input obtains its own fresh frame under the same serialized queue.
      // CUA then refuses stale native pixel/zoom input until the agent re-reads.
      if (command.action.type === "pointer") {
        await this.operations(command);
        const source = this.frames.get(command.action.frameId)!;
        const fresh = await this.captureTarget(command.targetId, undefined, true);
        const current = this.frames.get(fresh.frameId)!;
        if (
          Math.abs(source.windowWidth - current.windowWidth) >= 0.5 ||
          Math.abs(source.windowHeight - current.windowHeight) >= 0.5
        )
          throw new ComputerBackendError(
            "frame_stale",
            "Window resized; read a fresh frame before input",
            false,
            false,
          );
      }
      const operations = await this.operations(command);
      const observed = this.observations.get(command.targetId);
      this.observations.delete(command.targetId);
      const acted = await this.target(command.targetId);
      const known = new Set(this.targetsById.keys());
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
          // CUA's own wording names its raw tools; say what the caller does.
          if (
            error instanceof ComputerBackendError &&
            error.code === "observation_stale" &&
            !error.dispatched
          )
            throw new ComputerBackendError(
              "observation_stale",
              "CUA refused the element reference because the window was read again since; observe it again and act on a ref from that observation",
              false,
              false,
            );
          if (error instanceof CuaFailure && !error.dispatched)
            throw this.keyboardRefusal(command, error, observed) ?? error;
          throw error;
        }
      }
      // Post-action observation failure cannot turn a delivered action into a
      // pre-dispatch rejection. The controller retains its completed receipt.
      try {
        const openedReading = async () => {
          const opened = await this.openedWindow(acted, known).catch(() => null);
          return opened ? await this.observeTarget(opened).catch(() => null) : null;
        };
        const opened = await openedReading();
        if (opened) return opened;
        try {
          return await this.observeTarget(command.targetId);
        } catch (error) {
          // The acted window closed or can no longer be read, as an Open
          // panel does when its app makes a new document: the window the
          // action opened can appear a moment after the action returns.
          const deadline = Date.now() + OPENED_WINDOW_WAIT_MS;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, OPENED_WINDOW_POLL_MS));
            const reading = await openedReading();
            if (reading) return reading;
          }
          throw error;
        }
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
        if (this.nativeSessionStarted)
          await callDesktop(this.runtime, "end_session", { session: this.nativeSession });
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
    const result = this.tail
      .then(async () => {
        const data = await this.startSession(this.session);
        if (data.revived === true) {
          this.observations.clear();
          this.frames.clear();
        }
        return await operation();
      })
      .finally(() => {
        this.pending--;
      });
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Start or reassert a CUA session, setting its cursor motion once per
   * session and again whenever CUA revives it with defaults. */
  private async startSession(session: string): Promise<Record<string, unknown>> {
    const { data } = await callDesktop(this.runtime, "start_session", { session });
    if (data.revived === true || !this.cursorMotionSet.has(session)) {
      this.cursorMotionSet.add(session);
      // Cosmetic: a host without a cursor overlay must still act.
      await callDesktop(this.runtime, "set_agent_cursor_motion", {
        session,
        ...CURSOR_MOTION,
      }).catch(() => undefined);
    }
    return data;
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
        this.unreadableSheets.delete(id);
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

  /** The window an action opened, such as a new document or a dialog: the
   * one window of the acted window's app not listed before the action. CUA's
   * own report of new windows misses some, such as a key equivalent it ran as
   * a menu command, so the windows are listed after every action. A window
   * lying within another window of its app is a sheet or part of a panel,
   * read through that window, so it never counts. Two candidates are never
   * guessed between. */
  private async openedWindow(acted: Target, known: ReadonlySet<string>): Promise<string | null> {
    const opened = (await this.discover()).filter(
      (target) =>
        !known.has(target.id) &&
        target.processId === acted.pid &&
        this.sheetHosts(this.targetsById.get(target.id)!).length === 0,
    );
    return opened.length === 1 ? opened[0]!.id : null;
  }

  /** Other windows of the same macOS app that a window lies within: where a
   * sheet (a Save panel, a Go to Folder prompt) it may be is attached. */
  private sheetHosts(target: Target): Target[] {
    const inner = target.native.bounds;
    if (this.identity.platform !== "macos" || !inner) return [];
    return [...this.targetsById.values()].filter((other) => {
      const outer = other.native.bounds;
      return (
        other !== target &&
        other.pid === target.pid &&
        !!outer &&
        inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height &&
        inner.width * inner.height < outer.width * outer.height
      );
    });
  }

  /** A sheet has a window id of its own, but CUA reads its controls only
   * through the window it is attached to, as an AXSheet with the sheet's
   * bounds. Geometry cannot tell which window that is (or whether this is a
   * sheet at all), so read the windows it lies within and name a parent only
   * when exactly one of them shows it now. */
  private async sheetError(target: Target): Promise<ComputerBackendError> {
    const inner = target.native.bounds!;
    const hosts = this.sheetHosts(target).slice(0, 4);
    const near = (a: number, b: number) => Math.abs(a - b) <= 2;
    const shown: Target[] = [];
    for (const host of hosts) {
      const reading = await this.observeTarget(host.native.id).catch(() => null);
      if (
        reading?.roots.some(
          (node) =>
            node.role === "AXSheet" &&
            !!node.bounds &&
            near(node.bounds.x, inner.x) &&
            near(node.bounds.y, inner.y) &&
            near(node.bounds.width, inner.width) &&
            near(node.bounds.height, inner.height),
        )
      )
        shown.push(host);
    }
    return new ComputerBackendError(
      "target_stale",
      shown.length === 1
        ? `${target.native.id} is a sheet attached to the window ${shown[0]!.native.id}, and its controls are read and used through that window: observe ${shown[0]!.native.id} and act on its refs`
        : `${target.native.id} cannot be read on its own. If it is a sheet or panel of another window of this app, its controls are in that window's observation: observe the window it belongs to (one of ${hosts
            .map((host) => host.native.id)
            .join(", ")}) and act on its refs`,
      false,
      false,
    );
  }

  /** CUA's refusals of background input name CUA's own options (a foreground
   * delivery mode the caller does not have). Say what the caller can do. */
  private keyboardRefusal(
    command: ComputerBackendActionCommand,
    error: CuaFailure,
    observed: ComputerBackendObservation | undefined,
  ): ComputerBackendError | null {
    const target = this.targetsById.get(command.targetId);
    if (
      !target ||
      this.identity.platform !== "macos" ||
      error.cuaCode !== "window_not_key" ||
      command.action.type !== "keyboard"
    )
      return null;
    if (observed?.roots.some((node) => node.role === "AXSheet"))
      return new ComputerBackendError(
        error.code,
        "Keys cannot reach the sheet open in this window while its app is in the background, so none were sent. Use the sheet's controls from this window's observation instead: set_value on a text field's ref, invoke on a button's ref",
        false,
        false,
      );
    const others = [...this.targetsById.values()]
      .filter((other) => other !== target && other.pid === target.pid)
      .map((other) => other.native.id);
    return new ComputerBackendError(
      error.code,
      `Keys reach only the focused window of a background app, and another of its windows has focus${
        others.length ? ` (one of ${others.slice(0, 5).join(", ")})` : ""
      }, so none were sent: act on that window, or close it first`,
      false,
      false,
    );
  }

  private async observeTarget(targetId: string): Promise<ComputerBackendObservation> {
    const target = await this.target(targetId);
    if (
      this.initialCapabilities.windowCapture &&
      ![...this.frames.values()].some((frame) => frame.targetId === targetId)
    )
      await this.captureTarget(targetId).catch((error: unknown) => {
        // CUA captures nothing for a sheet's own window; its tree read below
        // says whether this is one.
        if (!this.sheetHosts(target).length) throw error;
      });
    // Viewer polling must never retire a native CUA element-token snapshot.
    // Once native tools own observations, the legacy viewer receives geometry
    // and pixels only. The native result carries its exact tree unchanged.
    if (this.nativeObservations) {
      const observation: ComputerBackendObservation = {
        observationId: this.session + ":viewer",
        target: target.native,
        frameId:
          [...this.frames.entries()]
            .reverse()
            .find(([, frame]) => frame.targetId === targetId)?.[0] ?? null,
        roots: [],
        nodeCount: 0,
        focusedRef: null,
        changedRegions: [],
      };
      this.observations.set(targetId, observation);
      return observation;
    }
    const { data } = await callDesktop(this.runtime, "get_window_state", {
      ...this.args(target),
      include_screenshot: false,
      include_accessibility_tree: true,
      // Both: the elements carry tokens and frames; the Markdown tree also has
      // the unindexed text inside rows and cells, which the elements omit. CUA
      // returns only Markdown when tree_format is omitted, on every platform.
      tree_format: "both",
      // UIA answers ordinary windows (Notepad, the Run dialog) in about two
      // seconds; CUA's one-second default returned zero nodes for them.
      ...(this.identity.platform === "windows" ? { timeout_ms: 5_000 } : {}),
      max_elements: 2000,
      max_depth: 25,
    });
    const state = WindowState.parse(data);
    if (state.pid !== target.pid || state.window_id !== target.windowId || !state.snapshot_id) {
      if (
        this.sheetHosts(target).length &&
        String(data.degraded_reason ?? "").startsWith("ax_window_unresolved")
      ) {
        this.unreadableSheets.add(targetId);
        throw await this.sheetError(target);
      }
      throw new ComputerBackendError(
        "target_stale",
        `CUA observation did not bind the requested window (snapshot=${state.snapshot_id ?? "missing"}, reason=${data.degraded_reason ?? "none"})`,
        false,
        false,
      );
    }
    const roots = projectElements(
      state.elements,
      this.identity.platform,
      unindexedTextByElement(state.tree_markdown, this.identity.platform),
    );
    const incomplete = walkIncompleteness(state);
    const observation: ComputerBackendObservation = {
      observationId: `${this.session}:${state.snapshot_id}`,
      target: { ...target.native, bounds: state.window_bounds ?? target.native.bounds },
      frameId:
        [...this.frames.entries()]
          .reverse()
          .find(([, frame]) => frame.targetId === targetId)?.[0] ?? null,
      roots,
      nodeCount: roots.length,
      ...(incomplete ? { incomplete } : {}),
      focusedRef: roots.find((node) => node.states.includes("focused"))?.ref ?? null,
      changedRegions: [],
    };
    this.observations.delete(targetId);
    this.observations.set(targetId, observation);
    while (this.observations.size > 32)
      this.observations.delete(this.observations.keys().next().value!);
    const recent = (this.recentObservations.get(targetId) ?? []).slice(-(RECENT_OBSERVATIONS - 1));
    this.recentObservations.delete(targetId);
    this.recentObservations.set(targetId, [...recent, observation]);
    while (this.recentObservations.size > 32)
      this.recentObservations.delete(this.recentObservations.keys().next().value!);
    return observation;
  }

  private async captureTarget(
    targetId: string,
    options?: ComputerBackendCaptureOptions,
    actionCapture = false,
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
      ...(this.identity.platform !== "windows" && !actionCapture ? { display_only: true } : {}),
    });
    const state = WindowState.parse(data);
    const image = result.images[0];
    if (
      state.pid !== target.pid ||
      state.window_id !== target.windowId ||
      ((actionCapture || this.identity.platform === "windows") && !state.capture_id) ||
      (this.identity.platform !== "windows"
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
    const frameId = `${this.session}:${state.capture_id ?? randomUUID()}`;
    this.frames.set(frameId, {
      targetId,
      width: state.screenshot_width,
      height: state.screenshot_height,
      windowWidth: state.window_bounds?.width ?? bounds.width,
      windowHeight: state.window_bounds?.height ?? bounds.height,
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
    if (command.action.type === "pointer" && command.action.clickCount === 2) {
      throw unsupported("CUA click continuation is unavailable");
    }
    const target = await this.target(command.targetId);
    if (target.native.targetGeneration !== command.expectedTargetGeneration)
      throw new ComputerBackendError("target_stale", "CUA target generation changed", false, false);
    const args = this.args(target),
      action = command.action;
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
      const delivery = { ...args, delivery_mode: this.inputDelivery() };
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
    if (action.type === "focus")
      throw unsupported(
        "CUA acts on windows in the background without bringing them to the front, so it has no focus action: act on the window itself",
      );
    if (action.type !== "semantic" && action.type !== "keyboard")
      throw unsupported("This CUA operation is not admitted by the desktop adapter");
    const observed = this.observations.get(command.targetId);
    // A ref is its own fence: it resolves only to the same element, unchanged,
    // in the latest reading of the window (see locateObserved). So a ref
    // action may name any recent observation of this window.
    const refFenced =
      action.type === "semantic" &&
      action.locator.kind === "ref" &&
      (this.recentObservations.get(command.targetId) ?? []).some(
        (recent) => recent.observationId === command.expectedObservationId,
      );
    if (
      !observed ||
      !command.expectedObservationId ||
      (observed.observationId !== command.expectedObservationId && !refFenced)
    ) {
      if (this.unreadableSheets.has(command.targetId) && this.sheetHosts(target).length)
        throw await this.sheetError(target);
      throw new ComputerBackendError(
        "observation_stale",
        "CUA action requires the current semantic observation",
        false,
        false,
      );
    }
    if (action.type === "semantic") {
      const node = this.locateObserved(command.targetId, observed, action.locator);
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
          args: {
            ...args,
            ...focused,
            text: action.value,
            delivery_mode: this.inputDelivery(),
          },
        },
      ];
    const keys = action.value.split("+").map((key) => key.toLowerCase());
    const key = keys.pop()!;
    const { aliases: modifierAliases, allowed: allowedModifiers } =
      KEY_MODIFIERS[this.identity.platform];
    const modifiers = keys.map((modifier) => modifierAliases[modifier] ?? modifier);
    if (modifiers.some((modifier) => !allowedModifiers.includes(modifier)))
      throw unsupported("CUA keyboard modifier is unsupported");
    const named = key === "enter" ? "return" : key;
    // Keys posted to a background Mac app never reach its menus, so a
    // shortcut such as cmd+s would report success and do nothing. CUA's
    // hotkey runs the menu item behind the shortcut through accessibility
    // instead, and refuses when macOS keeps that item disabled.
    if (this.identity.platform === "macos" && modifiers.length > 0)
      return [
        {
          name: "hotkey",
          args: {
            ...args,
            ...focused,
            keys: [...modifiers, named],
            delivery_mode: this.inputDelivery(),
          },
        },
      ];
    return [
      {
        name: "press_key",
        args: {
          ...args,
          ...focused,
          key: named,
          modifiers,
          delivery_mode: this.inputDelivery(),
        },
      },
    ];
  }

  /** Start an app (or bring up its existing instance) in the background. */
  private async launch(applicationId: string): Promise<LaunchedApp> {
    const id = applicationId.trim();
    const { data } = await callDesktop(
      this.runtime,
      "launch_app",
      launchArguments(this.identity.platform, id),
      "caller-settles",
    );
    // Launching may have happened even without a reported process. On Linux
    // the app starts through a launcher process, which CUA reports instead.
    if (typeof data.pid !== "number" && typeof data.launcher_pid !== "number")
      throw new ComputerBackendError(
        "outcome_unknown",
        `CUA did not report a running process for ${id}; observe the desktop before launching it again`,
        false,
        true,
      );
    const reported = Windows.safeParse({ windows: data.windows });
    return {
      pid: typeof data.pid === "number" ? data.pid : null,
      launcherPid: typeof data.launcher_pid === "number" ? data.launcher_pid : null,
      windows: reported.success ? reported.data.windows : [],
    };
  }

  /** The targets of the launched app's windows, best first: the windows the
   * launch reported, then the listed windows of its process. On Linux the app
   * may run as a child of the launcher process CUA reports, so a window of a
   * descendant counts too. A window that cannot be tied to the launch is never
   * guessed. A window lying within another of the app's windows (part of a
   * panel, such as an Open panel's accessory view) comes after the windows it
   * lies in. The first window can appear a moment after the process starts,
   * so discovery is retried briefly. */
  private async launchedWindows(launched: LaunchedApp): Promise<string[]> {
    const ownsWindow = (processId: number | null): boolean => {
      if (processId === null) return false;
      if (processId === launched.pid || processId === launched.launcherPid) return true;
      if (launched.launcherPid === null) return false;
      // Walk up the window's process ancestry, at most a few generations.
      let current: number | null = processId;
      for (let depth = 0; depth < 16 && current !== null && current > 1; depth++) {
        current = this.parentPid(current);
        if (current === launched.launcherPid) return true;
      }
      return false;
    };
    for (let attempt = 0; ; attempt++) {
      const targets = await this.discover();
      const reported = launched.windows
        .map((window) => `cua:window:${window.pid}:${window.window_id}`)
        .filter((id) => this.targetsById.has(id));
      const owned = targets
        .filter((target) => ownsWindow(target.processId))
        .map((target) => target.id);
      const candidates = [...new Set([...reported, ...owned])];
      if (candidates.length) {
        const inner = (id: string) => this.sheetHosts(this.targetsById.get(id)!).length > 0;
        return [...candidates.filter((id) => !inner(id)), ...candidates.filter((id) => inner(id))];
      }
      if (attempt >= LAUNCH_WINDOW_RETRIES) return [];
      await new Promise((resolve) => setTimeout(resolve, LAUNCH_WINDOW_RETRY_MS));
    }
  }

  /** The element a locator names. A ref from an earlier observation of the
   * same window names the same element in the latest one only while the
   * window is unchanged: CUA honours only the tokens of its latest reading,
   * so when every element still reads the same, in the same order, the ref
   * acts through its element's current token. Otherwise it is refused. A ref
   * seen nowhere says which observation is current. */
  private locateObserved(
    targetId: string,
    observed: ComputerBackendObservation,
    locator: ComputerLocator,
  ): InteractionSemanticNodeValue {
    try {
      return locate(observed.roots, locator);
    } catch (error) {
      if (
        locator.kind !== "ref" ||
        !(error instanceof ComputerBackendError) ||
        error.code !== "locator_not_found"
      )
        throw error;
      const recent = this.recentObservations.get(targetId) ?? [];
      const latest = recent.at(-1);
      for (const earlier of [...recent].reverse()) {
        const node = earlier.roots.find((candidate) => candidate.ref === locator.ref);
        if (!node) continue;
        if (earlier === latest) return node;
        if (!locator.ref.startsWith("read-only:") && sameContent(earlier, latest!))
          return latest!.roots[earlier.roots.indexOf(node)]!;
        // Names no label: one could be a typed secret.
        throw new ComputerBackendError(
          "observation_stale",
          `CUA ref ${locator.ref} is from an earlier observation, and the window has changed since; use a ref from the latest observation (${latest!.observationId.split(":").pop()})`,
          false,
          false,
        );
      }
      throw new ComputerBackendError(
        "locator_not_found",
        `CUA ref ${locator.ref} is not in a recent observation of this window; observe it again and use a ref from the latest observation (${observed.observationId.split(":").pop()})`,
        false,
        false,
      );
    }
  }

  /** Pointer and keyboard delivery. Linux owns an isolated seat, so viewer
   * input may focus within it. macOS posts events to the target process
   * without raising it. Windows delivers through SendInput after briefly
   * fronting the window and restoring the previous foreground window:
   * background PostMessage input is silently dropped by Chromium, Electron,
   * WinUI and other common surfaces, which would leave ordinary clicks and
   * typing unreliable. Semantic UIA actions stay in the background everywhere. */
  private inputDelivery(): "foreground" | "background" {
    return this.identity.platform === "macos" ? "background" : "foreground";
  }
}

const RECENT_OBSERVATIONS = 4;

/** Whether two readings show the same window (title, process, generation,
 * place) with the same elements in the same order: everything but the
 * snapshot-bound tokens. Then an element's position is its identity. */
function sameContent(
  earlier: ComputerBackendObservation,
  latest: ComputerBackendObservation,
): boolean {
  const content = (node: InteractionSemanticNodeValue) =>
    JSON.stringify({ ...node, ref: node.ref.startsWith("read-only:") ? node.ref : null });
  return (
    JSON.stringify(earlier.target) === JSON.stringify(latest.target) &&
    earlier.roots.length === latest.roots.length &&
    (earlier.incomplete === undefined) === (latest.incomplete === undefined) &&
    earlier.roots.every((node, index) => content(node) === content(latest.roots[index]!))
  );
}
/** A Linux process's parent from /proc, or null when it cannot be read. */
function procParentPid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name is in parentheses and may contain spaces or ")".
    const parent = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(parent) ? parent : null;
  } catch {
    return null;
  }
}

/** How long a launch waits for the app's first window: up to a second. */
const LAUNCH_WINDOW_RETRIES = 4;
const LAUNCH_WINDOW_RETRY_MS = 250;

/** How long an action whose window can no longer be read waits for the
 * window it opened. */
const OPENED_WINDOW_WAIT_MS = 1_000;
const OPENED_WINDOW_POLL_MS = 150;

/** A launched app's processes and the windows launch_app reported, which
 * have list_windows' shape. */
type LaunchedApp = {
  pid: number | null;
  /** The process a Linux launch started the app through. */
  launcherPid: number | null;
  windows: { pid: number; window_id: number }[];
};

/** A reverse-DNS bundle identifier such as com.apple.TextEdit; anything else is an app name. */
const BUNDLE_ID = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u;

/** How CUA's launch_app names an app on each platform. */
function launchArguments(
  platform: "macos" | "windows" | "linux",
  id: string,
): Record<string, string> {
  switch (platform) {
    case "macos": {
      // "TextEdit.app" names the app; a bundle identifier has more than one dot.
      const name = id.replace(/^([^./]+)\.app$/iu, "$1");
      return BUNDLE_ID.test(name) ? { bundle_id: name } : { name };
    }
    case "windows":
      // A full path runs that executable; a packaged app's AUMID
      // ({PackageFamilyName}!{AppId}) activates that app; a name is looked up
      // among the installed apps, then on PATH.
      if (/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(id)) return { path: id };
      if (id.includes("!")) return { aumid: id };
      return { name: id };
    case "linux":
      // A name runs as a command, or matches an installed application.
      return { name: id };
  }
}

const KEY_MODIFIERS: Record<
  "macos" | "windows" | "linux",
  { aliases: Record<string, string>; allowed: string[] }
> = {
  macos: {
    aliases: {
      meta: "cmd",
      command: "cmd",
      super: "cmd",
      win: "cmd",
      control: "ctrl",
      alt: "option",
      opt: "option",
    },
    allowed: ["cmd", "ctrl", "option", "shift", "fn"],
  },
  windows: {
    aliases: { meta: "win", super: "win", cmd: "win", control: "ctrl", option: "alt" },
    allowed: ["win", "ctrl", "alt", "shift"],
  },
  linux: {
    aliases: {
      meta: "super",
      cmd: "super",
      command: "super",
      win: "super",
      control: "ctrl",
      option: "alt",
    },
    allowed: ["super", "ctrl", "alt", "shift"],
  },
};

async function readPermissions(
  runtime: CuaDesktopRuntime,
  platform: "macos" | "windows" | "linux",
) {
  const { data } = await callDesktop(
    runtime,
    "check_permissions",
    platform !== "macos" ? {} : { prompt: false, probe_direct_capture: false },
  );
  return {
    accessibility:
      platform === "windows"
        ? data.uia === true && data.post_message === true
        : platform === "linux"
          ? data.atspi === true
          : data.accessibility === true,
    // Windows has no Screen Recording grant. Interactive-seat admission is
    // checked before opening the SDK; each target capture still must prove its
    // native capture ID, exact window identity, PNG dimensions and bytes.
    screen_recording:
      platform === "linux"
        ? data.x11 === true
        : platform === "windows" || data.screen_recording === true,
  };
}

function unsupported(message: string): ComputerBackendError {
  return new ComputerBackendError("unsupported", message, false, false);
}
