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
  getConnectionMetadata,
  installApiIntegration,
  listInstalledApiIntegrations,
  type Database,
} from "@opengeni/db";
import { InstallApiIntegrationRequest } from "@opengeni/contracts";
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
