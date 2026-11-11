/**
 * Microsoft Dynamics MCP endpoints. Each customer environment has its own
 * host, so one reviewed connection recognizes the product from the URL and
 * turns an environment URL a person pastes into its MCP endpoint.
 *
 * Only Microsoft's commercial cloud is recognized: sovereign clouds use other
 * sign-in authorities.
 */

export type MicrosoftDynamicsProduct = "dataverse" | "finance_operations";

export const MICROSOFT_DYNAMICS_PRODUCT_LABELS: Readonly<Record<MicrosoftDynamicsProduct, string>> =
  {
    dataverse: "Dynamics 365 Sales and Dataverse",
    finance_operations: "Dynamics 365 Finance and Operations",
  };

// Dataverse (Dynamics 365 Sales, Customer Service, Power Apps): <org>.crm[N].dynamics.com
const DATAVERSE_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.crm\d*\.dynamics\.com$/u;
// Finance and Operations: <env>[.sandbox].operations.dynamics.com, or a cloud-hosted
// development environment on cloudax.dynamics.com.
const FINANCE_OPERATIONS_HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:operations|cloudax)\.dynamics\.com$/u;

const MCP_PATHS: Readonly<Record<MicrosoftDynamicsProduct, readonly string[]>> = {
  dataverse: ["/api/mcp", "/api/mcp_preview"],
  finance_operations: ["/mcp"],
};

function productForHost(host: string): MicrosoftDynamicsProduct | null {
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

/** The Dynamics product an exact MCP endpoint belongs to, or null. */
export function microsoftDynamicsProductForMcpUrl(mcpUrl: string): MicrosoftDynamicsProduct | null {
  const url = parseHttps(mcpUrl);
  if (!url || url.search || url.hash) return null;
  const product = productForHost(url.hostname.toLowerCase());
  if (!product) return null;
  const path = url.pathname.replace(/\/+$/u, "");
  return MCP_PATHS[product].includes(path) ? product : null;
}

/**
 * The MCP endpoint for an environment URL as a person would copy it from
 * their browser (any page of the environment, with or without `https://`),
 * or null when it is not a recognized Dynamics environment.
 */
export function microsoftDynamicsMcpEndpoint(
  environmentUrl: string,
): { product: MicrosoftDynamicsProduct; mcpUrl: string } | null {
  const trimmed = environmentUrl.trim();
  if (!trimmed) return null;
  const url = parseHttps(
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`,
  );
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const product = productForHost(host);
  if (!product) return null;
  const path = url.pathname.replace(/\/+$/u, "");
  const mcpPath = MCP_PATHS[product].includes(path) ? path : MCP_PATHS[product][0]!;
  return { product, mcpUrl: `https://${host}${mcpPath}` };
}

/**
 * Delegated Microsoft Entra scope for a Dynamics endpoint. Dataverse tools run
 * against the environment's Web API, which needs `user_impersonation` on the
 * environment's resource. Finance and Operations asks for every permission
 * the app has been granted on its environment (`.default`).
 */
export function microsoftDynamicsDefaultScope(mcpUrl: string): string | null {
  const product = microsoftDynamicsProductForMcpUrl(mcpUrl);
  if (!product) return null;
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
