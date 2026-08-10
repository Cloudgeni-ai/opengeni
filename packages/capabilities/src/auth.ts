import type {
  IntegrationCredentialPlacement,
  ResolvedIntegrationCredential,
} from "./types";
import { IntegrationInvocationError } from "./types";

const forbiddenCredentialHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function normalizeAudiencePath(path: string | undefined): string {
  if (!path?.trim()) return "/";
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

export function assertCredentialAudience(
  credential: ResolvedIntegrationCredential,
  destination: URL,
): void {
  let audience: URL;
  try {
    audience = new URL(credential.audience.origin);
  } catch {
    throw new IntegrationInvocationError(
      "credential_audience_invalid",
      "Connection credential audience is invalid",
      "not_started",
      false,
    );
  }
  if (
    audience.origin !== destination.origin ||
    audience.username ||
    audience.password ||
    audience.pathname !== "/" ||
    audience.search ||
    audience.hash
  ) {
    throw new IntegrationInvocationError(
      "credential_audience_mismatch",
      "Connection credential is not authorized for this integration destination",
      "not_started",
      false,
    );
  }
  const prefix = normalizeAudiencePath(credential.audience.pathPrefix);
  const path = destination.pathname.endsWith("/")
    ? destination.pathname
    : `${destination.pathname}/`;
  if (!path.startsWith(prefix)) {
    throw new IntegrationInvocationError(
      "credential_path_mismatch",
      "Connection credential is not authorized for this integration path",
      "not_started",
      false,
    );
  }
}

function placementValue(placement: IntegrationCredentialPlacement): string {
  return `${placement.prefix ?? ""}${placement.value}`;
}

export function applyCredentialPlacements(
  destination: URL,
  headers: Headers,
  credential: ResolvedIntegrationCredential,
): void {
  assertCredentialAudience(credential, destination);
  const cookies: string[] = [];
  for (const placement of credential.placements) {
    const name = placement.name.trim();
    if (!name || /[\r\n]/.test(name) || /[\r\n]/.test(placement.value)) {
      throw new IntegrationInvocationError(
        "credential_placement_invalid",
        "Connection credential placement is invalid",
        "not_started",
        false,
      );
    }
    const value = placementValue(placement);
    if (placement.carrier === "header") {
      const normalized = name.toLowerCase();
      if (forbiddenCredentialHeaders.has(normalized) || normalized.startsWith("sec-")) {
        throw new IntegrationInvocationError(
          "credential_header_forbidden",
          "Connection credential targets a forbidden request header",
          "not_started",
          false,
        );
      }
      headers.set(name, value);
    } else if (placement.carrier === "query") {
      destination.searchParams.set(name, value);
    } else {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[;\r\n]/.test(value)) {
        throw new IntegrationInvocationError(
          "credential_cookie_invalid",
          "Connection credential cookie placement is invalid",
          "not_started",
          false,
        );
      }
      cookies.push(`${name}=${value}`);
    }
  }
  if (cookies.length > 0) {
    const current = headers.get("cookie");
    headers.set("cookie", [...(current ? [current] : []), ...cookies].join("; "));
  }
}