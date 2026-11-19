/**
 * Microsoft Dynamics connection URLs. Each customer environment has its own
 * address, so one reviewed connection recognizes the product from the URL and
 * turns an environment URL a person pastes into its connection URL: the
 * environment's MCP endpoint for Dataverse and Finance and Operations, and the
 * environment's API root for Business Central (whose MCP server is one global
 * URL for every tenant and environment).
 *
 * Only Microsoft's commercial cloud is recognized: sovereign clouds use other
 * sign-in authorities.
 */

export type MicrosoftDynamicsProduct = "dataverse" | "finance_operations" | "business_central";

export const MICROSOFT_DYNAMICS_PRODUCT_LABELS: Readonly<Record<MicrosoftDynamicsProduct, string>> =
  {
    dataverse: "Dynamics 365 Sales and Dataverse",
    finance_operations: "Dynamics 365 Finance and Operations",
    business_central: "Dynamics 365 Business Central",
  };

// Dataverse (Dynamics 365 Sales, Customer Service, Power Apps): <org>.crm[N].dynamics.com
const DATAVERSE_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.crm\d*\.dynamics\.com$/u;
// Finance and Operations: <env>[.sandbox].operations[.<region>].dynamics.com (environments
// created in the Power Platform admin center use a regional host such as
// operations.ch.dynamics.com), or a cloud-hosted development environment on cloudax.dynamics.com.
const FINANCE_OPERATIONS_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:operations(?:\.[a-z]{2,4})?|cloudax)\.dynamics\.com$/u;

// Business Central: the web client at businesscentral.dynamics.com/[<tenant>/][<environment>],
// and the environment's API at api.businesscentral.dynamics.com/v2.0/[<tenant>/]<environment>/api/v2.0.
const BUSINESS_CENTRAL_WEB_HOST = "businesscentral.dynamics.com";
const BUSINESS_CENTRAL_API_HOST = "api.businesscentral.dynamics.com";
const BUSINESS_CENTRAL_DEFAULT_ENVIRONMENT = "Production";
// A tenant is its ID or one of its domains (contoso.onmicrosoft.com).
const BUSINESS_CENTRAL_TENANT =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})$/iu;
const BUSINESS_CENTRAL_ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
// Web client pages that are not an environment name (sign-in and link landing pages).
const BUSINESS_CENTRAL_WEB_PAGES = new Set(["signin", "signout", "oauthlanding"]);
// Web client pages that may follow the environment (deep links and device clients).
const BUSINESS_CENTRAL_WEB_CLIENT_PAGES = new Set(["deeplink", "tablet.aspx", "phone.aspx"]);
export const BUSINESS_CENTRAL_API_SCOPE = `https://${BUSINESS_CENTRAL_API_HOST}/Financials.ReadWrite.All`;
/** Every Business Central environment's API is below this root. */
export const BUSINESS_CENTRAL_API_ROOT = `https://${BUSINESS_CENTRAL_API_HOST}/v2.0/`;

const MCP_PATHS: Readonly<
  Record<Exclude<MicrosoftDynamicsProduct, "business_central">, readonly string[]>
> = {
  dataverse: ["/api/mcp", "/api/mcp_preview"],
  finance_operations: ["/mcp"],
};

function productForHost(
  host: string,
): Exclude<MicrosoftDynamicsProduct, "business_central"> | null {
  if (DATAVERSE_HOST.test(host)) return "dataverse";
  if (FINANCE_OPERATIONS_HOST.test(host)) return "finance_operations";
  return null;
}

function parseHttps(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.port && url.port !== "443") return null;
    return url;
  } catch {
    return null;
  }
}

/** A Business Central environment: its tenant (when named) and environment name. */
export type BusinessCentralEnvironment = { tenant: string | null; environment: string };

function businessCentralApiRoot({ tenant, environment }: BusinessCentralEnvironment): string {
  return `https://${BUSINESS_CENTRAL_API_HOST}/v2.0/${tenant ? `${tenant}/` : ""}${environment}/api/v2.0`;
}

/** The environment of a Business Central API URL (`/v2.0/[<tenant>/]<environment>/api/...`). */
function businessCentralApiEnvironment(
  url: URL,
): { environment: BusinessCentralEnvironment; rest: string[] } | null {
  if (url.hostname.toLowerCase() !== BUSINESS_CENTRAL_API_HOST) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "v2.0") return null;
  const tenanted = segments[3] === "api";
  if (!tenanted && segments[2] !== "api") return null;
  const tenant = tenanted ? segments[1]!.toLowerCase() : null;
  const environment = segments[tenanted ? 2 : 1] ?? "";
  if (tenant !== null && !BUSINESS_CENTRAL_TENANT.test(tenant)) return null;
  if (!BUSINESS_CENTRAL_ENVIRONMENT.test(environment)) return null;
  return { environment: { tenant, environment }, rest: segments.slice(tenanted ? 4 : 3) };
}

