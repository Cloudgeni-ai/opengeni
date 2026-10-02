/**
 * Settings > General > New session defaults > Agent: what agents can do and
 * who they are when someone starts a new chat or schedule in this workspace.
 * A flush form page (DESIGN.md section 8): starting point, capabilities in
 * three groups, identity, Save. Running chats keep what they started with.
 *
 * Saved as `settings.sessionAgentDefaults`; OpenGeni's own defaults (every
 * capability, the default identity) are stored as no value at all.
 */
import {
  AGENT_IDENTITY_MAX_CHARACTERS,
  resolveWorkspaceAgentDefaults,
  resolveWorkspaceDefaultAgentIdentity,
  type AgentCapabilities,
  type WorkspaceAgentDefaults,
} from "@opengeni/contracts";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AgentCapabilityPicker } from "@/components/agent/agent-capability-picker";
import { Button } from "@/components/ui/button";
import { Field, FieldStack, TextArea } from "@/components/ui/field";
import { FlushFormPage } from "@/components/ui/flush-form-page";
import { Notice } from "@/components/ui/notice";
import { useAppContext } from "@/context";
import {
  agentConfigErrorText,
  capabilityAvailability,
  capabilitySummary,
  draftsEqual,
  requestFromDraft,
  workspaceAgentDefaultsDraft,
  type AgentCapabilityDraft,
} from "@/lib/agent-capabilities";

export const IDENTITY_PLACEHOLDER =
  "You are Acme's operations assistant. You help the team triage support tickets and keep answers short and friendly.";

