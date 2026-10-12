import {
  externalContinuationCommitAuthorizer,
  hasPermission,
  isVerifiedOrganizationServiceAuthorization,
  type AccessGrantAuthorization,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  readActiveExternalOrganizationKeyAuthority,
  withAccountRls,
  withDatabaseStatementTimeout,
  type Database,
} from "@opengeni/db";
import { ToolGatewayApprovalRequiredError, ToolGatewayBlockedError } from "@opengeni/tool-gateway";
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "./http/api-error";

/**
 * One evaluation's budget. Below the MCP SDK's 5 s setup-request timeout, so a
 * stalled authority read is reported as unavailable authority rather than
 * silently dropping the target connector (a 404).
 */
export const TARGET_FENCE_DEADLINE_MS = 2_500;

/**
 * A part of the live fence. `db` is the evaluation's bounded transaction;
 * `stop` aborts once the evaluation's deadline passes or its request ends. The
 * evaluation checks it before each part; the route part also checks it between
 * its capability, integration and connection reads.
 */
export type TargetFenceCheck = (db: Database, stop: AbortSignal) => Promise<void>;

export type TargetFenceCaller = {
  /** Read inside the evaluation's bounded transaction. */
  scoped?: TargetFenceCheck;
  /** Runs beside it: its own bounded transaction, or the route's fresh grant. */
  standalone?: (stop: AbortSignal) => Promise<void>;
};

type Outcome = "denied" | "approval_required" | "unavailable" | "aborted" | "closed";

export type TargetFenceStats = {
  /** Started evaluations (caller-only plus full). */
  evaluations: number;
  full: number;
  /** Wall time spent inside evaluations, summed (they may overlap). */
  durationMs: number;
  outcomes: Partial<Record<Outcome, number>>;
};

class TargetFenceClosedError extends Error {
  constructor() {
    super("target request scope has ended");
    this.name = "TargetFenceClosedError";
  }
}

class TargetFenceDeadlineError extends Error {
  constructor() {
    super("target authority deadline exceeded");
    this.name = "TargetFenceDeadlineError";
  }
}

/**
 * Authority could not be read in time: a 503 distinct from a provider failure
 * (502, outcome unknown). Never names the target, its connector or its owner.
 */
export function targetAuthorityUnavailable(retryable: boolean): ApiHttpError {
  return new ApiHttpError(503, {
    code: "upstream_unavailable",
    message: "Tool authority could not be verified. Retry the request.",
    retryable,
    outcomeUnknown: false,
    details: { code: "tool_authority_unavailable" },
  });
}

/**
 * Live caller authority for one targeted request. A verified organization key
 * is read without a lock or write (admission already recorded its use); an
 * external continuation keeps its complete commit authorizer; a person keeps
 * the route's fresh grant (`reauthorize`), unchanged. That grant runs outside
 * the evaluation's transaction: the deadline answers the request without
 * cancelling it.
 */
export function targetFenceCaller(
  deps: Pick<ApiRouteDeps, "db">,
  authorization: AccessGrantAuthorization,
  reauthorize: (() => Promise<void>) | undefined,
): TargetFenceCaller {
  const grant = authorization.grant;
  const external = externalContinuationCommitAuthorizer(authorization);
  if (external)
    return {
      standalone: async (stop) =>
        await withDatabaseStatementTimeout(deps.db, TARGET_FENCE_DEADLINE_MS, async (bounded) => {
          stop.throwIfAborted();
          await withAccountRls(bounded, grant.accountId, async (tx) => await external(tx));
          // A stopped evaluation rolls back instead of committing a late decision.
          stop.throwIfAborted();
        }),
    };
  if (isVerifiedOrganizationServiceAuthorization(authorization)) {
    const keyId = grant.subjectId.slice("api_key:".length);
    const permissions = [...grant.permissions];
    return {
      scoped: async (db) => {
        const live = await readActiveExternalOrganizationKeyAuthority(
          db,
          grant.accountId,
          keyId,
          grant.workspaceId,
        );
        if (
          !live ||
          permissions.some(
            (permission) => !hasPermission(live.permissions, permission, live.permissionMode),
          )
        )
          throw new HTTPException(403, { message: "service gateway authority changed" });
      },
    };
  }
  // Never a fence without a live caller.
  if (!reauthorize) throw new Error("a person's targeted request requires the route's fresh grant");
  return { standalone: async () => await reauthorize() };
}

