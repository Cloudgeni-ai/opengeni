import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { localDirLazySkillSource } from "@openai/agents/sandbox/local";
import {
  dir,
  file,
  localDir,
  type Dir,
  type Entry,
  type LocalDirLazySkillSource,
  type SkillIndexEntry,
} from "@openai/agents/sandbox";

import { skillArtifactContentSha256 } from "./skill-library";

export type RuntimeSkillArtifactFile = Readonly<{
  path: string;
  content: string;
}>;

/**
 * One immutable Skill artifact that may be activated by an installation, a
 * Pack, or an exact session selection. The artifact itself is deliberately
 * acquisition-neutral: Packs do not own a second Skill representation.
 */
export type RuntimeSkillArtifact = Readonly<{
  name: string;
  description?: string | null | undefined;
  files: readonly RuntimeSkillArtifactFile[];
}>;

export type InstalledSkillActivation = Readonly<{
  source: "installation";
  id: string;
  artifact: RuntimeSkillArtifact;
  version: string | null;
  contentSha256: string;
  reason: string;
}>;

export type PackSkillActivation = Readonly<{
  source: "pack";
  id: string;
  artifact: RuntimeSkillArtifact;
  reason: string;
}>;

export type SessionSkillActivation = Readonly<{
  source: "session";
  id: string;
  artifact: RuntimeSkillArtifact;
  reason: string;
}>;

export type RuntimeSkillActivation =
  | InstalledSkillActivation
  | PackSkillActivation
  | SessionSkillActivation;

export type NativeToolSkillSet = Readonly<{
  editableArtifacts: boolean;
  sites?: boolean;
  videoGeneration: boolean;
}>;

export type EffectiveSkillSelection = Readonly<{
  id: string;
  name: string;
  source: "installation" | "pack" | "session" | "native_tool";
  version: string | null;
  contentSha256: string | null;
  reason: string;
}>;

export type RuntimeSkillComposition = Readonly<{
  lazySource: LocalDirLazySkillSource;
  selections: readonly EffectiveSkillSelection[];
  /** Exact always-visible catalog descriptors for explicitly activated Skills. */
  configuredDescriptors: readonly RuntimeSkillDescriptor[];
  configuredNames: readonly string[];
  nativeToolNames: readonly string[];
}>;

export type RuntimeSkillDescriptor = Readonly<{
  id: string;
  name: string;
  source: RuntimeSkillActivation["source"];
  reason: string;
  description: string;
}>;

type ValidatedRuntimeSkillActivation = Readonly<{
  activation: RuntimeSkillActivation;
  contentSha256: string;
}>;

const emptyNativeToolSkillSet: NativeToolSkillSet = Object.freeze({
  editableArtifacts: false,
  sites: false,
  videoGeneration: false,
});

let stagedBundledArtifactSkillsDir: string | null = null;
let stagedBundledSiteSkillsDir: string | null = null;
let stagedBundledVideoSkillsDir: string | null = null;

/**
 * Compose the exact Skills surface for one agent.
 *
 * Optional/domain Skills enter only through explicit activations. Native
 * Skills are admitted only with the exact executable tool surface they
 * document. This one result owns both lazy materialization and inspection
 * provenance so those projections cannot disagree.
 */
export function composeRuntimeSkills(
  activations: readonly RuntimeSkillActivation[],
  nativeTools: NativeToolSkillSet = emptyNativeToolSkillSet,
): RuntimeSkillComposition {
  const nativeSources = nativeToolSkillSources(nativeTools);
  const nativeNameKeys = new Set(
    nativeSources.flatMap((source) => source.names).map((name) => name.toLowerCase()),
  );
  const effectiveActivations = resolveEffectiveActivations(
    activations.map(validateRuntimeSkillActivation),
    nativeNameKeys,
  );
  const activatedNameKeys = new Set(
    effectiveActivations.map(({ activation }) => activation.artifact.name.toLowerCase()),
  );
  const children: Record<string, Entry> = {};
  for (const source of nativeSources) {
    for (const name of source.names) {
      children[name] = localDir({ src: join(source.directory, name) });
    }
  }

  const activationIndex: SkillIndexEntry[] = [];
  for (const { activation } of effectiveActivations) {
    const { artifact } = activation;
    children[artifact.name] = runtimeSkillDirEntry(artifact);
    activationIndex.push({
      name: artifact.name,
      description: runtimeSkillDescription(artifact),
      path: artifact.name,
    });
  }

  return Object.freeze({
    lazySource: {
      source: dir({ children }),
      getIndex: (manifest, skillsPath) => [
        ...nativeSources.flatMap((source) =>
          (source.lazySource.getIndex?.(manifest, skillsPath) ?? []).filter(
            (entry) => !activatedNameKeys.has((entry.path ?? entry.name).toLowerCase()),
          ),
        ),
        ...activationIndex,
      ],
    },
    selections: Object.freeze([
      ...nativeSources.flatMap((source) =>
        source.names.map((name) =>
          Object.freeze({
            id: `native-tool:${name}`,
            name,
            source: "native_tool" as const,
            version: null,
            contentSha256: null,
            reason: source.reason,
          }),
        ),
      ),
      ...effectiveActivations.map((activation) => selectionForActivation(activation)),
    ]),
    configuredDescriptors: Object.freeze(
      effectiveActivations.map(({ activation }) =>
        Object.freeze({
          id: activation.id,
          name: activation.artifact.name,
          source: activation.source,
          reason: activation.reason,
          description: runtimeSkillDescription(activation.artifact),
        }),
      ),
    ),
    configuredNames: Object.freeze(
      effectiveActivations.map(({ activation }) => activation.artifact.name),
    ),
    nativeToolNames: Object.freeze(nativeSources.flatMap((source) => source.names)),
  });
}

