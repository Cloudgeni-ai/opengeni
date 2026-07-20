import {
  NewSessionDraft,
  SaveNewSessionDraftRequest,
  type AccessGrant,
  type NewSessionDraft as NewSessionDraftValue,
} from "@opengeni/contracts";
import {
  getNewSessionDraftInTransaction,
  saveNewSessionDraftInTransaction,
  withWorkspaceSubjectRls,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import type { AppDependencies } from "../dependencies";
import { settingsWithEnabledCapabilityMcpServers } from "../domain/capabilities";
import {
  normalizeResources,
  validateFileResources,
  validateGitHubRepositorySelection,
  validateToolRefs,
} from "../domain/resources";
import { assertConfiguredModel, assertWorkspaceModelPolicyAllows } from "../domain/sessions";

type NewSessionDraftDependencies = Pick<AppDependencies, "settings" | "db" | "objectStorage">;

function mapNewSessionDraft(
  row: Awaited<ReturnType<typeof getNewSessionDraftInTransaction>>,
): NewSessionDraftValue | null {
  if (!row) return null;
  return NewSessionDraft.parse({
    revision: row.revision,
    text: row.text,
    resources: row.resources,
    tools: row.tools,
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    options: row.sessionOptions,
    updatedAt: row.updatedAt.toISOString(),
  });
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
    mapNewSessionDraft(row) ?? {
      revision: 0,
      text: "",
      resources: [],
      tools: [],
      model: deps.settings.openaiModel,
      reasoningEffort: deps.settings.openaiReasoningEffort,
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
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(
    deps.db,
    workspaceId,
    deps.settings,
  );
  const resources = normalizeResources(input.resources);
  const tools = validateToolRefs(input.tools, runtimeSettings);
  await validateGitHubRepositorySelection(deps.db, workspaceId, resources);
  if (resources.some((resource) => resource.kind === "file") && !deps.objectStorage) {
    throw new HTTPException(503, { message: "object storage is not configured" });
  }
  await validateFileResources(deps.db, workspaceId, resources);
  assertConfiguredModel(deps.settings, input.model);
  await assertWorkspaceModelPolicyAllows(deps.db, deps.settings, workspaceId, input.model);

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
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        options: input.options,
      }),
    ),
  );
  return mapNewSessionDraft(saved)!;
}
