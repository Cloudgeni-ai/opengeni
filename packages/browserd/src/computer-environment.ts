import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { InteractionControllerError } from "@opengeni/interaction";

const START_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 3_000;
const MAX_START_LINE_BYTES = 4_096;

export type ComputerEnvironmentContext = {
  computerSessionId: string;
  controllerGeneration: string;
  sessionDirectory: string;
  baseEnvironment: NodeJS.ProcessEnv;
};

export type ComputerEnvironmentLease = {
  seatId: string;
  displayId: string;
  environment: NodeJS.ProcessEnv;
  close(): Promise<void>;
};

export interface ComputerEnvironmentAllocator {
  allocate(context: ComputerEnvironmentContext): Promise<ComputerEnvironmentLease>;
}

export type LinuxVirtualComputerEnvironmentOptions = {
  width?: number;
  height?: number;
  depth?: number;
  dpi?: number;
  windowManagerBinary?: string | null;
};

/** One isolated X11, D-Bus and AT-SPI envelope per managed Linux ComputerSession. */
export class LinuxVirtualComputerEnvironmentAllocator implements ComputerEnvironmentAllocator {
  private readonly width: number;
  private readonly height: number;
  private readonly depth: number;
  private readonly dpi: number;
  private readonly windowManagerBinary: string | null;

  constructor(options: LinuxVirtualComputerEnvironmentOptions = {}) {
    this.width = boundedInteger(options.width ?? 1_440, 320, 8_192, "virtual display width");
    this.height = boundedInteger(options.height ?? 900, 240, 8_192, "virtual display height");
    this.depth = boundedInteger(options.depth ?? 24, 16, 32, "virtual display depth");
    this.dpi = boundedInteger(options.dpi ?? 96, 48, 384, "virtual display DPI");
    this.windowManagerBinary = options.windowManagerBinary ?? "xfwm4";
  }

  async allocate(context: ComputerEnvironmentContext): Promise<ComputerEnvironmentLease> {
    if (process.platform !== "linux") {
      throw new InteractionControllerError(
        "unsupported",
        "isolated virtual ComputerSessions require Linux",
      );
    }
    const environmentDigest = createHash("sha256")
      .update(`${context.computerSessionId}\0${context.controllerGeneration}`)
      .digest("hex")
      .slice(0, 32);
    const runtimeDirectory = join("/tmp", `opengeni-cs-${environmentDigest}`);
    const cacheDirectory = join(context.sessionDirectory, "gui-cache");
    const configDirectory = join(context.sessionDirectory, "gui-config");
    const dataDirectory = join(context.sessionDirectory, "gui-data");
    // Chromium places its singleton socket below TMPDIR. Keep this root short
    // enough for Linux's bounded Unix-domain socket paths regardless of the
    // controller's durable state-directory depth.
    const temporaryDirectory = join("/tmp", `ogct-${environmentDigest}`);
    const directories = [
      runtimeDirectory,
      cacheDirectory,
      configDirectory,
      dataDirectory,
      temporaryDirectory,
    ];
    for (const directory of directories) {
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, {
        recursive: directory !== runtimeDirectory,
        mode: 0o700,
      });
      await chmod(directory, 0o700);
    }

