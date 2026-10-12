import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as yieldNativeRead } from "node:timers/promises";
import { UnixLocalSandboxSession } from "@openai/agents/sandbox/local";
import type { ModalSandboxSession } from "@openai/agents-extensions/sandbox/modal";
import { E2BSandboxSession } from "@openai/agents-extensions/sandbox/e2b";
import { BlaxelSandboxSession } from "@openai/agents-extensions/sandbox/blaxel";
import { VercelSandboxSession } from "@openai/agents-extensions/sandbox/vercel";
import { RunloopSandboxSession } from "@openai/agents-extensions/sandbox/runloop";
import { DaytonaSandboxSession } from "@openai/agents-extensions/sandbox/daytona";
import { CloudflareSandboxSession } from "@openai/agents-extensions/sandbox/cloudflare";
import type { ChannelASession } from "./channel-a";
import type { ProviderCommandOutput } from "./provider-command-session";
import { parseExecResponseBanner } from "./exec-banner";
import {
  SynchronousCommandOutcomeUnknownError,
  type SynchronousCommandPage,
} from "./synchronous-command";
import { collectCloudflareCommandOutput } from "./cloudflare-command-output";
import { boundDaytonaCommandProcess } from "./providers/daytona-command-binding";
import { DaytonaFramedCommand } from "./providers/daytona-framed-command";

type Capture = {
  identity: string;
  stdout: string[];
  stderr: string[];
  cursor: { stdout: number; stderr: number };
  eof: { stdout: boolean; stderr: boolean };
  closed: boolean;
  exitCode: number | null;
  unavailable: boolean;
  terminalObserved: boolean;
  started?: boolean;
  completion?: Promise<unknown>;
  sessionId?: number;
  child?: ChildProcessWithoutNullStreams;
  receipts: Set<unknown>;
  daytona?: DaytonaFramedCommand;
};
type Adapter = {
  captures: Map<number, Capture>;
  pages: Map<unknown, SynchronousCommandPage>;
  translate: (output: string) => string;
};
type Scope = { adapter: Adapter; captures: Set<Capture> };
const adapters = new WeakMap<object, Adapter>();
const scopes = new AsyncLocalStorage<Scope>();
type TerminalProviderScope = {
  session: object;
  pages: Map<string, ProviderCommandOutput>;
  parent: TerminalProviderScope | undefined;
  closed: boolean;
};
const terminalProviderPages = new AsyncLocalStorage<TerminalProviderScope>();

function terminalProviderScope(session: object): TerminalProviderScope | undefined {
  // Routing nests its collector proxy inside the exact backend's scope.
  for (let scope = terminalProviderPages.getStore(); scope; scope = scope.parent)
    if (!scope.closed && scope.session === session) return scope;
  return undefined;
}

/** Keep an unretained terminal page only through this synchronous collector's
 * snapshot/settlement. Never turn its presentation banner into output proof. */
export function retainSynchronousTerminalProviderPage(
  session: object,
  result: string,
  page: ProviderCommandOutput,
): void {
  const scope = terminalProviderScope(session);
  if (scope && page.exitCode !== null) scope.pages.set(result, page);
}

export function synchronousTerminalProviderPage(
  session: object,
  result: string,
): ProviderCommandOutput | null {
  return terminalProviderScope(session)?.pages.get(result) ?? null;
}
const launches = new AsyncLocalStorage<Capture>();
const remoteStarts = new AsyncLocalStorage<Capture>();
const formattedStarts = new AsyncLocalStorage<{
  page?: SynchronousCommandPage;
  capture?: Capture;
}>();
// Retained admission IDs are PostgreSQL int32. The pinned SDK allocates PTY
// IDs only in [1000, 100000), so this runtime range cannot alias its controls.
let nextDaytonaHandle = 2 ** 30;
const cloudflareRequest = Object.getOwnPropertyDescriptor(
  CloudflareSandboxSession.prototype,
  "fetch",
)?.value;

