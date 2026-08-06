import { createHash } from "node:crypto";

import { Capability, type SandboxSessionLike } from "@openai/agents/sandbox";

const SKILL_FILE = "SKILL.md";
const MAX_DISCOVERED_SKILLS = 256;
const MAX_SKILL_ENTRIES = 1_024;
const MAX_SKILL_BYTES = 32 * 1024 * 1024;
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type WorkspaceSkillSearchPath = Readonly<{
  path: string;
  source: string;
}>;

type WorkspaceSkill = Readonly<{
  name: string;
  description: string;
  path: string;
  fingerprint: string;
  source: string;
}>;

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
  private discovery?: Promise<readonly WorkspaceSkill[]>;

  constructor(
    private readonly searchPaths: readonly WorkspaceSkillSearchPath[],
    private readonly reservedNames: ReadonlySet<string> = new Set(),
  ) {
    super();
  }

  override async instructions(): Promise<string | null> {
    const session = requireWorkspaceSkillSession(this._session);
    this.discovery ??= discoverWorkspaceSkills(
      session,
      this.searchPaths,
      this.reservedNames,
      this._runAs,
    );
    const skills = await this.discovery;
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
): WorkspaceSkillsCapability {
  return new WorkspaceSkillsCapability(
    searchPaths,
    new Set([...reservedNames].map((name) => name.toLowerCase())),
  );
}

export async function discoverWorkspaceSkills(
  session: SandboxSessionLike,
  searchPaths: readonly WorkspaceSkillSearchPath[],
  reservedNames: ReadonlySet<string> = new Set(),
  runAs?: string,
): Promise<readonly WorkspaceSkill[]> {
  if (!session.listDir || !session.readFile) {
    throw new Error("Workspace skill discovery requires sandbox listDir() and readFile() support");
  }
  const discovered = new Map<string, WorkspaceSkill>();
  let candidates = 0;
  for (const searchPath of searchPaths) {
    let entries;
    try {
      entries = await session.listDir({ path: searchPath.path, ...(runAs ? { runAs } : {}) });
    } catch {
      continue;
    }
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.type !== "dir") continue;
      candidates += 1;
      if (candidates > MAX_DISCOVERED_SKILLS) {
        throw new Error(`Repository skill discovery exceeds ${MAX_DISCOVERED_SKILLS} directories`);
      }
      const skillMarkdownPath = joinWorkspacePath(entry.path, SKILL_FILE);
      let markdown: string;
      try {
        const content = await session.readFile({
          path: skillMarkdownPath,
          ...(runAs ? { runAs } : {}),
        });
        markdown = typeof content === "string" ? content : new TextDecoder().decode(content);
      } catch {
        continue;
      }
      const frontmatter = parseSkillFrontmatter(markdown);
      const name = frontmatter.name?.trim() || entry.name;
      if (name.length > 64 || !SAFE_SKILL_NAME.test(name)) {
        throw new Error(`Repository skill has an invalid name: ${name.slice(0, 64)}`);
      }
      const description = frontmatter.description?.trim() || "No description provided.";
      if (description.length > 2_048 || /[\r\n]/.test(description)) {
        throw new Error(`Repository skill "${name}" has an invalid description`);
      }
      const key = name.toLowerCase();
      if (reservedNames.has(key)) {
        throw new Error(`Workspace skill "${name}" conflicts with a configured OpenGeni skill`);
      }
      const candidate: WorkspaceSkill = {
        name,
        description,
        path: skillMarkdownPath,
        fingerprint: await fingerprintWorkspaceDirectory(session, entry.path, runAs),
        source: searchPath.source,
      };
      const existing = discovered.get(key);
      if (!existing) {
        discovered.set(key, candidate);
        continue;
      }
      if (existing.fingerprint !== candidate.fingerprint) {
        throw new Error(
          `Workspace skill "${name}" has conflicting definitions in ${existing.source} and ${candidate.source}`,
        );
      }
    }
  }
  return [...discovered.values()].sort((left, right) => left.name.localeCompare(right.name));
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