/**
 * The single live fence of one targeted request: exact caller, pinned Site,
 * selected route (connector configuration and connection) and action policy.
 *
 * Every evaluation reads current state; nothing is cached, shared between
 * physical requests, or reused across requests. `full()` runs once for each
 * installed physical-request boundary, after that request's last credential
 * step. Its Site, route, policy and organization-key reads share one
 * transaction bounded by `statement_timeout`; an external actor's authorizer
 * runs in a second bounded transaction and a person's fresh grant beside them.
 * At the deadline the evaluation is answered as unavailable authority and no
 * further part starts. The running part may still finish its current read and
 * issue its remaining ones (a pinned Site's version after its artifact, the
 * next selected connection), each bounded by the statement timeout; the
 * transaction then rolls back.
 * Boundaries swallow hook failures, so the fence records each outcome itself;
 * `settle()` reports a recorded denial or unavailable authority instead of an
 * opaque missing connector. After `close()` (strictly after the awaited
 * cleanup) every evaluation fails, so nothing is authorized once the request
 * scope ends.
 */
export class TargetAuthorityFence {
  #site: TargetFenceCheck | undefined;
  #route: TargetFenceCheck | undefined;
  #policy: TargetFenceCheck | undefined;
  #closed = false;
  #denied: { error: unknown } | undefined;
  #approval: { error: unknown } | undefined;
  #unavailable = false;
  readonly #pending = new Set<Promise<void>>();
  readonly stats: TargetFenceStats = { evaluations: 0, full: 0, durationMs: 0, outcomes: {} };

  constructor(
    private readonly input: {
      db: Database;
      /** A targeted request must install its route before any full evaluation. */
      targeted: boolean;
      caller: TargetFenceCaller;
      signal?: AbortSignal | undefined;
      deadlineMs?: number;
    },
  ) {}