function resolveEffectiveActivations(
  activations: readonly ValidatedRuntimeSkillActivation[],
  nativeNameKeys: ReadonlySet<string>,
): ValidatedRuntimeSkillActivation[] {
  const effective = new Map<string, ValidatedRuntimeSkillActivation>();
  for (const candidate of activations) {
    const { activation } = candidate;
    const key = activation.artifact.name.toLowerCase();
    if (nativeNameKeys.has(key)) {
      throw new Error(
        `Skill "${activation.artifact.name}" conflicts with a native tool-bound Skill`,
      );
    }
    const existing = effective.get(key);
    if (!existing) {
      effective.set(key, candidate);
      continue;
    }
    if (existing.contentSha256 !== candidate.contentSha256) {
      throw new Error(`Conflicting Skill definitions for "${activation.artifact.name}"`);
    }
    if (
      activationPrecedence(activation.source) > activationPrecedence(existing.activation.source)
    ) {
      effective.set(key, candidate);
    }
  }
  return [...effective.values()].sort(({ activation: left }, { activation: right }) =>
    compareRuntimeSkillName(left.artifact.name, right.artifact.name),
  );
}

function activationPrecedence(source: RuntimeSkillActivation["source"]): number {
  switch (source) {
    case "installation":
      return 1;
    case "pack":
      return 2;
    case "session":
      return 3;
  }
}

function validateRuntimeSkillActivation(
  activation: RuntimeSkillActivation,
): ValidatedRuntimeSkillActivation {
  if (!activation.id.trim()) throw new Error("Skill activation id must not be blank");
  if (!activation.reason.trim()) throw new Error("Skill activation reason must not be blank");
  if (activation.source === "installation" && activation.version !== null) {
    if (!activation.version.trim()) throw new Error("Installed Skill version must not be blank");
  }
  assertSafeRuntimeSkillName(activation.artifact.name);
  runtimeSkillDirNode(activation.artifact);
  const contentSha256 = skillArtifactContentSha256(activation.artifact.files);
  if (activation.source === "installation" && contentSha256 !== activation.contentSha256) {
    throw new Error(
      `Installed Skill artifact hash mismatch for ${activation.id}: expected ${activation.contentSha256}, got ${contentSha256}`,
    );
  }
  return Object.freeze({ activation, contentSha256 });
}

function selectionForActivation({
  activation,
  contentSha256,
}: ValidatedRuntimeSkillActivation): EffectiveSkillSelection {
  switch (activation.source) {
    case "installation":
      return Object.freeze({
        id: activation.id,
        name: activation.artifact.name,
        source: activation.source,
        version: activation.version,
        contentSha256,
        reason: activation.reason,
      });
    case "pack":
    case "session":
      return Object.freeze({
        id: activation.id,
        name: activation.artifact.name,
        source: activation.source,
        version: null,
        contentSha256,
        reason: activation.reason,
      });
  }
}

function nativeToolSkillSources(nativeTools: NativeToolSkillSet): Array<{
  directory: string;
  lazySource: LocalDirLazySkillSource;
  names: string[];
  reason: string;
}> {
  const sources: Array<{
    directory: string;
    lazySource: LocalDirLazySkillSource;
    names: string[];
    reason: string;
  }> = [];
  if (nativeTools.editableArtifacts) {
    const directory = bundledArtifactSkillsDir();
    sources.push({
      directory,
      lazySource: localDirLazySkillSource({ src: directory }),
      names: skillDirNames(directory),
      reason: "native editable-artifact tool surface",
    });
  }
  if (nativeTools.sites) {
    const directory = bundledSiteSkillsDir();
    sources.push({
      directory,
      lazySource: localDirLazySkillSource({ src: directory }),
      names: skillDirNames(directory),
      reason: "bundled Site authoring skill",
    });
  }
  if (nativeTools.videoGeneration) {
    const directory = bundledVideoSkillsDir();
    sources.push({
      directory,
      lazySource: localDirLazySkillSource({ src: directory }),
      names: skillDirNames(directory),
      reason: "native video-generation tool surface",
    });
  }
  return sources;
}

