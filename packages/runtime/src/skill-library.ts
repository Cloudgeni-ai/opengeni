import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Metadata for a platform-curated skill. The metadata is deliberately
 * provider-neutral: it describes guidance provenance and compatibility, not
 * credentials, tools, permissions, or a model route.
 *
 * Entries are immutable in the runtime. A new artifact gets a new version and
 * content hash; callers must not mutate the returned records.
 */
export type SkillLibraryEntry = Readonly<{
  id: string;
  name: string;
  version: string;
  description: string;
  category: string;
  tags: readonly string[];
  contentSha256: string;
  sourceCommit: string;
  sourceUrl: string;
  provenance: string;
  license: string;
  documentationUrl: string;
  compatibility: Readonly<{
    runtime: string;
    minimumSkillCapabilityVersion: string;
  }>;
  upgrade: Readonly<{
    policy: "immutable-replacement";
    supersedes: string | null;
  }>;
  relativePath: string;
}>;

export type SkillLibraryFile = Readonly<{
  path: string;
  content: string;
}>;

export type SkillLibrarySkill = Readonly<{
  name: string;
  description: string;
  files: readonly SkillLibraryFile[];
}>;

const skillLibraryEntries: readonly SkillLibraryEntry[] = Object.freeze([
  Object.freeze({
    id: "azure-verified-modules",
    name: "azure-verified-modules",
    version: "1.0.0",
    description:
      "Azure Verified Modules (AVM) requirements and best practices for certified Terraform modules.",
    category: "infrastructure",
    tags: Object.freeze(["skill", "infrastructure", "terraform", "azure", "opt-in"]),
    contentSha256: "f17d1e7d909797042d71ae1ccfee04a2f5a3d96f4972db8ca005f1173cd40564",
    sourceCommit: "de4323afdfbc30d1387f287b55062fa8d82b62e8",
    sourceUrl:
      "https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/module-generation/skills/azure-verified-modules",
    provenance: "Vendored from hashicorp/agent-skills; reviewed OpenGeni curated entry.",
    license: "MPL-2.0",
    documentationUrl: "https://azure.github.io/Azure-Verified-Modules/",
    compatibility: Object.freeze({
      runtime: "openai-agents-skills",
      minimumSkillCapabilityVersion: "0.13.3",
    }),
    upgrade: Object.freeze({
      policy: "immutable-replacement",
      supersedes: null,
    }),
    relativePath: "azure-verified-modules",
  }),
]);

const skillLibraryRootCandidates = (): string[] => {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return [
    join(moduleDir, "bundled_skill_library"),
    join(moduleDir, "..", "src", "bundled_skill_library"),
  ];
};

function skillLibraryRoot(): string | null {
  return skillLibraryRootCandidates().find((candidate) => existsSync(candidate)) ?? null;
}

function entryDirectory(entry: SkillLibraryEntry): string | null {
  const root = skillLibraryRoot();
  if (!root) return null;
  const directory = join(root, entry.relativePath);
  const withinRoot = relative(root, directory);
  if (
    isAbsolute(withinRoot) ||
    withinRoot === ".." ||
    withinRoot.startsWith("../") ||
    !existsSync(join(directory, "SKILL.md"))
  ) {
    return null;
  }
  return directory;
}

/** Return only entries whose reviewed artifact is present in this deployment. */
export function listSkillLibraryEntries(): readonly SkillLibraryEntry[] {
  return skillLibraryEntries.filter((entry) => reviewedArtifactIsAvailable(entry));
}

/** Return whether an id belongs to the immutable library, even if its artifact is unavailable. */
export function isSkillLibraryEntryId(id: string): boolean {
  return skillLibraryEntries.some((entry) => entry.id === id);
}

/** Resolve an exact immutable library entry by id and version. */
export function getSkillLibraryEntry(
  id: string,
  version?: string,
): SkillLibraryEntry | null {
  const entry = skillLibraryEntries.find(
    (candidate) => candidate.id === id && (version === undefined || candidate.version === version),
  );
  return entry && reviewedArtifactIsAvailable(entry) ? entry : null;
}

/**
 * Load a selected curated entry into the SDK's in-memory skill shape.
 * Selection is guidance-only: this function has no access to settings,
 * credentials, MCP declarations, or model-provider configuration.
 */
export function loadSkillLibrarySkill(
  id: string,
  version?: string,
): { entry: SkillLibraryEntry; skill: SkillLibrarySkill } {
  const entry = getSkillLibraryEntry(id, version);
  if (!entry) {
    throw new Error(
      version
        ? `Skill library entry is unavailable: ${id}@${version}`
        : `Skill library entry is unavailable: ${id}`,
    );
  }
  const directory = entryDirectory(entry);
  if (!directory) {
    throw new Error(`Skill library entry is unavailable: ${entry.id}@${entry.version}`);
  }
  const files = readSkillFiles(directory);
  const skillMarkdown = files.find((file) => file.path === "SKILL.md")?.content;
  if (skillMarkdown === undefined) {
    throw new Error(`Skill library entry is missing SKILL.md: ${entry.id}@${entry.version}`);
  }
  const actualHash = createHash("sha256").update(skillMarkdown, "utf8").digest("hex");
  if (actualHash !== entry.contentSha256) {
    throw new Error(
      `Skill library content hash mismatch for ${entry.id}@${entry.version}: expected ${entry.contentSha256}, got ${actualHash}`,
    );
  }
  return {
    entry,
    skill: Object.freeze({
      name: entry.name,
      description: entry.description,
      files: Object.freeze(files.map((file) => Object.freeze(file))),
    }),
  };
}

function readSkillFiles(root: string, current = ""): SkillLibraryFile[] {
  const directory = current ? join(root, current) : root;
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((child) => {
      const path = current ? `${current}/${child.name}` : child.name;
      if (child.isDirectory()) {
        return readSkillFiles(root, path);
      }
      if (!child.isFile()) {
        return [];
      }
      return [{ path, content: readFileSync(join(root, path), "utf8") }];
    });
}

function reviewedArtifactIsAvailable(entry: SkillLibraryEntry): boolean {
  const directory = entryDirectory(entry);
  if (!directory) return false;
  try {
    const skillMarkdown = readFileSync(join(directory, "SKILL.md"), "utf8");
    return (
      createHash("sha256").update(skillMarkdown, "utf8").digest("hex") ===
      entry.contentSha256
    );
  } catch {
    return false;
  }
}