function snapshot(adapter: Adapter, capture: Capture): SynchronousCommandPage {
  if (capture.unavailable) {
    // An unprovable receipt does not consume our independently captured bytes
    // or advance its cursor. The original handle retains custody without replay.
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      ...(capture.sessionId !== undefined ? { sessionId: capture.sessionId } : {}),
      wallTimeSeconds: 0,
      collectionUnavailable: true,
      outputCursor: {
        identity: capture.identity,
        expected: { ...capture.cursor },
        next: { ...capture.cursor },
      },
    };
  }
  const stdout = capture.stdout.join("");
  const stderr = capture.stderr.join("");
  capture.stdout = [];
  capture.stderr = [];
  const expected = { ...capture.cursor };
  capture.cursor.stdout += Buffer.byteLength(stdout);
  capture.cursor.stderr += Buffer.byteLength(stderr);
  const terminal = capture.closed && capture.eof.stdout && capture.eof.stderr;
  return {
    stdout: adapter.translate(stdout),
    stderr: adapter.translate(stderr),
    exitCode: terminal ? capture.exitCode : null,
    ...(capture.sessionId !== undefined && !terminal ? { sessionId: capture.sessionId } : {}),
    wallTimeSeconds: 0,
    outputCursor: { identity: capture.identity, expected, next: { ...capture.cursor } },
  };
}

function retain(adapter: Adapter, capture: Capture, result: unknown, page: SynchronousCommandPage) {
  capture.receipts.add(result);
  adapter.pages.set(result, page);
}

function createCapture(): Capture {
  return {
    identity: crypto.randomUUID(),
    stdout: [],
    stderr: [],
    cursor: { stdout: 0, stderr: 0 },
    eof: { stdout: false, stderr: false },
    closed: false,
    exitCode: null,
    unavailable: false,
    terminalObserved: false,
    receipts: new Set(),
  };
}

async function releaseCapture(adapter: Adapter, capture: Capture): Promise<void> {
  if (!capture.terminalObserved || capture.unavailable) return;
  try {
    await capture.daytona?.cleanup();
  } catch (error) {
    throw new SynchronousCommandOutcomeUnknownError(
      capture.sessionId ?? null,
      { stdout: "", stderr: "" },
      error,
    );
  }
  if (capture.sessionId !== undefined) adapter.captures.delete(capture.sessionId);
  for (const receipt of capture.receipts) adapter.pages.delete(receipt);
  capture.receipts.clear();
  capture.stdout = [];
  capture.stderr = [];
  delete capture.child;
  delete capture.completion;
  delete capture.daytona;
}

async function daytonaReceipt(adapter: Adapter, capture: Capture): Promise<string> {
  try {
    if (!capture.closed) {
      const result = await capture.daytona!.read();
      capture.unavailable = false;
      if (result && !capture.closed) captureRemoteResult(capture, result, true);
    }
  } catch {
    // Preserve the exact native session/cmd and original receipt on malformed
    // or lost reads. A later exact read can recover; no Start or delete follows.
    capture.unavailable = true;
  }
  const terminal = capture.closed && capture.eof.stdout && capture.eof.stderr;
  const raw = terminal
    ? `Process exited with code ${capture.exitCode}\n\nOutput:\n`
    : `Process running with session ID ${capture.sessionId}\n\nOutput:\n`;
  return await formattedReceipt(adapter, capture, raw, capture.sessionId);
}

async function formattedReceipt(
  adapter: Adapter,
  capture: Capture,
  raw: string,
  originalSessionId?: number,
): Promise<string> {
  const banner = parseExecResponseBanner(raw);
  if (banner.kind === "exited") await capture.completion;
  if (
    (banner.kind === "running" &&
      originalSessionId !== undefined &&
      banner.sessionId !== originalSessionId) ||
    (banner.kind === "exited" && (!capture.closed || banner.exitCode !== capture.exitCode)) ||
    (banner.kind !== "running" && banner.kind !== "exited")
  )
    capture.unavailable = true;
  if (banner.kind === "running") {
    capture.sessionId = banner.sessionId;
    adapter.captures.set(banner.sessionId, capture);
  }
  const page = snapshot(adapter, capture);
  if (banner.kind === "running") page.sessionId = banner.sessionId;
  capture.terminalObserved =
    !page.collectionUnavailable && page.sessionId === undefined && page.exitCode !== null;
  const result = `Native output receipt: ${crypto.randomUUID()}\n${raw}`;
  retain(adapter, capture, result, page);
  return result;
}

function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && "value" in field ? field.value : undefined;
}

