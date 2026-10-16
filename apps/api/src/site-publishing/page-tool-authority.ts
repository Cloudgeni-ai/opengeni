import type { AccessGrant } from "@opengeni/contracts";
import { hasPermission, type ApiRouteDeps, type SiteSessionOrigin } from "@opengeni/core";
import {
  getPublishedSiteVersion,
  getWorkspaceGrant,
  subjectHasLiveWorkspaceAuthorityInScope,
  withWorkspaceSubjectRls,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import type { WorkspaceSiteVersionResolver } from "../workspace-tool-gateway";
import type { SiteGatewayFields } from "./gateway-signature";
import {
  requireServedSiteRuntimeHost,
  resolveSiteRuntimeViewer,
  siteNotAvailableForViewer,
} from "./runtime";

/** A Site cookie is NOT a console session or a general access authorization. */
export type PublishedSiteToolAuthorization = {
  readonly kind: "published_site_tools";
  readonly grant: AccessGrant;
};

type Authority = {
  requestedTools: Array<{ serverId: string; toolName: string }>;
  origin: SiteSessionOrigin & { siteId: string; versionId: string };
  reauthorize: () => Promise<void>;
  readVersion: WorkspaceSiteVersionResolver;
};
const authorities = new WeakMap<PublishedSiteToolAuthorization, Authority>();

export function isPublishedSiteToolAuthorization(
  value: object,
): value is PublishedSiteToolAuthorization {
  return authorities.has(value as PublishedSiteToolAuthorization);
}

export function publishedSiteToolAuthority(value: PublishedSiteToolAuthorization): Authority {
  const authority = authorities.get(value);
  if (!authority) throw new HTTPException(403, { message: "site_tool_not_authorized" });
  return authority;
}

/**
 * Called only after gateway signature verification. Authenticate the opaque
 * Site cookie against this served host; never accept a subject or grant from
 * the page. The resulting capability is usable only by the tool gateway.
 */
export async function authorizePublishedSiteTools(
  deps: ApiRouteDeps,
  domain: string,
  fields: SiteGatewayFields,
): Promise<PublishedSiteToolAuthorization> {
  const denied = () =>
    siteNotAvailableForViewer("workspace_tools", "Workspace tools require workspace membership");
  const read = async () => {
    const host = await requireServedSiteRuntimeHost(deps, domain, fields.host);
    const viewer = await resolveSiteRuntimeViewer(deps, host, fields);
    if (viewer.kind !== "member" || !viewer.subjectId || !viewer.sessionId) throw denied();
    const scope = { ...host.scope, subjectId: viewer.subjectId };
    const grant = await withWorkspaceSubjectRls(
      deps.db,
      scope.workspaceId,
      scope.subjectId,
      async (tx) => {
        // Membership is necessary but not sufficient while its organization is suspended.
        if (!(await subjectHasLiveWorkspaceAuthorityInScope(tx, scope))) throw denied();
        return await getWorkspaceGrant(tx, scope.subjectId, scope.workspaceId, {
          principalKind: "human_session",
        });
      },
    );
    if (!grant || !hasPermission(grant.permissions, "workspace:read")) throw denied();
    return { host, viewer, grant };
  };
  const initial = await read();
  const { host, grant } = initial;
  const version = await getPublishedSiteVersion(deps.db, host.scope, host.site.id, host.versionId);
  if (!version) throw new HTTPException(403, { message: "site_tool_not_authorized" });
  const reauthorize = async () => {
    const live = await read();
    if (
      live.host.site.id !== host.site.id ||
      live.host.versionId !== version.id ||
      live.grant.accountId !== grant.accountId ||
      live.grant.workspaceId !== grant.workspaceId ||
      live.grant.subjectId !== grant.subjectId ||
      live.viewer.sessionId !== initial.viewer.sessionId ||
      grant.permissions.some((permission) => !hasPermission(live.grant.permissions, permission))
    )
      throw new HTTPException(403, { message: "site_tool_access_changed" });
  };
  Object.freeze(grant.permissions);
  Object.freeze(grant);
  const authorization: PublishedSiteToolAuthorization = Object.freeze({
    kind: "published_site_tools",
    grant,
  });
  authorities.set(authorization, {
    requestedTools: version.requestedTools,
    origin: { siteId: host.site.id, versionId: version.id, title: host.site.title },
    reauthorize,
    readVersion: async (_db, caller, siteId, versionId) => {
      if (caller !== grant || siteId !== host.site.id || versionId !== version.id)
        throw new HTTPException(403, { message: "site_tool_not_authorized" });
      await reauthorize();
      return { status: "active", version };
    },
  });
  return authorization;
}
