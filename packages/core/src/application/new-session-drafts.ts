import {
  NewSessionDraft,
  SaveNewSessionDraftRequest,
  type AccessGrant,
  type NewSessionDraft as NewSessionDraftValue,
} from "@opengeni/contracts";
import {
  getNewSessionDraftInTransaction,
  getEnrollment,
  getRig,
  getSandbox,
  getVariableSet,
  NewSessionDraftAccessError,
  newSessionDraftToolsProvided,
  publicNewSessionDraftOptions,
  requireFile,
  saveNewSessionDraftInTransaction,
  withWorkspaceSubjectRls,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import type { AppDependencies } from "../dependencies";
import { settingsWithEnabledCapabilityMcpServers } from "../domain/capabilities";
import {
  isAuthoritativeGitHubRepositorySelectionError,
  normalizeResources,
  validateFileResources,
  validateGitHubRepositorySelection,
  validateToolRefs,
} from "../domain/resources";
import { hasPermission } from "../access";
import { assertConfiguredModel, assertWorkspaceModelPolicyAllows } from "../domain/sessions";

type NewSessionDraftDependencies = Pick<AppDependencies, "settings" | "db" | "objectStorage">;

function hasOwn(value: unknown, key: string): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key);
}

function mapNewSessionDraft(
  row: Awaited<ReturnType<typeof getNewSessionDraftInTransaction>>,
): NewSessionDraftValue | null {
  if (!row) return null;
  return NewSessionDraft.parse({
    revision: row.revision,
    text: row.text,
    resources: row.resources,
    tools: newSessionDraftToolsProvided(row) ? row.tools : [],
    toolsProvided: newSessionDraftToolsProvided(row),
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    latencyMode: row.latencyMode,
    options: publicNewSessionDraftOptions(row),
    updatedAt: row.updatedAt.toISOString(),
  });
}

async function hydrateNewSessionDraft(
  deps: Pick<NewSessionDraftDependencies, "db" | "settings">,
  grant: AccessGrant,
  workspaceId: string,
  row: Awaited<ReturnType<typeof getNewSessionDraftInTransaction>>,
): Promise<NewSessionDraftValue | null> {
  if (!row) return null;
  const mapped = mapNewSessionDraft(row);
  if (!mapped) return null;
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(
    deps.db,
    workspaceId,
    deps.settings,
  );
  const resources = [] as NewSessionDraftValue["resources"];
  for (const resource of mapped.resources) {
    if (resource.kind === "repository") {
      try {
        await validateGitHubRepositorySelection(deps.db, workspaceId, [resource]);
        resources.push(resource);
      } catch (error) {
        if (isAuthoritativeGitHubRepositorySelectionError(error)) {
          // Repository authorization can be revoked after the draft was saved.
          // The next form must not present the stale identity as selectable.
          continue;
        }
        // A catalog/database outage is not proof that a repository was revoked.
        // Preserve the resource so a later retry cannot autosave its deletion.
        resources.push(resource);
      }
      continue;
    }
    try {
      const file = await requireFile(deps.db, workspaceId, resource.fileId);
      if (file.status === "ready") resources.push(resource);
    } catch {
      // Missing, foreign, failed, and pending files are stale draft state.
    }
  }

  const options = { ...mapped.options };
  if (options.variableSetId) {
    if (
      !hasPermission(grant.permissions, "variable-sets:use") ||
      !(await getVariableSet(deps.db, workspaceId, options.variableSetId))
    ) {
      delete options.variableSetId;
    }
  }
  if (options.rigId) {
    const rig = await getRig(deps.db, workspaceId, options.rigId);
    if (!rig?.activeVersion) delete options.rigId;
  }
  if (options.targetSandboxId) {
    const sandbox = await getSandbox(deps.db, workspaceId, options.targetSandboxId);
    const enrollment = sandbox?.enrollmentId
      ? await getEnrollment(deps.db, workspaceId, sandbox.enrollmentId)
      : null;
    if (
      !sandbox ||
      sandbox.kind !== "selfhosted" ||
      !enrollment ||
      enrollment.status !== "active"
    ) {
      delete options.targetSandboxId;
      delete options.workingDir;
      delete options.sandboxBackend;
    }
  }

  let tools: NewSessionDraftValue["tools"] = [];
  if (mapped.toolsProvided) {
    try {
      tools = validateToolRefs(mapped.tools, runtimeSettings);
    } catch {
      // A revoked/disabled MCP selection is removed while explicitness remains
      // true, so an explicit empty policy cannot silently widen to defaults.
      tools = mapped.tools.filter((tool) => {
        try {
          validateToolRefs([tool], runtimeSettings);
          return true;
        } catch {
          return false;
        }
      });
    }
  }
  return {
    ...mapped,
    resources,
    tools,
    options,
  };
}

