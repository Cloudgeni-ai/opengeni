// `RoutingSandboxSession` — the per-session hot-swap routing proxy (M7).
//
// THE load-bearing SDK finding (dossier §10.3 / §20-M7): when a box is injected
// NON-OWNED into a turn (`ownedSandbox.session`), the agent SDK's sandbox
// capabilities bind to that ONE session OBJECT ONCE and call ITS methods
// (`exec`/`execCommand`/`readFile`/`listDir`/`resolveExposedPort`/…) per tool
// call WITHOUT re-resolving the session. So to make the active sandbox flippable
// mid-turn we cannot swap the object the SDK holds — we must give the SDK ONE
// STABLE session-shaped object that, on EACH method call, re-reads the
// per-session active pointer `(active_sandbox_id, active_epoch)` and DISPATCHES
// to the CURRENTLY-active backend session (Modal or selfhosted).
//
// The contract (dossier §10.3):
//   - ONE stable object implementing the `SandboxSessionLike` structural surface.
//   - On EVERY op, re-read `(activeSandboxId, activeEpoch)` via `readPointer`.
//   - Cache the resolved backend session keyed by `activeEpoch`; when the epoch
//     changes mid-turn (a swap bumped it), re-resolve so the NEXT op hits the new
//     backend. Single active at a time (NOT parallel multi-attach).
//   - An in-flight op fenced by a STALE `active_epoch` (the backend rejects with a
//     fence error, OR the pointer moved under us between read and dispatch)
//     RETRIES against the new active sandbox — reusing the existing fenced-retry
//     role. Bounded retries so a pathological swap-storm can't loop forever.
//
// This module is agent-loop-free (it lives in the sandbox leaf). It depends ONLY
// on injected closures (`readPointer` + `resolveActiveBackend`), so the API
// (`withChannelA`) and the worker (`resumeBoxForTurn`/the turn) wire it to the
// real `readActiveSandbox` DAO + a backend resolver without coupling the leaf to
// `@opengeni/db`.

import type { ExposedPortEndpoint } from "../stream-port";

/** The per-session active-sandbox pointer the proxy re-reads on every op. Mirror
 *  of `@opengeni/db`'s `ActiveSandboxPointer` (structural, so the leaf does not
 *  import the DB package). `activeSandboxId === null` == "use the session's own
 *  group sandbox" (the default/backward-compat target). */
export interface ActivePointer {
  activeSandboxId: string | null;
  activeEpoch: number;
}

/**
 * The structural slice of a backend session the routing proxy forwards to. It is
 * a superset-by-optionality of every backend's surface (Modal's `SandboxSession`
 * AND the `SelfhostedSession`): each method is optional because a heterogeneous
 * target may or may not implement it, and the proxy reflects that at call-time.
 */
export interface RoutableBackendSession {
  state?: unknown;
  exec?(args: unknown): Promise<unknown>;
  execCommand?(args: unknown): Promise<string>;
  writeStdin?(args: unknown): Promise<string>;
  readFile?(args: unknown): Promise<string | Uint8Array>;
  writeFile?(args: unknown): Promise<unknown>;
  createEditor?(runAs?: string): unknown;
  listDir?(args: unknown): Promise<unknown>;
  pathExists?(path: string, runAs?: string): Promise<boolean>;
  viewImage?(args: unknown): Promise<unknown>;
  materializeEntry?(args: unknown): Promise<void>;
  supportsPty?(): boolean;
  resolveExposedPort?(port: number): Promise<ExposedPortEndpoint>;
  serializeSessionState?(): Promise<unknown>;
}

/** The resolved active backend for an epoch: the live session + the sandbox id it
 *  belongs to (`null` == the group sandbox) so a fence-retry can detect a move. */
export interface ResolvedActiveBackend {
  session: RoutableBackendSession;
  /** The sandbox id this backend serves (`null` == the session's group sandbox). */
  sandboxId: string | null;
  /** A label for diagnostics ("modal" | "selfhosted" | the sandbox name). */
  kind: string;
}

