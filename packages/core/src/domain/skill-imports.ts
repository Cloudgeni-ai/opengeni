import { createHash } from "node:crypto";
import type { SkillImportPreview, SkillImportSource } from "@opengeni/contracts";
import {
  buildPortableSkillArtifact,
  parsePortableSkillFrontmatter,
  PORTABLE_SKILL_MAX_FILE_BYTES,
  PORTABLE_SKILL_MAX_FILES,
  PORTABLE_SKILL_MAX_TOTAL_BYTES,
  type SkillLibraryFile,
} from "@opengeni/runtime/skill-library";
import { HTTPException } from "hono/http-exception";

export type GitHubSkillTreeEntry = Readonly<{
  path: string;
  type: "blob" | "tree" | "commit";
  mode: string;
  sha: string;
  size: number | null;
}>;

export type GitHubSkillSourceClient = Readonly<{
  downloadSnapshot?(
    owner: string,
    repository: string,
    slug: string,
  ): Promise<readonly SkillLibraryFile[]>;
  resolveCommit(owner: string, repository: string, ref: string): Promise<string>;
  listTree(
    owner: string,
    repository: string,
    commit: string,
  ): Promise<readonly GitHubSkillTreeEntry[]>;
  readBlob(owner: string, repository: string, sha: string): Promise<Uint8Array>;
}>;

export type ResolvedSkillImport = Readonly<{
  preview: SkillImportPreview;
  files: readonly SkillLibraryFile[];
}>;

type ParsedSkillSource = Readonly<{
  source: SkillImportSource;
  owner: string;
  repository: string;
  ref: string;
  requestedPath: string | null;
  skillSlug: string | null;
  inputUrl: string;
}>;

const githubSegment = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const gitCommit = /^[0-9a-f]{40,64}$/u;
const maxConcurrentBlobReads = 8;

export async function resolveSkillImport(
  rawUrl: string,
  client: GitHubSkillSourceClient,
): Promise<ResolvedSkillImport> {
  const parsed = parseSkillSource(rawUrl);
  if (parsed.source === "skills_sh" && client.downloadSnapshot) {
    const files = await client.downloadSnapshot(parsed.owner, parsed.repository, parsed.skillSlug!);
    return buildResolvedImport(parsed, files, parsed.skillSlug!, null);
  }
  const sourceCommit = await client.resolveCommit(parsed.owner, parsed.repository, parsed.ref);
  if (!gitCommit.test(sourceCommit)) {
    throw new HTTPException(422, { message: "GitHub returned an invalid source commit" });
  }
  const tree = await client.listTree(parsed.owner, parsed.repository, sourceCommit);
  // Metadata discovery and the selected artifact share immutable blobs. This
  // avoids reading SKILL.md twice without caching mutable refs or remote URLs.
  const blobs = new Map<string, Promise<Uint8Array>>();
  const readBlob = (sha: string) => {
    let pending = blobs.get(sha);
    if (!pending) {
      pending = client.readBlob(parsed.owner, parsed.repository, sha);
      blobs.set(sha, pending);
    }
    return pending;
  };
  const sourcePath = await selectSkillRoot(parsed, tree, readBlob, sourceCommit);
  const entries = skillFilesUnderRoot(tree, sourcePath);
  const declaredBytes = entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  if (entries.length > PORTABLE_SKILL_MAX_FILES) {
    throw new HTTPException(422, {
      message: `Skill contains more than ${PORTABLE_SKILL_MAX_FILES} files`,
    });
  }
  if (declaredBytes > PORTABLE_SKILL_MAX_TOTAL_BYTES) {
    throw new HTTPException(422, {
      message: `Skill exceeds ${PORTABLE_SKILL_MAX_TOTAL_BYTES} bytes`,
    });
  }
  const files = await mapConcurrent(entries, maxConcurrentBlobReads, async (entry) => {
    // Keep provider/network failures distinct from UTF-8 validation failures.
    const bytes = await readBlob(entry.sha);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new HTTPException(422, {
        message: `Skill file is not valid UTF-8 text: ${relativeSkillPath(entry.path, sourcePath)}`,
      });
    }
    return { path: relativeSkillPath(entry.path, sourcePath), content };
  });
  return buildResolvedImport(parsed, files, sourcePath, sourceCommit);
}

