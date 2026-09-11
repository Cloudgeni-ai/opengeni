import { existsSync, readdirSync } from "node:fs";
import { sitePackageVersions } from "./site-package-versions";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readSkillMetadata } from "@opengeni/contracts";

import {
  PORTABLE_SKILL_MAX_FILES,
  buildPortableSkillArtifact,
  readSkillLibraryArtifact,
} from "./skill-library";
import { SkillFileError, listSkillPaths, readSkillFiles } from "./skill-files";
import type { SkillCatalogDescriptor } from "./skill-catalog";

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

export type RuntimeSkillReadable = Readonly<{
  id: string;
  name: string;
  description: string;
  files: readonly RuntimeSkillArtifactFile[];
}>;

export type RuntimeSkillComposition = Readonly<{
  selections: readonly EffectiveSkillSelection[];
  /** Exact always-visible catalog descriptors for explicitly activated Skills. */
  configuredDescriptors: readonly RuntimeSkillDescriptor[];
  configuredNames: readonly string[];
  nativeToolNames: readonly string[];
  /** Model-facing catalog descriptors for configured and bundled Skills. */
  index: readonly RuntimeSkillIndexEntry[];
  artifacts: readonly RuntimeSkillReadable[];
}>;

export type RuntimeSkillIndexEntry = Readonly<{
  id: string;
  name: string;
  description: string;
}>;

export type RuntimeSkillDescriptor = Readonly<{
  id: string;
  name: string;
  source: RuntimeSkillActivation["source"];
  reason: string;
  description: string;
}>;