export interface RoutingSandboxSessionDeps {
  /** Re-read the per-session active pointer. Called on EVERY op (the per-call
   *  re-resolve that makes a mid-turn swap visible to the next tool call). */
  readPointer(): Promise<ActivePointer>;
  /**
   * Resolve the active backend session for a pointer. The proxy memoizes the
   * result by `activeEpoch`, so this is called at most once per epoch (per op the
   * pointer is re-read, but the heavy resolve only re-runs when the epoch moved).
   * For `pointer.activeSandboxId === null` this returns the default/group backend
   * (typically the already-established turn box); for a non-null target it builds
   * the target backend (a sibling Modal box or a selfhosted machine session).
   */
  resolveActiveBackend(pointer: ActivePointer): Promise<ResolvedActiveBackend>;
  /** Max fence/stale retries within a single op before surfacing the error.
   *  Defaults to 3 — enough to absorb a couple of concurrent swaps, bounded so a
   *  swap-storm cannot loop forever. */
  maxFenceRetries?: number;
  /** Optional structured-log sink for swap/fence transitions (diagnostics). */
  onTransition?: (event: RoutingTransitionEvent) => void;
}

export interface RoutingTransitionEvent {
  type: "resolved" | "fenced-retry" | "epoch-changed";
  fromEpoch: number;
  toEpoch: number;
  sandboxId: string | null;
  kind: string;
}

/** Thrown when the active backend does not implement the requested op (a
 *  heterogeneous target whose surface lacks the method the caller reached for). */
export class RoutingUnsupportedError extends Error {
  readonly name = "RoutingUnsupportedError";
  constructor(op: string, kind: string) {
    super(`the active sandbox (${kind}) does not support "${op}"`);
  }
}

/** Recognize a stale-epoch FENCE error from a backend op so the proxy retries
 *  against the re-resolved active sandbox (the existing fenced-retry role). A
 *  selfhosted `SelfhostedControlError` carries `.fenced`; a generic fence is
 *  matched on the message as a fallback. */
function isFenceError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if ((error as { fenced?: unknown }).fenced === true) {
    return true;
  }
  const name = typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : "";
  const message = error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? "");
  const haystack = `${name} ${message}`.toLowerCase();
  return haystack.includes("fenced") || haystack.includes("epoch") && haystack.includes("super");
}

/**
 * ONE stable session-shaped object the SDK binds to. Every method re-reads the
 * pointer, resolves the active backend (cached by epoch), and dispatches. A
 * stale-epoch fence (the pointer moved mid-op) re-resolves and retries.
 *
 * The proxy implements ALL of the consumed surface so the SDK (which binds method
 * presence ONCE) always sees `exec`/`readFile`/`resolveExposedPort`/… present. If
 * the CURRENTLY-active backend lacks a method, the proxy applies the natural
 * fallback (`exec`→`execCommand`) or throws `RoutingUnsupportedError` — degrade is
 * a value, not a crash.
 *
 * `state` is a STABLE getter so a consumer reading `session.state` (channel-a's
 * `readInstanceId`, the docker-network decoration) gets a coherent snapshot of the
 * currently-active backend without a method call.
 */
export class RoutingSandboxSession implements RoutableBackendSession {
  private readonly deps: RoutingSandboxSessionDeps;
  private readonly maxFenceRetries: number;
  // The per-epoch resolved-backend cache. Keyed by activeEpoch: a swap bumps the
  // epoch, invalidating the cache so the NEXT op re-resolves the new backend.
  private cachedEpoch: number | undefined;
  private cached: ResolvedActiveBackend | undefined;
  // The last-resolved backend, exposed via the `state` getter (a method-free read
  // of the active backend's `state`). Updated on every resolve.
  private lastResolved: ResolvedActiveBackend | undefined;

  constructor(deps: RoutingSandboxSessionDeps) {
    this.deps = deps;
    this.maxFenceRetries = deps.maxFenceRetries ?? 3;
  }

