import { createHash } from "node:crypto";
import { tool, type Tool } from "@openai/agents";
import { parseSkillFrontmatter } from "@opengeni/contracts";
import { z } from "zod";
import {
  assertSkillRelativePath,
  listSkillPaths,
  readSkillFiles,
  SkillFileError,
  SKILL_READ_MAX_PATHS,
  SKILL_READ_MAX_OUTPUT_BYTES,
  type SkillTextFile,
} from "./skill-files";

import {
  Capability,
  SandboxWorkspaceReadNotFoundError,
  type SandboxSessionLike,
} from "@openai/agents/sandbox";
import { SandboxFilesystemNotFoundError } from "modal";
import { recordModelPreparationMeasurement } from "./model-preparation-diagnostics";
import { isDefinitePathNotFoundError } from "./sandbox/channel-a";

const SKILL_FILE = "SKILL.md";
const MAX_DISCOVERED_SKILLS = 256;
const MAX_SKILL_ENTRIES = 1_024;
const MAX_SKILL_BYTES = 32 * 1024 * 1024;
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isMissingSkillPath(error: unknown): boolean {
  return (
    isDefinitePathNotFoundError(error) ||
    error instanceof SandboxWorkspaceReadNotFoundError ||
    error instanceof SandboxFilesystemNotFoundError
  );
}

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
  private discovery?: Promise<readonly WorkspaceSkill[]>;

  constructor(
    private readonly searchPaths: readonly WorkspaceSkillSearchPath[],
    private readonly reservedNames: ReadonlySet<string> = new Set(),
    private readonly shadowedNames: ReadonlySet<string> = new Set(),
  ) {
    super();
  }

  override bind(session: SandboxSessionLike): this {
    if (this._session !== session) delete this.discovery;
    return super.bind(session);
  }

  private discover(): Promise<readonly WorkspaceSkill[]> {
    const session = requireWorkspaceSkillSession(this._session);
    return (this.discovery ??= discoverWorkspaceSkills(
      session,
      this.searchPaths,
      this.reservedNames,
      this._runAs,
      this.shadowedNames,
    ));
  }

  override tools(): Tool<unknown>[] {
    return [
      tool({
        name: "repository_skill_read",
        description:
          "Read current repository Skill files from the bound workspace. Use the exact repository: identifier from the Repository skills index. Omit paths for SKILL.md; explicit relative paths read only those files. Set listFiles:true without paths for a bounded file inventory. This reads live files through the sandbox, including Connected Machines.",
        parameters: z.object({
          skill: z.string().min(1),
          paths: z.array(z.string().min(1).max(1024)).min(1).max(SKILL_READ_MAX_PATHS).optional(),
          listFiles: z.boolean().optional(),
        }),
        execute: async (request) => {
          if (request.listFiles && request.paths !== undefined)
            throw new SkillFileError(
              "invalid_request",
              "listFiles:true cannot be combined with paths.",
            );
          const skill = (await this.discover()).find(
            (entry) => repositorySkillId(entry) === request.skill,
          );
          if (!skill)
            throw new SkillFileError(
              "missing_file",
              "Repository Skill is not in this index. Use its exact repository: identifier.",
            );
          const session = requireWorkspaceSkillSession(this._session);
          const root = skill.path.slice(0, -SKILL_FILE.length - 1);
          const result = request.listFiles
            ? listSkillPaths(
                await repositorySkillInventory(session, root, this._runAs),
                MAX_SKILL_ENTRIES,
              )
            : readSkillFiles(
                await repositorySkillFiles(
                  session,
                  root,
                  request.paths ?? [SKILL_FILE],
                  this._runAs,
                ),
                request.paths,
              );
          const output = JSON.stringify({
            skillId: request.skill,
            source: "repository",
            root,
            ...result,
          });
          if (new TextEncoder().encode(output).byteLength > SKILL_READ_MAX_OUTPUT_BYTES) {
            throw new SkillFileError(
              "output_too_large",
              "Repository Skill response exceeds the read output limit. Request fewer paths.",
            );
          }
          return output;
        },
      }),
    ];
  }

  override async instructions(): Promise<string | null> {
    const skills = await this.discover();
    if (skills.length === 0) return null;

    const available = skills
      .map(
        (skill) =>
          `- ${JSON.stringify({ id: repositorySkillId(skill), name: skill.name, description: skill.description, reader: "repository_skill_read", path: skill.path })}`,
      )
      .join("\n");
    return `## Repository skills

Repository skills are instructions already present in the live workspace. Read them with repository_skill_read using the exact repository: id below. The reader returns current live files; ordinary filesystem tools execute referenced scripts and read binary assets. Configured Skills use their separate skill_read index.

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
): WorkspaceSkillsCapability {
  return new WorkspaceSkillsCapability(
    searchPaths,
    new Set([...reservedNames].map((name) => name.toLowerCase())),
    new Set([...shadowedNames].map((name) => name.toLowerCase())),
  );
}

export async function discoverWorkspaceSkills(
  session: SandboxSessionLike,
  searchPaths: readonly WorkspaceSkillSearchPath[],
  reservedNames: ReadonlySet<string> = new Set(),
  runAs?: string,
  shadowedNames: ReadonlySet<string> = new Set(),
): Promise<readonly WorkspaceSkill[]> {
  const startedAt = performance.now();
  let outcome: "completed" | "failed" = "completed";
  try {
    return await discoverWorkspaceSkillsUnmeasured(
      session,
      searchPaths,
      reservedNames,
      runAs,
      shadowedNames,
    );
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    recordModelPreparationMeasurement({
      phase: "repository_skill_discovery",
      outcome,
      durationSeconds: (performance.now() - startedAt) / 1_000,
      count: searchPaths.length,
    });
  }
}

async function discoverWorkspaceSkillsUnmeasured(
  session: SandboxSessionLike,
  searchPaths: readonly WorkspaceSkillSearchPath[],
  reservedNames: ReadonlySet<string>,
  runAs: string | undefined,
  shadowedNames: ReadonlySet<string>,
): Promise<readonly WorkspaceSkill[]> {
  if (!session.listDir || !session.readFile) {
    throw new Error("Workspace skill discovery requires sandbox listDir() and readFile() support");
  }
  const discovered = new Map<string, DiscoveredWorkspaceSkill>();
  let candidates = 0;
  for (const searchPath of searchPaths) {
    let entries;
    try {
      entries = await session.listDir({ path: searchPath.path, ...(runAs ? { runAs } : {}) });
    } catch (error) {
      if (!isMissingSkillPath(error)) throw error;
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
      } catch (error) {
        if (!isMissingSkillPath(error)) throw error;
        continue;
      }
      const frontmatter = parseSkillFrontmatter(markdown);
      const name = frontmatter.name?.trim() || entry.name;
      if (name.length > 64 || !SAFE_SKILL_NAME.test(name)) {
        throw new Error(`Repository skill has an invalid name: ${name.slice(0, 64)}`);
      }
      const key = name.toLowerCase();
      if (shadowedNames.has(key)) continue;
      const description = frontmatter.description?.trim() || "No description provided.";
      if (description.length > 2_048 || /[\r\n]/.test(description)) {
        throw new Error(`Repository skill "${name}" has an invalid description`);
      }
      if (reservedNames.has(key)) {
        throw new Error(`Workspace skill "${name}" conflicts with a configured OpenGeni skill`);
      }
      const candidate: DiscoveredWorkspaceSkill = {
        name,
        description,
        path: skillMarkdownPath,
        source: searchPath.source,
        directory: entry.path,
      };
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
          `Workspace skill "${name}" has conflicting definitions in ${existing.source} and ${candidate.source}`,
        );
      }
      existing.fingerprint = existingFingerprint;
    }
  }
  return [...discovered.values()]
    .map(({ name, description, path, source }) => ({ name, description, path, source }))
    .sort((left, right) => left.name.localeCompare(right.name));
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

function repositorySkillId(skill: WorkspaceSkill): string {
  return `repository:${skill.path}`;
}

/** Resolve only ordinary directory entries under the discovered Skill root.
 * Never treat a caller identifier as a path or follow a listed symlink. The
 * bound sandbox remains the filesystem authority, including concurrent edits.
 */
async function repositorySkillFiles(
  session: SandboxSessionLike,
  root: string,
  paths: readonly string[],
  runAs?: string,
): Promise<SkillTextFile[]> {
  // Validate the entire request before touching the filesystem.
  readSkillFiles(
    paths.map((path) => ({ path, content: "" })),
    paths,
  );
  const files: SkillTextFile[] = [];
  for (const path of paths) {
    let directory = root;
    const segments = path.split("/");
    for (const [index, name] of segments.entries()) {
      const entries = await session.listDir!({ path: directory, ...(runAs ? { runAs } : {}) });
      const entry = entries.find((candidate) => candidate.name === name);
      const expected = index === segments.length - 1 ? "file" : "dir";
      if (entry?.type !== expected)
        throw new SkillFileError("missing_file", `Repository Skill file is unavailable: ${path}`);
      directory = joinWorkspacePath(directory, name);
    }
    const content = await session.readFile!({ path: directory, ...(runAs ? { runAs } : {}) });
    files.push({
      path,
      content:
        typeof content === "string"
          ? content
          : new TextDecoder("utf-8", { fatal: true }).decode(content),
    });
    // Bound aggregate output as each file arrives; do not truncate accepted text.
    readSkillFiles(
      files,
      files.map((file) => file.path),
    );
  }
  return files;
}

async function repositorySkillInventory(
  session: SandboxSessionLike,
  root: string,
  runAs?: string,
): Promise<SkillTextFile[]> {
  const files: SkillTextFile[] = [];
  let count = 0;
  async function visit(relative: string): Promise<void> {
    const entries = await session.listDir!({
      path: relative ? joinWorkspacePath(root, relative) : root,
      ...(runAs ? { runAs } : {}),
    });
    for (const entry of entries) {
      if (++count > MAX_SKILL_ENTRIES)
        throw new SkillFileError("output_too_large", "Repository Skill inventory is too large.");
      // Paths derive from validated names, never provider-returned absolute paths.
      assertSkillRelativePath(entry.name);
      if (entry.name.includes("/"))
        throw new SkillFileError("invalid_path", "Invalid repository directory entry.");
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.type === "dir") await visit(path);
      else if (entry.type === "file") files.push({ path, content: "" });
    }
  }
  await visit("");
  return files;
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
