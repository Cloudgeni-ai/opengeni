/** Public shared Skill folder/history shapes; no runtime contracts dependency. */
export type SkillFile = { path: string; content: string };
export type SkillScope = "workspace" | "organization" | "user";
export type SkillRecord = {
  activationMode: "workspace_managed" | "session_selected";
  pendingRevisionIds: string[];
  id: string;
  stableKey: string;
  scope: SkillScope;
  scopeVersion: number;
  status: string;
  activeRevisionId: string | null;
  revisionId: string | null;
  title: string | null;
  description: string | null;
  contentHash: string | null;
  files: SkillFile[];
  source: { pluginId: string; facetKey: string; skillFacetId: string } | null;
};
export type SkillSummary = Omit<SkillRecord, "files">;
export type SkillWriteReceipt = {
  operationId: string;
  skillId: string;
  revisionId: string;
  outcome: "applied" | "pending" | "preserved";
  pendingReason?: "approval" | "source_finalization" | undefined;
  replayed: boolean;
};
export type SkillPublicationReceipt = SkillWriteReceipt & {
  sourceOperationId: string;
  activationEventId: string | null;
};
export type SkillSourceReleaseReceipt = {
  skillId: string;
  revisionId: string | null;
  disposition: "deactivated" | "preserved" | "inactive";
  eventId: string | null;
  warning: string | null;
};
export type SaveWorkspaceSkillRequest = {
  operationId: string;
  skillId: string;
  expectedRevisionId: string | null;
  expectedScopeVersion: number;
  scope?: SkillScope;
  stableKey: string;
  files: SkillFile[];
  deletions?: string[];
  reason: string;
};
export type ApplyWorkspaceSkillRevisionRequest = {
  operationId: string;
  revisionId: string;
  expectedRevisionId: string | null;
  expectedScopeVersion: number;
  reason: string;
};
