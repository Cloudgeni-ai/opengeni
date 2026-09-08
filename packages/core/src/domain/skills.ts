import type {
  SkillFile,
  SkillInstallInput,
  SkillRevisionInput,
  SkillSaveInput,
} from "@opengeni/contracts";
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
  if (files.length < 1 || files.length > 128) throw new Error("A Skill requires 1–128 text files");
  const paths = new Set<string>();
  let total = 0;
  const result = files.map(({ path, content }) => {
    if (
      !path ||
      path.length > 512 ||
      /(^\/|\\|(^|\/)\.\.?($|\/)|\/\/|\/$|[\x00-\x1f\x7f]|:)/u.test(path) ||
      Buffer.from(path, "utf8").toString("utf8") !== path ||
      paths.has(path)
    )
      throw new Error(`Invalid or duplicate Skill path: ${path}`);
    if (
      [...paths].some(
        (existing) => existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`),
      )
    )
      throw new Error(`Skill file/directory path conflict: ${path}`);
    if (Buffer.from(content, "utf8").toString("utf8") !== content || content.includes("\0"))
      throw new Error("Skill content must be valid UTF-8 text without NUL");
    const size = Buffer.byteLength(content, "utf8");
    if (size > 256 * 1024) throw new Error("Skill file exceeds 256 KiB");
    total += size;
    paths.add(path);
    return { path, content };
  });
  if (total > 1024 * 1024) throw new Error("Skill folder exceeds 1 MiB");
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
  return applySkillLifecycle(
    db,
    { accountId, workspaceId, actor },
    {
      ...request,
      operation: "save",
      files: validateSkillFiles(input.files),
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
export async function restoreSkill(db: Database, input: SkillRevisionInput) {
  const { accountId, workspaceId, actor, ...request } = input;
  return applySkillLifecycle(
    db,
    { accountId, workspaceId, actor },
    { ...request, operation: "restore" },
  );
}
