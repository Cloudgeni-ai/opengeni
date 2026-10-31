// The built-in meeting summary (docs/recordings.md, "Built-in summary"): once a meeting's
// shown transcript is ready, Opengeni starts one ordinary chat that writes its
// notes. It is the meeting owner's Only me chat (a workspace chat when the
// meeting is shared), created like any automation's session, on a model the
// workspace's shared Codex or Claude subscription accounts serve. With no such
// model it does not start, so it never spends Opengeni credits or an API key.
import { resolveTurnExecutionPolicyV1, type Settings } from "@opengeni/config";
import {
  isEuResidency,
  type DefaultModelSelection,
  type FirstPartyMcpToolName,
} from "@opengeni/contracts";
import {
  agentRunAdmissionDenial,
  applySessionAgentConfigWriteThrough,
  assertWorkspaceModelPolicyAllows,
  createAndStartSessionWithOutcome,
  loadWorkspaceModelSelectionInput,
  meetingSummaryPrompt,
  recordWorkspaceUsage,
  resolveCatalogSettings,
  resolveDefaultSessionModelForSelections,
  resolveSessionAgentConfigForCreate,
  resolveWorkspaceModelSelection,
  selectDefaultSessionModel,
  settingsWithInferenceResidency,
  type WorkspaceModelSelection,
} from "@opengeni/core";
import {
  MEETING_SUMMARY_POLICY_ROLE,
  MEETING_SUMMARY_RECORDING_METADATA_KEY,
  MEETING_SUMMARY_SUBJECT_ID,
  MEETING_SUMMARY_TOOLS,
  meetingSummaryCandidate,
  requireWorkspace,
} from "@opengeni/db";
import type { ControlActivityServices } from "./types";

export type MeetingSummaryInput = {
  accountId: string;
  workspaceId: string;
  recordingId: string;
  versionId: string;
  ownerSubjectId: string;
};

export type MeetingSummaryOutcome =
  | { started: true; sessionId: string; model: string }
  | { started: false; reason: string };

/**
 * The model a summary runs on: the one a new chat would get, when the
 * workspace's subscription accounts serve it, else the first model they serve.
 * Null when no subscription account can serve one. Under EU-only inference
 * only a model whose route's residency record is EU counts.
 */
export function meetingSummaryModel(input: {
  settings: Settings;
  selections: readonly WorkspaceModelSelection[];
  chatDefault: DefaultModelSelection;
}): DefaultModelSelection | null {
  const selections =
    input.settings.requiredModelGeography === "eu"
      ? input.selections.map((selection) =>
          isEuResidency(selection.model.residency)
            ? selection
            : { ...selection, availability: { ...selection.availability, selectable: false } },
        )
      : input.selections;
  const chat = selections.find((selection) => selection.model.id === input.chatDefault.model);
  if (chat?.availability.selectable && chat.model.cost === "subscription") return input.chatDefault;
  const subscription = selectDefaultSessionModel({
    settings: input.settings,
    selections,
    workspaceDefaults: null,
    organizationDefaults: null,
    creditsAvailable: false,
  });
  return subscription.source === "subscription" ? subscription : null;
}

/**
 * Start the summary for one completed transcript version, at most once: the
 * session is keyed by the version. Re-running a transcript starts another
 * while the meeting has no notes, or to write again the notes an earlier
 * summary wrote that nobody has touched since.
 */
