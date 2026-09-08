import { z } from "zod";

/** Files are UTF-8 text, relative to the Skill root. No executable authority. */
export const SkillFile = z.object({ path: z.string().min(1).max(512), content: z.string() });
export type SkillFile = z.infer<typeof SkillFile>;
export const SkillActor = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("human"),
    subjectId: z.string().min(1),
    principalKind: z.literal("human_session"),
  }),
  z.object({
    kind: z.literal("agent"),
    sessionId: z.uuid(),
    turnId: z.uuid(),
    attemptId: z.uuid(),
    executionGeneration: z.number().int().positive(),
  }),
]);
export type SkillActor = z.infer<typeof SkillActor>;
export type SkillScope = "workspace" | "organization" | "user";
export type SkillWriteContext = { accountId: string; workspaceId: string; actor: SkillActor };
export type SkillSaveInput = SkillWriteContext & {
  operationId: string;
  skillId: string;
  expectedRevisionId: string | null;
  expectedScopeVersion: number;
  stableKey: string;
  title: string;
  description: string;
  files: SkillFile[];
  scope?: SkillScope;
  reason: string;
};
export type SkillRevisionInput = SkillWriteContext & {
  operationId: string;
  skillId: string;
  revisionId: string;
  expectedRevisionId: string | null;
  expectedScopeVersion: number;
  reason: string;
};
export type SkillInstallInput = SkillWriteContext & {
  operationId: string;
  skillFacetId: string;
  reason: string;
};
export const SkillWriteReceipt = z.object({
  operationId: z.uuid(),
  skillId: z.uuid(),
  revisionId: z.uuid(),
  outcome: z.enum(["applied", "pending", "preserved"]),
  replayed: z.boolean(),
});
export type SkillWriteReceipt = z.infer<typeof SkillWriteReceipt>;
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
