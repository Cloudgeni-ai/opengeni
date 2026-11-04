/** Public shared Skill folder/history shapes; no runtime contracts dependency. */
export type SkillFile = { path: string; content: string };
export type SkillScope = "workspace" | "organization" | "user";
/**
 * Where an organization Skill works: every shared workspace of the
 * organization (`allowedWorkspaceIds: null`, new ones too) or the listed ones,
 * and members' Personal workspaces when `allowPersonalWorkspaces` is on.
 */
export type OrganizationSkillReach = {
  allowedWorkspaceIds: string[] | null;
  allowPersonalWorkspaces: boolean;
};
export type SkillRecord = {
  removalOperationId?: string | null;
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
  /** Where an organization Skill works; null for workspace and personal Skills. */
  reach?: OrganizationSkillReach | null;
  /**
   * Whether agents in the workspace that was asked use it. False only for an
   * organization Skill that doesn't work there, which the Skills page still
   * lists so its managers can change that.
   */
  availableHere?: boolean;
};
export type SkillSummary = Omit<SkillRecord, "files">;
export type SkillWriteReceipt = {
  removed?: boolean | undefined;
  operationId: string;
  skillId: string;
  revisionId: string;
  outcome: "applied" | "pending" | "preserved";
  pendingReason?: "approval" | "source_finalization" | undefined;
  replayed: boolean;
  decision?: "rejected" | undefined;
  skillReview?: import("./types").SkillReviewReference | undefined;
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
  removalOperationId?: string;
  operationId: string;
  revisionId: string;
  expectedRevisionId: string | null;
  expectedScopeVersion: number;
  reason: string;
};

export type RemoveWorkspaceSkillRequest = {
  operationId: string;
  expectedRevisionId: string | null;
  expectedScopeVersion: number;
  reason: string;
};
