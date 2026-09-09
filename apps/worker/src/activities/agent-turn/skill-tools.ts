import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";
import {
  skillReviewHumanInput,
  type SkillActor,
  type SkillWriteReceipt,
} from "@opengeni/contracts";
import {
  assertSkillReadAttempt,
  skillReviewResolution,
  installPortableSkill,
  replayPortableSkillInstall,
  listSkillDescriptors,
  type Database,
  type InstallPortableSkillInput,
} from "@opengeni/db";
import {
  createGitHubSkillSourceClient,
  createPublicSkillSearchClient,
  portableSkillCapabilityId,
  portableSkillPluginKey,
  readSkill,
  resolveSkillImport,
  saveSkill,
} from "@opengeni/core";
import {
  buildPortableSkillArtifact,
  loadSkillLibrarySkill,
  skillLibraryRepositoryUrl,
  type SkillTextFile,
} from "@opengeni/runtime/skill-library";
import type { RuntimeSkillArtifact } from "@opengeni/runtime";
import type { SandboxChannelAService } from "@opengeni/runtime/sandbox";
import { createSkillReadAttemptToolDefinition, type SkillReadContent } from "./skill-read";
import { createSkillSearchAttemptToolDefinition } from "./skill-search";
import { createSkillSaveAttemptToolDefinition, type SkillSaveRequest } from "./skill-save";
import { createSkillInstallAttemptToolDefinition } from "./skill-install";
import {
  createSkillCheckoutAttemptToolDefinition,
  createSkillPublishAttemptToolDefinition,
} from "./skill-checkout";

