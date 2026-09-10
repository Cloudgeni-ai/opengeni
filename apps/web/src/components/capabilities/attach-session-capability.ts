import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { FirstPartyMcpToolName } from "@opengeni/sdk";
import type { CapabilityCatalogItem } from "@/types";

/** A connection never resets the human's existing tool selection. Default-mode
 * sessions discover newly enabled servers at admission; explicit/inherited
 * policies add only this reviewed capability, with the existing CAS fence. */
export async function attachSessionCapability(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  sessionId: string,
  item: CapabilityCatalogItem,
  stillCurrent: () => boolean = () => true,
): Promise<void> {
  if (item.kind === "skill" || item.tools.length === 0) return;
  if (!stillCurrent()) throw new Error("Connection setup was interrupted.");
  const session = await client.getSession(workspaceId, sessionId);
  if (!stillCurrent()) throw new Error("Connection setup was interrupted.");
  let existing = session.tools;
  if (session.toolPolicy.mode === "workspace_default") {
    const policy = session.effectiveToolPolicy;
    if (!policy || policy.idsTruncated)
      throw new Error(
        "Connected, but the full session tool selection could not be read. Review the Tools picker before continuing.",
      );
    // A workspace may choose a restricted default instead of all enabled servers.
    // Preserve that exact selection if this connection needs an explicit addition.
    existing = policy.selectedIds.map((id) => ({ kind: "mcp" as const, id }));
  }
  const additions = item.tools.filter(
    (tool) => !existing.some((current) => current.kind === tool.kind && current.id === tool.id),
  );
  const recommended = Array.isArray(item.metadata?.firstPartyMcpTools)
    ? (item.metadata.firstPartyMcpTools.filter(
        (name): name is string => typeof name === "string",
      ) as FirstPartyMcpToolName[])
    : [];
  const firstParty = [...new Set([...session.firstPartyMcpTools, ...recommended])];
  if (additions.length === 0 && firstParty.length === session.firstPartyMcpTools.length) return;
  await client.updateSessionToolPolicy(workspaceId, sessionId, {
    mode: "explicit",
    tools: [...existing, ...additions],
    firstPartyMcpTools: firstParty,
    expectedVersion: session.toolPolicyVersion,
  });
}