  /** A method-free read of the active backend's `state` (best-effort: the last
   *  resolved backend; an op forces a fresh resolve). Consumers that read
   *  `session.state` (instanceId/decoration) get the active backend's state. */
  get state(): unknown {
    return this.lastResolved?.session.state ?? {};
  }

  /**
   * Re-read the pointer and resolve the active backend, using the per-epoch cache.
   * The cache is keyed by `activeEpoch`: if the epoch is unchanged we return the
   * cached backend; if it moved (a swap) we re-resolve and update the cache. This
   * is THE per-call re-read that makes a mid-turn swap land on the next op.
   */
  private async resolve(): Promise<ResolvedActiveBackend> {
    const pointer = await this.deps.readPointer();
    if (this.cachedEpoch === pointer.activeEpoch && this.cached) {
      return this.cached;
    }
    const fromEpoch = this.cachedEpoch ?? pointer.activeEpoch;
    const resolved = await this.deps.resolveActiveBackend(pointer);
    this.cachedEpoch = pointer.activeEpoch;
    this.cached = resolved;
    this.lastResolved = resolved;
    this.deps.onTransition?.({
      type: this.cachedEpoch !== undefined && fromEpoch !== pointer.activeEpoch ? "epoch-changed" : "resolved",
      fromEpoch,
      toEpoch: pointer.activeEpoch,
      sandboxId: resolved.sandboxId,
      kind: resolved.kind,
    });
    return resolved;
  }

  /**
   * Dispatch an op to the currently-active backend, retrying on a stale-epoch
   * fence. The sequence per attempt:
   *   1. re-read the pointer + resolve the active backend (cached by epoch),
   *   2. run `fn(activeSession)`,
   *   3. on a FENCE error (the pointer moved under us / the backend rejected a
   *      stale epoch), INVALIDATE the cache and retry against the re-resolved
   *      active sandbox — up to `maxFenceRetries`.
   * A non-fence error propagates immediately (it is a real op failure, not a swap
   * race).
   */
  private async dispatch<T>(op: string, fn: (session: RoutableBackendSession) => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastError: unknown;
    while (attempt <= this.maxFenceRetries) {
      const backend = await this.resolve();
      try {
        return await fn(backend.session);
      } catch (error) {
        if (!isFenceError(error)) {
          throw error;
        }
        // Stale-epoch fence: the active pointer moved mid-op. Drop the cache so
        // the next resolve re-reads the NEW pointer and the op lands on the new
        // active sandbox (the fenced-retry role). Bounded by maxFenceRetries.
        lastError = error;
        this.cachedEpoch = undefined;
        this.cached = undefined;
        this.deps.onTransition?.({
          type: "fenced-retry",
          fromEpoch: backend.sandboxId === null ? 0 : 0,
          toEpoch: 0,
          sandboxId: backend.sandboxId,
          kind: backend.kind,
        });
        attempt += 1;
      }
    }
    // Exhausted retries against a relentless swap-storm: surface the fence so the
    // caller (turn) backs off — never loop forever.
    throw lastError ?? new Error(`routing op "${op}" exhausted fence retries`);
  }

  // ── The forwarded structural surface ──────────────────────────────────────
  // Every method is PRESENT on the proxy (the SDK binds presence once) and
  // dispatches to the active backend at call-time. A missing backend method
  // degrades via the natural fallback or RoutingUnsupportedError.

  async exec(args: unknown): Promise<unknown> {
    return this.dispatch("exec", async (s) => {
      if (s.exec) {
        return s.exec(args);
      }
      // Some backends (selfhosted) only expose exec; others only execCommand.
      if (s.execCommand) {
        return s.execCommand(args);
      }
      throw new RoutingUnsupportedError("exec", this.cached?.kind ?? "unknown");
    });
  }

  async execCommand(args: unknown): Promise<string> {
    return this.dispatch("execCommand", async (s) => {
      if (s.execCommand) {
        return s.execCommand(args);
      }
      if (s.exec) {
        const r = (await s.exec(args)) as { stdout?: string; output?: string };
        return r.stdout ?? r.output ?? "";
      }
      throw new RoutingUnsupportedError("execCommand", this.cached?.kind ?? "unknown");
    });
  }

