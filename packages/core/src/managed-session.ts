import type { Context } from "hono";
import type { ManagedAuth } from "./managed-auth-type";
import type { Database } from "@opengeni/db";
import {
  acquireManagedAuthActorMutationLease,
  getManagedAuthAdoptedSessionSnapshot,
  getManagedAuthSessionSetSnapshot,
  ManagedAuthSessionSetAuthorityError,
  ManagedAuthSessionSetGenerationConflictError,
  releaseManagedAuthActorMutationLease,
  validateManagedAuthActorMutationLease,
} from "@opengeni/db/managed-auth-session-sets";
import { validateCanonicalHumanSession } from "@opengeni/db/canonical-human-identities";
import type { ManagedAuthSessionSetMode } from "@opengeni/contracts/managed-auth-session-sets";
import { HTTPException } from "hono/http-exception";
import {
  MANAGED_AUTH_ACTOR_EPOCH_HEADER,
  MANAGED_AUTH_SESSION_SET_COOKIE,
  ManagedAuthActorChangeError,
  managedAuthSha256,
  resolveManagedAuthSelectedSession,
  type ManagedAuthSessionAdapter,
} from "./managed-auth-session-sets";

const ACTOR_MUTATION_LEASE_SECONDS = 15 * 60;
const ACTOR_MUTATION_LEASE_REFRESH_MS = 5 * 60 * 1_000;
const ACTOR_MUTATION_HANDLER_DEADLINE_MS = 10 * 60 * 1_000;
const ACTOR_MUTATION_FATAL_SAFETY_MS = 5_000;
type ActorMutationLeaseRuntime = {
  monotonicNow: () => number;
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
  terminate: () => void;
};
const productionActorMutationLeaseRuntime: ActorMutationLeaseRuntime = {
  monotonicNow: () => performance.now(),
  schedule: (callback, delayMs) => unrefTimer(setTimeout(callback, delayMs)),
  cancel: (timer) => clearTimeout(timer),
  terminate: () => {
    process.stderr.write("fatal: managed actor mutation outlived its durable lease\n");
    process.exit(1);
  },
};
let actorMutationLeaseRuntime = productionActorMutationLeaseRuntime;
type ActorMutationLease = {
  db: Database;
  authorityHash: string;
  actorEpoch: string;
  requestId: string;
  refreshTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  fatalTimer: ReturnType<typeof setTimeout> | null;
  expiresAt: Date;
  localFatalDeadlineMonotonicMs: number;
  runtime: ActorMutationLeaseRuntime;
  abortController: AbortController;
  poisoned: unknown | null;
  actorTransitionApplied: boolean;
};
const actorMutationLeaseByRequest = new WeakMap<Request, ActorMutationLease>();
const managedActorEpochByRequest = new WeakMap<Request, string>();
const managedActorAdmissionByRequest = new WeakMap<Request, ManagedAuthActorAdmissionStamp>();

/**
 * Read a Better Auth session without bypassing its sliding-cookie renewal.
 *
 * Better Auth can refresh the durable session while resolving `getSession`.
 * Programmatic callers must explicitly request and forward the returned cookie
 * headers; the HTTP handler does this automatically, but direct API calls do not.
 */