/** Read the authenticated actor's server-authoritative pre-session composer state. */
export async function getActorNewSessionDraft(
  deps: Pick<NewSessionDraftDependencies, "settings" | "db">,
  grant: AccessGrant,
  workspaceId: string,
): Promise<NewSessionDraftValue> {
  const row = await withWorkspaceSubjectRls(deps.db, workspaceId, grant.subjectId, (scoped) =>
    getNewSessionDraftInTransaction(scoped, {
      workspaceId,
      subjectId: grant.subjectId,
    }),
  );
  return (
    (await hydrateNewSessionDraft(deps, grant, workspaceId, row)) ?? {
      revision: 0,
      text: "",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: deps.settings.openaiModel,
      reasoningEffort: deps.settings.openaiReasoningEffort,
      latencyMode: "standard",
      options: {},
      updatedAt: null,
    }
  );
}

/**
 * Validate and save one exact actor-private draft revision. Create-time-only
 * checks (live machine target, rig/variable-set state, and permission
 * delegation) intentionally remain in createSessionForRequest: a recoverable
 * draft may represent incomplete options, while no invalid option can become a
 * session without passing that single canonical create boundary.
 */
export async function saveActorNewSessionDraft(
  deps: NewSessionDraftDependencies,
  grant: AccessGrant,
  workspaceId: string,
  rawInput: unknown,
): Promise<NewSessionDraftValue> {
  const input = SaveNewSessionDraftRequest.parse(rawInput);
  // The pre-marker client contract required `tools` and had no
  // `toolsProvided`. Its array—including []—was the user's complete selection.
  // Do this presence check before Zod's default turns the missing marker into
  // false, preserving old-client → new-server intent safely.
  const toolsProvided = hasOwn(rawInput, "toolsProvided") ? input.toolsProvided : true;
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(
    deps.db,
    workspaceId,
    deps.settings,
  );
  const resources = normalizeResources(input.resources);
  const tools = toolsProvided ? validateToolRefs(input.tools, runtimeSettings) : [];
  await validateGitHubRepositorySelection(deps.db, workspaceId, resources);
  if (resources.some((resource) => resource.kind === "file") && !deps.objectStorage) {
    throw new HTTPException(503, { message: "object storage is not configured" });
  }
  await validateFileResources(deps.db, workspaceId, resources);
  assertConfiguredModel(deps.settings, input.model);
  await assertWorkspaceModelPolicyAllows(deps.db, deps.settings, workspaceId, input.model);

  try {
    const saved = await withWorkspaceSubjectRls(deps.db, workspaceId, grant.subjectId, (scoped) =>
      scoped.transaction((tx) =>
        saveNewSessionDraftInTransaction(tx as unknown as typeof scoped, {
          accountId: grant.accountId,
          workspaceId,
          subjectId: grant.subjectId,
          expectedRevision: input.expectedRevision,
          text: input.text,
          resources,
          tools,
          toolsProvided,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          latencyMode: input.latencyMode,
          options: input.options,
          // Only managed people are removed through removeWorkspaceMember().
          // API keys and delegated service actors (for example the first-party
          // worker MCP principal) legitimately have no workspace_memberships
          // row, so they must not be rejected by the human-removal fence.
          requireWorkspaceMembership: grant.subjectId.startsWith("user:"),
        }),
      ),
    );
    return mapNewSessionDraft(saved)!;
  } catch (error) {
    if (error instanceof NewSessionDraftAccessError) {
      throw new HTTPException(403, { message: error.message });
    }
    throw error;
  }
}
