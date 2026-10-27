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
   agent sends to Opengeni's own host as a remote MCP server names the calling
   workspace in a signed header, so the endpoint can keep EU-only content out
   of a non-EU workspace (docs/organization-tenancy.md). A request that can't
   be signed isn't sent.
   -------------------------------------------------------------------------- */

export class CallingWorkspaceProofUnavailableError extends Error {
  constructor() {
    super(
      "Nothing was sent: this MCP server is Opengeni itself, and Opengeni couldn't name the calling workspace.",
    );
    this.name = "CallingWorkspaceProofUnavailableError";
  }
}

function host(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw.replaceAll("{workspaceId}", "w")).host.toLowerCase();
  } catch {
    return null;
  }
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
    const each = host(raw);
    if (each) hosts.add(each);
  }
  return hosts;
}

/**
 * The request init to send to a remote MCP server: unchanged for any other
 * host; for Opengeni's own host, with the signed calling-workspace header
 * (replacing any configured one). Throws when it can't be signed.
 */
export async function withCallingWorkspaceProof(
  settings: Settings,
  caller: { accountId?: string | undefined; workspaceId?: string | undefined },
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<RequestInit | undefined> {
  const target = host(input instanceof Request ? input.url : String(input));
  if (!target || !opengeniOwnHosts(settings).has(target)) return init;
  const secret = resolveFirstPartyDelegationSecret(settings);
  if (!secret || !caller.accountId || !caller.workspaceId)
    throw new CallingWorkspaceProofUnavailableError();
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set(
    OPENGENI_CALLING_WORKSPACE_HEADER,
    await signCallingWorkspaceProof(secret, {
      accountId: caller.accountId,
      workspaceId: caller.workspaceId,
    }),
  );
  return { ...init, headers };
}
