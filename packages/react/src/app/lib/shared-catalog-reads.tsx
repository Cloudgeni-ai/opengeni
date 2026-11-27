// Workspace catalog reads kept in the client's shared reads (see
// `fetchSharedQuery`). A small module of its own, so the app shell can read the
// catalog without loading the capability presentation helpers.
import type { ConnectionMetadata } from "../types";
import { fetchSharedQuery } from "../../hooks/shared-query";

/**
 * Read the account inventory `connectionHealth` takes: this workspace's shared
 * accounts and the caller's own accounts from every workspace, inactive ones
 * included for repair. Rejects when the read fails, so callers keep the
 * `loaded` gate.
 *
 * Every read is kept in the client's shared reads; `reuseRecent` (a screen's
 * first read on mount) takes one in flight or a few seconds old instead of
 * sending another, so the composer and its account picker read it once.
 */
export async function loadConnectionHealthAccounts(
  client: {
    listOwnConnectionAccounts: (
      workspaceId: string,
      options: { includeInactive: boolean },
    ) => Promise<ConnectionMetadata[]>;
  },
  workspaceId: string,
  options: { reuseRecent?: boolean | undefined } = {},
): Promise<ConnectionMetadata[]> {
  return await fetchSharedQuery(
    client,
    ["connection-accounts", workspaceId, "include-inactive"],
    async () => await client.listOwnConnectionAccounts(workspaceId, { includeInactive: true }),
    { fresh: options.reuseRecent !== true },
  );
}

/**
 * The workspace's capability catalog, kept in the client's shared reads like
 * `loadConnectionHealthAccounts`: the workspace tool list and the composer's
 * connector list each read it on mount, and `reuseRecent` lets the second take
 * the first's read.
 */
export async function loadWorkspaceCapabilities<Catalog>(
  client: { listCapabilities: (workspaceId: string) => Promise<Catalog> },
  workspaceId: string,
  options: { reuseRecent?: boolean | undefined } = {},
): Promise<Catalog> {
  return await fetchSharedQuery(
    client,
    ["workspace-capabilities", workspaceId],
    async () => await client.listCapabilities(workspaceId),
    { fresh: options.reuseRecent !== true },
  );
}