    const processes: ChildProcess[] = [];
    try {
      const baseEnvironment = nativeComputerEnvironment(context.baseEnvironment);
      const xvfb = spawn(
        "Xvfb",
        [
          "-displayfd",
          "3",
          "-screen",
          "0",
          `${this.width}x${this.height}x${this.depth}`,
          "-dpi",
          String(this.dpi),
          "-nolisten",
          "tcp",
          "-ac",
        ],
        {
          detached: true,
          env: baseEnvironment,
          stdio: ["ignore", "ignore", "pipe", "pipe"],
        },
      );
      processes.push(xvfb);
      drain(xvfb.stderr);
      const displayPipe = xvfb.stdio[3];
      if (!displayPipe || !("readable" in displayPipe)) {
        throw new Error("Xvfb display pipe is unavailable");
      }
      const displayNumber = await readStartupLine(displayPipe, xvfb, "Xvfb display");
      if (!/^(0|[1-9][0-9]{0,4})$/u.test(displayNumber)) {
        throw new Error("Xvfb returned an invalid display number");
      }
      const displayId = `:${displayNumber}`;
      const sessionEnvironment: NodeJS.ProcessEnv = {
        ...baseEnvironment,
        DISPLAY: displayId,
        XDG_RUNTIME_DIR: runtimeDirectory,
        XDG_CACHE_HOME: cacheDirectory,
        XDG_CONFIG_HOME: configDirectory,
        XDG_DATA_HOME: dataDirectory,
        TMPDIR: temporaryDirectory,
        NO_AT_BRIDGE: "0",
        GTK_A11Y: "1",
        GTK_MODULES: "gail:atk-bridge",
        QT_ACCESSIBILITY: "1",
        GDK_BACKEND: "x11",
        QT_QPA_PLATFORM: "xcb",
        XDG_SESSION_TYPE: "x11",
        XDG_SESSION_CLASS: "user",
        XDG_CURRENT_DESKTOP: "XFCE",
        XDG_DATA_DIRS: baseEnvironment.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share",
      };

      const dbus = spawn(
        "dbus-daemon",
        [
          "--session",
          "--nofork",
          "--nopidfile",
          `--address=unix:path=${join(runtimeDirectory, "bus")}`,
          "--print-address=1",
        ],
        {
          detached: true,
          env: sessionEnvironment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      processes.push(dbus);
      drain(dbus.stderr);
      const busAddress = await readStartupLine(dbus.stdout, dbus, "D-Bus address");
      if (
        busAddress.length > 2_048 ||
        !/^(unix|tcp):/u.test(busAddress) ||
        /[\u0000-\u001f\u007f]/u.test(busAddress)
      ) {
        throw new Error("session D-Bus returned an invalid address");
      }
      sessionEnvironment.DBUS_SESSION_BUS_ADDRESS = busAddress;

      if (this.windowManagerBinary) {
        const windowManager = spawn(this.windowManagerBinary, ["--replace", "--compositor=off"], {
          detached: true,
          env: sessionEnvironment,
          stdio: ["ignore", "ignore", "pipe"],
        });
        processes.push(windowManager);
        drain(windowManager.stderr);
        await assertStillRunning(windowManager, "virtual window manager");
      }

      let closed = false;
      return {
        seatId: `linux-virtual:${context.computerSessionId}`,
        displayId,
        environment: sessionEnvironment,
        async close() {
          if (closed) return;
          closed = true;
          const failures = await stopProcessGroups([...processes].reverse());
          if (failures.length === 0) failures.push(...(await removeDirectories(directories)));
          if (failures.length > 0) {
            throw new AggregateError(failures, "virtual ComputerSession cleanup failed");
          }
        },
      };
    } catch (error) {
      const cleanup = await stopProcessGroups([...processes].reverse());
      if (cleanup.length === 0) cleanup.push(...(await removeDirectories(directories)));
      if (cleanup.length > 0) {
        const failure = new Error("virtual ComputerSession allocation and cleanup failed", {
          cause: error,
        });
        Object.defineProperty(failure, "errors", { value: [error, ...cleanup] });
        throw failure;
      }
      throw error;
    }
  }
}

async function removeDirectories(directories: readonly string[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const directory of [...directories].reverse()) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/** Existing physical/login seat used by connected machines and macOS. */
export class ExistingComputerEnvironmentAllocator implements ComputerEnvironmentAllocator {
  async allocate(context: ComputerEnvironmentContext): Promise<ComputerEnvironmentLease> {
    const environment = nativeComputerEnvironment(context.baseEnvironment);
    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      throw new InteractionControllerError(
        "unsupported",
        "the native ComputerSession adapter supports macOS and Linux",
      );
    }
    const displayId = platform === "darwin" ? "aqua" : environment.DISPLAY;
    if (!displayId) {
      throw new InteractionControllerError(
        environment.WAYLAND_DISPLAY ? "unsupported" : "resource_unavailable",
        environment.WAYLAND_DISPLAY
          ? "the current Linux ComputerSession adapter requires an X11 or XWayland display"
          : "connected Linux ComputerSession has no active graphical display",
        !environment.WAYLAND_DISPLAY,
      );
    }
    return {
      seatId: platform === "darwin" ? "macos-login-seat" : `host-seat:${displayId}`,
      displayId,
      environment,
      async close() {},
    };
  }
}

/** Deliberately excludes cloud/API credentials from the native helper process. */
export function nativeComputerEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const exact = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_DATA_DIRS",
    "XDG_SESSION_TYPE",
    "XDG_SESSION_CLASS",
    "XDG_CURRENT_DESKTOP",
    "DBUS_SESSION_BUS_ADDRESS",
    "AT_SPI_BUS_ADDRESS",
    "NO_AT_BRIDGE",
    "GTK_A11Y",
    "GTK_MODULES",
    "QT_ACCESSIBILITY",
    "GDK_BACKEND",
    "QT_QPA_PLATFORM",
    "__CF_USER_TEXT_ENCODING",
  ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || (!exact.has(name) && !name.startsWith("LC_"))) continue;
    if (Buffer.byteLength(value) > 16 * 1024 || value.includes("\0")) continue;
    environment[name] = value;
  }
  environment.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  return environment;
}

async function readStartupLine(
  stream: Readable | null,
  child: ChildProcess,
  label: string,
): Promise<string> {
  if (!stream) throw new Error(`${label} pipe is unavailable`);
  return await new Promise<string>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error: Error | null, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_START_LINE_BYTES) {
        finish(new Error(`${label} exceeds its startup envelope`));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline >= 0) finish(null, buffer.subarray(0, newline).toString("utf8").trim());
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      finish(new Error(`${label} process exited (${signal ?? String(code ?? "unknown")})`));
    const timer = setTimeout(
      () => finish(new Error(`${label} did not become ready`)),
      START_TIMEOUT_MS,
    );
    stream.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function assertStillRunning(child: ChildProcess, label: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (child.exitCode !== null || child.signalCode !== null) {
    throw new Error(`${label} exited during startup`);
  }
}

function drain(stream: Readable | null): void {
  stream?.on("data", () => undefined);
}

async function stopProcessGroups(processes: readonly ChildProcess[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const child of processes) {
    try {
      await stopProcessGroup(child);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function stopProcessGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid || !Number.isSafeInteger(pid) || pid < 2) {
    throw new Error("computer environment process has no safe PID");
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  if (await waitForExit(child, STOP_TIMEOUT_MS)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
    throw new Error("computer environment process group did not terminate");
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} is outside its supported range`);
  }
  return value;
}