  get #deadlineMs() {
    return this.input.deadlineMs ?? TARGET_FENCE_DEADLINE_MS;
  }

  /** Each part is installed once; a later install never replaces it. */
  setSite(check: TargetFenceCheck): void {
    if (this.#site) throw new Error("target Site fence is already installed");
    this.#site = check;
  }

  /** Installed by preparation before any provider is constructed. */
  setRoute(check: TargetFenceCheck): void {
    if (this.#route) throw new Error("target route fence is already installed");
    this.#route = check;
  }

  /** Installed when the selected call's action policy is decided. */
  setPolicy(check: TargetFenceCheck): void {
    if (this.#policy) throw new Error("target action policy fence is already installed");
    this.#policy = check;
  }

  /** Live caller only: before credential acquisition may refresh or record use. */
  async caller(): Promise<void> {
    await this.#evaluate(false);
  }

  /** Admission: the live caller, with unavailable authority as a retryable 503. */
  async admit(): Promise<void> {
    try {
      await this.caller();
    } catch (error) {
      throw this.#public(error, true);
    }
  }

  /** Caller, Site, route and policy: once per physical provider request. */
  async full(): Promise<void> {
    await this.#evaluate(true);
  }

  /** Credential hooks report a boolean; their failure is recorded, not lost. */
  async allows(): Promise<boolean> {
    try {
      await this.full();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * An explicit fence before an application step. Denials keep their error;
   * unavailable authority becomes a 503 (retryable only before begin).
   */
  async check(options: { retryable: boolean }): Promise<void> {
    try {
      await this.full();
    } catch (error) {
      throw this.#public(error, options.retryable);
    }
  }

  /** Transport boundary of a credential-fenced connector: no database read. */
  assertOpen(): void {
    if (this.#closed) throw new TargetFenceClosedError();
    this.input.signal?.throwIfAborted();
  }

  close(): void {
    this.#closed = true;
  }

  /**
   * Classify a failed preparation or a missing target. Waits (bounded) for
   * evaluations already started, then prefers a recorded denial, then an
   * approval change, then unavailable authority; otherwise `error` stands.
   * In-flight, aborted and post-close evaluations never decide by themselves.
   */
  async settle(
    error: unknown,
    options: { retryable: boolean } = { retryable: true },
  ): Promise<never> {
    throw (await this.failure(options)) ?? error;
  }

  async failure(options: { retryable: boolean } = { retryable: true }): Promise<unknown> {
    if (this.input.signal?.aborted) return undefined;
    if (this.#pending.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...this.#pending]),
        new Promise((resolve) => (timer = setTimeout(resolve, this.#deadlineMs))),
      ]);
      clearTimeout(timer);
    }
    if (this.input.signal?.aborted) return undefined;
    if (this.#denied) return this.#denied.error;
    if (this.#approval) return this.#approval.error;
    if (this.#unavailable) return targetAuthorityUnavailable(options.retryable);
    return undefined;
  }

  #public(error: unknown, retryable: boolean): unknown {
    const outcome = this.#outcome(error);
    return outcome === "unavailable" ? targetAuthorityUnavailable(retryable) : error;
  }

  #outcome(error: unknown): Outcome {
    if (error instanceof TargetFenceClosedError) return "closed";
    if (this.input.signal?.aborted) return "aborted";
    if (error instanceof ToolGatewayApprovalRequiredError) return "approval_required";
    if (error instanceof ToolGatewayBlockedError) return "denied";
    if (error instanceof HTTPException) {
      if (error.status >= 500 || error.status === 408 || error.status === 429) return "unavailable";
      // A conflict is a changed decision, never unavailable authority.
      return error.status === 409 ? "approval_required" : "denied";
    }
    // Database, pool and deadline failures: authority could not be read.
    return "unavailable";
  }

  #evaluate(full: boolean): Promise<void> {
    const started = performance.now();
    this.stats.evaluations++;
    if (full) this.stats.full++;
    const run = this.#run(full);
    // Registered before the caller can observe the rejection, so `settle()`
    // always sees this outcome.
    const recorded = run.then(
      () => undefined,
      (error: unknown) => this.#record(error),
    );
    const tracked = recorded.finally(() => {
      this.stats.durationMs += performance.now() - started;
      this.#pending.delete(tracked);
    });
    this.#pending.add(tracked);
    return run;
  }

  #record(error: unknown) {
    const outcome = this.#outcome(error);
    this.stats.outcomes[outcome] = (this.stats.outcomes[outcome] ?? 0) + 1;
    if (outcome === "denied") this.#denied ??= { error };
    else if (outcome === "approval_required") this.#approval ??= { error };
    else if (outcome === "unavailable") this.#unavailable = true;
  }

  async #run(full: boolean): Promise<void> {
    this.assertOpen();
    if (full && this.input.targeted && !this.#route)
      throw new HTTPException(403, { message: "tool_access_changed" });
    // The deadline (or the request's end) answers at once and stops the work:
    // no later part starts, and its transaction rolls back.
    const expiry = new AbortController();
    const timer = setTimeout(() => expiry.abort(new TargetFenceDeadlineError()), this.#deadlineMs);
    const stop = this.input.signal
      ? AbortSignal.any([expiry.signal, this.input.signal])
      : expiry.signal;
    const stopped = new Promise<never>((_, reject) => {
      if (stop.aborted) reject(stop.reason);
      else stop.addEventListener("abort", () => reject(stop.reason), { once: true });
    });
    stopped.catch(() => undefined);
    const work = this.#parts(full, stop);
    work.catch(() => undefined);
    try {
      await Promise.race([work, stopped]);
    } finally {
      clearTimeout(timer);
    }
    this.assertOpen();
  }

  async #parts(full: boolean, stop: AbortSignal): Promise<void> {
    // Site, route and policy first; a service caller reads its key last, so the
    // caller fact is the freshest at dispatch.
    const scoped = [
      ...(full ? [this.#site, this.#route, this.#policy] : []),
      this.input.caller.scoped,
    ].filter((check): check is TargetFenceCheck => check !== undefined);
    const results = await Promise.allSettled([
      scoped.length > 0
        ? withDatabaseStatementTimeout(this.input.db, this.#deadlineMs, async (bounded) => {
            // Also when the transaction starts: it may have waited for a
            // pooled connection past the deadline.
            stop.throwIfAborted();
            for (const check of scoped) {
              await check(bounded, stop);
              stop.throwIfAborted();
            }
          })
        : undefined,
      this.input.caller.standalone?.(stop),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length === 0) return;
    // A denial outranks unavailable authority from the concurrent part.
    throw (
      failures.find((error) => this.#outcome(error) === "denied") ??
      failures.find((error) => this.#outcome(error) === "approval_required") ??
      failures[0]
    );
  }
}