export async function getManagedSession(
  c: Context,
  auth: ManagedAuth,
  options?: {
    db?: Database | undefined;
    allowIdentityRecovery?: boolean | undefined;
    sessionSetMode?: ManagedAuthSessionSetMode | undefined;
    sessionAdapter?: ManagedAuthSessionAdapter | null | undefined;
  },
) {
  const sessionSetMode = options?.sessionSetMode ?? "legacy";
  if (sessionSetMode !== "legacy" && options?.db && options.sessionAdapter) {
    const authority = requestCookie(c.req.raw, MANAGED_AUTH_SESSION_SET_COOKIE);
    if (authority) {
      try {
        // A long-lived response reuses this exact Request for periodic
        // authorization. Once admitted, the server-owned stamp is the actor
        // fence: a client may omit the header on its initial GET, but a later
        // reauthorization must not follow a newly selected actor.
        const admittedActorEpoch = managedActorEpochByRequest.get(c.req.raw) ?? null;
        const expectedActorEpoch =
          admittedActorEpoch ?? c.req.header(MANAGED_AUTH_ACTOR_EPOCH_HEADER) ?? null;
        const legacyAmbient =
          sessionSetMode === "dual" && expectedActorEpoch === null
            ? await options.sessionAdapter.resolveAmbientSession(c.req.raw.headers)
            : null;
        const selected = await resolveManagedAuthSelectedSession({
          db: options.db,
          adapter: options.sessionAdapter,
          authority,
          mode: sessionSetMode,
          expectedActorEpoch,
          legacyAmbientSessionId:
            typeof legacyAmbient?.session?.id === "string" ? legacyAmbient.session.id : null,
          allowRecovery: options.allowIdentityRecovery ?? false,
        });
        if (selected) {
          // The actor epoch is both an admission fence and response provenance.
          // A browser must ignore a late finite response after another tab has
          // advanced selection, even when the request itself was read-only.
          if (admittedActorEpoch === null) {
            c.header(MANAGED_AUTH_ACTOR_EPOCH_HEADER, selected.projection.actorEpoch);
            managedActorEpochByRequest.set(c.req.raw, selected.projection.actorEpoch);
          }
          managedActorAdmissionByRequest.set(c.req.raw, {
            authorityHash: managedAuthSha256(authority),
            actorEpoch: selected.projection.actorEpoch,
          });
        }
        if (selected && !selected.session) return null;
        if (selected?.session) {
          let resolvedSession = selected.session;
          if (requestNeedsActorMutationLease(c.req.method)) {
            await ensureActorMutationLease(
              c.req.raw,
              options.db,
              authority,
              selected.projection.actorEpoch,
            );
            const selectedSlot = await selectedSlotForAuthority(
              options.db,
              authority,
              sessionSetMode,
              options.allowIdentityRecovery ?? false,
            );
            if (!selectedSlot) throw new ManagedAuthActorChangeError();
            const refreshed = await options.sessionAdapter.refreshSelectedSession(selectedSlot);
            if (
              !refreshed ||
              refreshed.session.id !== selectedSlot.authSessionId ||
              refreshed.user.id !== selectedSlot.authUserId
            ) {
              throw new ManagedAuthActorChangeError();
            }
            resolvedSession = refreshed;
          }
          return resolvedSession;
        }
        // Once a browser presents a session-set authority it is authoritative.
        // An absent/expired/rekeyed authority must never fall through to an
        // ambient Better Auth cookie in dual mode: that would bypass the actor
        // epoch and mutation-lease fences after another tab transitions.
        return null;
      } catch (error) {
        if (error instanceof ManagedAuthActorChangeError) {
          // Response headers are immutable after an SSE body starts. The
          // original response already carries its actor epoch; reauthorization
          // closes that stream through the thrown conflict instead.
          if (!managedActorEpochByRequest.has(c.req.raw)) {
            c.header("x-opengeni-actor-state", "changed");
          }
          throw new HTTPException(409, { message: error.code, cause: error });
        }
        throw error;
      }
    }
    if (sessionSetMode === "broker") return null;
    const ambient = await options.sessionAdapter.resolveAmbientSession(c.req.raw.headers);
    if (ambient?.session?.id)
      try {
        const adopted = await getManagedAuthAdoptedSessionSnapshot(options.db, ambient.session.id);
        if (adopted) {
          const admittedActorEpoch = managedActorEpochByRequest.get(c.req.raw) ?? null;
          if (
            adopted.actorEpoch !== "1" ||
            (admittedActorEpoch !== null && adopted.actorEpoch !== admittedActorEpoch) ||
            !adopted.selected ||
            adopted.selected.authSessionId !== ambient.session.id ||
            adopted.selected.authUserId !== ambient.user.id
          ) {
            throw new ManagedAuthActorChangeError();
          }
          if (admittedActorEpoch === null) {
            c.header(MANAGED_AUTH_ACTOR_EPOCH_HEADER, adopted.actorEpoch);
            managedActorEpochByRequest.set(c.req.raw, adopted.actorEpoch);
          }
          managedActorAdmissionByRequest.set(c.req.raw, {
            authorityHash: adopted.authorityHash,
            actorEpoch: adopted.actorEpoch,
          });
          if (requestNeedsActorMutationLease(c.req.method)) {
            await ensureActorMutationLeaseForHash(
              c.req.raw,
              options.db,
              adopted.authorityHash,
              adopted.actorEpoch,
            );
            const current = await getManagedAuthAdoptedSessionSnapshot(
              options.db,
              ambient.session.id,
            );
            if (
              current?.authorityHash !== adopted.authorityHash ||
              current.actorEpoch !== adopted.actorEpoch ||
              !current.selected ||
              current.selected.authSessionId !== ambient.session.id
            ) {
              throw new ManagedAuthActorChangeError();
            }
            const refreshed = await options.sessionAdapter.refreshSelectedSession(current.selected);
            if (
              !refreshed ||
              refreshed.session.id !== ambient.session.id ||
              refreshed.user.id !== ambient.user.id
            ) {
              throw new ManagedAuthActorChangeError();
            }
            return refreshed;
          }
          return ambient;
        }
      } catch (error) {
        if (error instanceof ManagedAuthActorChangeError) {
          if (!managedActorEpochByRequest.has(c.req.raw)) {
            c.header("x-opengeni-actor-state", "changed");
          }
          throw new HTTPException(409, { message: error.code, cause: error });
        }
        throw error;
      }
  }
  const result = await auth.api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });

  for (const cookie of setCookieHeaders(result.headers)) {
    c.header("set-cookie", cookie, { append: true });
  }

  const session = result.response;
  if (!session?.user || !options?.db) return session;
  const authSessionId = session.session?.id;
  if (typeof authSessionId !== "string") return null;
  const valid = await validateCanonicalHumanSession(options.db, {
    authSessionId,
    authUserId: session.user.id,
    ...(options.allowIdentityRecovery === undefined
      ? {}
      : { allowRecovery: options.allowIdentityRecovery }),
  });
  return valid ? session : null;
}