export function SessionDefaultsPage({
  workspaceId,
  canManage,
  onClose,
}: {
  workspaceId: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const availability = useMemo(
    () => capabilityAvailability(context.clientConfig.agentConfig),
    [context.clientConfig.agentConfig],
  );
  const saved = useMemo(() => {
    if (!workspace) return null;
    const defaults = resolveWorkspaceAgentDefaults(workspace.settings);
    const identity = resolveWorkspaceDefaultAgentIdentity(
      workspace.settings,
      workspace.agentInstructions,
    );
    return {
      defaults,
      draft: workspaceAgentDefaultsDraft({
        capabilities: defaults?.capabilities,
        legacyHumanInputOff: workspace.settings.agentHumanInputEnabled === false,
      }),
      identity: identity.identity ?? "",
      identitySource: identity.source,
    };
  }, [workspace]);
  const [draft, setDraft] = useState<AgentCapabilityDraft | null>(saved?.draft ?? null);
  const [identity, setIdentity] = useState(saved?.identity ?? "");
  // A fresh read (first load, or someone else saved) resets the form.
  const savedKey = saved ? JSON.stringify([saved.defaults, saved.identity]) : null;
  useEffect(() => {
    if (!saved) return;
    setDraft(saved.draft);
    setIdentity(saved.identity);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reset only when the saved value changes
  }, [savedKey]);

  const identityChanged = saved !== null && identity.trim() !== saved.identity.trim();
  const dirty =
    saved !== null && draft !== null && (!draftsEqual(draft, saved.draft) || identityChanged);
  const identityTooLong = identity.trim().length > AGENT_IDENTITY_MAX_CHARACTERS;
  const legacyHumanInputOff = workspace?.settings.agentHumanInputEnabled === false;
  const capabilitiesRequest = (current: AgentCapabilityDraft): AgentCapabilities => {
    const request = requestFromDraft(current, availability);
    // The workspace's older "Ask questions" switch is off: say "on" out loud.
    if (!legacyHumanInputOff || current.values.humanInput !== true) return request;
    return typeof request === "string"
      ? { from: request, humanInput: true }
      : { ...request, humanInput: true };
  };
  const openGeniDefaults =
    draft !== null &&
    capabilitiesRequest(draft) === "all" &&
    !identity.trim() &&
    saved?.identitySource !== "legacy_agent_instructions";
  const readOnlyReason = canManage ? undefined : "Only workspace admins can change these.";

  async function save(): Promise<boolean> {
    if (!workspace || !draft || !saved || !canManage) return false;
    const invocation = context.captureWorkspaceInvocation(workspaceId);
    if (!invocation) return false;
    const trimmed = identity.trim();
    // Keep an identity nobody touched exactly as it is: an older custom
    // persona stays where it lives instead of being copied here.
    const nextIdentity = identityChanged
      ? trimmed || null
      : (saved.defaults?.identity ?? undefined);
    const next: WorkspaceAgentDefaults | null = openGeniDefaults
      ? null
      : {
          capabilities: capabilitiesRequest(draft),
          ...(nextIdentity !== undefined ? { identity: nextIdentity } : {}),
          ...(saved.defaults?.renderer ? { renderer: saved.defaults.renderer } : {}),
        };
    try {
      await context.client.updateWorkspaceSettings(workspaceId, { sessionAgentDefaults: next });
    } catch (error) {
      throw new Error(
        agentConfigErrorText(error, "Couldn't save the defaults. Nothing was changed. Try again."),
        { cause: error },
      );
    }
    if (context.ownsWorkspaceInvocation(workspaceId, invocation)) {
      await context.refreshWorkspace(workspaceId);
      toast.success("Agent defaults saved", {
        description: "New chats and schedules start with them.",
      });
    }
    return true;
  }

  return (
    <FlushFormPage
      backLabel="General"
      onClose={onClose}
      title="Agent defaults"
      description="New chats and schedules in this workspace start with these. Running chats keep what they started with."
      loading={!draft}
      loadingFields={4}
      submitLabel="Save"
      pendingLabel="Saving…"
      submitDisabled={!canManage || !dirty || identityTooLong}
      // The footer shows only while there is something to save.
      className={canManage && dirty ? undefined : "[&>form>footer]:hidden"}
      footerStart={draft ? capabilitySummary(draft.values, availability) : null}
      onSubmit={save}
      onSubmitted={onClose}
    >
      {draft ? (
        <FieldStack>
          {readOnlyReason ? <Notice>{readOnlyReason}</Notice> : null}
          <AgentCapabilityPicker
            draft={draft}
            onChange={setDraft}
            availability={availability}
            disabled={!canManage}
            startingPointLabel="What agents can do"
            startingPointDescription="People can still change this for one chat from the composer."
          />
          <Field
            label="Who the agent is"
            optional
            aside={
              <span className={identityTooLong ? "text-danger" : undefined}>
                {identity.trim().length.toLocaleString()} /{" "}
                {AGENT_IDENTITY_MAX_CHARACTERS.toLocaleString()}
              </span>
            }
            error={
              identityTooLong
                ? `Use ${AGENT_IDENTITY_MAX_CHARACTERS.toLocaleString()} characters or fewer.`
                : undefined
            }
            hint={
              saved?.identitySource === "legacy_agent_instructions" && !identityChanged
                ? "From this workspace's earlier custom persona. Saving new text replaces it for new chats."
                : "Replaces how OpenGeni introduces the agent. Workspace instructions still apply on top. Empty uses OpenGeni's default."
            }
          >
            <TextArea
              rows={4}
              value={identity}
              disabled={!canManage}
              placeholder={IDENTITY_PLACEHOLDER}
              onChange={(event) => setIdentity(event.target.value)}
            />
          </Field>
          {canManage && !openGeniDefaults ? (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-3 text-fg-muted pointer-coarse:h-11"
                onClick={() => {
                  setDraft(
                    workspaceAgentDefaultsDraft({
                      capabilities: undefined,
                      legacyHumanInputOff: false,
                    }),
                  );
                  setIdentity(
                    saved?.identitySource === "legacy_agent_instructions" ? saved.identity : "",
                  );
                }}
              >
                Use OpenGeni's defaults
              </Button>
            </div>
          ) : null}
        </FieldStack>
      ) : null}
    </FlushFormPage>
  );
}
