import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { UnixLocalSandboxSession } from "@openai/agents/sandbox/local";
import type { ChannelASession } from "./channel-a";
import { parseExecResponseBanner } from "./exec-banner";
import type { SynchronousCommandPage } from "./synchronous-command";

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
  sessionId?: number;
  child?: ChildProcessWithoutNullStreams;
  receipts: Set<unknown>;
};
type Adapter = {
  session: UnixLocalSandboxSession;
  captures: Map<number, Capture>;
  pages: Map<unknown, SynchronousCommandPage>;
  translate: (output: string) => string;
};
type Scope = { adapter: Adapter; captures: Set<Capture> };
const adapters = new WeakMap<UnixLocalSandboxSession, Adapter>();
const scopes = new AsyncLocalStorage<Scope>();
const launches = new AsyncLocalStorage<Capture>();
const formattedStarts = new AsyncLocalStorage<{
  page?: SynchronousCommandPage;
  capture?: Capture;
}>();

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
      session,
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
      const capture: Capture = {
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

/** Opt in before the one SDK Start. Worker synchronous runners use the same
 * scope; model/background/interactive commands outside it retain SDK semantics.
 * Unknown active captures stay bound for later exact-handle control reads. */
export async function withNativeSynchronousCommandCollection<T>(
  session: ChannelASession,
  run: () => Promise<T>,
): Promise<T> {
  if (!(session instanceof UnixLocalSandboxSession)) return await run();
  const adapter = NativeCollectionAccess.install(session);
  if (scopes.getStore()?.adapter === adapter) return await run();
  const scope: Scope = { adapter, captures: new Set() };
  return await scopes.run(scope, async () => {
    const result = await run();
    for (const capture of scope.captures) {
      if (!capture.terminalObserved || capture.unavailable) continue;
      if (capture.sessionId !== undefined) adapter.captures.delete(capture.sessionId);
      for (const receipt of capture.receipts) adapter.pages.delete(receipt);
      capture.receipts.clear();
    }
    return result;
  });
}
