import { CapabilityPack } from "@opengeni/contracts";
import {
  getWorkspace,
  listInstalledPortableSkills,
  type Database,
} from "@opengeni/db";
import {
  legacySandboxRuntimeFromPacks,
  packInstallationUsesLegacyRuntime,
  resolveWorkspaceLegacyRuntimePacks,
} from "@opengeni/core";
import {
  buildPortableSkillArtifact,
  type InstalledSkillActivation,
  type PackSkillActivation,
  type RuntimeSkillArtifact,
} from "@opengeni/runtime";
export {
  resolveRigProviderImageSelection,
  rigProviderImageSourceImage,
  settingsWithPackSandboxImage,
  settingsWithRigImage,
  settingsWithRigProviderImage,
} from "./sandbox-images";
export { packInstallationUsesLegacyRuntime };

/**
 * Legacy pack-scoped runtime compatibility. V2 Pack installations own ordinary
 * Skill components and select an explicit Rig; they contribute nothing here.
 */
export type WorkspacePackRuntime = {
  sandboxImage: string | null;
  sandboxProviderImages: CapabilityPack["sandboxProviderImages"] | null;
  skillActivations: PackSkillActivation[];
};

const emptyPackRuntime: WorkspacePackRuntime = {
  sandboxImage: null,
  sandboxProviderImages: null,
  skillActivations: [],
};

export type WorkspaceInstalledSkillRuntime = {
  activations: InstalledSkillActivation[];
};

/**
 * Resolves only pre-V2 active Pack installations. A frozen manifest/digest is
 * the protocol marker for V2: inline Skills were migrated into the ordinary
 * Skill ledger and sandboxImage was resolved to selectedRigId during install,
 * so reading either field directly here would duplicate ownership and silently
 * override session compute.
 */
export async function resolveWorkspacePackRuntime(
  db: Database,
  workspaceId: string,
): Promise<WorkspacePackRuntime> {
  const packs = await resolveWorkspaceLegacyRuntimePacks(db, workspaceId);
  if (packs.length === 0) return emptyPackRuntime;
  return workspacePackRuntimeFromPacks(packs);
}

/**
 * Resolves every active immutable Skill through the normalized Plugin/Skill-
 * Facet ledger. The data layer has already filtered ineffective owner edges;
 * this boundary independently verifies exact files before runtime activation.
 */
export async function resolveWorkspaceInstalledSkillRuntime(
  db: Database,
  workspaceId: string,
): Promise<WorkspaceInstalledSkillRuntime> {
  const installedSkills = await listInstalledPortableSkills(db, workspaceId);
  const activations: InstalledSkillActivation[] = [];
  for (const installed of installedSkills) {
    const artifact = buildPortableSkillArtifact(installed.files);
    if (
      artifact.name !== installed.name ||
      artifact.description !== installed.description ||
      artifact.contentSha256 !== installed.contentSha256
    ) {
      throw new Error(
        `Installed Skill artifact verification failed for ${installed.capabilityId}; reinstall it from the pinned source`,
      );
    }
    activations.push({
      source: "installation",
      id: installed.capabilityId,
      artifact: {
        name: artifact.name,
        description: artifact.description,
        files: artifact.files.map((file) => ({ path: file.path, content: file.content })),
      },
      version: installed.version,
      contentSha256: artifact.contentSha256,
      reason:
        installed.source === "library"
          ? "installed from the curated Skill library"
          : installed.source === "pack"
            ? "installed as a Pack-owned Skill"
            : `installed from ${installed.sourceUrl}`,
    });
  }
  return { activations };
}

/**
 * Pure pre-V2 compatibility rule for enabled Pack manifests. At most one
 * legacy Pack may declare a sandbox image, and legacy Skill names must be
 * unique. V2 rows never reach this function through runtime resolution.
 */
export function workspacePackRuntimeFromPacks(packs: CapabilityPack[]): WorkspacePackRuntime {
  const sandboxRuntime = legacySandboxRuntimeFromPacks(packs);
  const skillActivations: PackSkillActivation[] = [];
  // Keyed case-insensitively to match the per-pack uniqueness rule in the
  // CapabilityPack contract (and case-insensitive filesystems).
  const skillOwners = new Map<string, string>();
  for (const pack of [...packs].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const skill of pack.skills) {
      const key = skill.name.toLowerCase();
      const existingOwner = skillOwners.get(key);
      if (existingOwner !== undefined && existingOwner !== pack.id) {
        throw new Error(
          `Enabled packs ${existingOwner} and ${pack.id} both declare a skill named "${skill.name}". Pack skill names must be unique across enabled packs; disable one of the packs and retry.`,
        );
      }
      skillOwners.set(key, pack.id);
      const artifact: RuntimeSkillArtifact = {
        name: skill.name,
        description: skill.description ?? null,
        files: skill.files.map((file) => ({ path: file.path, content: file.content })),
      };
      skillActivations.push({
        source: "pack",
        id: `pack:${pack.id}:${skill.name}`,
        artifact,
        reason: `active legacy Pack ${pack.id}`,
      });
    }
  }
  return {
    sandboxImage: sandboxRuntime.sandboxImage,
    sandboxProviderImages: sandboxRuntime.sandboxProviderImages,
    skillActivations,
  };
}

/**
 * Resolves the per-workspace agent persona override (the white-label surface).
 * Returns the workspace's stored template when set, else null to mean "use the
 * deployment default" (settings.agentInstructionsTemplate). The runtime always
 * injects the non-bypassable CORE regardless, so a null here keeps the
 * byte-identical default and a non-null value only restyles the persona.
 *
 * This is the workspace tier of the session > workspace > deployment-default
 * resolution; per-session overrides do not exist in this slice, so the worker
 * resolves workspace > default and passes the result as instructionsTemplate.
 */
export async function resolveWorkspaceAgentInstructions(
  db: Database,
  workspaceId: string,
): Promise<string | null> {
  const workspace = await getWorkspace(db, workspaceId);
  return workspace?.agentInstructions ?? null;
}

/**
 * Applies a pack-declared sandbox image to run settings. With no pack image
 * the settings pass through untouched, so deployments without packs keep the
 * global OPENGENI_DOCKER_IMAGE / OPENGENI_MODAL_IMAGE_REF behavior exactly.
 */
/**
 * Layers the rig version's default variable sets BELOW the session's own set:
 * the session's values WIN on any key collision (explicit precedence). Both maps
 * are already the decrypted-and-merged values (rig defaults merged in listed
 * order upstream). Pure and deterministic — given the same inputs it returns the
 * same env, which is what keeps a session's box-manifest env stable across turns
 * (the rig version is frozen per session, so its default-set list is fixed).
 */
export function mergeRigDefaultVariableSetEnvironment(
  rigDefaultValues: Record<string, string>,
  sessionValues: Record<string, string>,
): Record<string, string> {
  return { ...rigDefaultValues, ...sessionValues };
}
