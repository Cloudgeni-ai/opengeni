import { createHash } from "node:crypto";
import type { Settings } from "@opengeni/config";
import { type SkillActor, type SkillScope, type SkillWriteReceipt } from "@opengeni/contracts";
import {
  assertSkillReadAttempt,
  getActiveSessionFunctionToolResults,
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
  removeSkill,
} from "@opengeni/core";
import {
  buildPortableSkillArtifact,
  loadSkillLibrarySkill,
  skillArtifactContentSha256,
  skillLibraryRepositoryUrl,
  type SkillTextFile,
} from "@opengeni/runtime/skill-library";
import type { RuntimeSkillArtifact } from "@opengeni/runtime";
import type { SandboxChannelAService } from "@opengeni/runtime/sandbox";
import {
  createSkillReadAttemptToolDefinition,
  SKILL_READ_TOOL_NAME,
  type SelectedSkillReadContent,
  type SkillReadContent,
  type SkillReadObservation,
  type SkillReadOrigin,
  unavailableSkillError,
} from "./skill-read";
import { createSkillSearchAttemptToolDefinition } from "./skill-search";
import { createSkillSaveAttemptToolDefinition, type SkillSaveRequest } from "./skill-save";
import { createSkillInstallAttemptToolDefinition } from "./skill-install";
import { createSkillRemoveAttemptToolDefinition } from "./skill-remove";
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
  /** The resolved model's bound, which `settings` does not carry. */
  modelToolOutputTruncationTokens: () => number;
  onSkillReadHistoryLookupFailed?: (error: unknown) => void;
  /** Content-free skill_read telemetry; it never changes a result. */
  skillReadTelemetry?: {
    /** Ids in the Skill index the model sees this turn; null until known. */
    indexedSkillIds: () => ReadonlySet<string> | null;
    observe: (observation: SkillReadObservation) => void;
  };
}) {
  const context = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
  };
  const authorize = () => assertSkillReadAttempt(input.db, { ...context, actor: input.actor });
  const selected = new Map(input.selected.map((entry) => [entry.id, entry.artifact]));
  // Readable Skills that skill_search returned in this attempt.
  const searchedSkillIds = new Set<string>();
  const list = async () =>
    (await listSkillDescriptors(input.db, context)).filter(
      (entry) => entry.activationMode === "workspace_managed",
    );
  // Both text reads and inventory resolve through this same authorized source.
  // Selected artifacts have no ledger revision identity; never synthesize one.
  const load = async (identifier: string): Promise<SkillReadContent | SelectedSkillReadContent> => {
    const exact = selected.get(identifier);
    if (exact) return selectedSkillContent(identifier, exact);
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
    if (!matches.length && selectedMatches.length === 1)
      return selectedSkillContent(selectedMatches[0]![0], selectedMatches[0]![1]);
    const match = matches[0];
    // skill_checkout resolves through this reader too, so both return the list.
    if (!match)
      throw unavailableSkillError(identifier, [
        ...descriptors.map((entry) => ({ id: entry.id, name: entry.title })),
        ...[...selected].map(([id, artifact]) => ({ id, name: artifact.name })),
      ]);
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
      origin: { id: record.id, source: registrySkillSource(record.scope) },
    };
  };
  const withReviewState = async (receipt: SkillWriteReceipt) => {
    const reviewResolution = receipt.skillReview
      ? await skillReviewResolution(input.db, context, receipt.skillReview)
      : undefined;
    return {
      ...receipt,
      ...(reviewResolution ? { reviewResolution } : {}),
    };
  };
  const save = async (request: SkillSaveRequest) => {
    const artifact = buildPortableSkillArtifact(request.files);
    const base = request.expectedRevisionId
      ? await readSkill(input.db, context, request.skillId, request.expectedRevisionId)
      : null;
    return withReviewState(
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
    createSkillRemoveAttemptToolDefinition({
      authorize,
      remove: async (request) =>
        withReviewState(
          await removeSkill(input.db, { ...context, ...request, actor: input.actor }),
        ),
    }),
    createSkillReadAttemptToolDefinition({
      authorize,
      load,
      activeHistory: {
        readResults: async () =>
          (
            await getActiveSessionFunctionToolResults(input.db, {
              workspaceId: input.workspaceId,
              sessionId: input.actor.sessionId,
              toolName: SKILL_READ_TOOL_NAME,
            })
          ).map((row) => row.item),
        toolOutputTruncationTokens: input.modelToolOutputTruncationTokens,
        ...(input.onSkillReadHistoryLookupFailed
          ? { onLookupFailed: input.onSkillReadHistoryLookupFailed }
          : {}),
      },
      ...(input.skillReadTelemetry
        ? {
            telemetry: {
              ...input.skillReadTelemetry,
              searched: (id: string) => searchedSkillIds.has(id),
            },
          }
        : {}),
    }),
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
          source: entry.id.startsWith("builtin:") ? ("builtin" as const) : ("session" as const),
        })),
      ],
      publicSearch: createPublicSkillSearchClient(input.settings),
      onWorkspaceHits: (ids) => {
        for (const id of ids) searchedSkillIds.add(id);
      },
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
        if (replay) return withReviewState(replay.skillReceipt);
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
        return withReviewState(installed.skillReceipt);
      },
    }),
    createSkillCheckoutAttemptToolDefinition({
      authorize,
      filesystem: input.filesystem,
      load: async (skill) => {
        const content = await load(skill);
        if (!("skillId" in content))
          return { skillId: skill, revisionId: null, scopeVersion: null, files: content.files };
        return content;
      },
    }),
    createSkillPublishAttemptToolDefinition({ authorize, filesystem: input.filesystem, save }),
  ];
}

function registrySkillSource(scope: SkillScope): SkillReadOrigin["source"] {
  return scope === "user" ? "personal" : scope;
}

// Artifacts are immutable, so each digest is computed once per loaded artifact.
const selectedArtifactDigests = new WeakMap<RuntimeSkillArtifact, string | null>();

function selectedSkillContent(
  id: string,
  artifact: RuntimeSkillArtifact,
): SelectedSkillReadContent {
  let digest = selectedArtifactDigests.get(artifact);
  if (digest === undefined) {
    try {
      digest = skillArtifactContentSha256(artifact.files);
    } catch {
      // Telemetry identity only; an unhashable artifact still reads.
      digest = null;
    }
    selectedArtifactDigests.set(artifact, digest);
  }
  return {
    files: artifact.files,
    origin: {
      id,
      source: id.startsWith("builtin:") ? "builtin" : "session",
      ...(digest ? { contentSha256: digest } : {}),
    },
  };
}

function fileMetadata(files: readonly SkillTextFile[]) {
  return files.map((file) => ({
    ...file,
    byteSize: Buffer.byteLength(file.content),
    contentSha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
  }));
}