function packagedSkillDirectory(directoryName: string): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return (
    [
      join(moduleDir, "assets", "runtime", directoryName),
      join(moduleDir, directoryName),
      join(moduleDir, "..", "src", directoryName),
    ].find((candidate) => existsSync(candidate)) ?? join(moduleDir, directoryName)
  );
}

function bundledArtifactSkillsDir(): string {
  const packaged = packagedSkillDirectory("bundled_artifact_skills");
  if (isPathWithin(process.cwd(), packaged)) return packaged;
  if (!stagedBundledArtifactSkillsDir) {
    stagedBundledArtifactSkillsDir = stageSkillDirectory(
      packaged,
      join(process.cwd(), ".opengeni", "bundled_artifact_skills"),
    );
  }
  return stagedBundledArtifactSkillsDir;
}

function bundledSiteSkillsDir(): string {
  const packaged = packagedSkillDirectory("bundled_site_skills");
  if (isPathWithin(process.cwd(), packaged)) return packaged;
  if (!stagedBundledSiteSkillsDir) {
    stagedBundledSiteSkillsDir = stageSkillDirectory(
      packaged,
      join(process.cwd(), ".opengeni", "bundled_site_skills"),
    );
  }
  return stagedBundledSiteSkillsDir;
}

function bundledVideoSkillsDir(): string {
  const packaged = packagedSkillDirectory("bundled_video_skills");
  if (isPathWithin(process.cwd(), packaged)) return packaged;
  if (!stagedBundledVideoSkillsDir) {
    stagedBundledVideoSkillsDir = stageSkillDirectory(
      packaged,
      join(process.cwd(), ".opengeni", "bundled_video_skills"),
    );
  }
  return stagedBundledVideoSkillsDir;
}

function stageSkillDirectory(packaged: string, target: string): string {
  const temporary = `${target}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(dirname(temporary), { recursive: true });
  cpSync(packaged, temporary, { recursive: true });
  rmSync(target, { recursive: true, force: true });
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    if (!existsSync(target)) throw error;
  }
  return target;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function skillDirNames(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();
}

type RuntimeSkillDirNode = {
  dirs: Map<string, RuntimeSkillDirNode>;
  files: Map<string, string>;
};

function runtimeSkillDirEntry(skill: RuntimeSkillArtifact): Dir {
  return runtimeSkillDirFromNode(runtimeSkillDirNode(skill));
}

function runtimeSkillDirNode(skill: RuntimeSkillArtifact): RuntimeSkillDirNode {
  const root: RuntimeSkillDirNode = { dirs: new Map(), files: new Map() };
  for (const skillFile of skill.files) {
    const segments = runtimeSkillPathSegments(skill.name, skillFile.path);
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      if (node.files.has(segment)) {
        throw new Error(`Skill ${skill.name} uses ${segment} as both a file and a directory`);
      }
      let next = node.dirs.get(segment);
      if (!next) {
        next = { dirs: new Map(), files: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    const filename = segments.at(-1)!;
    if (node.dirs.has(filename) || node.files.has(filename)) {
      throw new Error(`Duplicate Skill file path in ${skill.name}: ${skillFile.path}`);
    }
    node.files.set(filename, skillFile.content);
  }
  if (!root.files.has("SKILL.md")) {
    throw new Error(`Skill ${skill.name} is missing a top-level SKILL.md file`);
  }
  return root;
}

function runtimeSkillDirFromNode(node: RuntimeSkillDirNode): Dir {
  const children: Record<string, Entry> = {};
  for (const [name, child] of node.dirs) children[name] = runtimeSkillDirFromNode(child);
  for (const [name, content] of node.files) children[name] = file({ content });
  return dir({ children });
}

function assertSafeRuntimeSkillName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) {
    throw new Error(`Invalid Skill name: ${name}`);
  }
}

function runtimeSkillPathSegments(skillName: string, path: string): string[] {
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid Skill file path for ${skillName}: ${path}`);
  }
  return segments;
}

function compareRuntimeSkillName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runtimeSkillDescription(skill: RuntimeSkillArtifact): string {
  const explicit = skill.description?.trim();
  if (explicit) return explicit;
  const markdown = skill.files.find((skillFile) => skillFile.path === "SKILL.md")?.content ?? "";
  return skillFrontmatterDescription(markdown) ?? "No description provided.";
}

function skillFrontmatterDescription(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return null;
  const collected: string[] = [];
  let inDescription = false;
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^description:\s*(.*)$/);
    if (match) {
      const inline = match[1]!.trim();
      if (inline && inline !== ">-" && inline !== ">" && inline !== "|" && inline !== "|-") {
        return unquoteFrontmatterValue(inline);
      }
      inDescription = true;
      continue;
    }
    if (!inDescription) continue;
    if (/^\s+\S/.test(line)) {
      collected.push(line.trim());
      continue;
    }
    break;
  }
  const blockValue = collected.join(" ").trim();
  return blockValue || null;
}

function unquoteFrontmatterValue(value: string): string {
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1);
  }
  return value;
}
