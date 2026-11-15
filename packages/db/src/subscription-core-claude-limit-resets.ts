/**
 * Claude limit reset claims on the shared subscription core.
 *
 * Claude offers some accounts limit reset grants (the provider's
 * `cedar_ember` program; the usage read stores them as provider details,
 * see `subscription-core-claude-usage.ts`). Claiming one is a request to
 * `POST /api/organizations/{organization}/reset_rate_limits` with
 * `{ program: "cedar_ember", grant_id, request_id }`, made the way Claude
 * Code 2.1.322 makes it: Claude Code's CLI surface, the account's
 * organization from the OAuth profile, and a 25-second deadline. The
 * provider settles a claim once per request id, so an unsettled claim
 * (`retryable`) is retried with the same id and can never use two resets.
 *
 * After every claim that reached the provider the connection's usage is
 * read again, past the refresh throttle: an authoritative reading below the
 * limit ends each stored exhaustion or cooldown whose claimed limits it now
 * shows below the limit (`subscriptionCoreClaudeUsageEndsClaimedBlock`), so
 * the limits the claim cleared serve again; the caller wakes waiters when
 * the read reports a recovery.
 */
import type { Settings } from "@opengeni/config";
import { CLAUDE_OAUTH_PROFILE_URL, parseClaudeLimitResetClaim } from "@opengeni/config";
import type { ClaudeLimitResetClaim, ClaudeSubscriptionUsage } from "@opengeni/contracts";
import { readResponseJsonBounded } from "@opengeni/network";
import type { SubscriptionCoreConnectionRead } from "@opengeni/subscriptions";
import type { Database } from "./database";
import type { SubscriptionCoreConnectionRow } from "./subscription-core/administration";
import { subscriptionCoreAdministeredConnections } from "./subscription-core/administered-connections";
import {
  subscriptionCoreOperationConnections,
  type SubscriptionCoreConnectionProbeDeps,
  type SubscriptionCoreConnectionReadRun,
} from "./subscription-core/operation-connections";
import { subscriptionCoreProvider } from "./subscription-core-providers";
import {
  SUBSCRIPTION_CORE_CLAUDE_PROVIDER,
  type SubscriptionCoreClaudeCredential,
} from "./subscription-core-claude-adapter";
import {
  refreshSubscriptionCoreClaudeOrganizationUsage,
  refreshSubscriptionCoreClaudeWorkspaceUsage,
  type SubscriptionCoreClaudeUsageTarget,
} from "./subscription-core-claude-reads";
import {
  SUBSCRIPTION_CORE_CLAUDE_USAGE_SCOPE,
  subscriptionCoreClaudeAccountHeaders,
} from "./subscription-core-claude-usage";

/** Claude's account API (the organization a claim names is read from the profile). */
export const SUBSCRIPTION_CORE_CLAUDE_ACCOUNT_API = "https://api.anthropic.com";
/** The limit reset program Claude Code claims grants of. */
export const SUBSCRIPTION_CORE_CLAUDE_RESET_PROGRAM = "cedar_ember";
/** Claude Code's deadline for one claim. */
const CLAIM_DEADLINE_MS = 25_000;
const PROFILE_DEADLINE_MS = 10_000;
const BODY_LIMIT_BYTES = 64 * 1024;
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SubscriptionCoreClaudeLimitResetClaimInput = {
  grantId: string;
  /** The caller's idempotency key; retry an unsettled claim with the same one. */
  requestId: string;
};

function notSettled(
  result: "rate_limited" | "auth_error" | "error",
  retryable: boolean,
): ClaudeLimitResetClaim {
  return {
    result,
    reason: null,
    resetsLeft: null,
    cleared: [],
    weeklyResetsAt: null,
    cooldownUntil: null,
    retryable,
  };
}

