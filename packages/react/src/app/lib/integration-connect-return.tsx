// One-shot provider return parameters for the consent-gated integration
// connect journey (integration-connect-analytics.ts). Route handlers remove
// these parameters from the URL as soon as they render, which can be before
// the analytics providers have loaded, so the boot entry snapshots them here.
// Only the parameter name, the closed outcome token, and a provider domain on
// success are kept in page memory; nothing is written to storage.

/** Return parameters whose value is the closed outcome of a redirect connect. */
export const INTEGRATION_CONNECT_RETURN_PARAMETERS = [
  "integration_oauth",
  "social_oauth",
  "fiken",
  "slack",
  "google_drive",
  "atlassian",
  "github_personal_oauth",
  "github",
] as const;
export type IntegrationConnectReturnParameter =
  (typeof INTEGRATION_CONNECT_RETURN_PARAMETERS)[number];

export type IntegrationConnectReturn = {
  parameter: IntegrationConnectReturnParameter;
  /** The parameter value, for example `success`, `connected` or `error`. */
  status: string;
  /** The error reason token, for closed outcome mapping only. */
  reason: string | null;
  /** The connected provider domain on an MCP OAuth success, for class mapping only. */
  providerDomain: string | null;
};

const TOKEN = /^[a-z0-9_.-]{1,64}$/i;
let pendingReturn: IntegrationConnectReturn | null = null;
let observed = false;

function token(value: string | null): string | null {
  return value && TOKEN.test(value) ? value : null;
}

export function parseIntegrationConnectReturn(search: string): IntegrationConnectReturn | null {
  const parameters = new URLSearchParams(search);
  for (const parameter of INTEGRATION_CONNECT_RETURN_PARAMETERS) {
    const status = token(parameters.get(parameter));
    if (!status) continue;
    return {
      parameter,
      status,
      reason: token(parameters.get("reason")),
      providerDomain: token(parameters.get("providerDomain")),
    };
  }
  return null;
}

/** Called once at boot, before the router or a route handler sees the URL. */
export function retainIntegrationConnectReturn(search: string): void {
  if (observed) return;
  observed = true;
  pendingReturn = parseIntegrationConnectReturn(search);
}

/** The boot-time return, at most once per document. */
export function takeIntegrationConnectReturn(): IntegrationConnectReturn | null {
  const value = pendingReturn;
  pendingReturn = null;
  return value;
}

export function resetIntegrationConnectReturnForTests(): void {
  pendingReturn = null;
  observed = false;
}
