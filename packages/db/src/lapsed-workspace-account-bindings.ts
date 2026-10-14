import type { McpConnectionAccountBinding } from "@opengeni/contracts";
import { and, eq } from "drizzle-orm";
import { withWorkspaceRls, type Database } from "./database";
import * as schema from "./schema";

/** A shared account a prompt runs without, and why. Internal turn metadata only. */
export type LapsedWorkspaceAccountGap = {
  serverId: string;
  connectionId: string;
  reason: "account_not_visible" | "account_inactive" | "account_mismatch";
};

/**
 * Drop shared workspace accounts that can no longer be used from accounts a
 * prompt copies instead of resolving afresh: a voice session's accounts (frozen
 * when voice started, possibly days before its last words are handed off) and
 * an edited prompt's accounts (frozen when it was first sent).
 *
 * The turn fence admits a new turn only while each shared account it carries
 * is still the same live account. A copied account that was disconnected or
 * reconnected since would make the fence refuse the whole insert; in a work
 * claim that refusal rolls back and blocks the chat on every later message.
 * Running without that connector is what the person's next message would do
 * anyway, so the prompt keeps every other account and records the gap.
 *
 * This only narrows: nothing is added or replaced, personal accounts are left
 * to their own fence (a lapsed owner account is already accepted without
 * authority), and the fence still checks everything kept. The checks mirror
 * `fence_mcp_account_bindings`.
 */
export async function withoutLapsedWorkspaceAccountBindings(
  db: Database,
  workspaceId: string,
  bindings: McpConnectionAccountBinding[] | null,
): Promise<{ bindings: McpConnectionAccountBinding[] | null; gaps: LapsedWorkspaceAccountGap[] }> {
  if (!bindings?.some((binding) => binding.subjectScope === "workspace")) {
    return { bindings, gaps: [] };
  }
  const kept: McpConnectionAccountBinding[] = [];
  const gaps: LapsedWorkspaceAccountGap[] = [];
  // `db` may be one bounded transaction: these reads must not overlap.
  for (const binding of bindings) {
    if (binding.subjectScope !== "workspace") {
      kept.push(binding);
      continue;
    }
    const connection = await withWorkspaceRls(db, workspaceId, async (scopedDb) => {
      const [row] = await scopedDb
        .select({
          workspaceId: schema.connections.workspaceId,
          originWorkspaceId: schema.connections.originWorkspaceId,
          authorityScope: schema.connections.authorityScope,
          status: schema.connections.status,
          providerDomain: schema.connections.providerDomain,
          kind: schema.connections.kind,
          authorityGeneration: schema.connections.authorityGeneration,
        })
        .from(schema.connections)
        .where(
          and(
            eq(schema.connections.workspaceId, workspaceId),
            eq(schema.connections.id, binding.connectionId),
          ),
        )
        .limit(1);
      return row ?? null;
    });
    const reason: LapsedWorkspaceAccountGap["reason"] | null = !connection
      ? "account_not_visible"
      : connection.status !== "active"
        ? "account_inactive"
        : binding.originWorkspaceId !== workspaceId ||
            connection.authorityScope !== "workspace" ||
            connection.originWorkspaceId !== workspaceId ||
            connection.providerDomain.toLowerCase() !== binding.providerDomain.toLowerCase() ||
            connection.kind !== binding.kind ||
            binding.connectionAuthorityGeneration !== connection.authorityGeneration
          ? "account_mismatch"
          : null;
    if (reason) {
      gaps.push({ serverId: binding.serverId, connectionId: binding.connectionId, reason });
    } else {
      kept.push(binding);
    }
  }
  return { bindings: kept, gaps };
}
