import type {
  PreferenceRegistrySnapshot,
  ResolvedCompanyProfileSnapshot,
  ResolvedWorkspaceInstructionPolicySnapshot,
  WorkspaceMemoryPromptMode,
} from "@opengeni/contracts";
import { composeRuntimeSkills, type RuntimeSkillActivation } from "@opengeni/runtime";

export type CompanyBrainContributionCategory =
  | "mandatory_rule"
  | "skill_guide_descriptor"
  | "retrieved_knowledge"
  | "task_note";

export type CompanyBrainContribution = Readonly<{
  category: CompanyBrainContributionCategory;
  source:
    | "workspace_instruction_policy"
    | "legacy_workspace_instructions"
    | "preference_registry_descriptor"
    | "company_profile"
    | "legacy_memory_v1"
    | "runtime_skill_catalog";
  inclusionReason:
    | "active_instruction_policy"
    | "legacy_instruction_fallback"
    | "active_preference_descriptor"
    | "active_company_profile_root"
    | "legacy_standing_working_set"
    | "authorized_skill_descriptor";
  authorityScope: "organization" | "workspace" | "user" | "session";
  utf8Bytes: number;
  estimatedTokens: number;
}>;

export type CompanyBrainContributionReceipt = Readonly<{
  attemptId: string;
  turnId: string;
  sessionRole: "root" | "child";
  memoryPromptMode: WorkspaceMemoryPromptMode;
  instructionPolicySnapshotId: string;
  preferenceSnapshotId: string | null;
  companyProfileSnapshotId: string;
  contributions: readonly CompanyBrainContribution[];
}>;

/**
 * Build a content-free exact-attempt receipt for the Company Brain material
 * selected before inference. Token counts are deliberately estimates (UTF-8
 * bytes / 4); provider-accounted total input tokens remain the separate source
 * of truth for billing and context pressure.
 */
export function buildCompanyBrainContributionReceipt(input: {
  attemptId: string;
  turnId: string;
  nestedAgentDepth: number;
  memoryPromptMode: WorkspaceMemoryPromptMode;
  instructionPolicy: ResolvedWorkspaceInstructionPolicySnapshot;
  workspaceAgentInstructions: string | null;
  preferences: PreferenceRegistrySnapshot | null;
  companyProfile: ResolvedCompanyProfileSnapshot;
  companyProfileIncluded: boolean;
  workspaceMemory: string | null;
  skillActivations: readonly RuntimeSkillActivation[];
}): CompanyBrainContributionReceipt {
  const contributions: CompanyBrainContribution[] = [];
  for (const entry of input.instructionPolicy.entries) {
    contributions.push(
      contribution({
        category: "mandatory_rule",
        source: "workspace_instruction_policy",
        inclusionReason: "active_instruction_policy",
        authorityScope: "workspace",
        text: entry.content,
      }),
    );
  }
  if (input.instructionPolicy.entries.length === 0 && input.workspaceAgentInstructions) {
    contributions.push(
      contribution({
        category: "mandatory_rule",
        source: "legacy_workspace_instructions",
        inclusionReason: "legacy_instruction_fallback",
        authorityScope: "workspace",
        text: input.workspaceAgentInstructions,
      }),
    );
  }
  for (const descriptor of input.preferences?.descriptors ?? []) {
    contributions.push(
      contribution({
        category: "skill_guide_descriptor",
        source: "preference_registry_descriptor",
        inclusionReason: "active_preference_descriptor",
        authorityScope: descriptor.scope,
        text: JSON.stringify(descriptor),
      }),
    );
  }
  if (input.companyProfileIncluded && input.companyProfile.profile) {
    contributions.push(
      contribution({
        category: "retrieved_knowledge",
        source: "company_profile",
        inclusionReason: "active_company_profile_root",
        authorityScope: "organization",
        text: JSON.stringify(input.companyProfile.profile.profile),
      }),
    );
  }
  if (input.workspaceMemory?.trim()) {
    contributions.push(
      contribution({
        category: "retrieved_knowledge",
        source: "legacy_memory_v1",
        inclusionReason: "legacy_standing_working_set",
        authorityScope: "workspace",
        text: input.workspaceMemory,
      }),
    );
  }
  for (const descriptor of composeRuntimeSkills(input.skillActivations).configuredDescriptors) {
    contributions.push(
      contribution({
        category: "skill_guide_descriptor",
        source: "runtime_skill_catalog",
        inclusionReason: "authorized_skill_descriptor",
        authorityScope: descriptor.source === "session" ? "session" : "workspace",
        text: descriptor.description,
      }),
    );
  }
  return Object.freeze({
    attemptId: input.attemptId,
    turnId: input.turnId,
    sessionRole: input.nestedAgentDepth === 0 ? "root" : "child",
    memoryPromptMode: input.memoryPromptMode,
    instructionPolicySnapshotId: input.instructionPolicy.id,
    preferenceSnapshotId: input.preferences?.id ?? null,
    companyProfileSnapshotId: input.companyProfile.id,
    contributions: Object.freeze(contributions),
  });
}

function contribution(
  input: Omit<CompanyBrainContribution, "utf8Bytes" | "estimatedTokens"> & {
    text: string;
  },
): CompanyBrainContribution {
  const utf8Bytes = Buffer.byteLength(input.text, "utf8");
  return Object.freeze({
    category: input.category,
    source: input.source,
    inclusionReason: input.inclusionReason,
    authorityScope: input.authorityScope,
    utf8Bytes,
    estimatedTokens: Math.ceil(utf8Bytes / 4),
  });
}
