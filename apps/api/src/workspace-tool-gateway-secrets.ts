/**
 * `{{secret:…}}` resolution for workspace tool gateway calls made by people,
 * services and Sites (GW-4). The prepared gateway may serve many calls, so
 * the Site context is request-local: a Site call resolves with the viewer's
 * reach (`site_viewer`), any other call with the calling human or service.
 * Values replace references only in the deep copy the gateway executes; the
 * approval digest stays bound to the references.
 */
import type { VaultProviderRegistry } from "@opengeni/vaults";
import { AsyncLocalStorage } from "node:async_hooks";
import { environmentsEncryptionKeyBytes, type Settings } from "@opengeni/config";
import {
  SecretReferenceError,
  collectReferencesDeep,
  type AccessGrant,
  type SecretPrincipal,
} from "@opengeni/contracts";
import { createSecretResolver, hasPermission } from "@opengeni/core";
import type { Database } from "@opengeni/db";
import {
  createSecretArgumentResolver,
  handOffSecretArguments,
  literalSecretScope,
  secretArgumentMode,
} from "@opengeni/runtime/workspace-tool-gateway";
import type { ToolGatewayArgumentResolver } from "@opengeni/tool-gateway";

export type SiteSecretContext = { siteId: string; siteVersion: string };

const siteSecretContexts = new AsyncLocalStorage<SiteSecretContext | null>();

/** Runs `run` with the validated Site (or explicitly no Site) as secret context. */
export function withSiteSecretContext<T>(context: SiteSecretContext | null, run: () => T): T {
  return siteSecretContexts.run(context, run);
}

export function workspaceGatewaySecretPrincipal(
  grant: AccessGrant,
  site: SiteSecretContext | null,
): SecretPrincipal {
  if (site) {
    return {
      kind: "site_viewer",
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
      siteId: site.siteId,
      siteVersion: site.siteVersion,
    };
  }
  const viaApiKey =
    grant.principalKind === "api_key" ||
    grant.principalKind === "configured_key" ||
    grant.principalKind === "service";
  return {
    kind: "human",
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    verifiedHuman: !viaApiKey,
    viaApiKey,
  };
}

export function workspaceGatewaySecretArguments(input: {
  db: Database;
  settings: Settings;
  grant: AccessGrant;
  /** Connected vaults (1Password, host) for the resolved acting subject. */
  providersForSubject?:
    | ((subjectId: string | null, site?: SiteSecretContext | null) => VaultProviderRegistry)
    | undefined;
}): ToolGatewayArgumentResolver {
  const encryptionKey = environmentsEncryptionKeyBytes(input.settings) ?? null;
  return async (call) => {
    // Hand-off tools (sessions, messages, schedules, goals, notes, Knowledge,
    // artifacts, notifications) keep reference text and need no secrets:use.
    const mode = secretArgumentMode(call.entry, call.arguments);
    if (mode === "handoff") return handOffSecretArguments(call.arguments);
    if (mode !== "literal") return call.arguments;
    const site = siteSecretContexts.getStore() ?? null;
    // Site viewers are checked in the database (secrets:use on the viewer);
    // people and services are checked here, like the vault routes. Only the
    // references that become values count (an admin_action_call resolves
    // only its credential fields).
    const references = collectReferencesDeep(literalSecretScope(call.entry, call.arguments).target);
    if (
      !site &&
      references.length > 0 &&
      !hasPermission(input.grant.permissions, "secrets:use", input.grant.permissionMode)
    ) {
      throw new SecretReferenceError(
        references.map((reference) => ({
          raw: reference.raw,
          code: "denied",
          message: "the caller is not allowed to use secrets (secrets:use)",
        })),
      );
    }
    const resolver = createSecretResolver(
      { db: input.db, encryptionKey },
      workspaceGatewaySecretPrincipal(input.grant, site),
      {
        capabilityEnabled: true,
        ...(input.providersForSubject
          ? {
              providersForSubject: (subjectId: string | null) =>
                input.providersForSubject!(subjectId, site),
            }
          : {}),
      },
    );
    const hook = createSecretArgumentResolver({
      resolver,
      ...(site ? { surface: "site" as const } : {}),
    });
    return hook ? await hook(call) : call.arguments;
  };
}