function captureRemoteResult(capture: Capture, value: unknown, requireStreams = false): void {
  const stdout = ownValue(value, "stdout");
  const stderr = ownValue(value, "stderr");
  const exitCode = ownValue(value, "exitCode");
  const unsupportedField = (key: string) =>
    value &&
    typeof value === "object" &&
    key in value &&
    !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value");
  if (
    (requireStreams && (typeof stdout !== "string" || typeof stderr !== "string")) ||
    (stdout !== undefined && typeof stdout !== "string") ||
    (stderr !== undefined && typeof stderr !== "string") ||
    unsupportedField("stdout") ||
    unsupportedField("stderr") ||
    unsupportedField("exitCode") ||
    !Number.isSafeInteger(exitCode)
  ) {
    capture.unavailable = true;
    return;
  }
  // These foreground native contracts define omitted optional streams as
  // empty. A malformed value/accessor or missing terminal exit is not proof.
  capture.stdout.push((stdout as string | undefined) ?? "");
  capture.stderr.push((stderr as string | undefined) ?? "");
  capture.closed = true;
  capture.eof = { stdout: true, stderr: true };
  capture.exitCode = exitCode as number;
}

class E2BCollectionAccess extends E2BSandboxSession {
  static hook(session: E2BSandboxSession) {
    const access = session as E2BCollectionAccess;
    return {
      run: access.runRemoteCommand.bind(session),
      replace: (run: typeof access.runRemoteCommand) => {
        access.runRemoteCommand = run;
      },
    };
  }
}
class BlaxelCollectionAccess extends BlaxelSandboxSession {
  static hook(session: BlaxelSandboxSession) {
    const access = session as BlaxelCollectionAccess;
    return {
      run: access.runRemoteCommand.bind(session),
      replace: (run: typeof access.runRemoteCommand) => {
        access.runRemoteCommand = run;
      },
    };
  }
}
class VercelCollectionAccess extends VercelSandboxSession {
  static hook(session: VercelSandboxSession) {
    const access = session as VercelCollectionAccess;
    return {
      run: access.runRemoteCommand.bind(session),
      replace: (run: typeof access.runRemoteCommand) => {
        access.runRemoteCommand = run;
      },
    };
  }
}
class RunloopCollectionAccess extends RunloopSandboxSession {
  static hook(session: RunloopSandboxSession) {
    const access = session as RunloopCollectionAccess;
    return {
      run: access.runRemoteCommand.bind(session),
      replace: (run: typeof access.runRemoteCommand) => {
        access.runRemoteCommand = run;
      },
    };
  }
}

type RemoteCollectionSession =
  | E2BSandboxSession
  | BlaxelSandboxSession
  | VercelSandboxSession
  | RunloopSandboxSession
  | DaytonaSandboxSession
  | CloudflareSandboxSession;

/** Observe only the known SDK constructor's original foreground transport.
 * Protected exec-kind hooks exclude preflight/archive work. The two SDKs with
 * no declared raw hook are scoped at their exact command request, never at a
 * global transport, before formatting can trim or merge the native receipt. */