function buildResolvedImport(
  parsed: ParsedSkillSource,
  files: readonly SkillLibraryFile[],
  sourcePath: string,
  commit: string | null,
): ResolvedSkillImport {
  let artifact;
  try {
    artifact = buildPortableSkillArtifact(files);
  } catch (error) {
    throw new HTTPException(422, {
      message: error instanceof Error ? error.message : "Skill artifact is invalid",
    });
  }
  const repositoryUrl = `https://github.com/${parsed.owner}/${parsed.repository}`;
  // The existing revision field holds our content digest for registry snapshots;
  // snapshots do not provide a Git commit or a repository-relative folder path.
  const sourceCommit = commit ?? artifact.contentSha256;
  if (
    !commit &&
    artifact.name
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") !== parsed.skillSlug!.toLowerCase()
  ) {
    throw new HTTPException(422, {
      message: "The downloaded skill does not match the requested name",
    });
  }
  const sourceUrl = !commit
    ? `https://skills.sh/${parsed.owner}/${parsed.repository}/${parsed.skillSlug}`
    : sourcePath === "."
      ? `${repositoryUrl}/tree/${sourceCommit}`
      : `${repositoryUrl}/tree/${sourceCommit}/${encodeGitHubPath(sourcePath)}`;
  const warnings: string[] = [];
  if (!artifact.files.some((file) => /(^|\/)licen[cs]e(?:\.|$)/iu.test(file.path))) {
    warnings.push("No license file was found inside the selected Skill folder.");
  }
  const executableFiles = artifact.files.filter((file) => /(^|\/)scripts?\//u.test(file.path));
  if (executableFiles.length > 0) {
    warnings.push(
      `${executableFiles.length} script file${executableFiles.length === 1 ? "" : "s"} will be available to the agent only after installation.`,
    );
  }
  return {
    preview: {
      markdown: artifact.files.find((file) => file.path === "SKILL.md")?.content,
      source: parsed.source,
      sourceUrl,
      repositoryUrl,
      owner: parsed.owner,
      repository: parsed.repository,
      sourcePath,
      sourceCommit,
      name: artifact.name,
      description: artifact.description,
      contentSha256: artifact.contentSha256,
      totalBytes: artifact.totalBytes,
      files: artifact.files.map((file) => {
        const bytes = new TextEncoder().encode(file.content);
        return {
          path: file.path,
          byteSize: bytes.byteLength,
          contentSha256: sha256Hex(bytes),
        };
      }),
      warnings,
      installed: false,
      installationVersion: null,
    },
    files: artifact.files,
  };
}

export function portableSkillPluginKey(
  source: Pick<SkillImportPreview, "owner" | "repository" | "sourcePath">,
): string {
  return `skill/${source.owner}/${source.repository}/${source.sourcePath}`.toLowerCase();
}

export function portableSkillCapabilityId(
  source: Pick<SkillImportPreview, "name" | "owner" | "repository" | "sourcePath">,
): string {
  const identity = portableSkillPluginKey(source);
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `skill:${source.name.toLowerCase()}-${suffix}`;
}

export function parseSkillSource(rawUrl: string): ParsedSkillSource {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HTTPException(422, { message: "Enter a valid GitHub or skills.sh URL" });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new HTTPException(422, {
      message: "Skill imports require a credential-free HTTPS URL without a fragment",
    });
  }
  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HTTPException(422, { message: "The Skill URL contains invalid encoding" });
  }
  if (url.hostname === "skills.sh" || url.hostname === "www.skills.sh") {
    if (segments.length !== 3) {
      throw new HTTPException(422, {
        message: "A skills.sh URL must identify one owner, repository, and Skill",
      });
    }
    const [owner, repository, skillSlug] = segments;
    assertGitHubRepository(owner!, repository!);
    if (!skillSlug || !githubSegment.test(skillSlug)) {
      throw new HTTPException(422, { message: "The skills.sh Skill name is invalid" });
    }
    return {
      source: "skills_sh",
      owner: owner!,
      repository: stripGitSuffix(repository!),
      ref: "HEAD",
      requestedPath: null,
      skillSlug,
      inputUrl: url.toString(),
    };
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new HTTPException(422, {
      message: "Only github.com and skills.sh imports are supported",
    });
  }
  if (segments.length < 2) {
    throw new HTTPException(422, { message: "A GitHub URL must identify a repository" });
  }
  const owner = segments[0]!;
  const repository = stripGitSuffix(segments[1]!);
  assertGitHubRepository(owner, repository);
  if (segments.length === 2) {
    return {
      source: "github",
      owner,
      repository,
      ref: "HEAD",
      requestedPath: null,
      skillSlug: null,
      inputUrl: url.toString(),
    };
  }
  const mode = segments[2];
  if (mode !== "tree" && mode !== "blob") {
    throw new HTTPException(422, {
      message: "Use a GitHub repository, tree, folder, or SKILL.md URL",
    });
  }
  const ref = segments[3];
  if (!ref) throw new HTTPException(422, { message: "The GitHub URL is missing a revision" });
  const pathSegments = segments.slice(4);
  if (pathSegments.length === 0 && mode === "blob") {
    throw new HTTPException(422, { message: "The GitHub URL is missing a Skill folder" });
  }
  const folderSegments =
    mode === "blob" && pathSegments.at(-1)?.toLowerCase() === "skill.md"
      ? pathSegments.slice(0, -1)
      : pathSegments;
  const requestedPath = folderSegments.length === 0 ? "." : normalizeGitHubPath(folderSegments);
  return {
    source: "github",
    owner,
    repository,
    ref,
    requestedPath,
    skillSlug: null,
    inputUrl: url.toString(),
  };
}

