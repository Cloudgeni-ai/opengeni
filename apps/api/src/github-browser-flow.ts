import type { Settings } from "@opengeni/config";
import type { AccessGrant } from "@opengeni/contracts";
import { hasPermission } from "@opengeni/core";
import type { GitHubSignedStatePayload } from "@opengeni/github";

/**
 * Dormant compatibility helpers for tests and decoding already-issued browser
 * handoffs. No production route imports this module. Its signed claims preserve
 * a prior OpenGeni grant across a redirect; they do not prove that GitHub
 * authorizes the human to install, configure, or bind an App installation.
 */
export const githubBrowserGrantMaxAgeSeconds = 10 * 60;

export function githubBrowserGrantClaims(
  settings: Pick<Settings, "productAccessMode">,
  grant: AccessGrant,
  nowSeconds = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  if (
    settings.productAccessMode !== "configured" ||
    !hasPermission(grant.permissions, "github:manage")
  ) {
    return {};
  }
  return {
    browserGrantSubjectId: grant.subjectId,
    browserGrantExpiresAt: nowSeconds + githubBrowserGrantMaxAgeSeconds,
  };
}

export function continuedGitHubBrowserGrantClaims(
  payload: GitHubSignedStatePayload,
): Record<string, unknown> {
  return typeof payload.browserGrantSubjectId === "string" &&
    typeof payload.browserGrantExpiresAt === "number"
    ? {
        browserGrantSubjectId: payload.browserGrantSubjectId,
        browserGrantExpiresAt: payload.browserGrantExpiresAt,
      }
    : {};
}

export function githubBrowserGrantFromState(
  settings: Pick<Settings, "productAccessMode">,
  payload: GitHubSignedStatePayload,
  workspaceId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): AccessGrant | null {
  const subjectId = payload.browserGrantSubjectId;
  const expiresAt = payload.browserGrantExpiresAt;
  if (
    settings.productAccessMode !== "configured" ||
    typeof payload.accountId !== "string" ||
    payload.workspaceId !== workspaceId ||
    typeof subjectId !== "string" ||
    subjectId.length === 0 ||
    typeof expiresAt !== "number" ||
    !Number.isInteger(expiresAt) ||
    expiresAt < nowSeconds ||
    expiresAt > payload.iat + githubBrowserGrantMaxAgeSeconds
  ) {
    return null;
  }
  return {
    accountId: payload.accountId,
    workspaceId,
    subjectId,
    permissions: ["github:manage"],
    metadata: { githubBrowserHandoff: true, expiresAt },
  };
}

export function githubBrowserBaseUrl(
  settings: Pick<Settings, "githubAppManifestBaseUrl" | "publicBaseUrl">,
  requestOrigin?: string | null,
): string {
  return (
    settings.githubAppManifestBaseUrl ??
    settings.publicBaseUrl ??
    requestOrigin ??
    ""
  ).replace(/\/+$/, "");
}