  async writeStdin(args: unknown): Promise<string> {
    return this.dispatch("writeStdin", async (s) => {
      if (!s.writeStdin) {
        throw new RoutingUnsupportedError("writeStdin", this.cached?.kind ?? "unknown");
      }
      return s.writeStdin(args);
    });
  }

  async readFile(args: unknown): Promise<string | Uint8Array> {
    return this.dispatch("readFile", async (s) => {
      if (!s.readFile) {
        throw new RoutingUnsupportedError("readFile", this.cached?.kind ?? "unknown");
      }
      return s.readFile(args);
    });
  }

  async writeFile(args: unknown): Promise<unknown> {
    return this.dispatch("writeFile", async (s) => {
      if (!s.writeFile) {
        throw new RoutingUnsupportedError("writeFile", this.cached?.kind ?? "unknown");
      }
      return s.writeFile(args);
    });
  }

  async listDir(args: unknown): Promise<unknown> {
    return this.dispatch("listDir", async (s) => {
      if (!s.listDir) {
        throw new RoutingUnsupportedError("listDir", this.cached?.kind ?? "unknown");
      }
      return s.listDir(args);
    });
  }

  async pathExists(path: string, runAs?: string): Promise<boolean> {
    return this.dispatch("pathExists", async (s) => {
      if (!s.pathExists) {
        throw new RoutingUnsupportedError("pathExists", this.cached?.kind ?? "unknown");
      }
      return s.pathExists(path, runAs);
    });
  }

  async viewImage(args: unknown): Promise<unknown> {
    return this.dispatch("viewImage", async (s) => {
      if (!s.viewImage) {
        throw new RoutingUnsupportedError("viewImage", this.cached?.kind ?? "unknown");
      }
      return s.viewImage(args);
    });
  }

  async materializeEntry(args: unknown): Promise<void> {
    return this.dispatch("materializeEntry", async (s) => {
      if (!s.materializeEntry) {
        throw new RoutingUnsupportedError("materializeEntry", this.cached?.kind ?? "unknown");
      }
      return s.materializeEntry(args);
    });
  }

  /** PTY support reflects the LAST-resolved backend (a synchronous probe; the SDK
   *  reads it to decide if the terminal is interactive). It cannot re-read the
   *  pointer (synchronous), so it answers from the last resolve — coherent with
   *  the resolve the surrounding op already performed. Defaults false before the
   *  first resolve. */
  supportsPty(): boolean {
    const s = this.lastResolved?.session;
    return Boolean(s?.supportsPty?.());
  }

  /** createEditor is a synchronous factory in the SDK surface; it binds to the
   *  last-resolved backend's editor. Returns undefined when the active backend has
   *  no editor (channel-a falls back to its exec-based write path). */
  createEditor(runAs?: string): unknown {
    return this.lastResolved?.session.createEditor?.(runAs);
  }

  async resolveExposedPort(port: number): Promise<ExposedPortEndpoint> {
    return this.dispatch("resolveExposedPort", async (s) => {
      if (!s.resolveExposedPort) {
        throw new RoutingUnsupportedError("resolveExposedPort", this.cached?.kind ?? "unknown");
      }
      return s.resolveExposedPort(port);
    });
  }

  /** Serialize the active backend's session state. Used by the resume-by-id seam
   *  to fold the live box onto the lease. Dispatches to the active backend. */
  async serializeSessionState(): Promise<unknown> {
    return this.dispatch("serializeSessionState", async (s) => {
      if (!s.serializeSessionState) {
        // No-op for a backend with no serializable state (selfhosted state is
        // re-addressed, not snapshotted) — surface undefined, not an error.
        return undefined;
      }
      return s.serializeSessionState();
    });
  }

  /** Force a resolve (priming the proxy before the first op so `state`/`supportsPty`
   *  read a real backend). Optional — every op resolves lazily anyway. */
  async prime(): Promise<ResolvedActiveBackend> {
    return this.resolve();
  }
}
