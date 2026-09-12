import type {
  SkillFile,
  SkillInstallInput,
  SkillRevisionInput,
  SkillSaveInput,
} from "@opengeni/contracts";
import { validateSkillTextFiles } from "@opengeni/contracts";
import { buildPortableSkillArtifact } from "@opengeni/runtime/skill-library";
import {
  applySkillLifecycle,
  listSkillRecords,
  skillFilesContentHash,
  type Database,
  type SkillReadContext,
} from "@opengeni/db";
export { replayPortableSkillInstall } from "@opengeni/db";

/** Canonical text-only folder; rejects invalid Unicode before PostgreSQL conversion. */
export function validateSkillFiles(files: readonly SkillFile[]): SkillFile[] {
  validateSkillTextFiles(files);
  const result = files.map(({ path, content }) => ({ path, content }));
  if (!result.some((file) => file.path === "SKILL.md" && file.content.trim()))
    throw new Error("Skill requires nonempty SKILL.md");
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Separate from the historical SKILL.md hash, which must never be rewritten. */
export function skillBundleHash(files: readonly SkillFile[]): string {
  return skillFilesContentHash(validateSkillFiles(files));
}

export const listSkills = listSkillRecords;
export async function readSkill(
  db: Database,
  context: SkillReadContext,
  skillId: string,
  revisionId?: string,
) {
  return (
    (
      await listSkillRecords(db, context, {
        skillId,
        ...(revisionId ? { revisionId } : {}),
        limit: 1,
      })
    )[0] ?? null
  );
}
export async function saveSkill(db: Database, input: SkillSaveInput) {
  const { accountId, workspaceId, actor, ...request } = input;
  const artifact = buildPortableSkillArtifact(validateSkillFiles(input.files));
  return applySkillLifecycle(
    db,
    { accountId, workspaceId, actor },
    {
      ...request,
      operation: "save",
      files: artifact.files,
      title: artifact.name,
      description: artifact.description,
    },
  );
}
export async function installSkill(db: Database, input: SkillInstallInput) {
  const { accountId, workspaceId, actor, ...request } = input;
  return applySkillLifecycle(
    db,
    { accountId, workspaceId, actor },
    { ...request, operation: "install" },
  );
}
export async function approveSkill(db: Database, input: SkillRevisionInput) {
  const { accountId, workspaceId, actor, ...request } = input;
  return applySkillLifecycle(
    db,
    { accountId, workspaceId, actor },
    { ...request, operation: "approve" },
  );
}
export async function rejectSkill(db: Database, input: SkillRevisionInput) {
  const { accountId, workspaceId, actor, ...request } = input;
  return applySkillLifecycle(
    db,
    { accountId, workspaceId, actor },
    { ...request, operation: "reject" },
  );
}
export async function restoreSkill(db: Database, input: SkillRevisionInput) {
  const { accountId, workspaceId, actor, ...request } = input;
  return applySkillLifecycle(
    db,
    { accountId, workspaceId, actor },
    { ...request, operation: "restore" },
  );
}