function installRemoteCollection(session: RemoteCollectionSession): Adapter | undefined {
  const existing = adapters.get(session);
  if (existing) return existing;
  const adapter: Adapter = { captures: new Map(), pages: new Map(), translate: (value) => value };
  const captureCall = async <T>(
    run: () => Promise<T>,
    project?: (result: T) => Promise<unknown>,
  ) => {
    const capture = launches.getStore();
    if (!capture || scopes.getStore()?.adapter !== adapter) return await run();
    if (capture.started) capture.unavailable = true;
    capture.started = true;
    try {
      const result = await run();
      captureRemoteResult(capture, project ? await project(result) : result);
      return result;
    } catch (error) {
      // E2B's public command-exit error carries the same separated result.
      // Missing streams or exit remain unavailable, never invented from prose.
      captureRemoteResult(capture, error, true);
      throw error;
    }
  };
  const hook =
    session instanceof E2BSandboxSession
      ? E2BCollectionAccess.hook(session)
      : session instanceof BlaxelSandboxSession
        ? BlaxelCollectionAccess.hook(session)
        : session instanceof VercelSandboxSession
          ? VercelCollectionAccess.hook(session)
          : session instanceof RunloopSandboxSession
            ? RunloopCollectionAccess.hook(session)
            : undefined;
  const attached = new WeakSet<object>();
  let cloudflareBinding:
    | ((path: string, init: RequestInit, timeout?: number) => Promise<Response>)
    | undefined;
  const attach = () => {
    if (session instanceof CloudflareSandboxSession) {
      // This pinned SDK has no declared raw command extension hook. Its known
      // bound Worker request method is the narrow native transport boundary:
      // leave URL/auth/timeout/body unchanged, and tee only the same exec reply.
      const descriptor = Object.getOwnPropertyDescriptor(
        CloudflareSandboxSession.prototype,
        "fetch",
      );
      const own = Object.getOwnPropertyDescriptor(session, "fetch");
      if (
        typeof cloudflareRequest !== "function" ||
        descriptor?.value !== cloudflareRequest ||
        (cloudflareBinding ? own?.value !== cloudflareBinding : own !== undefined)
      )
        throw new SynchronousCommandOutcomeUnknownError(
          null,
          { stdout: "", stderr: "" },
          new Error("Unsupported pinned Cloudflare command request binding"),
        );
      if (cloudflareBinding) return true;
      const fetch = cloudflareRequest.bind(session) as (
        path: string,
        init: RequestInit,
        timeout?: number,
      ) => Promise<Response>;
      cloudflareBinding = async (path: string, init: RequestInit, timeout?: number) => {
        const capture = launches.getStore();
        if (
          !capture ||
          scopes.getStore()?.adapter !== adapter ||
          path !== `/v1/sandbox/${session.state.sandboxId}/exec` ||
          init.method !== "POST"
        )
          return await fetch(path, init, timeout);
        if (capture.started) capture.unavailable = true;
        capture.started = true;
        const response = await fetch(path, init, timeout);
        capture.completion = collectCloudflareCommandOutput(response.clone())
          .then((result) => {
            captureRemoteResult(capture, result, true);
          })
          .catch(() => {
            capture.unavailable = true;
          });
        return response;
      };
      Object.defineProperty(session, "fetch", { configurable: true, value: cloudflareBinding });
      attached.add(session);
      return true;
    }
    const native = ownValue(
      session,
      session instanceof RunloopSandboxSession ? "devbox" : "sandbox",
    );
    if (!native || typeof native !== "object") return false;
    if (attached.has(native)) return true;
    if (session instanceof E2BSandboxSession) {
      const source = (native as ConstructorParameters<typeof E2BSandboxSession>[0]["sandbox"])
        .commands;
      if (typeof source?.run !== "function") return false;
      const run = source.run.bind(source);
      source.run = (command, options) => captureCall(() => run(command, options));
    } else if (session instanceof BlaxelSandboxSession) {
      const source = (native as ConstructorParameters<typeof BlaxelSandboxSession>[0]["sandbox"])
        .process;
      if (typeof source?.exec !== "function") return false;
      const run = source.exec.bind(source);
      source.exec = (options) => captureCall(() => run(options));
    } else if (session instanceof VercelSandboxSession) {
      const source = native as ConstructorParameters<typeof VercelSandboxSession>[0]["sandbox"];
      if (typeof source.runCommand !== "function") return false;
      const run = source.runCommand.bind(source);
      source.runCommand = (options) =>
        captureCall(
          () => run(options),
          async (result) => ({
            exitCode: result.exitCode,
            stdout: await result.output("stdout"),
            stderr: await result.output("stderr"),
          }),
        );
    } else if (session instanceof RunloopSandboxSession) {
      const source = (native as ConstructorParameters<typeof RunloopSandboxSession>[0]["devbox"])
        .cmd;
      if (typeof source?.exec !== "function") return false;
      const run = source.exec.bind(source);
      source.exec = async (command, params, options) => {
        const capture = launches.getStore();
        if (!capture || scopes.getStore()?.adapter !== adapter)
          return await run(command, params, options);
        if (capture.started) capture.unavailable = true;
        capture.started = true;
        const result = await run(command, params, options);
        // The native result's no-limit public methods retrieve full logs from
        // this same execution when its initial last_n response is truncated.
        // Cache those reads for Agents' formatter, avoiding another log drain.
        const logs = await Promise.allSettled([
          Promise.resolve().then(() => result.stdout()),
          Promise.resolve().then(() => result.stderr()),
        ]);
        if (logs[0].status !== "fulfilled" || logs[1].status !== "fulfilled") {
          capture.unavailable = true;
          throw new SynchronousCommandOutcomeUnknownError(
            null,
            {
              stdout: logs[0].status === "fulfilled" ? logs[0].value : "",
              stderr: logs[1].status === "fulfilled" ? logs[1].value : "",
            },
            new AggregateError(
              logs.filter((log) => log.status === "rejected").map((log) => log.reason),
              "Original execution output retrieval failed",
            ),
          );
        }
        const [stdout, stderr] = [logs[0].value, logs[1].value];
        captureRemoteResult(capture, { stdout, stderr, exitCode: result.exitCode }, true);
        return new Proxy(result, {
          get(target, property) {
            if (property === "stdout" || property === "stderr")
              return (numLines?: number) =>
                numLines === undefined
                  ? Promise.resolve(property === "stdout" ? stdout : stderr)
                  : target[property](numLines);
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
    } else {
      const source = (native as ConstructorParameters<typeof DaytonaSandboxSession>[0]["sandbox"])
        .process;
      if (typeof source?.executeCommand !== "function") return false;
      const run = source.executeCommand.bind(source);
      source.executeCommand = async (command, cwd, env, timeout) => {
        const capture = launches.getStore();
        if (!capture || scopes.getStore()?.adapter !== adapter)
          return await run(command, cwd, env, timeout);
        if (capture.started)
          throw new SynchronousCommandOutcomeUnknownError(capture.sessionId ?? null, {
            stdout: "",
            stderr: "",
          });
        let process;
        try {
          process = await boundDaytonaCommandProcess(session as DaytonaSandboxSession);
        } catch (error) {
          throw new SynchronousCommandOutcomeUnknownError(null, { stdout: "", stderr: "" }, error);
        }
        capture.daytona = new DaytonaFramedCommand(process, command, capture.identity, cwd, env);
        if (nextDaytonaHandle > 2 ** 31 - 1)
          throw new Error("Native command handle space exhausted");
        capture.sessionId = nextDaytonaHandle++;
        adapter.captures.set(capture.sessionId, capture);
        capture.started = true;
        await capture.daytona.start(timeout);
        // SDK compilation supplied the original command/cwd/env exactly once.
        // Its formatted result is deliberately NOT the native receipt. The
        // enclosing filesystem scope returns our original-handle page instead.
        return { exitCode: 0, result: "" };
      };
    }
    attached.add(native);
    return true;
  };
  if (!attach()) return undefined;
  hook?.replace(async (command, options) => {
    const capture = remoteStarts.getStore();
    if (!capture || scopes.getStore()?.adapter !== adapter || options.kind !== "exec")
      return await hook.run(command, options);
    if (!attach()) capture.unavailable = true;
    return await launches.run(capture, () => hook.run(command, options));
  });
  const exec = session.execCommand.bind(session);
  session.execCommand = async (args) => {
    const scope = scopes.getStore();
    if (scope?.adapter !== adapter || args.tty) return await exec(args);
    if (!hook) attach();
    const capture = createCapture();
    scope.captures.add(capture);
    let raw: string;
    try {
      raw = await remoteStarts.run(capture, () =>
        hook ? exec(args) : launches.run(capture, () => exec(args)),
      );
    } catch (error) {
      if (!capture.started || error instanceof SynchronousCommandOutcomeUnknownError) throw error;
      capture.unavailable = true;
      throw new SynchronousCommandOutcomeUnknownError(null, { stdout: "", stderr: "" }, error);
    }
    if (!capture.started) capture.unavailable = true;
    if (capture.daytona) return await daytonaReceipt(adapter, capture);
    return await formattedReceipt(adapter, capture, raw);
  };
  if (session instanceof DaytonaSandboxSession) {
    const write = session.writeStdin.bind(session);
    session.writeStdin = async (args) => {
      const capture = adapter.captures.get(args.sessionId);
      if (!capture?.daytona) return await write(args);
      if (args.chars)
        throw new SynchronousCommandOutcomeUnknownError(args.sessionId, { stdout: "", stderr: "" });
      if (!capture.closed)
        await yieldNativeRead(Math.max(0, Math.min(args.yieldTimeMs ?? 250, 250)));
      return await daytonaReceipt(adapter, capture);
    };
  }
  const close = session.close.bind(session);
  session.close = async () => {
    await close();
    if (!(session instanceof DaytonaSandboxSession)) {
      adapter.captures.clear();
      adapter.pages.clear();
      return;
    }
    for (const [handle, capture] of adapter.captures) {
      if (capture.daytona) continue;
      adapter.captures.delete(handle);
      for (const receipt of capture.receipts) adapter.pages.delete(receipt);
    }
    // Native session deletion/instance shutdown is not output completion.
    // Unconsumed native captures remain in custody until exact settlement.
  };
  (session as ChannelASession).getSynchronousCommandOutput = (result) =>
    adapter.pages.get(result) ?? null;
  adapters.set(session, adapter);
  return adapter;
}

/** A later control owner can finish custody after the original scope unwinds.
 * Call only after output capture and exact terminal settlement both succeed. */
export async function releaseNativeSynchronousCommandOutput(
  session: object,
  receipt: unknown,
): Promise<void> {
  const adapter = adapters.get(session);
  const page = adapter?.pages.get(receipt);
  if (
    !adapter ||
    !page ||
    page.collectionUnavailable ||
    page.exitCode === null ||
    page.sessionId !== undefined
  )
    return;
  for (const capture of adapter.captures.values()) {
    if (capture.receipts.has(receipt)) {
      await releaseCapture(adapter, capture);
      return;
    }
  }
}

/** Runtime-owned native session aliases are readonly, turn-owned locators,
 * not SDK PTYs or durable cross-worker background command identities. */
export function isNativeSynchronousCommandHandle(session: object, handle: number): boolean {
  return adapters.get(session)?.captures.get(handle)?.daytona !== undefined;
}

/** Setup aliases change only SDK metadata, never the original native stream.
 * Keep that trusted page correlated with the alias's exact returned receipt. */
export function aliasNativeSynchronousCommandOutput(
  session: object,
  original: string,
  aliased: string,
  sessionId: number,
): void {
  const adapter = adapters.get(session);
  const page = adapter?.pages.get(original);
  if (!adapter || !page) return;
  for (const capture of adapter.captures.values()) {
    if (capture.receipts.has(original)) {
      retain(adapter, capture, aliased, { ...page, sessionId });
      return;
    }
  }
}

type ModalTransport = Pick<ConstructorParameters<typeof ModalSandboxSession>[0]["sandbox"], "exec">;

/** The runtime policy supplies its already-validated native binding. Observe
 * public process streams and share one original wait; never read SDK maps. */
export function installModalSynchronousCommandCollection(
  session: {
    execCommand?: ChannelASession["execCommand"];
    writeStdin?: ChannelASession["writeStdin"];
    getSynchronousCommandOutput?: ChannelASession["getSynchronousCommandOutput"];
    close?: (() => Promise<void>) | undefined;
  },
  getSandbox: () => Partial<ModalTransport> | undefined,
): void {
  if (
    adapters.has(session) ||
    session.getSynchronousCommandOutput ||
    !session.execCommand ||
    !session.writeStdin ||
    !getSandbox()?.exec
  )
    return;
  const adapter: Adapter = {
    captures: new Map(),
    pages: new Map(),
    translate: (value) => value,
  };
  const exec = session.execCommand.bind(session);
  const write = session.writeStdin.bind(session);
  const attached = new WeakSet<object>();
  const outputReaders = new Set<() => Promise<void>>();
  const attach = () => {
    const sandbox = getSandbox();
    if (!sandbox?.exec || attached.has(sandbox)) return;
    const nativeExec = sandbox.exec.bind(sandbox);
    sandbox.exec = async (command, options) => {
      const capture = launches.getStore();
      if (!capture || scopes.getStore()?.adapter !== adapter || options?.pty)
        return await nativeExec(command, options);
      if (capture.started) capture.unavailable = true;
      capture.started = true;
      const process = await nativeExec(command, options);
      const branches = {
        stdout: process.stdout.tee(),
        stderr: process.stderr.tee(),
      };
      const pump = async (stream: "stdout" | "stderr") => {
        const reader = branches[stream][1].getReader();
        const stop = async () => {
          // Explicit session close cancels the SDK's sibling tee. Join it
          // without allowing cancellation to masquerade as consumed EOF.
          capture.unavailable = true;
          await reader.cancel().catch(() => {});
        };
        outputReaders.add(stop);
        try {
          while (true) {
            const page = await reader.read();
            if (page.done) {
              capture.eof[stream] = true;
              return;
            }
            if (typeof page.value !== "string") capture.unavailable = true;
            else capture[stream].push(page.value);
          }
        } catch {
          capture.unavailable = true;
        } finally {
          outputReaders.delete(stop);
          reader.releaseLock();
        }
      };
      const waited = process.wait().then(
        (exitCode) => {
          capture.closed = true;
          capture.exitCode = exitCode;
          if (!Number.isSafeInteger(exitCode)) capture.unavailable = true;
          return exitCode;
        },
        (error) => {
          capture.unavailable = true;
          throw error;
        },
      );
      capture.completion = Promise.all([waited, pump("stdout"), pump("stderr")]).catch(() => {
        capture.unavailable = true;
      });
      return new Proxy(process, {
        get(target, property) {
          if (property === "stdout" || property === "stderr") return branches[property][0];
          if (property === "wait") return () => waited;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    attached.add(sandbox);
  };
  session.execCommand = async (args) => {
    const scope = scopes.getStore();
    if (scope?.adapter !== adapter || args.tty) return await exec(args);
    attach();
    const capture = createCapture();
    scope.captures.add(capture);
    const raw = await launches.run(capture, () => exec(args));
    return capture.started ? await formattedReceipt(adapter, capture, raw) : raw;
  };
  session.writeStdin = async (args) => {
    const capture = adapter.captures.get(args.sessionId);
    const raw = await write(args);
    return capture ? await formattedReceipt(adapter, capture, raw, args.sessionId) : raw;
  };
  session.getSynchronousCommandOutput = (result) => adapter.pages.get(result) ?? null;
  const close = session.close?.bind(session);
  if (close)
    session.close = async () => {
      const stopping = [...outputReaders].map((stop) => stop());
      await close();
      await Promise.allSettled(stopping);
      for (const capture of adapter.captures.values()) {
        capture.stdout = [];
        capture.stderr = [];
        capture.receipts.clear();
        delete capture.completion;
      }
      adapter.captures.clear();
      adapter.pages.clear();
    };
  adapters.set(session, adapter);
}

/** The pinned local and Docker SDK sessions expose this protected extension
 * point. Install it on the same instance, keeping its SDK process map/handles
 * and the provider's actual spawn, path translation and lifecycle untouched.
 * Never read SDK-private activeProcesses or recover output from a banner. */
class NativeCollectionAccess extends UnixLocalSandboxSession {
  static install(session: UnixLocalSandboxSession): Adapter {
    const existing = adapters.get(session);
    if (existing) return existing;
    const access = session as NativeCollectionAccess;
    const adapter: Adapter = {
      captures: new Map(),
      pages: new Map(),
      translate: access.translateCommandOutput.bind(session),
    };
    const spawn = access.spawnShellCommand.bind(session);
    const exec = session.exec.bind(session);
    const execCommand = session.execCommand.bind(session);
    const write = session.writeStdin.bind(session);
    const close = session.close.bind(session);

    access.spawnShellCommand = async (command, args) => {
      const child = await spawn(command, args);
      const capture = launches.getStore();
      if (!capture || scopes.getStore()?.adapter !== adapter || args.tty) return child;
      if (capture.child) {
        capture.unavailable = true;
        return child;
      }
      capture.child = child;
      // Tee raw bytes before the SDK applies its decoder and bounded buffers.
      // The same child/PID and stdin remain in its original process map. Each
      // pass-through delivers unchanged bytes to the SDK with normal backpressure.
      for (const stream of ["stdout", "stderr"] as const) {
        const source = child[stream];
        if (source.readableEncoding || source.readableFlowing === true) {
          capture.unavailable = true;
          continue;
        }
        const decoder = new StringDecoder("utf8");
        const output = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            const text = decoder.write(chunk);
            if (text) capture[stream].push(text);
            callback(null, chunk);
          },
          flush(callback) {
            const text = decoder.end();
            if (text) capture[stream].push(text);
            callback();
          },
        });
        output.once("close", () => {
          capture.eof[stream] = true;
        });
        output.once("error", () => {
          capture.unavailable = true;
        });
        source.once("error", (error) => {
          capture.unavailable = true;
          output.destroy(error);
        });
        source.once("close", () => {
          if (!source.readableEnded) {
            capture.unavailable = true;
            output.destroy();
          }
        });
        child[stream] = output;
        source.pipe(output);
      }
      child.once("error", () => {
        capture.unavailable = true;
      });
      child.once("close", (code, signal) => {
        capture.closed = true;
        capture.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
      });
      return child;
    };

    session.exec = async (args) => {
      const scope = scopes.getStore();
      if (scope?.adapter !== adapter || args.tty) return await exec(args);
      const capture = createCapture();
      scope.captures.add(capture);
      return await launches.run(capture, async () => {
        const raw = await exec(args);
        if (!capture.child) capture.unavailable = true;
        if (raw.sessionId !== undefined) {
          if (!Number.isSafeInteger(raw.sessionId) || raw.sessionId <= 0)
            capture.unavailable = true;
          capture.sessionId = raw.sessionId;
          adapter.captures.set(raw.sessionId, capture);
        } else if (!capture.closed || raw.exitCode !== capture.exitCode) {
          capture.unavailable = true;
        }
        const page = snapshot(adapter, capture);
        page.wallTimeSeconds = raw.wallTimeSeconds;
        // A yielded SDK start still needs its one exact handle read so routing
        // can settle the retained admission, even if close won this microtask.
        if (raw.sessionId !== undefined) page.sessionId = raw.sessionId;
        capture.terminalObserved =
          !page.collectionUnavailable && page.sessionId === undefined && page.exitCode !== null;
        const result = { ...raw, stdout: page.stdout, stderr: page.stderr };
        retain(adapter, capture, result, page);
        const formatted = formattedStarts.getStore();
        if (formatted) {
          formatted.page = page;
          formatted.capture = capture;
        }
        return result;
      });
    };
    session.execCommand = async (args) => {
      if (scopes.getStore()?.adapter !== adapter || args.tty) return await execCommand(args);
      const formatted: { page?: SynchronousCommandPage; capture?: Capture } = {};
      return await formattedStarts.run(formatted, async () => {
        const raw = await execCommand(args);
        if (!formatted.page) return raw;
        const result = `Native output receipt: ${crypto.randomUUID()}\n${raw}`;
        if (!formatted.capture) return raw;
        retain(adapter, formatted.capture, result, formatted.page);
        return result;
      });
    };
    session.writeStdin = async (args) => {
      const capture = adapter.captures.get(args.sessionId);
      if (!capture) return await write(args);
      const raw = await write(args);
      const banner = parseExecResponseBanner(raw);
      if (
        (banner.kind === "running" && banner.sessionId !== args.sessionId) ||
        (banner.kind === "exited" && (!capture.closed || banner.exitCode !== capture.exitCode)) ||
        (banner.kind !== "running" && banner.kind !== "exited")
      )
        capture.unavailable = true;
      const page = snapshot(adapter, capture);
      // The SDK still owns a live handle when its receipt says running, even
      // if child close arrives between that receipt and our stream snapshot.
      // Read that exact handle again rather than silently abandoning it.
      if (banner.kind === "running") page.sessionId = args.sessionId;
      capture.terminalObserved =
        !page.collectionUnavailable && page.sessionId === undefined && page.exitCode !== null;
      const result = `Native output receipt: ${crypto.randomUUID()}\n${raw}`;
      retain(adapter, capture, result, page);
      return result;
    };
    session.close = async () => {
      await close();
      adapter.captures.clear();
      adapter.pages.clear();
    };
    (session as ChannelASession).getSynchronousCommandOutput = (result) =>
      adapter.pages.get(result) ?? null;
    adapters.set(session, adapter);
    return adapter;
  }
}

/** Existing exact control helpers are not a new filesystem execution. Keep
 * their ordinary provider route even when cancellation runs inside a scope. */
export function withoutNativeSynchronousCommandCollection<T>(run: () => T): T {
  return terminalProviderPages.exit(() => scopes.exit(run));
}

/** Opt in before the one SDK Start. Worker synchronous runners use the same
 * scope; model/background/interactive commands outside it retain SDK semantics.
 * Unknown active captures stay bound for later exact-handle control reads. */
export async function withNativeSynchronousCommandCollection<T>(
  session: ChannelASession,
  run: () => Promise<T>,
): Promise<T> {
  if (!terminalProviderScope(session)) {
    const terminal: TerminalProviderScope = {
      session,
      pages: new Map<string, ProviderCommandOutput>(),
      parent: terminalProviderPages.getStore(),
      closed: false,
    };
    return await terminalProviderPages.run(terminal, async () => {
      try {
        return await withNativeSynchronousCommandCollection(session, run);
      } finally {
        terminal.closed = true;
        terminal.pages.clear();
      }
    });
  }
  const adapter =
    session instanceof UnixLocalSandboxSession
      ? NativeCollectionAccess.install(session)
      : (adapters.get(session) ??
        (session instanceof E2BSandboxSession ||
        session instanceof BlaxelSandboxSession ||
        session instanceof VercelSandboxSession ||
        session instanceof RunloopSandboxSession ||
        session instanceof DaytonaSandboxSession ||
        session instanceof CloudflareSandboxSession
          ? installRemoteCollection(session)
          : undefined));
  if (!adapter) return await run();
  if (scopes.getStore()?.adapter === adapter) return await run();
  const scope: Scope = { adapter, captures: new Set() };
  return await scopes.run(scope, async () => {
    const result = await run();
    for (const capture of scope.captures) await releaseCapture(adapter, capture);
    return result;
  });
}
