// `MockAgentResponder` — an in-process `ControlRpc` test double standing in for
// a real enrolled agent over NATS (the live NATS transport is M4). It answers
// the op table (ping / exec / fs.read / fs.write / fs.list / fs.stat / git /
// metrics / desktopEnsure) against an in-memory virtual filesystem + a pluggable
// exec handler, so the `SelfhostedSession` surface and the mocked-NATS
// integration tests run with zero broker.
//
// It is shipped from the runtime package (a testing util, not test-only-private)
// because the API/worker integration suites (M4+) reuse it to drive
// `withChannelA`/viewer/swap end-to-end without a real machine (dossier §16).

import {
  AgentError,
  ControlRequest,
  ControlResponse,
  ErrorCode,
  FsEntryKind,
  type ExecRequest,
  type ExecResponse,
  type FsListResponse,
  type FsReadResponse,
  type FsStatResponse,
  type FsWriteResponse,
} from "@opengeni/agent-proto";
import type { ControlRpc } from "./control-rpc";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A pluggable exec handler — given an ExecRequest, return an ExecResponse (or
 *  throw to surface a synthesized error). Defaults to a trivial echo. */
export type MockExecHandler = (req: ExecRequest) => ExecResponse | Promise<ExecResponse>;

export interface MockAgentResponderOptions {
  /** Whether a responder exists at all. When false EVERY request yields an
   *  AGENT_OFFLINE error (the "machine is offline" condition) — used to drive the
   *  agent_offline capability + the isProviderSandboxNotFoundError test. */
  online?: boolean;
  /** Whether the agent has acknowledged whole-machine / screen-control consent.
   *  When false, an op gated on consent yields CONSENT_REQUIRED. Defaults true. */
  consented?: boolean;
  /** Force the agent into a draining posture (every op → DRAINING). */
  draining?: boolean;
  /** Seed files (path → string|Uint8Array) into the virtual filesystem. */
  files?: Record<string, string | Uint8Array>;
  /** A custom exec handler; defaults to an echo of argv. */
  exec?: MockExecHandler;
  /** The hostname the mock reports (so PTY/exec `$HOSTNAME`-style asserts work). */
  hostname?: string;
}

/**
 * An in-process `ControlRpc` answering the agent op table against an in-memory
 * virtual filesystem. Drive a `SelfhostedSession` with this to test exec /
 * readFile / writeFile / list / stat round-trips without any NATS.
 */
export class MockAgentResponder implements ControlRpc {
  private online: boolean;
  private readonly consented: boolean;
  private readonly draining: boolean;
  private readonly files = new Map<string, Uint8Array>();
  private readonly execHandler: MockExecHandler;
  readonly hostname: string;

  /** Every request seen, for assertion (subject + decoded ControlRequest). */
  readonly requests: Array<{ subject: string; req: ControlRequest }> = [];

  constructor(opts: MockAgentResponderOptions = {}) {
    this.online = opts.online ?? true;
    this.consented = opts.consented ?? true;
    this.draining = opts.draining ?? false;
    this.hostname = opts.hostname ?? "mock-machine";
    this.execHandler = opts.exec ?? ((req) => defaultEcho(req, this.hostname));
    for (const [path, content] of Object.entries(opts.files ?? {})) {
      this.files.set(
        normalize(path),
        typeof content === "string" ? encoder.encode(content) : content,
      );
    }
  }

  /** Flip the responder offline mid-test (a deliberate stop / blip). */
  setOnline(online: boolean): void {
    this.online = online;
  }

  /** Read a file the session wrote (test assertion helper). */
  fileText(path: string): string | undefined {
    const bytes = this.files.get(normalize(path));
    return bytes ? decoder.decode(bytes) : undefined;
  }

