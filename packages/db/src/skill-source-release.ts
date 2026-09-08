import type { SkillActor } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, withWorkspaceSubjectRls, type Database } from "./database";
import { deactivatePreferenceRegistry } from "./preference-registry";

export type SkillSourceReleaseReceipt = {
  skillId: string;
  revisionId: string | null;
  disposition: "deactivated" | "preserved" | "inactive";
  eventId: string | null;
  warning: string | null;
};

/**
 * Called inside the source-owner removal transaction, with source installations
 * locked. Distribution identity/history stays bound after uninstall, so reinstall
 * finds the same head. This is not a new service/API-key governance authority.
 */
export async function releaseOrphanedSkillHeads(
  db: Database,
  input: { workspaceId: string; facetInstallationIds: readonly string[]; skillActor?: SkillActor },
): Promise<SkillSourceReleaseReceipt[]> {
  if (!input.facetInstallationIds.length) return [];
  const bindings = await rawRows<{ id: string }>(
    db,
    sql`
    SELECT DISTINCT b.preference_id AS id FROM skill_source_bindings b
    JOIN capability_facet_installations fi ON fi.facet_id=b.skill_facet_id
      AND fi.account_id=b.account_id AND fi.workspace_id=b.workspace_id
    WHERE b.workspace_id=${input.workspaceId}::uuid
      AND fi.id=ANY(string_to_array(${input.facetInstallationIds.join(",")},',')::uuid[])
    ORDER BY b.preference_id
  `,
  );
  if (!bindings.length) return [];
  const actor = input.skillActor;
  if (actor?.kind !== "human" || actor.principalKind !== "human_session") {
    throw new Error(
      "Skill source removal requires a trusted human session actor; service/API-key and agent removal are unsupported",
    );
  }
  return withWorkspaceSubjectRls(db, input.workspaceId, actor.subjectId, async (tx) => {
    // The established definer lock capability accepts at most two heads; acquire
    // individual heads in canonical order rather than widening its authority.
    for (const binding of bindings) {
      await tx.execute(
        sql`SELECT preference_id FROM preference_registry_lock_heads(ARRAY[${binding.id}::uuid])`,
      );
    }
    const rows = await rawRows<{
      id: string;
      account_id: string;
      scope: string;
      scope_workspace_id: string | null;
      scope_version: number;
      status: string;
      active_revision_id: string | null;
      provenance_source: string | null;
    }>(
      tx,
      sql`
      SELECT h.id,h.account_id,h.scope,h.scope_workspace_id,h.scope_version,h.status,h.active_revision_id,r.provenance_source
      FROM preference_registry_preferences h LEFT JOIN preference_registry_revisions r
        ON r.id=h.active_revision_id AND r.preference_id=h.id AND r.account_id=h.account_id
      WHERE h.id=ANY(string_to_array(${bindings.map((binding) => binding.id).join(",")},',')::uuid[])
      ORDER BY h.id
    `,
    );
    const receipts: SkillSourceReleaseReceipt[] = [];
    for (const head of rows) {
      if (head.status !== "active" || !head.active_revision_id) {
        receipts.push({
          skillId: head.id,
          revisionId: head.active_revision_id,
          disposition: "inactive",
          eventId: null,
          warning: null,
        });
      } else if (
        head.provenance_source !== "portable_skill" ||
        head.scope !== "workspace" ||
        head.scope_workspace_id !== input.workspaceId
      ) {
        receipts.push({
          skillId: head.id,
          revisionId: head.active_revision_id,
          disposition: "preserved",
          eventId: null,
          warning: "The source was removed, but the customized or re-scoped Skill remains active.",
        });
      } else {
        const result = await deactivatePreferenceRegistry(tx, {
          accountId: head.account_id,
          workspaceId: input.workspaceId,
          actorSubjectId: actor.subjectId,
          principalKind: actor.principalKind,
          preferenceId: head.id,
          expectedCurrentRevisionId: head.active_revision_id,
          expectedScopeVersion: head.scope_version,
          authorizeScope: (scope) => {
            if (scope !== "workspace")
              throw new Error("Source removal cannot deactivate a non-workspace Skill");
          },
          reason: "Deactivate source-managed Skill after its final distribution owner was removed",
        });
        receipts.push({
          skillId: head.id,
          revisionId: head.active_revision_id,
          disposition: "deactivated",
          eventId: result.event.id,
          warning: null,
        });
      }
    }
    return receipts;
  });
}
