export type SkillSourceReleaseHead = {
  id: string;
  account_id: string;
  scope: string;
  scope_workspace_id: string | null;
  scope_version: number;
  status: string;
  active_revision_id: string | null;
  provenance_source: string | null;
  title: string | null;
};

type SkillRetentionReason = "customized" | "re_scoped";

/** One decision for both the user-visible impact and committed source release. */
export function classifySkillSourceRelease(
  head: SkillSourceReleaseHead,
  workspaceId: string,
): {
  disposition: "inactive" | "retained" | "removed";
  retentionReasons: SkillRetentionReason[];
} {
  if (head.status !== "active" || !head.active_revision_id)
    return { disposition: "inactive", retentionReasons: [] };
  const retentionReasons: SkillRetentionReason[] = [];
  if (head.provenance_source !== "portable_skill") retentionReasons.push("customized");
  if (head.scope !== "workspace" || head.scope_workspace_id !== workspaceId)
    retentionReasons.push("re_scoped");
  return {
    disposition: retentionReasons.length ? "retained" : "removed",
    retentionReasons,
  };
}
