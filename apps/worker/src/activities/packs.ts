import type { Settings } from "@opengeni/config";
import { CapabilityPack } from "@opengeni/contracts";
import { getWorkspacePack, listPackInstallations, type Database } from "@opengeni/db";
import type { PackSkill } from "@opengeni/runtime";

/**
 * The pack-scoped runtime for a workspace: the sandbox image its sessions run
 * in (when an enabled pack declares one) and the pack skills that join the
 * sandbox skill index.
 */
export type WorkspacePackRuntime = {
  sandboxImage: string | null;
  skills: PackSkill[];
};

const emptyPackRuntime: WorkspacePackRuntime = { sandboxImage: null, skills: [] };

/**
 * Resolves the pack-scoped runtime from the workspace's active pack
 * installations. Only registered (manifest-backed) packs can contribute a
 * sandbox image or skills; built-in packs never declare either (enforced by a
 * test on the built-in catalog), so their installations are skipped here
 * without consulting the API's built-in pack list.
 */
export async function resolveWorkspacePackRuntime(db: Database, workspaceId: string): Promise<WorkspacePackRuntime> {
  const installations = await listPackInstallations(db, workspaceId);
  const active = installations.filter((installation) => installation.status === "active");
  if (active.length === 0) {
    return emptyPackRuntime;
  }
  const packs: CapabilityPack[] = [];
  for (const installation of active) {
    const registration = await getWorkspacePack(db, workspaceId, installation.packId);
    if (!registration) {
      continue;
    }
    const parsed = CapabilityPack.safeParse(registration.pack);
    if (parsed.success) {
      packs.push(parsed.data);
    }
  }
  return workspacePackRuntimeFromPacks(packs);
}

/**
 * Pure composition rule for enabled pack manifests. v1 keeps this small by
 * design: at most one enabled pack may declare a sandbox image (no image
 * layering or composition), and skill names must be unique across enabled
 * packs. Violations fail the turn with a plain error instead of guessing.
 */
export function workspacePackRuntimeFromPacks(packs: CapabilityPack[]): WorkspacePackRuntime {
  const imagePacks = packs.filter((pack) => typeof pack.sandboxImage === "string" && pack.sandboxImage.trim().length > 0);
  if (imagePacks.length > 1) {
    const ids = imagePacks.map((pack) => pack.id).sort().join(", ");
    throw new Error(
      `Multiple enabled packs declare a sandbox image (${ids}). Only one enabled pack per workspace may declare sandboxImage; disable the others and retry.`,
    );
  }
  const skills: PackSkill[] = [];
  const skillOwners = new Map<string, string>();
  for (const pack of [...packs].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const skill of pack.skills) {
      const existingOwner = skillOwners.get(skill.name);
      if (existingOwner !== undefined && existingOwner !== pack.id) {
        throw new Error(
          `Enabled packs ${existingOwner} and ${pack.id} both declare a skill named "${skill.name}". Pack skill names must be unique across enabled packs; disable one of the packs and retry.`,
        );
      }
      skillOwners.set(skill.name, pack.id);
      skills.push({
        name: skill.name,
        description: skill.description ?? null,
        files: skill.files.map((file) => ({ path: file.path, content: file.content })),
      });
    }
  }
  return {
    sandboxImage: imagePacks[0]?.sandboxImage?.trim() ?? null,
    skills,
  };
}

/**
 * Applies a pack-declared sandbox image to run settings. With no pack image
 * the settings pass through untouched, so deployments without packs keep the
 * global OPENGENI_DOCKER_IMAGE / OPENGENI_MODAL_IMAGE_REF behavior exactly.
 */
export function settingsWithPackSandboxImage(settings: Settings, sandboxImage: string | null): Settings {
  if (!sandboxImage) {
    return settings;
  }
  return {
    ...settings,
    dockerImage: sandboxImage,
    modalImageRef: sandboxImage,
  };
}