/** The account's organization from the OAuth profile, or null when it cannot be read. */
async function claudeOrganizationUuid(
  read: SubscriptionCoreConnectionRead<SubscriptionCoreClaudeCredential>,
  token: string,
): Promise<string | null> {
  const signal = AbortSignal.timeout(PROFILE_DEADLINE_MS);
  const response = await read.fetch(CLAUDE_OAUTH_PROFILE_URL, {
    headers: subscriptionCoreClaudeAccountHeaders(token),
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = await readResponseJsonBounded<unknown>(
    response,
    BODY_LIMIT_BYTES,
    "Claude profile",
    {
      signal,
    },
  );
  const organization =
    body && typeof body === "object" && "organization" in body
      ? (body as { organization?: { uuid?: unknown } }).organization
      : null;
  const uuid = organization && typeof organization === "object" ? organization.uuid : null;
  return typeof uuid === "string" && UUID.test(uuid) ? uuid.toLowerCase() : null;
}

/**
 * One limit reset claim with a connection's read (the adapter-level call).
 * Nothing is sent for a malformed grant or request id, or for a credential
 * without the profile scope (a setup token): neither can succeed by
 * retrying. A profile or transport failure is unsettled and retryable with
 * the same request id; the provider's own answer is parsed as Claude Code
 * parses it (`parseClaudeLimitResetClaim`).
 */
export async function requestSubscriptionCoreClaudeLimitResetClaim(
  read: SubscriptionCoreConnectionRead<SubscriptionCoreClaudeCredential>,
  input: SubscriptionCoreClaudeLimitResetClaimInput,
): Promise<ClaudeLimitResetClaim> {
  if (!GRANT_ID.test(input.grantId) || !REQUEST_ID.test(input.requestId))
    return notSettled("error", false);
  const { credential } = await read.getToken();
  if (!credential.oauth?.scopes.includes(SUBSCRIPTION_CORE_CLAUDE_USAGE_SCOPE))
    return notSettled("auth_error", false);
  let organization: string | null;
  try {
    organization = await claudeOrganizationUuid(read, credential.token);
  } catch {
    return notSettled("error", true);
  }
  if (organization === null) return notSettled("auth_error", true);
  try {
    const signal = AbortSignal.timeout(CLAIM_DEADLINE_MS);
    const response = await read.fetch(
      `${SUBSCRIPTION_CORE_CLAUDE_ACCOUNT_API}/api/organizations/${organization}/reset_rate_limits`,
      {
        method: "POST",
        headers: subscriptionCoreClaudeAccountHeaders(credential.token),
        body: JSON.stringify({
          program: SUBSCRIPTION_CORE_CLAUDE_RESET_PROGRAM,
          grant_id: input.grantId,
          request_id: input.requestId,
        }),
        redirect: "error",
        signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return parseClaudeLimitResetClaim(response.status, null);
    }
    const body = await readResponseJsonBounded<unknown>(
      response,
      BODY_LIMIT_BYTES,
      "Claude limit reset",
      { signal },
    );
    return parseClaudeLimitResetClaim(response.status, body);
  } catch {
    // Sent or not, the outcome is unknown: the same request id settles it.
    return notSettled("error", true);
  }
}

/** A claim and the connection's usage read after it. */
export type SubscriptionCoreClaudeLimitResetClaimOutcome = {
  claim: ClaudeLimitResetClaim;
  usage: ClaudeSubscriptionUsage;
  /** The read after the claim ended a stored exhaustion or cooldown (wake waiters). */
  recovered: boolean;
};

function claimOf(run: SubscriptionCoreConnectionReadRun<ClaudeLimitResetClaim>) {
  switch (run.kind) {
    case "read":
      return run.value;
    case "relogin":
      return notSettled("auth_error", false);
    case "not_visible":
      return notSettled("error", false);
    default:
      // The credential or transport failed before the provider answered.
      return notSettled("error", true);
  }
}

/** A claim that reached the provider (whatever it answered) changes what usage reads report. */
function reachedProvider(claim: ClaudeLimitResetClaim): boolean {
  return claim.result !== "auth_error" && !(claim.result === "error" && !claim.retryable);
}

function claude() {
  return subscriptionCoreProvider(SUBSCRIPTION_CORE_CLAUDE_PROVIDER);
}

/**
 * Claim a limit reset grant of a Claude connection a workspace usage route
 * names (`readSubscriptionCoreClaudeWorkspaceUsageTarget`): a shared
 * connection through the workspace seam, the caller's own personal
 * connection through the owner seam. The caller has already checked that
 * the subject may change this connection. Then the usage is read again.
 */
export async function claimSubscriptionCoreClaudeWorkspaceLimitReset(
  db: Database,
  settings: Settings,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    target: SubscriptionCoreClaudeUsageTarget;
  } & SubscriptionCoreClaudeLimitResetClaimInput,
  deps: Pick<SubscriptionCoreConnectionProbeDeps, "fetchImpl" | "requestFetch" | "resolver"> & {
    now?: () => number;
  } = {},
): Promise<SubscriptionCoreClaudeLimitResetClaimOutcome> {
  const binding = claude();
  const call = (read: SubscriptionCoreConnectionRead<unknown>) =>
    requestSubscriptionCoreClaudeLimitResetClaim(
      read as SubscriptionCoreConnectionRead<SubscriptionCoreClaudeCredential>,
      input,
    );
  const run =
    input.target.scope === "user"
      ? await subscriptionCoreAdministeredConnections(
          binding,
        ).runSubscriptionCoreAdministeredConnectionRead(
          db,
          settings,
          {
            kind: "personal_owner",
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
          },
          input.target.connectionId,
          call,
          deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
        )
      : await subscriptionCoreOperationConnections(binding).runSubscriptionCoreConnectionRead(
          db,
          settings,
          {
            kind: "workspace",
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            subjectId: input.subjectId,
          },
          input.target.connectionId,
          call,
          {
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
            ...(deps.requestFetch ? { requestFetch: deps.requestFetch } : {}),
            ...(deps.resolver ? { resolver: deps.resolver } : {}),
          },
        );
  const claim = claimOf(run);
  const refreshed = await refreshSubscriptionCoreClaudeWorkspaceUsage(
    db,
    settings,
    {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.subjectId,
      target: input.target,
    },
    { ...deps, force: reachedProvider(claim) },
  );
  return { claim, usage: refreshed.usage, recovered: refreshed.recovered };
}

/**
 * Claim a limit reset grant of an organization-pool Claude connection, for
 * an organization administrator (the organization usage route's row). Then
 * the usage is read again.
 */
export async function claimSubscriptionCoreClaudeOrganizationLimitReset(
  db: Database,
  settings: Settings,
  input: {
    organizationId: string;
    subjectId: string;
    row: SubscriptionCoreConnectionRow;
  } & SubscriptionCoreClaudeLimitResetClaimInput,
  deps: { fetchImpl?: SubscriptionCoreConnectionProbeDeps["fetchImpl"]; now?: () => number } = {},
): Promise<SubscriptionCoreClaudeLimitResetClaimOutcome> {
  const run = await subscriptionCoreAdministeredConnections(
    claude(),
  ).runSubscriptionCoreAdministeredConnectionRead(
    db,
    settings,
    {
      kind: "organization_administrator",
      accountId: input.organizationId,
      subjectId: input.subjectId,
    },
    input.row.id,
    (read) =>
      requestSubscriptionCoreClaudeLimitResetClaim(
        read as SubscriptionCoreConnectionRead<SubscriptionCoreClaudeCredential>,
        input,
      ),
    deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
  );
  const claim = claimOf(run);
  const refreshed = await refreshSubscriptionCoreClaudeOrganizationUsage(
    db,
    settings,
    { organizationId: input.organizationId, subjectId: input.subjectId, row: input.row },
    { ...deps, force: reachedProvider(claim) },
  );
  return { claim, usage: refreshed.usage, recovered: refreshed.recovered };
}