/** Safe response provenance for a request authenticated through session-set authority. */
export function getManagedAuthRequestActorEpoch(request: Request): string | null {
  return managedActorEpochByRequest.get(request) ?? null;
}

function selectedSlotForAuthority(
  db: Database,
  authority: string,
  mode: ManagedAuthSessionSetMode,
  allowRecovery: boolean,
) {
  return getManagedAuthSessionSetSnapshot(db, {
    authorityHash: managedAuthSha256(authority),
    mode,
    includeInternal: true,
    allowRecovery,
    readOnly: true,
  }).then((snapshot) => snapshot?.selected ?? null);
}

/** Release the multi-replica actor fence after the outer HTTP handler settles. */
export async function releaseManagedAuthRequestActorLease(request: Request): Promise<void> {
  const lease = actorMutationLeaseByRequest.get(request);
  if (!lease) return;
  actorMutationLeaseByRequest.delete(request);
  if (lease.refreshTimer) lease.runtime.cancel(lease.refreshTimer);
  if (lease.deadlineTimer) lease.runtime.cancel(lease.deadlineTimer);
  if (lease.fatalTimer) lease.runtime.cancel(lease.fatalTimer);
  await releaseManagedAuthActorMutationLease(lease.db, {
    authorityHash: lease.authorityHash,
    requestId: lease.requestId,
  });
}

/** Cooperative cancellation signal for actor-scoped provider/external I/O. */
export function getManagedAuthRequestActorAbortSignal(request: Request): AbortSignal | null {
  return actorMutationLeaseByRequest.get(request)?.abortController.signal ?? null;
}

