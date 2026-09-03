import { createHash } from "node:crypto";

import { Capability, type SandboxSessionLike } from "@openai/agents/sandbox";

const SKILL_FILE = "SKILL.md";
const MAX_DISCOVERED_SKILLS = 256;
const MAX_SKILL_ENTRIES = 1_024;
const MAX_SKILL_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT_SKILL_READS = 16;
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type WorkspaceSkillSearchPath = Readonly<{
  path: string;
  source: string;
}>;

type WorkspaceSkill = Readonly<{
  name: string;
  description: string;
  path: string;
  source: string;
}>;

export type WorkspaceSkillDiscoveryCache = {
  discovery?: Promise<readonly WorkspaceSkill[]>;
};

export function createWorkspaceSkillDiscoveryCache(): WorkspaceSkillDiscoveryCache {
  return {};
}

type DiscoveredWorkspaceSkill = {
  name: string;
  description: string;
  path: string;
  source: string;
  directory: string;
  fingerprint?: string;
};

/**
 * Index skills that already exist in the live workspace.
 *
 * Unlike the SDK's `skills({ from })` and `skills({ lazyFrom })` sources, this
 * capability deliberately contributes no manifest entries and materializes
 * nothing. Repository resources and Connected Machines already own these
 * files; the bound sandbox session is the one portable way to inspect them.
 */
export class WorkspaceSkillsCapability extends Capability {
  readonly type = "workspace-skills";

  constructor(
    private readonly searchPaths: readonly WorkspaceSkillSearchPath[],
    private readonly reservedNames: ReadonlySet<string> = new Set(),
    private readonly shadowedNames: ReadonlySet<string> = new Set(),
    private readonly discoveryCache: WorkspaceSkillDiscoveryCache = createWorkspaceSkillDiscoveryCache(),
  ) {
    super();
  }

  override async instructions(): Promise<string | null> {
    const session = requireWorkspaceSkillSession(this._session);
    const skills = await prepareWorkspaceSkillDiscovery(
      this.discoveryCache,
      session,
      this.searchPaths,
      this.reservedNames,
      this._runAs,
      this.shadowedNames,
    );
    if (skills.length === 0) return null;

    const available = skills
      .map((skill) => `- ${skill.name}: ${skill.description} (file: ${skill.path})`)
      .join("\n");
    return `## Repository skills

Repository skills are instructions already present in the live workspace. They do not need to be loaded or copied.

### Available repository skills
${available}

### How to use repository skills
- If the user names a skill, or the task clearly matches a skill description, read its complete SKILL.md before acting.
- Resolve referenced scripts, references, assets, and templates relative to that skill directory.
- Use only the minimum relevant skills for the turn, and say briefly which ones you are using.
- Do not assume a skill remains applicable on later turns; evaluate the current request again.`;
  }
}

export function workspaceSkills(
  searchPaths: readonly WorkspaceSkillSearchPath[],
  reservedNames: Iterable<string> = [],
  shadowedNames: Iterable<string> = [],
  discoveryCache: WorkspaceSkillDiscoveryCache = createWorkspaceSkillDiscoveryCache(),
): WorkspaceSkillsCapability {
  return new WorkspaceSkillsCapability(
    searchPaths,
    new Set([...reservedNames].map((name) => name.toLowerCase())),
    new Set([...shadowedNames].map((name) => name.toLowerCase())),
    discoveryCache,
  );
}

export function prepareWorkspaceSkillDiscovery(
  cache: WorkspaceSkillDiscoveryCache,
  session: SandboxSessionLike,
  searchPaths: readonly WorkspaceSkillSearchPath[],
  reservedNames: ReadonlySet<string> = new Set(),
  runAs?: string,
  shadowedNames: ReadonlySet<string> = new Set(),
): Promise<readonly WorkspaceSkill[]> {
  cache.discovery ??= discoverWorkspaceSkills(
    session,
    searchPaths,
    reservedNames,
    runAs,
    shadowedNames,
  );
  return cache.discovery;
}