export type RuntimeSkillReadRequest = Readonly<{
  skill: string;
  paths?: readonly string[];
  listFiles?: boolean;
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

/**
 * Packaged guidance is server-readable content, not a sandbox installation.
 * The caller supplies the effective capability selection; compute backend is
 * deliberately absent. Reading never stages files into cwd or a user's box.
 */
export function loadNativeToolSkillArtifacts(
  nativeTools: NativeToolSkillSet & Readonly<{ projects?: boolean }>,
): readonly RuntimeSkillArtifact[] {
  const directories: string[] = ["bundled_default_skills"];
  if (nativeTools.projects) directories.push("bundled_project_skills");
  if (nativeTools.editableArtifacts) directories.push("bundled_artifact_skills");
  if (nativeTools.sites) directories.push("bundled_site_skills");
  if (nativeTools.videoGeneration) directories.push("bundled_video_skills");
  return directories.flatMap((directory) => {
    const root = packagedSkillDirectory(directory);
    return skillDirNames(root).map((name) => {
      const artifact = readSkillLibraryArtifact(join(root, name));
      const files = [...artifact.files];
      if (name === "opengeni-sites") {
        const generatedPath = "package-versions.json";
        const existing = files.findIndex((entry) => entry.path === generatedPath);
        if (existing !== -1) files.splice(existing, 1);
        files.push({
          path: generatedPath,
          content: JSON.stringify(sitePackageVersions(), null, 2),
        });
      }
      return buildPortableSkillArtifact(files);
    });
  });
}

/**
 * Compose the exact Skills surface for one agent.
 * Optional/domain Skills enter only through explicit activations. Native
 * Skills are admitted only with the exact executable tool surface they
 * document. The result is an in-memory catalog and file set, not an SDK loader.
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
  const nativeArtifacts = loadNativeToolSkillArtifacts(nativeTools);
  const nativeReadables: RuntimeSkillReadable[] = nativeArtifacts.map((artifact) =>
    Object.freeze({
      id: `native-tool:${artifact.name}`,
      name: artifact.name,
      description: runtimeSkillDescription(artifact),
      files: artifact.files,
    }),
  );
  const configuredDescriptors = Object.freeze(
    effectiveActivations.map(({ activation }) =>
      Object.freeze({
        id: activation.id,
        name: activation.artifact.name,
        source: activation.source,
        reason: activation.reason,
        description: runtimeSkillDescription(activation.artifact),
      }),
    ),
  );
  const configuredReadables: RuntimeSkillReadable[] = effectiveActivations.map(({ activation }) =>
    Object.freeze({
      id: activation.id,
      name: activation.artifact.name,
      description: runtimeSkillDescription(activation.artifact),
      files: activation.artifact.files,
    }),
  );
  const index = Object.freeze([
    ...nativeReadables.map((artifact) =>
      Object.freeze({
        id: artifact.id,
        name: artifact.name,
        description: artifact.description,
      }),
    ),
    ...configuredDescriptors.map((descriptor) =>
      Object.freeze({
        id: descriptor.id,
        name: descriptor.name,
        description: descriptor.description,
      }),
    ),
  ]);

  return Object.freeze({
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
    configuredDescriptors,
    configuredNames: Object.freeze(
      effectiveActivations.map(({ activation }) => activation.artifact.name),
    ),
    nativeToolNames: Object.freeze([...nativeSources.flatMap((source) => source.names)]),
    index,
    artifacts: Object.freeze([...nativeReadables, ...configuredReadables]),
  });
}

export function skillCatalogFromComposition(
  composition: RuntimeSkillComposition,
): readonly SkillCatalogDescriptor[] {
  return composition.index;
}

export function readRuntimeSkill(
  composition: RuntimeSkillComposition,
  request: RuntimeSkillReadRequest,
): { skillId: string; files?: ReturnType<typeof readSkillFiles>["files"]; paths?: string[] } {
  const skill = request.skill.trim();
  if (!skill)
    throw new SkillFileError("invalid_request", "skill_read requires a Skill identifier.");
  if (request.listFiles === true && request.paths !== undefined) {
    throw new SkillFileError(
      "invalid_request",
      "skill_read listFiles:true cannot be combined with paths.",
    );
  }
  const exact = composition.artifacts.find((artifact) => artifact.id === skill);
  const matches = exact
    ? [exact]
    : composition.artifacts.filter((artifact) => artifact.name === skill);
  if (matches.length === 0) {
    throw new SkillFileError("missing_file", `Skill not found: ${skill}`);
  }
  if (matches.length > 1) {
    throw new SkillFileError(
      "invalid_request",
      `Skill name is ambiguous: ${skill}. Use the catalog id.`,
    );
  }
  const artifact = matches[0]!;
  if (request.listFiles === true) {
    return { skillId: artifact.id, ...listSkillPaths(artifact.files, PORTABLE_SKILL_MAX_FILES) };
  }
  return {
    skillId: artifact.id,
    files: readSkillFiles(artifact.files, request.paths).files,
  };
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
  const artifact = buildPortableSkillArtifact(activation.artifact.files);
  if (
    activation.artifact.name !== artifact.name ||
    (activation.artifact.description != null &&
      activation.artifact.description !== artifact.description)
  ) {
    throw new Error(`Skill metadata must match SKILL.md frontmatter: ${activation.id}`);
  }
  const contentSha256 = artifact.contentSha256;
  if (activation.source === "installation" && contentSha256 !== activation.contentSha256) {
    throw new Error(
      `Installed Skill artifact hash mismatch for ${activation.id}: expected ${activation.contentSha256}, got ${contentSha256}`,
    );
  }
  return Object.freeze({ activation: { ...activation, artifact }, contentSha256 });
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
  names: string[];
  reason: string;
}> {
  const sources: Array<{ names: string[]; reason: string }> = [{
    names: skillDirNames(packagedSkillDirectory("bundled_default_skills")),
    reason: "included by default",
  }];
  if (nativeTools.editableArtifacts) {
    sources.push({
      names: skillDirNames(packagedSkillDirectory("bundled_artifact_skills")),
      reason: "native editable-artifact tool surface",
    });
  }
  if (nativeTools.sites) {
    sources.push({
      names: skillDirNames(packagedSkillDirectory("bundled_site_skills")),
      reason: "bundled Site authoring skill",
    });
  }
  if (nativeTools.videoGeneration) {
    sources.push({
      names: skillDirNames(packagedSkillDirectory("bundled_video_skills")),
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
  const markdown = skill.files.find((skillFile) => skillFile.path === "SKILL.md")?.content ?? "";
  return readSkillMetadata(markdown).description;
}
