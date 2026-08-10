import type { Settings } from "@opengeni/config";
import type { AccessGrant } from "@opengeni/contracts";
import { hasPermission } from "@opengeni/core";
import type { GitHubSignedStatePayload } from "@opengeni/github";

/**
 * Bounded configured-token browser handoff. These signed claims preserve only
 * the exact OpenGeni github:manage grant across GitHub redirects; the callback
 * independently proves current GitHub personal/organization ownership. This
 * state must never be interpreted as GitHub installation authority.
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
  const browserGrant =
    typeof payload.browserGrantSubjectId === "string" &&
    typeof payload.browserGrantExpiresAt === "number"
      ? {
          browserGrantSubjectId: payload.browserGrantSubjectId,
          browserGrantExpiresAt: payload.browserGrantExpiresAt,
        }
      : {};
  return {
    ...browserGrant,
    ...(typeof payload.returnPath === "string" ? { returnPath: payload.returnPath } : {}),
  };
}

/**
 * GitHub may return only to the session that initiated setup. This rejects
 * absolute/protocol-relative URLs and paths for another workspace before the
 * value is signed into provider state.
 */
export function githubSessionReturnPath(
  value: string | undefined | null,
  workspaceId: string,
): string | null {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }
  const parsed = new URL(value, "https://opengeni.local");
  const sessionPrefix = `/workspaces/${encodeURIComponent(workspaceId)}/sessions/`;
  if (
    parsed.origin !== "https://opengeni.local" ||
    parsed.pathname.startsWith("//") ||
    !parsed.pathname.startsWith(sessionPrefix)
  ) {
    return null;
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
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
