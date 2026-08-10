import type { IntegrationCredentialPlacement, ResolvedIntegrationCredential } from "./types";
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
const MAX_CREDENTIAL_PLACEMENTS = 32;
const MAX_CREDENTIAL_NAME_LENGTH = 256;
const MAX_CREDENTIAL_VALUE_LENGTH = 16_384;
const headerNamePattern = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const queryNamePattern = /^[A-Za-z0-9._~-]+$/;
const cookieNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

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

function validateCredentialPlacements(placements: readonly IntegrationCredentialPlacement[]): void {
  if (placements.length === 0 || placements.length > MAX_CREDENTIAL_PLACEMENTS) {
    throw new IntegrationInvocationError(
      "credential_placement_invalid",
      "Connection credential placement count is invalid",
      "not_started",
      false,
    );
  }
  const seen = new Set<string>();
  for (const placement of placements) {
    const name = placement.name;
    const value = placementValue(placement);
    const normalizedName = placement.carrier === "header" ? name.toLowerCase() : name;
    if (
      name.length === 0 ||
      name.length > MAX_CREDENTIAL_NAME_LENGTH ||
      placement.value.length === 0 ||
      value.length > MAX_CREDENTIAL_VALUE_LENGTH ||
      /[\r\n\0]/.test(name) ||
      /[\r\n\0]/.test(value)
    ) {
      throw new IntegrationInvocationError(
        "credential_placement_invalid",
        "Connection credential placement is invalid",
        "not_started",
        false,
      );
    }
    if (placement.carrier === "header") {
      if (
        !headerNamePattern.test(name) ||
        forbiddenCredentialHeaders.has(normalizedName) ||
        normalizedName.startsWith("sec-")
      ) {
        throw new IntegrationInvocationError(
          "credential_header_forbidden",
          "Connection credential targets a forbidden request header",
          "not_started",
          false,
        );
      }
    } else if (placement.carrier === "query") {
      if (!queryNamePattern.test(name)) {
        throw new IntegrationInvocationError(
          "credential_placement_invalid",
          "Connection credential query placement is invalid",
          "not_started",
          false,
        );
      }
    } else if (!cookieNamePattern.test(name) || /;/.test(value)) {
      throw new IntegrationInvocationError(
        "credential_cookie_invalid",
        "Connection credential cookie placement is invalid",
        "not_started",
        false,
      );
    }
    const key = `${placement.carrier}\0${normalizedName}`;
    if (seen.has(key)) {
      throw new IntegrationInvocationError(
        "credential_placement_invalid",
        "Connection credential placements contain a duplicate destination",
        "not_started",
        false,
      );
    }
    seen.add(key);
  }
}

export function applyCredentialPlacements(
  destination: URL,
  headers: Headers,
  credential: ResolvedIntegrationCredential,
): void {
  assertCredentialAudience(credential, destination);
  validateCredentialPlacements(credential.placements);
  const cookies: string[] = [];
  for (const placement of credential.placements) {
    const name = placement.name;
    const value = placementValue(placement);
    if (placement.carrier === "header") {
      headers.set(name, value);
    } else if (placement.carrier === "query") {
      destination.searchParams.set(name, value);
    } else {
      cookies.push(`${name}=${value}`);
    }
  }
  if (cookies.length > 0) {
    const current = headers.get("cookie");
    headers.set("cookie", [...(current ? [current] : []), ...cookies].join("; "));
  }
}