/** @internal Deterministic lease-clock seam used only by direct lifecycle tests. */
export function installManagedAuthActorLeaseRuntimeForTest(
  overrides: Partial<ActorMutationLeaseRuntime>,
): () => void {
  const previous = actorMutationLeaseRuntime;
  actorMutationLeaseRuntime = {
    ...productionActorMutationLeaseRuntime,
    ...overrides,
  };
  return () => {
    actorMutationLeaseRuntime = previous;
  };
}

/**
 * Exact post-handler fence. A finite unsafe response is not released unless
 * its request-owned lease is still live at the same actor epoch.
 */
export async function validateManagedAuthRequestActorLease(request: Request): Promise<void> {
  const lease = actorMutationLeaseByRequest.get(request);
  if (!lease) return;
  if (lease.actorTransitionApplied) return;
  if (lease.poisoned !== null) {
    throw new ManagedAuthActorLeaseOutcomeUnknownError({
      cause: lease.poisoned,
    });
  }
  const valid = await validateManagedAuthActorMutationLease(lease.db, {
    authorityHash: lease.authorityHash,
    actorEpoch: lease.actorEpoch,
    requestId: lease.requestId,
  });
  if (!valid) throw new ManagedAuthActorChangeError();
}

export class ManagedAuthActorLeaseOutcomeUnknownError extends Error {
  readonly name = "ManagedAuthActorLeaseOutcomeUnknownError";
  readonly code = "operation_outcome_unknown";
  constructor(options?: ErrorOptions) {
    super("The actor-scoped request outcome is unknown after its durable lease was lost", options);
  }
}

/** A known-applied same-request canonical transition intentionally consumes its lease. */
export function markManagedAuthRequestActorTransitionApplied(request: Request): void {
  const lease = actorMutationLeaseByRequest.get(request);
  if (lease) lease.actorTransitionApplied = true;
}

export type ManagedAuthActorMutationLeaseStamp = {
  authorityHash: string;
  actorEpoch: string;
  requestId: string;
};

export type ManagedAuthActorAdmissionStamp = {
  authorityHash: string;
  actorEpoch: string;
};

/** Verified server-owned actor evidence available to both reads and mutations. */
export function getManagedAuthRequestActorAdmissionStamp(
  request: Request,
): ManagedAuthActorAdmissionStamp | null {
  return managedActorAdmissionByRequest.get(request) ?? null;
}

/** Exact request-owned fence passed into a same-transaction actor transition. */
export function getManagedAuthRequestActorLeaseStamp(
  request: Request,
): ManagedAuthActorMutationLeaseStamp | null {
  const lease = actorMutationLeaseByRequest.get(request);
  return lease
    ? {
        authorityHash: lease.authorityHash,
        actorEpoch: lease.actorEpoch,
        requestId: lease.requestId,
      }
    : null;
}

