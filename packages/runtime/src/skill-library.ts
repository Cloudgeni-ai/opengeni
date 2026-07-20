import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { TextDecoder } from "node:util";
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
  /** SHA-256 over the complete canonical artifact manifest, not just SKILL.md. */
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

export type SkillLibraryArtifact = Readonly<{
  files: readonly SkillLibraryFile[];
  /** SHA-256 over the complete canonical artifact manifest, not just SKILL.md. */
  contentSha256: string;
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
    contentSha256: "bbc029412fd4893c35cf2a4df6e052efa5583d57d3c26e35d62869dcf4625699",
    sourceCommit: "de4323afdfbc30d1387f287b55062fa8d82b62e8",
    sourceUrl:
      "https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/code-generation/skills/azure-verified-modules",
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
  return skillLibraryRootCandidates().find((candidate) => isRealDirectory(candidate)) ?? null;
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
    !isRealDirectory(directory)
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
export function getSkillLibraryEntry(id: string, version?: string): SkillLibraryEntry | null {
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
  const artifact = verifySkillLibraryArtifact(directory, entry.contentSha256, entry);
  const files = artifact.files;
  const skillMarkdown = files.find((file) => file.path === "SKILL.md")?.content;
  if (skillMarkdown === undefined) {
    throw new Error(`Skill library entry is missing SKILL.md: ${entry.id}@${entry.version}`);
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

/**
 * Read a curated artifact and calculate its canonical whole-artifact digest.
 *
 * The manifest is JSON encoded as sorted `[normalizedRelativePath, base64Bytes]`
 * tuples. Base64 preserves every byte, including bytes that would not survive
 * a lossy UTF-8 string round-trip. Files are decoded only after the digest
 * input has been captured because the SDK skill surface is text-based.
 */
export function readSkillLibraryArtifact(root: string): SkillLibraryArtifact {
  const files = materializeSkillLibraryFiles(root);
  const contentSha256 = skillLibraryArtifactSha256(files);
  return Object.freeze({
    files: Object.freeze(
      files.map((file) =>
        Object.freeze({
          path: file.path,
          content: decodeSkillLibraryFile(file.bytes, file.path),
        }),
      ),
    ),
    contentSha256,
  });
}

/** Verify a reviewed artifact against its immutable catalog digest. */
export function verifySkillLibraryArtifact(
  root: string,
  expectedSha256: string,
  entry?: Pick<SkillLibraryEntry, "id" | "version">,
): SkillLibraryArtifact {
  const artifact = readSkillLibraryArtifact(root);
  if (artifact.files.every((file) => file.path !== "SKILL.md")) {
    throw new Error(
      entry
        ? `Skill library entry is missing SKILL.md: ${entry.id}@${entry.version}`
        : "Skill library artifact is missing SKILL.md",
    );
  }
  if (artifact.contentSha256 !== expectedSha256) {
    const label = entry ? ` for ${entry.id}@${entry.version}` : "";
    throw new Error(
      `Skill library artifact hash mismatch${label}: expected ${expectedSha256}, got ${artifact.contentSha256}`,
    );
  }
  return artifact;
}

type MaterializedSkillLibraryFile = Readonly<{
  path: string;
  bytes: Uint8Array;
}>;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function materializeSkillLibraryFiles(root: string, current = ""): MaterializedSkillLibraryFile[] {
  const directory = current ? join(root, current) : root;
  if (!isRealDirectory(directory)) {
    throw new Error(`Skill library artifact root is not a real directory: ${directory}`);
  }
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => compareCanonicalPath(a.name, b.name))
    .flatMap((child) => {
      const childName = normalizeSkillLibraryRelativePath(child.name, true);
      const path = current ? `${current}/${childName}` : childName;
      normalizeSkillLibraryRelativePath(path);
      const childPath = join(root, path);
      if (child.isSymbolicLink()) {
        throw new Error(`Skill library artifact contains a symbolic link: ${path}`);
      }
      if (child.isDirectory()) {
        return materializeSkillLibraryFiles(root, path);
      }
      if (!child.isFile() || !isRealFile(childPath)) {
        throw new Error(`Skill library artifact contains a non-regular file: ${path}`);
      }
      return [{ path, bytes: Uint8Array.from(readFileSync(childPath)) }];
    });
}

function reviewedArtifactIsAvailable(entry: SkillLibraryEntry): boolean {
  const directory = entryDirectory(entry);
  if (!directory) return false;
  try {
    verifySkillLibraryArtifact(directory, entry.contentSha256, entry);
    return true;
  } catch {
    return false;
  }
}

function skillLibraryArtifactSha256(files: readonly MaterializedSkillLibraryFile[]): string {
  const manifest = files
    .map((file) => {
      const path = normalizeSkillLibraryRelativePath(file.path);
      return [path, Buffer.from(file.bytes).toString("base64")] as const;
    })
    .sort((left, right) => compareCanonicalPath(left[0], right[0]));
  const paths = new Set<string>();
  for (const [path] of manifest) {
    if (paths.has(path)) {
      throw new Error(`Skill library artifact contains duplicate file path: ${path}`);
    }
    paths.add(path);
  }
  return createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");
}

function decodeSkillLibraryFile(bytes: Uint8Array, path: string): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    throw new Error(`Skill library artifact contains invalid UTF-8: ${path}`);
  }
}

function normalizeSkillLibraryRelativePath(path: string, segment = false): string {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    /^[A-Za-z]:(?:\/|$)/u.test(path)
  ) {
    throw new Error(`Skill library artifact contains an unsafe path: ${path}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`Skill library artifact contains an unsafe path: ${path}`);
  }
  if (segment && parts.length !== 1) {
    throw new Error(`Skill library artifact contains an unsafe path: ${path}`);
  }
  return parts.join("/");
}

function compareCanonicalPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRealDirectory(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function isRealFile(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}
