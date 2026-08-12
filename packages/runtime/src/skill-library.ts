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

export const PORTABLE_SKILL_MAX_FILES = 128;
export const PORTABLE_SKILL_MAX_FILE_BYTES = 256 * 1024;
export const PORTABLE_SKILL_MAX_TOTAL_BYTES = 1024 * 1024;
const portableSkillName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export type PortableSkillArtifact = Readonly<{
  name: string;
  description: string;
  files: readonly SkillLibraryFile[];
  contentSha256: string;
  totalBytes: number;
}>;

const skillLibraryEntries: readonly SkillLibraryEntry[] = Object.freeze([
  Object.freeze({
    id: "checkov",
    name: "checkov",
    version: "1.0.0",
    description:
      "Use Checkov to scan Terraform and infrastructure-as-code repositories, explain findings, apply safe fixes, and verify remediations.",
    category: "infrastructure",
    tags: Object.freeze(["skill", "infrastructure", "terraform", "security", "opt-in"]),
    contentSha256: "0331b987cd609946c4b95928fec9982b96b0a8614a95e5e628a531efb8ad8577",
    sourceCommit: "e9734c4aa062e0421a68acb5650bd5bf33ce2e10",
    sourceUrl:
      "https://github.com/Cloudgeni-ai/opengeni/tree/e9734c4aa062e0421a68acb5650bd5bf33ce2e10/packages/runtime/src/bundled_hashicorp_terraform_skills/checkov",
    provenance: "OpenGeni-authored guidance; reviewed immutable opt-in entry.",
    license: "Apache-2.0",
    documentationUrl: "https://www.checkov.io/",
    compatibility: Object.freeze({
      runtime: "openai-agents-skills",
      minimumSkillCapabilityVersion: "0.13.3",
    }),
    upgrade: Object.freeze({ policy: "immutable-replacement", supersedes: null }),
    relativePath: "checkov",
  }),
  Object.freeze({
    id: "refactor-module",
    name: "refactor-module",
    version: "0.0.1",
    description:
      "Transform monolithic Terraform configurations into reusable, maintainable modules following HashiCorp module-design practices.",
    category: "infrastructure",
    tags: Object.freeze(["skill", "infrastructure", "terraform", "modules", "opt-in"]),
    contentSha256: "cc6d70034c4d11ef6a496c0081ca28219cbd310283d77e327914bcd2f27f3a09",
    sourceCommit: "de4323afdfbc30d1387f287b55062fa8d82b62e8",
    sourceUrl:
      "https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/module-generation/skills/refactor-module",
    provenance: "Vendored from hashicorp/agent-skills; reviewed immutable opt-in entry.",
    license: "MPL-2.0",
    documentationUrl: "https://developer.hashicorp.com/terraform/language/modules/develop",
    compatibility: Object.freeze({
      runtime: "openai-agents-skills",
      minimumSkillCapabilityVersion: "0.13.3",
    }),
    upgrade: Object.freeze({ policy: "immutable-replacement", supersedes: null }),
    relativePath: "refactor-module",
  }),
  Object.freeze({
    id: "social-media-marketing",
    name: "social-media-marketing",
    version: "1.0.0",
    description:
      "Analyze connected social accounts, content performance, audience signals, campaigns, and daily media activity without inventing unavailable metrics.",
    category: "marketing",
    tags: Object.freeze(["skill", "marketing", "social", "analysis", "opt-in"]),
    contentSha256: "66893de1fd2110f18d9be69b1e0adb61193e0a736a88f0c0725168465d2b06a3",
    sourceCommit: "e9734c4aa062e0421a68acb5650bd5bf33ce2e10",
    sourceUrl:
      "https://github.com/Cloudgeni-ai/opengeni/tree/e9734c4aa062e0421a68acb5650bd5bf33ce2e10/packages/runtime/src/bundled_hashicorp_terraform_skills/social-media-marketing",
    provenance: "OpenGeni-authored guidance; reviewed immutable opt-in entry.",
    license: "Apache-2.0",
    documentationUrl:
      "https://github.com/Cloudgeni-ai/opengeni/blob/e9734c4aa062e0421a68acb5650bd5bf33ce2e10/docs/social-connectors.md",
    compatibility: Object.freeze({
      runtime: "openai-agents-skills",
      minimumSkillCapabilityVersion: "0.13.3",
    }),
    upgrade: Object.freeze({ policy: "immutable-replacement", supersedes: null }),
    relativePath: "social-media-marketing",
  }),
  Object.freeze({
    id: "terraform-search-import",
    name: "terraform-search-import",
    version: "0.1.0",
    description:
      "Discover existing cloud resources with Terraform Search and bring supported resources under Terraform management.",
    category: "infrastructure",
    tags: Object.freeze(["skill", "infrastructure", "terraform", "import", "opt-in"]),
    contentSha256: "994d7a48dd6a610daa8a4dbdf4b0f0e52eaf8662a509b6a163bc6e76611227f9",
    sourceCommit: "de4323afdfbc30d1387f287b55062fa8d82b62e8",
    sourceUrl:
      "https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/code-generation/skills/terraform-search-import",
    provenance: "Vendored from hashicorp/agent-skills; reviewed immutable opt-in entry.",
    license: "MPL-2.0",
    documentationUrl: "https://developer.hashicorp.com/terraform/language/import",
    compatibility: Object.freeze({
      runtime: "openai-agents-skills",
      minimumSkillCapabilityVersion: "0.13.3",
    }),
    upgrade: Object.freeze({ policy: "immutable-replacement", supersedes: null }),
    relativePath: "terraform-search-import",
  }),
  Object.freeze({
    id: "terraform-stacks",
    name: "terraform-stacks",
    version: "0.0.1",
    description:
      "Create, modify, validate, and troubleshoot Terraform Stack component and deployment configurations.",
    category: "infrastructure",
    tags: Object.freeze(["skill", "infrastructure", "terraform", "stacks", "opt-in"]),
    contentSha256: "0a6244ecddf1cce0357db41b41b3b20a1bfa71f331092ebc8bbd15e649733d35",
    sourceCommit: "de4323afdfbc30d1387f287b55062fa8d82b62e8",
    sourceUrl:
      "https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/code-generation/skills/terraform-stacks",
    provenance: "Vendored from hashicorp/agent-skills; reviewed immutable opt-in entry.",
    license: "MPL-2.0",
    documentationUrl: "https://developer.hashicorp.com/terraform/language/stacks",
    compatibility: Object.freeze({
      runtime: "openai-agents-skills",
      minimumSkillCapabilityVersion: "0.13.3",
    }),
    upgrade: Object.freeze({ policy: "immutable-replacement", supersedes: null }),
    relativePath: "terraform-stacks",
  }),
  Object.freeze({
    id: "terraform-style-guide",
    name: "terraform-style-guide",
    version: "1.0.0",
    description:
      "Generate and review Terraform HCL using HashiCorp's official style conventions and maintainability practices.",
    category: "infrastructure",
    tags: Object.freeze(["skill", "infrastructure", "terraform", "style", "opt-in"]),
    contentSha256: "1453c4f11636d2d88c5186a4ce2d7532d4b2056a861ed69653df21e8e45e19cd",
    sourceCommit: "de4323afdfbc30d1387f287b55062fa8d82b62e8",
    sourceUrl:
      "https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/code-generation/skills/terraform-style-guide",
    provenance: "Vendored from hashicorp/agent-skills; reviewed immutable opt-in entry.",
    license: "MPL-2.0",
    documentationUrl: "https://developer.hashicorp.com/terraform/language/style",
    compatibility: Object.freeze({
      runtime: "openai-agents-skills",
      minimumSkillCapabilityVersion: "0.13.3",
    }),
    upgrade: Object.freeze({ policy: "immutable-replacement", supersedes: null }),
    relativePath: "terraform-style-guide",
  }),
  Object.freeze({
    id: "terraform-test",
    name: "terraform-test",
    version: "0.0.2",
    description:
      "Write and run Terraform tests with assertions, mocked providers, data sources, and plan/apply scenarios.",
    category: "infrastructure",
    tags: Object.freeze(["skill", "infrastructure", "terraform", "testing", "opt-in"]),
    contentSha256: "61be0fa43c48f49980fee28c64215f593c4ab55d55a93c8f2e514d9ca566a97b",
    sourceCommit: "de4323afdfbc30d1387f287b55062fa8d82b62e8",
    sourceUrl:
      "https://github.com/hashicorp/agent-skills/tree/de4323afdfbc30d1387f287b55062fa8d82b62e8/terraform/code-generation/skills/terraform-test",
    provenance: "Vendored from hashicorp/agent-skills; reviewed immutable opt-in entry.",
    license: "MPL-2.0",
    documentationUrl: "https://developer.hashicorp.com/terraform/language/tests",
    compatibility: Object.freeze({
      runtime: "openai-agents-skills",
      minimumSkillCapabilityVersion: "0.13.3",
    }),
    upgrade: Object.freeze({ policy: "immutable-replacement", supersedes: null }),
    relativePath: "terraform-test",
  }),
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
    join(moduleDir, "assets", "runtime", "curated_skill_library"),
    join(moduleDir, "curated_skill_library"),
    join(moduleDir, "..", "src", "curated_skill_library"),
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

/** Return the immutable repository origin for a reviewed library source URL. */
export function skillLibraryRepositoryUrl(sourceUrl: string): string {
  const url = new URL(sourceUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.hostname === "github.com" && segments.length >= 2) {
    return `${url.origin}/${segments[0]}/${segments[1]}`;
  }
  return sourceUrl;
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

/**
 * Validate and fingerprint a portable, text-only Skill artifact before it is
 * persisted or exposed to the runtime. Remote imports and curated entries use
 * the same canonical path and whole-artifact digest rules.
 */
export function buildPortableSkillArtifact(
  inputFiles: readonly SkillLibraryFile[],
): PortableSkillArtifact {
  const { materialized, totalBytes } = materializePortableSkillFiles(inputFiles);
  const skillMarkdown = materialized.find((file) => file.path === "SKILL.md")?.content;
  if (skillMarkdown === undefined) {
    throw new Error("Skill artifact is missing a top-level SKILL.md");
  }
  const metadata = parsePortableSkillFrontmatter(skillMarkdown);
  if (!metadata.name || !portableSkillName.test(metadata.name)) {
    throw new Error("Skill artifact SKILL.md must declare a safe name");
  }
  if (
    !metadata.description ||
    metadata.description.length > 2_048 ||
    /[\r\n]/u.test(metadata.description)
  ) {
    throw new Error("Skill artifact SKILL.md must declare a single-line description");
  }
  return Object.freeze({
    name: metadata.name,
    description: metadata.description,
    files: Object.freeze(materialized.map(({ path, content }) => Object.freeze({ path, content }))),
    contentSha256: skillLibraryArtifactSha256(materialized),
    totalBytes,
  });
}

/**
 * Canonical whole-artifact identity for any validated runtime Skill shape.
 * This deliberately does not require frontmatter because legacy Pack/session
 * contracts historically allowed a top-level SKILL.md without metadata. The
 * content identity is nevertheless byte-exact and shared with portable imports.
 */
export function skillArtifactContentSha256(inputFiles: readonly SkillLibraryFile[]): string {
  return skillLibraryArtifactSha256(materializePortableSkillFiles(inputFiles).materialized);
}

function materializePortableSkillFiles(inputFiles: readonly SkillLibraryFile[]): {
  materialized: Array<Readonly<{ path: string; content: string; bytes: Uint8Array }>>;
  totalBytes: number;
} {
  if (inputFiles.length === 0 || inputFiles.length > PORTABLE_SKILL_MAX_FILES) {
    throw new Error(`Skill artifact must contain 1-${PORTABLE_SKILL_MAX_FILES} files`);
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  const materialized = inputFiles
    .map((file) => {
      const path = normalizeSkillLibraryRelativePath(file.path);
      if (paths.has(path)) {
        throw new Error(`Skill artifact contains duplicate file path: ${path}`);
      }
      paths.add(path);
      const bytes = new TextEncoder().encode(file.content);
      if (bytes.byteLength > PORTABLE_SKILL_MAX_FILE_BYTES) {
        throw new Error(
          `Skill artifact file exceeds ${PORTABLE_SKILL_MAX_FILE_BYTES} bytes: ${path}`,
        );
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > PORTABLE_SKILL_MAX_TOTAL_BYTES) {
        throw new Error(`Skill artifact exceeds ${PORTABLE_SKILL_MAX_TOTAL_BYTES} bytes`);
      }
      return Object.freeze({ path, content: file.content, bytes });
    })
    .sort((left, right) => compareCanonicalPath(left.path, right.path));
  return { materialized, totalBytes };
}

export function parsePortableSkillFrontmatter(markdown: string): {
  name: string | null;
  description: string | null;
} {
  const lines = markdown.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return { name: null, description: null };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return { name: null, description: null };
  let name: string | null = null;
  let description: string | null = null;
  for (let index = 1; index < end; index += 1) {
    const line = lines[index]!;
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (key === "name") {
      name = unquotePortableFrontmatterValue(raw);
      continue;
    }
    if (key !== "description") continue;
    if (raw !== ">" && raw !== ">-" && raw !== "|" && raw !== "|-") {
      description = unquotePortableFrontmatterValue(raw);
      continue;
    }
    const block: string[] = [];
    while (index + 1 < end && /^\s+\S/u.test(lines[index + 1]!)) {
      index += 1;
      block.push(lines[index]!.trim());
    }
    description = block.join(" ").trim() || null;
  }
  return { name: name?.trim() || null, description: description?.trim() || null };
}

function unquotePortableFrontmatterValue(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
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