  async request(
    subject: string,
    req: ControlRequest,
    _opts: { timeoutMs: number },
  ): Promise<ControlResponse> {
    this.requests.push({ subject, req });
    if (!this.online) {
      return errorResponse(
        req.requestId,
        ErrorCode.ERROR_CODE_AGENT_OFFLINE,
        "the enrolled agent is offline",
        false,
      );
    }
    if (this.draining) {
      return errorResponse(
        req.requestId,
        ErrorCode.ERROR_CODE_DRAINING,
        "the agent is draining",
        true,
      );
    }
    const op = req.op;
    if (!op) {
      return errorResponse(req.requestId, ErrorCode.ERROR_CODE_PROTOCOL, "empty op", false);
    }
    switch (op.$case) {
      case "ping":
        return ok(req.requestId, {
          $case: "ping",
          ping: { nonce: op.ping.nonce, agentMonotonicMs: "0" },
        });
      case "exec": {
        const res = await this.execHandler(op.exec);
        return ok(req.requestId, { $case: "exec", exec: res });
      }
      case "fsRead": {
        const bytes = this.files.get(normalize(op.fsRead.path));
        if (!bytes) {
          return errorResponse(
            req.requestId,
            ErrorCode.ERROR_CODE_NOT_FOUND,
            `no such file: ${op.fsRead.path}`,
            false,
          );
        }
        const res: FsReadResponse = { content: bytes, totalSize: String(bytes.length) };
        return ok(req.requestId, { $case: "fsRead", fsRead: res });
      }
      case "fsWrite": {
        const path = normalize(op.fsWrite.path);
        const next = op.fsWrite.append
          ? concat(this.files.get(path) ?? new Uint8Array(0), op.fsWrite.content)
          : op.fsWrite.content;
        this.files.set(path, next);
        const res: FsWriteResponse = { bytesWritten: String(op.fsWrite.content.length) };
        return ok(req.requestId, { $case: "fsWrite", fsWrite: res });
      }
      case "fsList": {
        const prefix = normalize(op.fsList.path).replace(/\/?$/, "/");
        const res: FsListResponse = {
          entries: [...this.files.keys()]
            .filter((p) => p.startsWith(prefix))
            .map((p) => {
              const bytes = this.files.get(p)!;
              const rel = p.slice(prefix.length);
              return {
                name: rel.split("/").pop() ?? rel,
                path: rel,
                kind: FsEntryKind.FS_ENTRY_KIND_FILE,
                size: String(bytes.length),
                modifiedMs: "0",
                mode: 0o644,
              };
            }),
        };
        return ok(req.requestId, { $case: "fsList", fsList: res });
      }
      case "fsStat": {
        const bytes = this.files.get(normalize(op.fsStat.path));
        const res: FsStatResponse = bytes
          ? {
              exists: true,
              entry: {
                name: normalize(op.fsStat.path).split("/").pop() ?? "",
                path: op.fsStat.path,
                kind: FsEntryKind.FS_ENTRY_KIND_FILE,
                size: String(bytes.length),
                modifiedMs: "0",
                mode: 0o644,
              },
            }
          : { exists: false, entry: undefined };
        return ok(req.requestId, { $case: "fsStat", fsStat: res });
      }
      case "desktopEnsure": {
        // The desktop STREAM (view) is DISPLAY-gated, not consent-gated: the real
        // agent registers the channel + captures frames regardless of screen-control
        // consent (`register_desktop` in hub.rs sets `allow_input` from consent and
        // the pump captures anyway) — only INPUT injection is gated. This stub has a
        // (mock) display and does not model input injection, so desktopEnsure always
        // succeeds; `consented` only affects the computer-use INPUT plane.
        return ok(req.requestId, {
          $case: "desktopEnsure",
          desktopEnsure: {
            channel: {
              channelId: "mock-desktop",
              workspaceId: "",
              agentId: "",
              kind: 1,
              port: 6080,
            },
            display: { id: ":99", width: 1024, height: 768, virtual: true },
          },
        });
      }
      case "ptyOpen": {
        // The PTY plane is display-INDEPENDENT and has NO consent gate (unlike
        // desktopEnsure) — a terminal works on a headless machine. Returns a PTY
        // StreamChannel on the 7681 port.
        return ok(req.requestId, {
          $case: "ptyOpen",
          ptyOpen: {
            ptyId: "mock-pty",
            channel: { channelId: "mock-pty", workspaceId: "", agentId: "", kind: 1, port: 7681 },
          },
        });
      }
      default:
        return errorResponse(
          req.requestId,
          ErrorCode.ERROR_CODE_UNSUPPORTED,
          `mock does not implement ${op.$case}`,
          false,
        );
    }
  }
}

function defaultEcho(req: ExecRequest, hostname: string): ExecResponse {
  // A trivial deterministic exec: echo the joined argv; if argv mentions
  // HOSTNAME, emit the mock hostname so terminal-style asserts work.
  const joined = req.command.join(" ");
  const stdout = /hostname|HOSTNAME/.test(joined) ? hostname : joined;
  return {
    exitCode: 0,
    stdout: encoder.encode(`${stdout}\n`),
    stderr: new Uint8Array(0),
    timedOut: false,
    durationMs: "1",
  };
}

function ok(requestId: string, result: NonNullable<ControlResponse["result"]>): ControlResponse {
  return { requestId, error: undefined, result };
}

function errorResponse(
  requestId: string,
  code: ErrorCode,
  message: string,
  retryable: boolean,
): ControlResponse {
  const error: AgentError = { code, message, retryable, detail: {} };
  return { requestId, error, result: undefined };
}

function normalize(path: string): string {
  // Collapse to a leading-slash absolute form for stable keys.
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