export function createWorkspaceSkillTools(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  subjectId?: string;
  actor: Extract<SkillActor, { kind: "agent" }>;
  selected: readonly { id: string; artifact: RuntimeSkillArtifact }[];
  filesystem: () => Promise<
    Pick<SandboxChannelAService, "fsList" | "fsRead" | "fsWrite" | "fsMkdir">
  >;
}) {
  const context = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
  };
  const authorize = () => assertSkillReadAttempt(input.db, { ...context, actor: input.actor });
  const selected = new Map(input.selected.map((entry) => [entry.id, entry.artifact]));
  const list = async () =>
    (await listSkillDescriptors(input.db, context)).filter(
      (entry) => entry.activationMode === "workspace_managed",
    );
  // Both text reads and inventory resolve through this same authorized source.
  // Selected artifacts have no ledger revision identity; never synthesize one.
  const load = async (identifier: string): Promise<readonly SkillTextFile[] | SkillReadContent> => {
    const exact = selected.get(identifier);
    if (exact) return exact.files;
    const descriptors = await list();
    const exactWorkspace = descriptors.find((entry) => entry.id === identifier);
    const matches = exactWorkspace
      ? [exactWorkspace]
      : descriptors.filter((entry) => entry.title === identifier || entry.stableKey === identifier);
    const selectedMatches = [...selected.entries()].filter(
      ([, artifact]) => artifact.name === identifier,
    );
    if (!exactWorkspace && matches.length + selectedMatches.length > 1)
      throw new Error(
        "Multiple Skills match that name. Use the Skill id from the index or search.",
      );
    if (!matches.length && selectedMatches.length === 1) return selectedMatches[0]![1].files;
    const match = matches[0];
    if (!match) throw new Error("Skill is not available in this session.");
    const record = await readSkill(input.db, context, match.id);
    if (
      !record ||
      record.status !== "active" ||
      !record.activeRevisionId ||
      record.revisionId !== record.activeRevisionId
    )
      throw new Error("Skill is no longer active. Search again for current Skills.");
    return {
      skillId: record.id,
      revisionId: record.activeRevisionId,
      scopeVersion: record.scopeVersion,
      ...(match.installationVersion !== null
        ? { installationVersion: match.installationVersion }
        : {}),
      files: record.files,
    };
  };
  const withConfirmation = async (receipt: SkillWriteReceipt) => {
    const reviewResolution = receipt.skillReview
      ? await skillReviewResolution(input.db, context, receipt.skillReview)
      : undefined;
    return {
      ...receipt,
      ...(reviewResolution ? { reviewResolution } : {}),
      ...(receipt.skillReview && reviewResolution === "pending"
        ? { humanInput: skillReviewHumanInput(receipt.skillReview) }
        : {}),
    };
  };
  const save = async (request: SkillSaveRequest) => {
    const artifact = buildPortableSkillArtifact(request.files);
    const base = request.expectedRevisionId
      ? await readSkill(input.db, context, request.skillId, request.expectedRevisionId)
      : null;
    return withConfirmation(
      await saveSkill(input.db, {
        ...context,
        ...request,
        actor: input.actor,
        files: [...artifact.files],
        stableKey: base?.stableKey ?? `authored-${request.skillId.replaceAll("-", "")}`,
      }),
    );
  };
  return [
    createSkillReadAttemptToolDefinition({ authorize, load }),
    createSkillSearchAttemptToolDefinition({
      authorize,
      listWorkspace: async () => [
        ...(await list()).map((entry) => ({
          id: entry.id,
          name: entry.title,
          description: entry.description,
          revisionId: entry.revisionId,
          scopeVersion: entry.scopeVersion,
          ...(entry.installationVersion !== null
            ? { installationVersion: entry.installationVersion }
            : {}),
        })),
        ...input.selected.map((entry) => ({
          id: entry.id,
          name: entry.artifact.name,
          description: entry.artifact.description || entry.artifact.name,
          source: entry.id.startsWith("builtin:")
            ? ("builtin" as const)
            : entry.id.startsWith("session:")
              ? ("session" as const)
              : ("pack" as const),
        })),
      ],
      publicSearch: createPublicSkillSearchClient(input.settings),
    }),
    createSkillSaveAttemptToolDefinition({
      authorize,
      save,
      load: async (skillId, revisionId) => {
        const record = await readSkill(input.db, context, skillId, revisionId);
        if (!record?.revisionId) throw new Error("Skill edit base is unavailable.");
        return { revisionId: record.revisionId, files: record.files };
      },
    }),
    createSkillInstallAttemptToolDefinition({
      authorize,
      install: async (request) => {
        const requestIdentity = {
          operation: "skill_install",
          source: request.source,
          expectedInstallationVersion: request.expectedInstallationVersion ?? null,
          reason: request.reason,
          owner: "direct",
        };
        const replay = await replayPortableSkillInstall(input.db, {
          ...context,
          actor: input.actor,
          operationId: request.operationId,
          requestIdentity,
        });
        if (replay) return withConfirmation(replay.skillReceipt);
        let source: Omit<InstallPortableSkillInput, "accountId" | "workspaceId" | "subjectId">;
        if (request.source.startsWith("library:")) {
          const loaded = loadSkillLibrarySkill(request.source.slice("library:".length));
          source = {
            capabilityId: `skill:${loaded.entry.id}`,
            pluginKey: `skill/library/${loaded.entry.id}`,
            source: "library",
            sourceUrl: loaded.entry.sourceUrl,
            repositoryUrl: skillLibraryRepositoryUrl(loaded.entry.sourceUrl),
            version: loaded.entry.version,
            sourceCommit: loaded.entry.sourceCommit,
            sourcePath: loaded.entry.relativePath,
            name: loaded.entry.name,
            description: loaded.entry.description,
            contentSha256: loaded.entry.contentSha256,
            totalBytes: loaded.skill.files.reduce(
              (total, file) => total + Buffer.byteLength(file.content),
              0,
            ),
            files: fileMetadata(loaded.skill.files),
            provenance: "platform",
            sourceProvenance: loaded.entry.provenance,
            category: loaded.entry.category,
            tags: [...loaded.entry.tags],
            license: loaded.entry.license,
          };
        } else {
          const resolved = await resolveSkillImport(
            request.source,
            createGitHubSkillSourceClient(input.settings),
          );
          source = {
            capabilityId: portableSkillCapabilityId(resolved.preview),
            pluginKey: portableSkillPluginKey(resolved.preview),
            source: resolved.preview.source,
            sourceUrl: resolved.preview.sourceUrl,
            repositoryUrl: resolved.preview.repositoryUrl,
            version: resolved.preview.sourceCommit,
            sourceCommit: resolved.preview.sourceCommit,
            sourcePath: resolved.preview.sourcePath,
            name: resolved.preview.name,
            description: resolved.preview.description,
            contentSha256: resolved.preview.contentSha256,
            totalBytes: resolved.preview.totalBytes,
            files: fileMetadata(resolved.files),
          };
        }
        const installed = await installPortableSkill(input.db, {
          ...context,
          ...source,
          subjectId: `service:skill-attempt:${input.actor.attemptId}`,
          skillActor: input.actor,
          skillOperationId: request.operationId,
          skillRequestIdentity: requestIdentity,
          ...(request.expectedInstallationVersion !== undefined
            ? {
                expectedInstallationVersion: request.expectedInstallationVersion,
              }
            : {}),
        });
        return withConfirmation(installed.skillReceipt);
      },
    }),
    createSkillCheckoutAttemptToolDefinition({
      authorize,
      filesystem: input.filesystem,
      load: async (skill) => {
        const content = await load(skill);
        if (!("files" in content))
          return { skillId: skill, revisionId: null, scopeVersion: null, files: content };
        return content;
      },
    }),
    createSkillPublishAttemptToolDefinition({ authorize, filesystem: input.filesystem, save }),
  ];
}

function fileMetadata(files: readonly SkillTextFile[]) {
  return files.map((file) => ({
    ...file,
    byteSize: Buffer.byteLength(file.content),
    contentSha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
  }));
}
