import { createHmac } from "node:crypto";
import type {
  InteractionPlacement,
  NetworkRouteConfiguration,
  NetworkRouteConsistency,
} from "@opengeni/contracts";

type BrowserControllerAuthorityScope = {
  rootSecret: string;
  accountId: string;
  workspaceId: string;
  placement: InteractionPlacement;
  placementInstanceId: string;
};

type BrowserSessionAuthorityScope = BrowserControllerAuthorityScope & {
  browserSessionId: string;
  controllerGeneration: string;
  tokenGeneration: number;
};

type ComputerSessionAuthorityScope = BrowserControllerAuthorityScope & {
  computerSessionId: string;
  controllerGeneration: string;
  tokenGeneration: number;
};

/** Stable placement-admin authority. This token is installed owner-only inside
 * the exact placement and is never persisted or returned by the public API. */
export function deriveBrowserControllerAdminToken(scope: BrowserControllerAuthorityScope): string {
  return derive(scope.rootSecret, "placement-admin.v1", [
    scope.accountId,
    scope.workspaceId,
    placementKey(scope.placement),
    scope.placementInstanceId,
  ]);
}

/** Deterministic controller credentials. The durable generations are the only
 * stored authority; plaintext tokens can be reconstructed only by API replicas
 * holding the deployment HMAC root. */
export function deriveBrowserSessionControllerTokens(scope: BrowserSessionAuthorityScope): {
  controlToken: string;
  viewToken: string;
} {
  const fields = [
    scope.accountId,
    scope.workspaceId,
    placementKey(scope.placement),
    scope.placementInstanceId,
    scope.browserSessionId,
    scope.controllerGeneration,
    scope.tokenGeneration,
  ] as const;
  return {
    controlToken: derive(scope.rootSecret, "session-control.v1", fields),
    viewToken: derive(scope.rootSecret, "session-view.v1", fields),
  };
}

/** Secret-safe durable identity for one exact route launch. The digest binds
 * the route snapshot and proxy credential without making a password-verifier
 * hash available to database readers. */
export function deriveBrowserNetworkRouteAuthorityDigest(scope: {
  rootSecret: string;
  accountId: string;
  workspaceId: string;
  browserSessionId: string;
  routeId: string;
  routeVersion: number;
  credentialVersion: number | null;
  configuration: NetworkRouteConfiguration;
  consistency: NetworkRouteConsistency;
  proxyCredential: { username: string; password: string } | null;
}): string {
  return derive(scope.rootSecret, "network-route-launch.v1", [
    scope.accountId,
    scope.workspaceId,
    scope.browserSessionId,
    scope.routeId,
    scope.routeVersion,
    scope.credentialVersion ?? "none",
    canonicalJson(scope.configuration),
    canonicalJson(scope.consistency),
    scope.proxyCredential?.username ?? "none",
    scope.proxyCredential?.password ?? "none",
  ]).replace(/^ogb\./u, "ogr.");
}

export function deriveBrowserViewGrantToken(
  scope: BrowserSessionAuthorityScope & { grantId: string; expiresAt: string },
): string {
  return derive(scope.rootSecret, "frame-view-grant.v1", [
    scope.accountId,
    scope.workspaceId,
    placementKey(scope.placement),
    scope.placementInstanceId,
    scope.browserSessionId,
    scope.controllerGeneration,
    scope.tokenGeneration,
    scope.grantId,
    scope.expiresAt,
  ]);
}

/** ComputerSession credentials share the placement controller root while using
 * resource-specific domains. Browser and computer authority cannot collide. */
export function deriveComputerSessionControllerTokens(scope: ComputerSessionAuthorityScope): {
  controlToken: string;
  viewToken: string;
} {
  const fields = [
    scope.accountId,
    scope.workspaceId,
    placementKey(scope.placement),
    scope.placementInstanceId,
    scope.computerSessionId,
    scope.controllerGeneration,
    scope.tokenGeneration,
  ] as const;
  return {
    controlToken: derive(scope.rootSecret, "computer-session-control.v1", fields),
    viewToken: derive(scope.rootSecret, "computer-session-view.v1", fields),
  };
}

export function deriveComputerViewGrantToken(
  scope: ComputerSessionAuthorityScope & { grantId: string; expiresAt: string },
): string {
  return derive(scope.rootSecret, "computer-frame-view-grant.v1", [
    scope.accountId,
    scope.workspaceId,
    placementKey(scope.placement),
    scope.placementInstanceId,
    scope.computerSessionId,
    scope.controllerGeneration,
    scope.tokenGeneration,
    scope.grantId,
    scope.expiresAt,
  ]);
}

function derive(rootSecret: string, domain: string, fields: readonly (string | number)[]): string {
  if (!rootSecret) throw new Error("browser controller authority root is unavailable");
  const hmac = createHmac("sha256", rootSecret);
  hmac.update("opengeni.browser-controller-authority\0", "utf8");
  writeField(hmac, domain);
  for (const field of fields) writeField(hmac, String(field));
  return `ogb.${hmac.digest("base64url")}`;
}

function writeField(hmac: ReturnType<typeof createHmac>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  hmac.update(String(bytes.byteLength), "utf8");
  hmac.update(":", "utf8");
  hmac.update(bytes);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

function placementKey(placement: InteractionPlacement): string {
  switch (placement.kind) {
    case "sandbox_group":
      return `sandbox_group:${placement.sandboxGroupId}`;
    case "connected_machine":
      return `connected_machine:${placement.sandboxId}`;
    case "attached_device":
      return `attached_device:${placement.deviceId}`;
    case "external_provider":
      return `external_provider:${placement.providerId}:${placement.placementId}`;
  }
}