async function selectSkillRoot(
  source: ParsedSkillSource,
  tree: readonly GitHubSkillTreeEntry[],
  readBlob: (sha: string) => Promise<Uint8Array>,
  sourceCommit: string,
): Promise<string> {
  const skillFiles = tree
    .filter(
      (entry) =>
        entry.type === "blob" &&
        entry.mode !== "120000" &&
        (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")),
    )
    .map((entry) => (entry.path === "SKILL.md" ? "." : entry.path.slice(0, -"/SKILL.md".length)))
    .sort();
  if (source.requestedPath) {
    const root = source.requestedPath;
    if (!skillFiles.includes(root)) {
      throw new HTTPException(422, {
        message: `No top-level SKILL.md was found in ${root}`,
      });
    }
    return root;
  }
  let candidates = skillFiles;
  if (source.skillSlug) {
    // skills.sh identifies frontmatter names, not necessarily folder basenames
    // (e.g. vercel-react-best-practices lives in skills/react-best-practices).
    // Bound discovery as well as the eventual artifact; exact folder URLs avoid
    // this scan for very large repositories or duplicate names.
    if (skillFiles.length > PORTABLE_SKILL_MAX_FILES) {
      throw new HTTPException(422, {
        message: "Too many Skill candidates; paste the exact GitHub folder URL",
      });
    }
    let metadataBytes = 0;
    const entriesByPath = new Map(tree.map((entry) => [entry.path, entry]));
    const matches = await mapConcurrent(skillFiles, maxConcurrentBlobReads, async (root) => {
      const entry = entriesByPath.get(root === "." ? "SKILL.md" : `${root}/SKILL.md`)!;
      if ((entry.size ?? 0) > PORTABLE_SKILL_MAX_FILE_BYTES) {
        throw new HTTPException(422, {
          message: "Skill metadata is too large; paste the exact GitHub folder URL",
        });
      }
      const bytes = await readBlob(entry.sha);
      metadataBytes += bytes.byteLength;
      if (
        bytes.byteLength > PORTABLE_SKILL_MAX_FILE_BYTES ||
        metadataBytes > PORTABLE_SKILL_MAX_TOTAL_BYTES
      ) {
        throw new HTTPException(422, {
          message: "Skill metadata is too large; paste the exact GitHub folder URL",
        });
      }
      let markdown: string;
      try {
        markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new HTTPException(422, {
          message: "Skill metadata is not valid UTF-8; paste the exact GitHub folder URL",
        });
      }
      return (
        parsePortableSkillFrontmatter(markdown).name?.toLowerCase() ===
        source.skillSlug!.toLowerCase()
      );
    });
    candidates = skillFiles.filter((_, index) => matches[index]);
    if (candidates.length === 0) {
      // A folder basename is not a skills.sh identity. Never silently import a
      // different frontmatter name from a stale directory-shaped link.
      const folders = skillFiles.filter((path) => path.split("/").at(-1) === source.skillSlug);
      const exactPath =
        folders.length === 1 ? encodeGitHubPath(folders[0]!) : "<exact-skill-folder-path>";
      throw new HTTPException(422, {
        message: `No Skill frontmatter name matches skills.sh slug "${source.skillSlug}"; the link may be stale. Check the current Skill name, or explicitly select the intended Skill using its exact GitHub folder URL: https://github.com/${source.owner}/${source.repository}/tree/${sourceCommit}/${exactPath}`,
      });
    }
  }
  if (candidates.length === 0) {
    throw new HTTPException(422, { message: "No Skill folder with SKILL.md was found" });
  }
  if (candidates.length > 1) {
    throw new HTTPException(422, {
      message: "This source contains multiple Skills; paste the exact GitHub folder URL",
    });
  }
  return candidates[0]!;
}

function skillFilesUnderRoot(
  tree: readonly GitHubSkillTreeEntry[],
  root: string,
): GitHubSkillTreeEntry[] {
  const prefix = root === "." ? "" : `${root}/`;
  const inside = tree.filter((entry) => entry.path.startsWith(prefix));
  const unsupported = inside.find(
    (entry) => entry.type === "commit" || (entry.type === "blob" && entry.mode === "120000"),
  );
  if (unsupported) {
    throw new HTTPException(422, {
      message: `Skill folders may not contain symbolic links or submodules (${unsupported.path})`,
    });
  }
  const files = inside
    .filter((entry) => entry.type === "blob")
    .sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0) {
    throw new HTTPException(422, { message: "The selected Skill folder is empty" });
  }
  return files;
}

function relativeSkillPath(path: string, root: string): string {
  return root === "." ? path : path.slice(root.length + 1);
}

function normalizeGitHubPath(segments: readonly string[]): string {
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        /[\u0000-\u001f\u007f]/u.test(segment),
    )
  ) {
    throw new HTTPException(422, { message: "The GitHub Skill path is invalid" });
  }
  return segments.join("/");
}

function encodeGitHubPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function stripGitSuffix(value: string): string {
  return value.replace(/\.git$/iu, "");
}

function assertGitHubRepository(owner: string, repository: string): void {
  if (!githubSegment.test(owner) || !githubSegment.test(stripGitSuffix(repository))) {
    throw new HTTPException(422, { message: "The GitHub owner or repository name is invalid" });
  }
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        if (failed) return;
        const index = next;
        next += 1;
        if (index >= values.length) return;
        try {
          output[index] = await map(values[index]!);
        } catch (error) {
          // Let existing reads settle, but do not launch further provider calls
          // after any peer detects a failed request or an exceeded byte budget.
          failed = true;
          throw error;
        }
      }
    }),
  );
  return output;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
