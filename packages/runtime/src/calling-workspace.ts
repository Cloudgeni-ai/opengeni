import {
  firstPartyMcpBaseUrl,
  firstPartyMcpInternalBaseUrl,
  resolveFirstPartyDelegationSecret,
  type Settings,
} from "@opengeni/config";
import { OPENGENI_CALLING_WORKSPACE_HEADER, signCallingWorkspaceProof } from "@opengeni/contracts";

/* ----------------------------------------------------------------------------
   Opengeni's own MCP endpoints can be added to a workspace as a remote MCP
   server and authorized for another organization. Every request a workspace
   agent sends to Opengeni as a remote MCP server (its own host however
   spelled, or carrying an Opengeni API key) names the calling workspace in a
   signed header, so the endpoint can keep EU-only content out of a non-EU
   workspace (docs/organization-tenancy.md). A request that can't be signed
   isn't sent.
   -------------------------------------------------------------------------- */

export class CallingWorkspaceProofUnavailableError extends Error {
  constructor() {
    super(
      "Nothing was sent: this MCP server is Opengeni itself, and Opengeni couldn't name the calling workspace.",
    );
    this.name = "CallingWorkspaceProofUnavailableError";
  }
}

/**
 * A URL's host as this deployment compares it: lowercase, percent-decoded (the
 * URL parser does both), without trailing dots, with a non-default port.
 */
export function normalizedUrlHost(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.replaceAll("{workspaceId}", "w"));
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
    if (!hostname) return null;
    return url.port ? `${hostname}:${url.port}` : hostname;
  } catch {
    return null;
  }
}

/**
 * An Opengeni organization (`ogk_`) or personal (`ogp_`) API key, or an
 * Opengeni MCP OAuth token (`ogmcp_at_`, `ogmcp_rt_`).
 */
const OPENGENI_KEY = /\bog(?:[kp]|mcp_at|mcp_rt)_[A-Za-z0-9_-]{8,}/;

/** Whether a request carries an Opengeni API key, so it is bound for Opengeni wherever it goes. */
export function carriesOpengeniKey(url: string, headers: Headers): boolean {
  if (OPENGENI_KEY.test(url)) return true;
  for (const [name, value] of headers) {
    if (name === OPENGENI_CALLING_WORKSPACE_HEADER) continue;
    if (OPENGENI_KEY.test(value)) return true;
  }
  return false;
}

/** The hosts (with port) this deployment serves its own API and MCP endpoints on. */
export function opengeniOwnHosts(settings: Settings): Set<string> {
  const hosts = new Set<string>();
  for (const raw of [
    settings.publicBaseUrl,
    settings.webhookBaseUrl,
    settings.opengeniMcpUrl,
    settings.opengeniMcpInternalUrl,
    firstPartyMcpBaseUrl(settings),
    firstPartyMcpInternalBaseUrl(settings),
  ]) {
    const each = normalizedUrlHost(raw);
    if (each) hosts.add(each);
  }
  return hosts;
}

/**
 * The request init to send to a remote MCP server: unchanged for any other
 * server; for Opengeni itself (its own host, however spelled, or any request
 * carrying an Opengeni API key), with the signed calling-workspace header,
 * replacing any configured one. Throws when it can't be signed.
 */
export async function withCallingWorkspaceProof(
  settings: Settings,
  caller: { accountId?: string | undefined; workspaceId?: string | undefined },
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<RequestInit | undefined> {
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const target = normalizedUrlHost(url);
  const opengeni =
    (target !== null && opengeniOwnHosts(settings).has(target)) || carriesOpengeniKey(url, headers);
  if (!opengeni) return init;
  const secret = resolveFirstPartyDelegationSecret(settings);
  if (!secret || !caller.accountId || !caller.workspaceId)
    throw new CallingWorkspaceProofUnavailableError();
  headers.set(
    OPENGENI_CALLING_WORKSPACE_HEADER,
    await signCallingWorkspaceProof(secret, {
      accountId: caller.accountId,
      workspaceId: caller.workspaceId,
    }),
  );
  return { ...init, headers };
}
