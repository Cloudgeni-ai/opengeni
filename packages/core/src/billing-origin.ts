import type {
  AccessGrant,
  BillingOrigin,
  SessionTurnSurface,
} from "@opengeni/contracts";
import {
  ambientBillingOrigin,
  currentCreditDebitAttribution,
  readTurnBillingOrigin,
  type Database,
} from "@opengeni/db";
import { isAppCredentialGrant, type AccessGrantAuthorization } from "./access";
import { currentSiteSessionOrigin } from "./site-session-origin";

/* ----------------------------------------------------------------------------
   Funding origin of accepted work (docs/billing-origin.md).

   App work is paid from the monthly plan credit first; API work only from
   credits. The origin is decided from trusted provenance when a turn is
   accepted and frozen on it; sub-agents, tools and continuations inherit it.
   It never grants or narrows access.
   -------------------------------------------------------------------------- */

const requestBillingOrigins = new WeakMap<Request, BillingOrigin>();

/**
 * TRUSTED IN-PROCESS DISPATCH ONLY: bill everything this exact raw Request
 * does as `origin` (a published Site's viewer is app; an outside agent's
 * organization action is API; an agent's action keeps its chat's origin).
 * Never call it with headers, claims or other caller input.
 */
export function stampRequestBillingOrigin(request: Request, origin: BillingOrigin): void {
  requestBillingOrigins.set(request, origin);
}

/** The origin a trusted dispatcher stamped on this exact raw Request, if any. */
export function requestBillingOrigin(request: Request): BillingOrigin | null {
  return requestBillingOrigins.get(request) ?? null;
}

/** Entry points that name their surface also fix who pays for them. */
function originForRequestedSurface(surface: SessionTurnSurface | null | undefined) {
  switch (surface) {
    case "web":
    case "slack":
    case "voice":
    case "site":
    case "automation":
    case "system":
    case "scheduled":
      return "app" as const;
    case "api_key":
    case "embedded":
    case "mcp":
      return "api" as const;
    default:
      return null;
  }
}

/**
 * The origin of a request's credential when nothing more specific applies.
 * Keys, products acting for their people, outside agents and services are
 * API. A person signed in to Opengeni's own apps is app. Any other person
 * credential (a personal API key, an outside agent's sign-in) is API.
 */
export function billingOriginForGrant(
  grant: AccessGrant,
  authorization?: AccessGrantAuthorization | null,
): BillingOrigin {
  const metadata = grant.metadata ?? {};
  if (
    grant.principalKind === "api_key" ||
    grant.principalKind === "configured_key" ||
    metadata.externalActor !== undefined ||
    metadata.mcpOAuth === true ||
    metadata.delegated === true ||
    grant.serviceInitiator
  ) {
    return "api";
  }
  if (currentSiteSessionOrigin()) return "app";
  return authorization?.canonicalManagedHumanSession ||
    authorization?.canonicalLocalHumanSession ||
    isAppCredentialGrant(grant)
    ? "app"
    : "api";
}

/**
 * Decide the origin frozen on a turn being accepted. Order: an in-process
 * entry point's explicit origin; an origin a trusted dispatcher fixed for
 * this request; the turn an agent attempt runs in; an entry point's surface;
 * the credential.
 */
export async function resolveTurnBillingOrigin(
  db: Database,
  input: {
    grant: AccessGrant;
    authorization?: AccessGrantAuthorization | null | undefined;
    requestedOrigin?: BillingOrigin | null | undefined;
    requestedSurface?: SessionTurnSurface | null | undefined;
  },
): Promise<BillingOrigin> {
  if (input.requestedOrigin) return input.requestedOrigin;
  const ambient = ambientBillingOrigin();
  if (ambient) return ambient;
  const { grant } = input;
  const turnId = grant.metadata?.turnId;
  if (grant.principalKind === "agent_attempt" || typeof turnId === "string") {
    const attribution = currentCreditDebitAttribution();
    if (attribution.kind === "turn" && attribution.turnId === turnId && attribution.billingOrigin) {
      return attribution.billingOrigin;
    }
    // Plan credit never pays for work whose chat cannot be found.
    return typeof turnId === "string"
      ? ((await readTurnBillingOrigin(db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          turnId,
        }).catch(() => null)) ?? "api")
      : "api";
  }
  return (
    originForRequestedSurface(input.requestedSurface) ??
    billingOriginForGrant(grant, input.authorization)
  );
}
