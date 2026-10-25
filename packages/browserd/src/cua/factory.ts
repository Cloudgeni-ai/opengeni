import { ComputerDriver } from "../computer-driver";
import { join, resolve } from "node:path";
import type { ComputerSupervisorDriverContext } from "../computer-supervisor";
import { CuaComputerBackend } from "./backend";
import { computerNativeMacWindows } from "./macos-windows";
import { createCuaRuntime, missingLinuxLibraryError } from "./sdk";
import type { CuaDesktopRuntime } from "./wire";
import { bringToFront, windowsForeground } from "./windows-foreground";

/** The part of the CUA SDK a desktop runtime uses. */
type CuaSdk = {
  listToolsJson(): Promise<string>;
  callTool: CuaDesktopRuntime["callTool"];
  shutdown(): Promise<void>;
  metadata?(): Promise<unknown>;
  uniffiDestroy?(): void;
};

/** The one CUA worker of this machine's physical desktop. Every
 * ComputerSession on that desktop uses it, each through its own CUA sessions,
 * observations and refs; its calls run one at a time, because separate cursor
 * overlays do not make simultaneous input into one desktop safe. Sessions
 * sharing it never displace each other, so two agents on one Mac keep their
 * refs and windows instead of restarting the worker on every call. */
type SeatWorker = {
  sdk: CuaSdk;
  users: number;
  queue: Promise<unknown>;
  /** No new session joins it: its process stopped answering. */
  retired: boolean;
  shutdown: Promise<void> | null;
};

let seatWorker: Promise<SeatWorker> | null = null;

function destroy(sdk: CuaSdk) {
  if (typeof sdk.uniffiDestroy === "function") sdk.uniffiDestroy();
}

async function stopWorker(worker: SeatWorker): Promise<void> {
  worker.shutdown ??= (async () => {
    try {
      await worker.sdk.shutdown();
    } finally {
      destroy(worker.sdk);
    }
  })();
  await worker.shutdown;
}

/** Whether the worker still answers; a worker whose process went away is
 * replaced for the next session instead of failing every one after it. */
async function answers(worker: SeatWorker): Promise<boolean> {
  if (typeof worker.sdk.metadata !== "function") return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      worker.sdk.metadata(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("CUA worker did not answer")), 5_000);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function joinSeatWorker(create: () => Promise<CuaSdk>): Promise<SeatWorker> {
  for (;;) {
    const pending = seatWorker;
    if (pending) {
      const worker = await pending.catch(() => null);
      if (worker && !worker.retired && !worker.shutdown) {
        // Count the session before the health check, so the worker cannot
        // stop under it meanwhile.
        worker.users += 1;
        if (await answers(worker)) return worker;
        worker.retired = true;
        await leaveSeatWorker(worker);
      }
      if (seatWorker === pending) seatWorker = null;
      continue;
    }
    const created = create().then(
      (sdk): SeatWorker => ({
        sdk,
        users: 0,
        queue: Promise.resolve(),
        retired: false,
        shutdown: null,
      }),
    );
    seatWorker = created;
    try {
      const worker = await created;
      worker.users += 1;
      return worker;
    } catch (error) {
      if (seatWorker === created) seatWorker = null;
      throw error;
    }
  }
}

async function leaveSeatWorker(worker: SeatWorker): Promise<void> {
  worker.users -= 1;
  if (worker.users > 0) return;
  // The last session stopped it; the next one starts a fresh worker.
  worker.retired = true;
  await stopWorker(worker);
}

/** One session's use of the physical desktop's shared worker, started with
 * `create` when no session holds one: its calls queue behind every other
 * session's, and shutting it down only leaves the worker. */
export async function openSeatRuntime(create: () => Promise<CuaSdk>): Promise<CuaDesktopRuntime> {
  const worker = await joinSeatWorker(create);
  let left = false;
  return {
    listToolsJson: () => worker.sdk.listToolsJson(),
    callTool: (name, args) => {
      const call = worker.queue.then(
        () => worker.sdk.callTool(name, args),
        () => worker.sdk.callTool(name, args),
      );
      worker.queue = call.catch(() => undefined);
      return call;
    },
    shutdown: async () => {
      if (left) return;
      left = true;
      await leaveSeatWorker(worker);
    },
  };
}

export async function createCuaComputerDriver(
  context: ComputerSupervisorDriverContext,
): Promise<ComputerDriver> {
  if (!["darwin", "win32", "linux"].includes(process.platform))
    throw new Error(
      "CUA requires macOS, an isolated Linux seat, or an interactive Windows desktop",
    );
  const physical = process.platform !== "linux";
  if (
    !physical &&
    (context.seatId !== `linux-virtual:${context.computerSessionId}` ||
      !context.displayId ||
      context.environment.DISPLAY !== context.displayId ||
      !context.environment.DBUS_SESSION_BUS_ADDRESS ||
      context.environment.HOME !== join(context.sessionDirectory, "gui-home"))
  )
    throw new Error("CUA Linux requires an allocated display and accessibility bus");
  // Lazy loading keeps the browser engine and normal native backend independent
  // of CUA's Node-API runtime. Never expose CUA browser tools or its raw SDK.
  const environment = { ...context.environment };
  let runtime: CuaDesktopRuntime;
  if (physical) {
    runtime = await openSeatRuntime(() => createCuaRuntime(environment));
  } else {
    // An isolated Linux seat has its own display, so its own worker.
    const sdk = await createCuaRuntime(environment).catch((error: unknown) => {
      throw (process.platform === "linux" && missingLinuxLibraryError(error)) || error;
    });
    let closed = false;
    runtime = {
      listToolsJson: () => sdk.listToolsJson(),
      callTool: (name, args) => sdk.callTool(name, args),
      shutdown: async () => {
        if (closed) return;
        closed = true;
        try {
          await sdk.shutdown();
        } finally {
          destroy(sdk);
        }
      },
    };
  }
  // The agent installs computer-native beside browserd; on macOS it reads
  // and restores windows that CUA cannot.
  const nativeBinary = process.env.OPENGENI_BROWSERD_COMPUTER_NATIVE_BINARY;
  // A failed open shuts its runtime down, which for a shared worker only
  // leaves it.
  const backend = await CuaComputerBackend.open(
    runtime,
    process.platform === "win32" ? "windows" : process.platform === "linux" ? "linux" : "macos",
    process.platform === "darwin" && nativeBinary
      ? { macWindows: computerNativeMacWindows(resolve(nativeBinary)) }
      : process.platform === "win32"
        ? {
            frontWindow: async (windowId) =>
              await bringToFront(await windowsForeground(), windowId),
          }
        : {},
  );
  return new ComputerDriver({
    computerSessionId: context.computerSessionId,
    controllerGeneration: context.controllerGeneration,
    client: backend,
    // No automatic SDK reconstruction after an ambiguous native failure.
    // A new ComputerSession establishes new observations/capture authority.
  });
}