export async function discoverWorkspaceSkills(
  session: SandboxSessionLike,
  searchPaths: readonly WorkspaceSkillSearchPath[],
  reservedNames: ReadonlySet<string> = new Set(),
  runAs?: string,
  shadowedNames: ReadonlySet<string> = new Set(),
): Promise<readonly WorkspaceSkill[]> {
  if (!session.listDir || !session.readFile) {
    throw new Error("Workspace skill discovery requires sandbox listDir() and readFile() support");
  }
  const discovered = new Map<string, DiscoveredWorkspaceSkill>();
  const directoriesByPath = await Promise.all(
    searchPaths.map(async (searchPath) => {
      let entries;
      try {
        entries = await session.listDir!({
          path: searchPath.path,
          ...(runAs ? { runAs } : {}),
        });
      } catch {
        return [];
      }
      return [...entries]
        .filter((entry) => entry.type === "dir")
        .sort((left, right) => left.name.localeCompare(right.name));
    }),
  );
  const directoryCount = directoriesByPath.reduce(
    (total, directories) => total + directories.length,
    0,
  );
  if (directoryCount > MAX_DISCOVERED_SKILLS) {
    throw new Error(`Repository skill discovery exceeds ${MAX_DISCOVERED_SKILLS} directories`);
  }
  const candidatesByPath = searchPaths.map((): DiscoveredWorkspaceSkill[] => []);
  const directoryJobs = directoriesByPath.flatMap((directories, searchPathIndex) =>
    directories.map((entry) => ({ entry, searchPathIndex })),
  );
  const loaded = await mapWithConcurrency(
    directoryJobs,
    MAX_CONCURRENT_SKILL_READS,
    async ({ entry, searchPathIndex }) => {
      const searchPath = searchPaths[searchPathIndex]!;
      const skillMarkdownPath = joinWorkspacePath(entry.path, SKILL_FILE);
      let markdown: string;
      try {
        const content = await session.readFile!({
          path: skillMarkdownPath,
          ...(runAs ? { runAs } : {}),
        });
        markdown = typeof content === "string" ? content : new TextDecoder().decode(content);
      } catch {
        return null;
      }
      const frontmatter = parseSkillFrontmatter(markdown);
      const name = frontmatter.name?.trim() || entry.name;
      if (name.length > 64 || !SAFE_SKILL_NAME.test(name)) {
        throw new Error(`Repository skill has an invalid name: ${name.slice(0, 64)}`);
      }
      const key = name.toLowerCase();
      if (shadowedNames.has(key)) return null;
      const description = frontmatter.description?.trim() || "No description provided.";
      if (description.length > 2_048 || /[\r\n]/.test(description)) {
        throw new Error(`Repository skill "${name}" has an invalid description`);
      }
      if (reservedNames.has(key)) {
        throw new Error(`Workspace skill "${name}" conflicts with a configured OpenGeni skill`);
      }
      return {
        searchPathIndex,
        candidate: {
          name,
          description,
          path: skillMarkdownPath,
          source: searchPath.source,
          directory: entry.path,
        } satisfies DiscoveredWorkspaceSkill,
      };
    },
  );
  for (const result of loaded) {
    if (result) candidatesByPath[result.searchPathIndex]!.push(result.candidate);
  }
  // Fold in declared search-path order so alias precedence remains deterministic
  // even though remote directory and frontmatter reads run concurrently.
  for (const candidates of candidatesByPath) {
    for (const candidate of candidates) {
      const key = candidate.name.toLowerCase();
      const existing = discovered.get(key);
      if (!existing) {
        discovered.set(key, candidate);
        continue;
      }
      // Unique names only need SKILL.md frontmatter for the prompt-cache prefix.
      // Hash both trees only when the same name appears in two search paths.
      const existingFingerprint =
        existing.fingerprint ??
        (await fingerprintWorkspaceDirectory(session, existing.directory, runAs));
      const candidateFingerprint = await fingerprintWorkspaceDirectory(
        session,
        candidate.directory,
        runAs,
      );
      if (existingFingerprint !== candidateFingerprint) {
        throw new Error(
          `Workspace skill "${candidate.name}" has conflicting definitions in ${existing.source} and ${candidate.source}`,
        );
      }
      existing.fingerprint = existingFingerprint;
    }
  }
  return [...discovered.values()]
    .map(({ name, description, path, source }) => ({ name, description, path, source }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => await worker()),
  );
  return results;
}

async function fingerprintWorkspaceDirectory(
  session: SandboxSessionLike,
  root: string,
  runAs?: string,
): Promise<string> {
  const hash = createHash("sha256");
  let entryCount = 0;
  let byteCount = 0;

  async function visit(path: string, relativePath: string): Promise<void> {
    const entries = await session.listDir!({ path, ...(runAs ? { runAs } : {}) });
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      entryCount += 1;
      if (entryCount > MAX_SKILL_ENTRIES) {
        throw new Error(`Workspace skill exceeds ${MAX_SKILL_ENTRIES} filesystem entries`);
      }
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      hash.update(entry.type);
      hash.update("\0");
      hash.update(childRelativePath);
      hash.update("\0");
      if (entry.type === "dir") {
        await visit(entry.path, childRelativePath);
        continue;
      }
      if (entry.type !== "file") continue;
      const content = await session.readFile!({
        path: entry.path,
        ...(runAs ? { runAs } : {}),
      });
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      byteCount += bytes.byteLength;
      if (byteCount > MAX_SKILL_BYTES) {
        throw new Error(`Workspace skill exceeds ${MAX_SKILL_BYTES} bytes`);
      }
      hash.update(bytes);
      hash.update("\0");
    }
  }

  await visit(root, "");
  return hash.digest("hex");
}

function parseSkillFrontmatter(markdown: string): {
  name?: string;
  description?: string;
} {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return {};
  const values: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    if (key !== "name" && key !== "description") continue;
    values[key] = unquote(line.slice(separator + 1).trim());
  }
  return values;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    value[0] === value[value.length - 1] &&
    (value[0] === '"' || value[0] === "'")
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function joinWorkspacePath(parent: string, child: string): string {
  return `${parent.replace(/\/+$/, "")}/${child}`;
}

function requireWorkspaceSkillSession(session: SandboxSessionLike | undefined): SandboxSessionLike {
  if (!session) {
    throw new Error('capability "workspace-skills" used before bind(session)');
  }
  return session;
}