/** The tenant and environment of a Business Central connection URL, or null. */
export function businessCentralEnvironment(mcpUrl: string): BusinessCentralEnvironment | null {
  if (microsoftDynamicsProductForMcpUrl(mcpUrl) !== "business_central") return null;
  return businessCentralApiEnvironment(new URL(mcpUrl))?.environment ?? null;
}

/**
 * The API root (with its trailing slash) of a Business Central connection
 * URL, or null for any other URL. The Business Central tools run below it.
 */
export function businessCentralApiBase(mcpUrl: string): string | null {
  return microsoftDynamicsProductForMcpUrl(mcpUrl) === "business_central" ? `${mcpUrl}/` : null;
}

/**
 * How a person recognizes a Dynamics connection's environment: its host, or
 * for Business Central its web client address. Null for any other URL.
 */
export function microsoftDynamicsEnvironmentAddress(mcpUrl: string): string | null {
  const product = microsoftDynamicsProductForMcpUrl(mcpUrl);
  if (!product) return null;
  if (product !== "business_central") return new URL(mcpUrl).hostname;
  const { tenant, environment } = businessCentralEnvironment(mcpUrl)!;
  return `${BUSINESS_CENTRAL_WEB_HOST}/${tenant ? `${tenant}/` : ""}${environment}`;
}

/** What to paste instead of a Business Central address that can't be read unambiguously. */
const BUSINESS_CENTRAL_ADDRESS_HINT = `Paste the address from the browser's address bar while Business Central is open (${BUSINESS_CENTRAL_WEB_HOST}/<tenant ID>/<environment>), or ${BUSINESS_CENTRAL_WEB_HOST}/<tenant>.onmicrosoft.com/<environment>.`;

/**
 * A Business Central address: its connection URL, or why it can't be read
 * unambiguously. Null when the address is not on a Business Central host.
 */
type BusinessCentralAddress = { mcpUrl: string } | { problem: string };

/**
 * The connection URL for a Business Central address: the web client
 * (`businesscentral.dynamics.com/[<tenant>/][<environment>][/deeplink]?company=…`;
 * a missing environment is the default `Production`) or any API URL of the
 * environment. Connections are per environment; tools name the company.
 *
 * No part of the path is ever ignored: a first segment that is neither a
 * tenant ID nor a domain, but is followed by more, is refused rather than
 * guessed (taking it as the environment would drop the real one).
 */
function businessCentralAddress(url: URL): BusinessCentralAddress | null {
  const host = url.hostname.toLowerCase();
  if (host === BUSINESS_CENTRAL_API_HOST) {
    const parsed = businessCentralApiEnvironment(url);
    if (!parsed || (parsed.rest[0] && parsed.rest[0] !== "v2.0"))
      return {
        problem: `That Business Central API address isn't one an environment can be read from (only the standard API, /v2.0/<tenant>/<environment>/api/v2.0, is). ${BUSINESS_CENTRAL_ADDRESS_HINT}`,
      };
    return { mcpUrl: businessCentralApiRoot(parsed.environment) };
  }
  if (host !== BUSINESS_CENTRAL_WEB_HOST) return null;
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  const isClientPage = (segment: string | undefined) =>
    segment !== undefined && BUSINESS_CENTRAL_WEB_CLIENT_PAGES.has(segment.toLowerCase());
  let tenant: string | null = null;
  // A web client page (tablet.aspx) looks like a domain but is never a tenant.
  if (segments[0] && !isClientPage(segments[0]) && BUSINESS_CENTRAL_TENANT.test(segments[0])) {
    tenant = segments.shift()!.toLowerCase();
  } else if (segments.length > 1 && !(segments.length === 2 && isClientPage(segments[1]))) {
    return {
      problem: `In that Business Central address, "${segments[0]}" isn't a tenant ID or domain, so the environment after it can't be used. ${BUSINESS_CENTRAL_ADDRESS_HINT}`,
    };
  } else {
    const queryTenant = url.searchParams.get("tenant")?.trim().toLowerCase() ?? "";
    if (BUSINESS_CENTRAL_TENANT.test(queryTenant)) tenant = queryTenant;
  }
  const environment = segments.shift() ?? BUSINESS_CENTRAL_DEFAULT_ENVIRONMENT;
  if (
    !BUSINESS_CENTRAL_ENVIRONMENT.test(environment) ||
    BUSINESS_CENTRAL_WEB_PAGES.has(environment.toLowerCase()) ||
    isClientPage(environment)
  )
    return {
      problem: `That Business Central address doesn't name an environment. ${BUSINESS_CENTRAL_ADDRESS_HINT}`,
    };
  if (segments.length > 1 || (segments.length === 1 && !isClientPage(segments[0])))
    return {
      problem: `That Business Central address has more after the environment "${environment}" than an environment address has. ${BUSINESS_CENTRAL_ADDRESS_HINT}`,
    };
  return { mcpUrl: businessCentralApiRoot({ tenant, environment }) };
}