export async function startMeetingSummary(
  service: ControlActivityServices,
  input: MeetingSummaryInput,
): Promise<MeetingSummaryOutcome> {
  const candidate = await meetingSummaryCandidate(service.db, {
    workspaceId: input.workspaceId,
    subjectId: input.ownerSubjectId,
    recordingId: input.recordingId,
    versionId: input.versionId,
  });
  if (!candidate.start) return { started: false, reason: candidate.reason };
  const { recording } = candidate;

  const settings = (
    await resolveCatalogSettings(service.db, service.catalogSourceSettings ?? service.settings)
  ).settings;
  const workspaceSettings = (await requireWorkspace(service.db, input.workspaceId)).settings;
  // The same choice as a new chat, as a service would make it: shared
  // subscription pools only, never a person's own account.
  const selections = resolveWorkspaceModelSelection(
    await loadWorkspaceModelSelectionInput(service.db, settings, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: MEETING_SUMMARY_SUBJECT_ID,
    }),
  );
  const chatDefault = await resolveDefaultSessionModelForSelections(service.db, {
    settings,
    accountId: input.accountId,
    workspaceSettings,
    selections,
  });
  // EU-only inference: choose only a model whose route is EU, before any
  // session exists, so the owner never gets a chat the turn would refuse.
  const regionSettings = await settingsWithInferenceResidency(service.db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    settings,
  });
  const chosen = meetingSummaryModel({ settings: regionSettings, selections, chatDefault });
  if (!chosen) {
    const regionOnly =
      regionSettings.requiredModelGeography === "eu" &&
      meetingSummaryModel({
        settings: { ...settings, requiredModelGeography: undefined },
        selections,
        chatDefault,
      }) !== null;
    return { started: false, reason: regionOnly ? "region_restricted" : "no_subscription" };
  }
  await assertWorkspaceModelPolicyAllows(service.db, settings, input.workspaceId, chosen.model);
  const denial = await agentRunAdmissionDenial(
    { ...service, settings },
    {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      model: chosen.model,
      requestedAgentRuns: 1,
    },
  );
  if (denial) return { started: false, reason: denial };

  const instructions =
    "Write the notes for exactly the meeting in the first message, as it asks, then stop.";
  // Off everything but reading this workspace's meetings.
  const agent = resolveSessionAgentConfigForCreate({
    settings,
    creator: "automation",
    request: {
      capabilities: { from: "none", knowledge: true, humanInput: false, skills: false },
    },
    instructions,
    workspaceSettings,
    parent: null,
    goal: false,
  });
  const toolPolicy = { mode: "explicit" as const, inheritedFromSessionId: null };
  const written = applySessionAgentConfigWriteThrough({
    config: agent.config,
    firstPartyMcpTools: [...MEETING_SUMMARY_TOOLS] as FirstPartyMcpToolName[],
    tools: [{ kind: "mcp", id: "opengeni" }],
    toolPolicy,
    productServerIds: [],
  });
  const turnExecutionPolicy = resolveTurnExecutionPolicyV1(settings, {
    modelId: chosen.model,
    requestedModelId: null,
    modelSource: "deployment",
    reasoningEffort: chosen.reasoningEffort,
    reasoningSource: "deployment",
    latencyMode: "standard",
    latencyModeSource: "deployment",
  });
  const created = await createAndStartSessionWithOutcome({
    db: service.db,
    bus: service.bus,
    workflowClient: {
      wakeSessionWorkflow: async (wake) => {
        await service.wakeSessionWorkflow?.(wake);
      },
    },
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    visibility: recording.visibility === "private" ? "user_private" : "workspace_shared",
    meetingSummary: { recordingId: recording.id, ownerSubjectId: recording.ownerSubjectId },
    initialMessage: meetingSummaryPrompt({
      recordingId: recording.id,
      title: recording.title,
      replacesRevision: candidate.replacesRevision,
    }),
    surface: "system",
    metrics: service.observability,
    resources: [],
    tools: written.tools,
    toolPolicy: written.toolPolicy,
    model: chosen.model,
    reasoningEffort: chosen.reasoningEffort,
    turnExecutionPolicy,
    sandboxBackend: "none",
    metadata: { [MEETING_SUMMARY_RECORDING_METADATA_KEY]: recording.id },
    createdBy: {
      kind: "service",
      subjectId: MEETING_SUMMARY_SUBJECT_ID,
      label: "Opengeni meeting notes",
    },
    createdByContext: { recordingId: recording.id, versionId: input.versionId },
    instructions: agent.instructions ?? instructions,
    policyRole: MEETING_SUMMARY_POLICY_ROLE,
    firstPartyMcpPermissions: ["sessions:read"],
    firstPartyMcpTools: written.firstPartyMcpTools,
    ...(agent.config ? { agentConfig: agent.config } : {}),
    createIdempotencyKey: `${MEETING_SUMMARY_SUBJECT_ID}:${input.versionId}`,
    subjectId: MEETING_SUMMARY_SUBJECT_ID,
  });
  await recordWorkspaceUsage(
    { db: service.db, settings },
    {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: MEETING_SUMMARY_SUBJECT_ID,
      eventType: "agent_run.created",
      quantity: 1,
      unit: "run",
      sourceResourceType: "recording",
      sourceResourceId: recording.id,
      sessionId: created.session.id,
      initiator: created.session.createdBy,
      initiatorContext: created.session.createdByContext,
      origin: "system",
      idempotencyKey: `agent_run.created:meeting-summary:${input.versionId}`,
    },
  ).catch(() => undefined);
  return { started: true, sessionId: created.session.id, model: chosen.model };
}
