import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";
import { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { shellQuote } from "@openai/agents-core/sandbox/internal";
import type { ChannelAExecArgs, ChannelASession } from "../channel-a";
import type { SynchronousCommandResult } from "../synchronous-command";
import { admittedProviderCommandHandle } from "../provider-command-session";
import { NativeBrokerCommandSession } from "./native-command-broker-session";
import { ModalNativeBrokerChannel } from "./modal-native-broker-channel";
import type { ModalClient } from "modal";

type Executor = (args: ChannelAExecArgs) => Promise<SynchronousCommandResult>;
type Scope = { session: object; execute: Executor; closed: boolean };
const scopes = new AsyncLocalStorage<Scope>();
const installed = new WeakSet<object>();

/** Inspect the actual pinned SDK wrapper, not a caller-provided provider ID or
 * ambient credential. The returned channel opens only when its owner elects
 * this wrapper to supply a physical broker transport. */
export function modalNativeBrokerSessionContext(value: unknown) {
  if (!(value instanceof ModalSandboxSession))
    throw new Error("Native broker requires the pinned Modal SDK session");
  const sdk = value as unknown as {
    modal: ModalClient;
    sandbox: { sandboxId: string };
  };
  const sandboxId = value.state.sandboxId;
  if (!sandboxId || sdk.sandbox.sandboxId !== sandboxId || sdk.modal.version() !== "0.9.0")
    throw new Error("Native broker SDK wrapper changed physical identity");
  return {
    session: value,
    sandboxId,
    root: value.state.manifest.root,
    environment: () => ({ ...value.state.environment }),
    connect: (signal?: AbortSignal) =>
      ModalNativeBrokerChannel.connect(sdk.modal, sandboxId, signal),
    closeTransport: () => sdk.modal.close(),
  };
}

/** Routing owns this exact-backend callback. An inherited task cannot retain
 * setup authority after its enclosing operation has completed. This context
 * supplies no admission itself: every command re-enters canonical routing. */
export async function withModalNativeBrokerSetupCommands<T>(
  session: object,
  execute: Executor,
  run: () => Promise<T>,
): Promise<T> {
  if (!installed.has(session)) return await run();
  const scope: Scope = { session, execute, closed: false };
  try {
    return await scopes.run(scope, run);
  } finally {
    scope.closed = true;
  }
}

function scopeFor(session: object): Scope {
  const scope = scopes.getStore();
  if (!scope || scope.closed || scope.session !== session)
    throw new Error("Modal broker SDK helpers require their exact live routing scope");
  return scope;
}

function textStream(text: string) {
  return new ReadableStream<string>({
    start(controller) {
      if (text) controller.enqueue(text);
      controller.close();
    },
  });
}

const commandMethods = [
  "execCommand",
  "writeStdin",
  "verifyCommandSupervisionCapability",
  "bindProviderCommand",
  "getProviderCommand",
  "getProviderCommandOutput",
  "captureCommandOutput",
  "releaseSupervisedCommand",
  "cancelSupervisedCommand",
  "cancelPendingExecCommand",
] as const satisfies readonly (keyof NativeBrokerCommandSession)[];

/** Install on a fresh SDK wrapper only after qualified bootstrap composition.
 * The real SDK keeps its manifest, editors, path checks and file API, but none
 * of its internal exec sites can reach TaskExec. Foreground helper results are
 * already losslessly captured and canonically settled by the supplied route;
 * these streams are presentation, never provider process or exit evidence.
 * This helper does not select a birth, create a provider or activate routing. */
export function installModalNativeBrokerSession(
  session: ModalSandboxSession,
  commands: NativeBrokerCommandSession,
  closeTransport: () => Promise<void>,
  verifyBootstrapReadiness?: (signal?: AbortSignal) => Promise<void>,
): ModalSandboxSession {
  if (!(session instanceof ModalSandboxSession) || installed.has(session))
    throw new Error("Modal broker requires one fresh SDK session wrapper");
  const sdk = session as unknown as {
    sandbox: ConstructorParameters<typeof ModalSandboxSession>[0]["sandbox"];
    activeProcesses: Map<unknown, unknown>;
  };
  if (!(sdk.activeProcesses instanceof Map) || sdk.activeProcesses.size)
    throw new Error("Modal broker cannot adopt existing SDK commands");
  const sandbox = sdk.sandbox;
  const filesystem = sandbox.filesystem;
  let closed = false;
  let closing: Promise<void> | undefined;
  const requireOpenScope = () => {
    if (closed) throw new Error("Modal broker SDK session is closed");
    return scopeFor(session);
  };
  const execute = async (argv: unknown, input: unknown = {}) => {
    const scope = requireOpenScope();
    if (
      !Array.isArray(argv) ||
      !argv.length ||
      argv.length > 1024 ||
      argv.some((part) => typeof part !== "string" || part.includes("\0")) ||
      !argv[0] ||
      !input ||
      typeof input !== "object" ||
      Array.isArray(input)
    )
      throw new Error("Unsupported Modal broker SDK foreground command");
    const options = input as Record<string, unknown>;
    if (
      Object.keys(options).some(
        (key) => !["mode", "workdir", "env", "pty", "stdout", "stderr"].includes(key),
      ) ||
      (options.mode !== undefined && options.mode !== "text") ||
      (options.pty !== undefined && options.pty !== false) ||
      (options.workdir !== undefined && typeof options.workdir !== "string") ||
      (options.env !== undefined && !isDeepStrictEqual(options.env, session.state.environment)) ||
      [options.stdout, options.stderr].some(
        (value) => value !== undefined && value !== "pipe" && value !== "ignore",
      )
    )
      throw new Error("Unsupported Modal broker SDK foreground options");
    // The pinned SDK emits literal argv. Quote every element, including empty
    // strings; never interpolate path content or a second shell payload.
    const result = await scope.execute({
      cmd: `exec ${argv.map((part: string) => shellQuote(part)).join(" ")}`,
      shell: "/bin/sh",
      login: false,
      tty: false,
      workdir: (options.workdir as string | undefined) ?? session.state.manifest.root,
    });
    requireOpenScope();
    if (
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      !Number.isSafeInteger(result.exitCode)
    )
      throw new Error("Modal broker SDK helper has no complete canonical result");
    return {
      stdout: textStream(options.stdout === "ignore" ? "" : result.stdout),
      stderr: textStream(options.stderr === "ignore" ? "" : result.stderr),
      wait: async () => result.exitCode,
    };
  };
  const fileApi = new Proxy(filesystem, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "readBytes" || property === "writeBytes")
        return async (...args: unknown[]) => {
          requireOpenScope();
          if (property === "writeBytes" && admittedProviderCommandHandle() === undefined)
            throw new Error("Modal broker file writes require canonical mutation admission");
          const result = await Reflect.apply(value, target, args);
          requireOpenScope();
          return result;
        };
      // The pinned SDK needs only the two scoped byte methods. Do not expose a
      // newly added mutating filesystem method without an explicit adapter.
      if (typeof value === "function")
        return () => {
          throw new Error("Unsupported Modal broker SDK filesystem operation");
        };
      return value;
    },
  });
  // Keep the sandbox object's identity: native snapshot retention records its
  // exact wrapper in a WeakSet and must not be installed a second time.
  Object.defineProperties(sandbox, {
    exec: { value: execute, configurable: false, writable: false },
    filesystem: { value: fileApi, configurable: false, writable: false },
  });
  for (const method of commandMethods)
    Reflect.set(session, method, commands[method].bind(commands));
  const listDir = (session as unknown as ChannelASession).listDir?.bind(session);
  if (listDir)
    Reflect.set(session, "listDir", async (args: Parameters<typeof listDir>[0]) => {
      requireOpenScope();
      // The existing compatibility shim captured the old SDK command methods.
      // Supply its canonical synchronous runner instead of using those caches.
      return await listDir(args, async (_unused, input) => requireOpenScope().execute(input));
    });
  // A snapshot restore may create/replace a physical sandbox behind the SDK
  // wrapper. Only the independently qualified lease-owned restore path may do
  // that; neither this proxy nor a failed command can infer such authority.
  for (const method of [
    "restoreSnapshotFilesystem",
    "restoreSnapshotDirectory",
    "hydrateWorkspace",
  ])
    Reflect.set(session, method, async () => {
      throw new Error("Modal broker restore requires separate qualified preservation admission");
    });
  Reflect.set(session, "verifyMaterializedPath", async (path: string) => {
    requireOpenScope();
    if (!(await session.pathExists(path)))
      throw new Error("Modal broker materialized path is absent");
  });
  Reflect.set(session, "verifyExecReadiness", async (signal?: AbortSignal) => {
    if (closed) throw new Error("Modal broker SDK session is closed");
    if (verifyBootstrapReadiness) {
      await verifyBootstrapReadiness(signal);
      if (closed) throw new Error("Modal broker SDK session is closed");
      return 0;
    }
    throw new Error(
      "Modal broker readiness requires its qualified initial bootstrap, not TaskExec",
    );
  });
  session.close = async () => {
    closed = true;
    closing ??= (async () => {
      try {
        await commands.close();
      } finally {
        await closeTransport();
      }
    })();
    await closing;
  };
  installed.add(session);
  return session;
}