/** The Dynamics product an exact connection URL belongs to, or null. */
export function microsoftDynamicsProductForMcpUrl(mcpUrl: string): MicrosoftDynamicsProduct | null {
  const url = parseHttps(mcpUrl);
  if (!url || url.search || url.hash) return null;
  if (url.hostname.toLowerCase() === BUSINESS_CENTRAL_API_HOST) {
    const parsed = businessCentralApiEnvironment(url);
    // Only the canonical API root: lowercase tenant, no trailing slash.
    return parsed && `${url.origin}${url.pathname}` === businessCentralApiRoot(parsed.environment)
      ? "business_central"
      : null;
  }
  const product = productForHost(url.hostname.toLowerCase());
  if (!product) return null;
  const path = url.pathname.replace(/\/+$/u, "");
  return MCP_PATHS[product].includes(path) ? product : null;
}

function parseEnvironmentAddress(environmentUrl: string): URL | null {
  const trimmed = environmentUrl.trim();
  if (!trimmed) return null;
  return parseHttps(/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
}

/**
 * The MCP endpoint for an environment URL as a person would copy it from
 * their browser (any page of the environment, with or without `https://`),
 * or null when it is not a recognized Dynamics environment.
 */
export function microsoftDynamicsMcpEndpoint(
  environmentUrl: string,
): { product: MicrosoftDynamicsProduct; mcpUrl: string } | null {
  const url = parseEnvironmentAddress(environmentUrl);
  if (!url) return null;
  const businessCentral = businessCentralAddress(url);
  if (businessCentral)
    return "mcpUrl" in businessCentral
      ? { product: "business_central", mcpUrl: businessCentral.mcpUrl }
      : null;
  const host = url.hostname.toLowerCase();
  const product = productForHost(host);
  if (!product) return null;
  const path = url.pathname.replace(/\/+$/u, "");
  const mcpPath = MCP_PATHS[product].includes(path) ? path : MCP_PATHS[product][0]!;
  return { product, mcpUrl: `https://${host}${mcpPath}` };
}

/**
 * Why an address on a Dynamics product's own host can't be turned into its
 * connection URL, in words to show the person (with what to paste instead),
 * or null when it can be, or when it is not such an address.
 */
export function microsoftDynamicsAddressProblem(environmentUrl: string): string | null {
  const url = parseEnvironmentAddress(environmentUrl);
  if (!url) return null;
  const businessCentral = businessCentralAddress(url);
  return businessCentral && "problem" in businessCentral ? businessCentral.problem : null;
}

/**
 * Delegated Microsoft Entra scope for a Dynamics endpoint. Dataverse tools run
 * against the environment's Web API, which needs `user_impersonation` on the
 * environment's resource. Finance and Operations asks for every permission
 * the app has been granted on its environment (`.default`). Business Central
 * has one resource for every environment.
 */
export function microsoftDynamicsDefaultScope(mcpUrl: string): string | null {
  const product = microsoftDynamicsProductForMcpUrl(mcpUrl);
  if (!product) return null;
  if (product === "business_central") return BUSINESS_CENTRAL_API_SCOPE;
  const origin = new URL(mcpUrl).origin;
  return product === "dataverse" ? `${origin}/user_impersonation` : `${origin}/.default`;
}

/**
 * The Dataverse Web API root for a Dataverse MCP endpoint, or null for any
 * other URL. The Dataverse tools run against this API with the connection's
 * grant.
 */
export function dataverseWebApiBase(mcpUrl: string): string | null {
  if (microsoftDynamicsProductForMcpUrl(mcpUrl) !== "dataverse") return null;
  return `${new URL(mcpUrl).origin}${DATAVERSE_WEB_API_PATH}`;
}

export const DATAVERSE_WEB_API_PATH = "/api/data/v9.2/";

/** Finance and Operations data entities (OData) and their JSON metadata service. */
export const FINANCE_OPERATIONS_DATA_PATH = "/data/";
export const FINANCE_OPERATIONS_METADATA_PATH = "/Metadata/";

/**
 * The environment origin of a Finance and Operations MCP endpoint, or null for
 * any other URL. The Finance and Operations tools run against the
 * environment's OData data entities (`/data/`) and metadata service
 * (`/Metadata/`) with the connection's grant.
 */
export function financeOperationsOrigin(mcpUrl: string): string | null {
  if (microsoftDynamicsProductForMcpUrl(mcpUrl) !== "finance_operations") return null;
  return new URL(mcpUrl).origin;
}

/** The agent-facing catalog entry that leads to a Microsoft Dynamics Connect card. */
export const MICROSOFT_DYNAMICS_CAPABILITY_ID = "api:microsoft-dynamics";

/** The name a Microsoft Dynamics connection is given when a person connects one. */
export const MICROSOFT_DYNAMICS_CONNECTION_NAME = "Microsoft Dynamics";

/**
 * The endpoint to store for a remote MCP address a person or agent supplied:
 * a Dynamics environment address (any page of it) becomes the environment's
 * MCP endpoint; anything else is returned unchanged.
 */
export function canonicalMcpEndpointUrl(endpointUrl: string): string {
  return microsoftDynamicsMcpEndpoint(endpointUrl)?.mcpUrl ?? endpointUrl;
}
