// Built-in integrations (SharePoint, Outlook, OneDrive, ...) have one reviewed
// tool set, so once the person has signed in there is nothing left for them to
// choose. Their provider callback finishes the whole setup: the account and
// every reviewed tool land in the same commit. Setup therefore completes
// without the app that started it: a closed dialog, a reload, a closed desktop
// app or a page the person navigated away from cannot leave it half done.
import {
  CORE_INTEGRATION_DEFINITIONS,
  createPinnedIntegrationTransport,
} from "@opengeni/capabilities";
import type { ConnectAttempt } from "@opengeni/contracts/connect";
import type { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import {
  requireConnectOwnerAuthority,
  requireMemberIntegrationSetupAllowed,
  type ApiRouteDeps,
  type ConnectOwner,
} from "@opengeni/core";
import {
  completeUnfinishedConnectSetup,
  getConnectionMetadata,
  installApiIntegration,
  listInstalledApiIntegrations,
  listUnfinishedConnectSetups,
  type Database,
} from "@opengeni/db";
import { withOrganizationIntegrationPolicyFence } from "@opengeni/db/organization-integration-policy";
import {
  assertOrganizationIntegrationAllowed,
  InstallApiIntegrationRequest,
} from "@opengeni/contracts";
import { validatedIntegrationInstallInput } from "../routes/api-integrations";
import {
  resolveApiIntegrationPreview,
  type ResolvedApiIntegrationPreview,
} from "./api-integrations";
import { integrationAvailable } from "./teams-rollout";

/** The starting request's permissions that bear on finishing setup in the callback. */
export const CURATED_CONNECT_FINISH_PERMISSIONS = [
  "connections:personal",
  "connections:write",
  "capabilities:manage",
] as const;
export type CuratedConnectFinishPermission = (typeof CURATED_CONNECT_FINISH_PERMISSIONS)[number];

/** The finishing permissions a starting request held, in a fixed order. */
export function curatedConnectFinishPermissions(
  held: readonly unknown[] | ((permission: CuratedConnectFinishPermission) => boolean),
): CuratedConnectFinishPermission[] {
  return CURATED_CONNECT_FINISH_PERMISSIONS.filter((permission) =>
    typeof held === "function" ? held(permission) : held.includes(permission),
  );
}

/** How long a callback waits for the reviewed tools before leaving the rest to the app. */
export const CURATED_CONNECT_RESOLVE_TIMEOUT_MS = 20_000;

/** A reviewed integration definition's own setup: nothing custom to review. */
export function curatedConnectFinishEligible(
  attempt: Pick<
    ConnectAttempt,
    "completionRequirement" | "mcpSetup" | "source" | "integrationInstalled"
  >,
): boolean {
  return (
    attempt.completionRequirement === "integration" &&
    !attempt.mcpSetup &&
    attempt.source === undefined &&
    !attempt.integrationInstalled
  );
}

/**
 * Installing a deployment-reviewed integration's tools for the caller's own
 * personal account is connecting that account, so it needs only the right to
 * connect your own accounts (connections:personal, included in
 * connections:write), like connecting Gmail. The instance resolves
 * credentials for that person alone. Anything else (a workspace account, a
 * custom source, or an instance not already bound to this same account)
 * is adding an integration (connections:write, which members hold).
 */
export async function isOwnAccountInstall(
  db: Database,
  settings: ApiRouteDeps["settings"],
  scope: { workspaceId: string; subjectId: string },
  attempt: {
    id: string;
    providerId: string;
    ownership: string;
    source?: unknown;
    account?: { id: string } | undefined;
    installationTarget?: { instanceKey: string } | undefined;
  },
): Promise<boolean> {
  if (attempt.ownership !== "personal" || attempt.source !== undefined || !attempt.account)
    return false;
  if (
    !CORE_INTEGRATION_DEFINITIONS.some((definition) => definition.id === attempt.providerId) ||
    !integrationAvailable(settings, scope.workspaceId, attempt.providerId)
  )
    return false;
  const connection = await getConnectionMetadata(
    db,
    scope.workspaceId,
    attempt.account.id,
    scope.subjectId,
  );
  if (!connection || connection.subjectId !== scope.subjectId) return false;
  const instanceKey = attempt.installationTarget?.instanceKey;
  // A fresh instance named after this attempt cannot replace anyone's.
  if (!instanceKey || instanceKey === `account-${attempt.id}`) return true;
  // Reconnecting reuses only an instance already bound to this same account.
  const installed = await listInstalledApiIntegrations(db, scope.workspaceId, scope.subjectId);
  return installed.some(
    (instance) =>
      instance.instanceKey === instanceKey &&
      instance.definitionId === attempt.providerId &&
      instance.connectionRef?.connectionId === attempt.account!.id,
  );
}

/**
 * The definition's reviewed tools, resolved outside any transaction (it reads
 * the provider's published API description). Null when they cannot be read in
 * time: the callback then saves only the account and the app finishes setup.
 */
export async function resolveCuratedConnectTools(
  deps: Pick<ApiRouteDeps, "settings" | "apiIntegrationSourceFetch">,
  owner: { accountId: string; workspaceId: string; subjectId: string },
  definitionId: string,
  timeoutMs = CURATED_CONNECT_RESOLVE_TIMEOUT_MS,
): Promise<ResolvedApiIntegrationPreview | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const transport = createPinnedIntegrationTransport({
      network: deps.settings,
      ...(deps.apiIntegrationSourceFetch ? { fetchImpl: deps.apiIntegrationSourceFetch } : {}),
    });
    const resolving = resolveApiIntegrationPreview({
      source: { kind: "definition", definitionId },
      connection: null,
      transport,
      authority: {
        accountId: owner.accountId,
        workspaceId: owner.workspaceId,
        initiatingSubjectId: owner.subjectId,
      },
    });
    resolving.catch(() => undefined);
    return await Promise.race([
      resolving,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The request that started setup could not have installed the tools itself. */
class CuratedConnectFinishRefusedError extends Error {
  readonly name = "CuratedConnectFinishRefusedError";
  constructor(permission: string) {
    super(`Finishing setup needs ${permission}`);
  }
}

/**
 * Install every reviewed tool for the account the callback just saved, inside
 * the callback's own commit and with the same checks as the manual install
 * step: the owner's current permission (connections:personal for one's own
 * account, otherwise connections:write) and, for a member who is not an
 * integration admin, the organization's member setup policy. Runs in a
 * savepoint: any refusal or conflict leaves the saved account untouched and
 * returns false, and the app offers the remaining step as before.
 */
export async function installCuratedConnectTools(
  tx: Database,
  input: {
    settings: ApiRouteDeps["settings"];
    owner: ConnectOwner;
    origin: ExternalActorContinuation | null;
    /** What the request that started setup held; never more than it. */
    finishPermissions: readonly CuratedConnectFinishPermission[];
    attempt: ConnectAttempt;
    connectionId: string;
    resolved: ResolvedApiIntegrationPreview;
  },
): Promise<boolean> {
  const { owner, origin, attempt, settings } = input;
  try {
    await tx.transaction(async (savepoint) => {
      const sp = savepoint as unknown as Database;
      const own = await isOwnAccountInstall(sp, settings, owner, {
        ...attempt,
        account: { id: input.connectionId },
      });
      const permission = own ? "connections:personal" : "connections:write";
      // connections:write includes connections:personal.
      if (
        !input.finishPermissions.includes(permission) &&
        !(own && input.finishPermissions.includes("connections:write"))
      )
        throw new CuratedConnectFinishRefusedError(permission);
      await requireConnectOwnerAuthority(sp, owner, permission, origin);
      const admin =
        !own &&
        input.finishPermissions.includes("capabilities:manage") &&
        (await sp
          .transaction(async (check) => {
            await requireConnectOwnerAuthority(
              check as unknown as Database,
              owner,
              "capabilities:manage",
              origin,
            );
            return true;
          })
          .catch(() => false));
      const memberSetup = !own && !admin;
      if (memberSetup) await requireMemberIntegrationSetupAllowed(sp, owner);
      const resolved: ResolvedApiIntegrationPreview = {
        ...input.resolved,
        preview: {
          ...input.resolved.preview,
          connectionId: input.connectionId,
          connectionOwnership: attempt.ownership,
        },
      };
      const payload = InstallApiIntegrationRequest.parse({
        source: { kind: "definition", definitionId: attempt.providerId },
        connectionId: input.connectionId,
        ownership: attempt.ownership,
        expectedRevisionId: resolved.preview.revisionId,
        expectedContentSha256: resolved.preview.contentSha256,
        // Always the explicit reviewed set; omission must never select all tools.
        allowedTools: resolved.preview.tools.map((tool) => tool.id),
        ...attempt.installationTarget,
      });
      // The owner's identity, not a request grant: no tools are auto-approved here.
      const grant = { accountId: owner.accountId, subjectId: owner.subjectId, permissions: [] };
      await installApiIntegration(sp, {
        ...validatedIntegrationInstallInput(grant, owner.workspaceId, payload, resolved),
        ...(memberSetup ? { memberCreate: true } : {}),
      });
    });
    return true;
  } catch (error) {
    console.warn("[connect] could not finish built-in integration setup in its callback", {
      attemptId: attempt.id,
      providerId: attempt.providerId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}

/** A built-in integration's setup that saved the account but not its tools. */
export function unfinishedCuratedSetup(attempt: ConnectAttempt): boolean {
  return (
    curatedConnectFinishEligible(attempt) &&
    attempt.credentialsCommitted &&
    attempt.account !== undefined &&
    // Expired: the person never came back before the attempt's short deadline.
    ["connected_but_incomplete", "preview", "expired"].includes(attempt.state)
  );
}

type FinishDeps = Pick<ApiRouteDeps, "db" | "settings" | "apiIntegrationSourceFetch">;

/**
 * Finish one built-in integration setup whose account is saved but whose
 * tools are not: read the reviewed tools (outside any transaction), then
 * install them and complete the attempt in one short commit, with exactly
 * the checks the callback applies. `unavailable` means the tools could not
 * be read and a later try may succeed; `not_finished` means it was refused,
 * already moved on, or its account is gone.
 */
export async function finishUnfinishedCuratedSetup(
  deps: FinishDeps,
  input: {
    owner: ConnectOwner;
    attempt: ConnectAttempt;
    finishPermissions: readonly CuratedConnectFinishPermission[];
    resolved?: ResolvedApiIntegrationPreview | null;
  },
): Promise<
  { outcome: "complete"; attempt: ConnectAttempt } | { outcome: "unavailable" | "not_finished" }
> {
  const { owner, attempt } = input;
  if (!unfinishedCuratedSetup(attempt) || input.finishPermissions.length === 0)
    return { outcome: "not_finished" };
  const resolved =
    input.resolved !== undefined
      ? input.resolved
      : await resolveCuratedConnectTools(deps, owner, attempt.providerId);
  if (!resolved) return { outcome: "unavailable" };
  const accountId = attempt.account!.id;
  try {
    const completed = await withOrganizationIntegrationPolicyFence(
      deps.db,
      owner,
      (fenced, policy) =>
        completeUnfinishedConnectSetup(fenced, owner, {
          attemptId: attempt.id,
          expectedRevision: attempt.revision,
          commit: async (tx, current, origin) => {
            assertOrganizationIntegrationAllowed(policy, current.providerId);
            // A person who removed the account since keeps it removed.
            const connection = await getConnectionMetadata(
              tx,
              owner.workspaceId,
              accountId,
              owner.subjectId,
            );
            if (!connection) return null;
            // Someone (or another tab) already added this account's tools.
            const installed = await listInstalledApiIntegrations(
              tx,
              owner.workspaceId,
              owner.subjectId,
            );
            const present = installed.some(
              (instance) =>
                instance.definitionId === current.providerId &&
                instance.connectionRef?.connectionId === accountId,
            );
            if (
              !present &&
              !(await installCuratedConnectTools(tx, {
                settings: deps.settings,
                owner,
                origin,
                finishPermissions: input.finishPermissions,
                attempt: current,
                connectionId: accountId,
                resolved,
              }))
            )
              return null;
            return {
              ...current,
              revision: current.revision + 1,
              state: "complete",
              integrationInstalled: true,
              nextAction: { type: "none" },
              error: undefined,
            };
          },
        }),
    );
    return completed ? { outcome: "complete", attempt: completed } : { outcome: "not_finished" };
  } catch (error) {
    console.warn("[connect] could not finish an unfinished built-in integration setup", {
      attemptId: attempt.id,
      providerId: attempt.providerId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return { outcome: "not_finished" };
  }
}

/**
 * Finish every built-in integration setup the actor left with a saved
 * account but no tools, under the requesting grant's own rights. The app
 * calls this when Capabilities opens, so a setup interrupted by a closed
 * dialog, reload or closed app finishes without anyone reopening it.
 */
export async function finishUnfinishedCuratedSetups(
  deps: FinishDeps,
  owner: ConnectOwner,
  finishPermissions: readonly CuratedConnectFinishPermission[],
): Promise<ConnectAttempt[]> {
  if (finishPermissions.length === 0) return [];
  const unfinished = (await listUnfinishedConnectSetups(deps.db, owner)).filter(
    unfinishedCuratedSetup,
  );
  const tools = new Map<string, Promise<ResolvedApiIntegrationPreview | null>>();
  const completed: ConnectAttempt[] = [];
  for (const attempt of unfinished) {
    let resolving = tools.get(attempt.providerId);
    if (!resolving) {
      resolving = resolveCuratedConnectTools(deps, owner, attempt.providerId);
      tools.set(attempt.providerId, resolving);
    }
    const result = await finishUnfinishedCuratedSetup(deps, {
      owner,
      attempt,
      finishPermissions,
      resolved: await resolving,
    });
    if (result.outcome === "complete") completed.push(result.attempt);
  }
  return completed;
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 5 * 60_000, 15 * 60_000];
let retryDelaysMs = DEFAULT_RETRY_DELAYS_MS;
const retryTimers = new Set<ReturnType<typeof setTimeout>>();

/** Test seam: the waits between a callback's later tries (null restores them). */
export function setCuratedConnectFinishRetryDelays(delays: readonly number[] | null): void {
  retryDelaysMs = delays ?? DEFAULT_RETRY_DELAYS_MS;
}

/** Stop pending later tries (process shutdown and tests). */
export function stopCuratedConnectFinishRetries(): void {
  for (const timer of retryTimers) clearTimeout(timer);
  retryTimers.clear();
}

/**
 * When a callback saved the account but could not read the reviewed tools in
 * time, keep trying here with the starter's signed rights, so setup still
 * finishes with nobody in the app. The saved state is durable: if this
 * process stops first, the app finishes it the next time Capabilities opens.
 * A refusal is final and is not retried.
 */
export function retryUnfinishedCuratedSetup(
  deps: FinishDeps,
  input: {
    owner: ConnectOwner;
    attemptId: string;
    finishPermissions: readonly CuratedConnectFinishPermission[];
  },
): void {
  const schedule = (index: number) => {
    const delay = retryDelaysMs[index];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      void run(index);
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    retryTimers.add(timer);
  };
  const run = async (index: number) => {
    let again = true;
    try {
      const attempt = (await listUnfinishedConnectSetups(deps.db, input.owner)).find(
        (candidate) => candidate.id === input.attemptId,
      );
      // Finished, cancelled or being advanced by the app: nothing left here.
      if (!attempt || !unfinishedCuratedSetup(attempt)) return;
      const result = await finishUnfinishedCuratedSetup(deps, {
        owner: input.owner,
        attempt,
        finishPermissions: input.finishPermissions,
      });
      again = result.outcome === "unavailable";
    } catch {
      // A transient database failure: try again later.
    }
    if (again) schedule(index + 1);
  };
  schedule(0);
}