function requestNeedsActorMutationLease(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

async function ensureActorMutationLease(
  request: Request,
  db: Database,
  authority: string,
  actorEpoch: string,
): Promise<void> {
  const authorityHash = managedAuthSha256(authority);
  await ensureActorMutationLeaseForHash(request, db, authorityHash, actorEpoch);
}

async function ensureActorMutationLeaseForHash(
  request: Request,
  db: Database,
  authorityHash: string,
  actorEpoch: string,
): Promise<void> {
  const existing = actorMutationLeaseByRequest.get(request);
  if (existing) {
    if (existing.authorityHash !== authorityHash || existing.actorEpoch !== actorEpoch) {
      throw new ManagedAuthActorChangeError();
    }
    return;
  }
  const lease: ActorMutationLease = {
    db,
    authorityHash,
    actorEpoch,
    requestId: crypto.randomUUID(),
    refreshTimer: null,
    deadlineTimer: null,
    fatalTimer: null,
    expiresAt: new Date(0),
    localFatalDeadlineMonotonicMs: 0,
    runtime: actorMutationLeaseRuntime,
    abortController: new AbortController(),
    poisoned: null,
    actorTransitionApplied: false,
  };
  const acquireStartedAtMonotonicMs = lease.runtime.monotonicNow();
  try {
    lease.expiresAt = await acquireManagedAuthActorMutationLease(db, {
      authorityHash,
      actorEpoch,
      requestId: lease.requestId,
      leaseSeconds: ACTOR_MUTATION_LEASE_SECONDS,
    });
  } catch (error) {
    if (
      error instanceof ManagedAuthSessionSetGenerationConflictError ||
      error instanceof ManagedAuthSessionSetAuthorityError
    ) {
      throw new ManagedAuthActorChangeError();
    }
    throw error;
  }
  lease.localFatalDeadlineMonotonicMs =
    acquireStartedAtMonotonicMs +
    ACTOR_MUTATION_LEASE_SECONDS * 1_000 -
    ACTOR_MUTATION_FATAL_SAFETY_MS;
  actorMutationLeaseByRequest.set(request, lease);
  scheduleActorMutationLeaseRefresh(request, lease);
  lease.deadlineTimer = lease.runtime.schedule(() => {
    poisonActorMutationLease(
      request,
      lease,
      new Error("managed actor mutation handler exceeded its bounded lifetime"),
    );
  }, ACTOR_MUTATION_HANDLER_DEADLINE_MS);
}

function scheduleActorMutationLeaseRefresh(request: Request, lease: ActorMutationLease): void {
  const timer = lease.runtime.schedule(() => {
    if (actorMutationLeaseByRequest.get(request) !== lease) return;
    const refreshStartedAtMonotonicMs = lease.runtime.monotonicNow();
    void acquireManagedAuthActorMutationLease(lease.db, {
      authorityHash: lease.authorityHash,
      actorEpoch: lease.actorEpoch,
      requestId: lease.requestId,
      leaseSeconds: ACTOR_MUTATION_LEASE_SECONDS,
    })
      .then(async (expiresAt) => {
        if (actorMutationLeaseByRequest.get(request) !== lease) {
          // Release may have won while this pooled acquire statement was in
          // flight. Converge the just-renewed row immediately; never resurrect
          // a request-owned fence after the outer handler has settled.
          await releaseManagedAuthActorMutationLease(lease.db, {
            authorityHash: lease.authorityHash,
            requestId: lease.requestId,
          });
          return;
        }
        lease.expiresAt = expiresAt;
        lease.localFatalDeadlineMonotonicMs =
          refreshStartedAtMonotonicMs +
          ACTOR_MUTATION_LEASE_SECONDS * 1_000 -
          ACTOR_MUTATION_FATAL_SAFETY_MS;
        scheduleActorMutationLeaseRefresh(request, lease);
      })
      .catch((error) => poisonActorMutationLease(request, lease, error));
  }, ACTOR_MUTATION_LEASE_REFRESH_MS);
  lease.refreshTimer = timer;
}

function poisonActorMutationLease(
  request: Request,
  lease: ActorMutationLease,
  error: unknown,
): void {
  if (actorMutationLeaseByRequest.get(request) !== lease || lease.poisoned !== null) return;
  lease.poisoned = error;
  if (lease.refreshTimer) lease.runtime.cancel(lease.refreshTimer);
  lease.refreshTimer = null;
  lease.abortController.abort(error);
  const fatalAfterMs = Math.max(
    0,
    lease.localFatalDeadlineMonotonicMs - lease.runtime.monotonicNow(),
  );
  lease.fatalTimer = lease.runtime.schedule(() => {
    if (actorMutationLeaseByRequest.get(request) !== lease) return;
    // A handler that ignored cooperative cancellation must not outlive the
    // durable fence and resume under a later actor. Terminate this API
    // instance before PostgreSQL can expire the lease; process death is the
    // final multi-replica-safe cancellation boundary.
    lease.runtime.terminate();
  }, fatalAfterMs);
}

function unrefTimer<T extends ReturnType<typeof setTimeout>>(timer: T): T {
  (timer as T & { unref?: () => void }).unref?.();
  return timer;
}

function requestCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    if (!value || value.length > 512) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

function setCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (
    headers as Headers & {
      getSetCookie?: () => string[];
    }
  ).getSetCookie;
  if (getSetCookie) {
    return getSetCookie.call(headers);
  }

  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
}
