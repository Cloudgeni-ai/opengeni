import { resolveWorkspaceAgentDefaults, type AgentCapabilities } from "@opengeni/contracts";
import type {
  AgentAvatar,
  AgentProfile,
  AgentProfileConfig,
  ReasoningEffort,
  Session,
  ToolRef,
} from "@opengeni/sdk";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveIcon, MessageSquareIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AgentCapabilityPicker } from "@opengeni/react/app/components/agent/agent-capability-picker";
import { ModelPicker } from "@opengeni/react/app/components/pickers";
import { suggestedAgentAvatar } from "@opengeni/react/app/components/session/agent-identity-control";
import { useAppContext } from "@opengeni/react/app/app-context";
import {
  capabilityAvailability,
  capabilitySummary,
  draftFromRequest,
  draftFromResolved,
  requestFromDraft,
  workspaceAgentDefaultsDraft,
} from "@opengeni/react/app/lib/agent-capabilities";
import { useAppAgentProfiles } from "@opengeni/react/app/lib/agent-profiles";
import { useWorkspaceModelCatalog } from "@opengeni/react/app/lib/use-workspace-model-catalog";
import { AgentAvatarPicker } from "@opengeni/react/ui/agent-avatar-picker";
import { AgentMark, agentAvatarHueForName } from "@opengeni/react/ui/agent-mark";
import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button, buttonVariants } from "@opengeni/react/ui/button";
import { CheckboxField, Field, FieldStack, TextArea, TextInput } from "@opengeni/react/ui/field";
import { FormPage } from "@opengeni/react/ui/form-dialog";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { cn } from "@opengeni/react/app/lib/utils";

import {
  readAgentProfileDraftHandoff,
  type AgentProfileDraftHandoff,
} from "@opengeni/react/app/lib/agent-profile-draft";

export type AgentFormMode =
  | {
      kind: "create";
      /** "Save as agent": prefill from this chat and make it the agent's first chat. */
      fromSession?: string | undefined;
      /** A suggestion's draft (name, avatar, role, instructions) handed over in session storage. */
      draftKey?: string | undefined;
    }
  | { kind: "edit"; profileId: string };

type Draft = {
  name: string;
  role: string;
  avatar: AgentAvatar;
  instructions: string;
  /** Null follows the workspace default model. */
  model: string | null;
  reasoningEffort: ReasoningEffort;
  /** Undefined follows the workspace's agent defaults. */
  capabilities: AgentCapabilities | undefined;
  tools: ToolRef[] | undefined;
  installedSkillIds: string[] | undefined;
};

const DEFAULT_AVATAR: AgentAvatar = { kind: "emoji", emoji: "🤖", hue: 235 };

function draftFromProfile(profile: AgentProfile): Draft {
  const { config } = profile;
  return {
    name: profile.name,
    role: profile.role ?? "",
    avatar: profile.avatar,
    instructions: config.agent?.instructions ?? "",
    model: config.model ?? null,
    reasoningEffort: config.reasoningEffort ?? "medium",
    capabilities: config.agent?.capabilities,
    tools: config.tools,
    installedSkillIds: config.installedSkillIds,
  };
}

function draftFromSession(session: Session, handoff: AgentProfileDraftHandoff | null): Draft {
  const title = session.title ?? "";
  const name = handoff?.name ?? session.agentProfile?.name ?? "";
  return {
    name,
    role: handoff?.role ?? session.agentProfile?.role ?? "",
    avatar: handoff?.avatar ?? session.agentProfile?.avatar ?? suggestedAgentAvatar(title, name),
    instructions: handoff?.instructions ?? session.instructions ?? "",
    model: session.model ?? null,
    reasoningEffort: session.reasoningEffort ?? "medium",
    capabilities: session.agent ? requestFromDraft(draftFromResolved(session.agent)) : undefined,
    tools: session.toolPolicy?.mode === "explicit" ? session.tools : undefined,
    installedSkillIds: undefined,
  };
}

function configFromDraft(draft: Draft): AgentProfileConfig {
  const instructions = draft.instructions.trim();
  const agent = {
    ...(draft.capabilities !== undefined ? { capabilities: draft.capabilities } : {}),
    ...(instructions ? { instructions } : {}),
  };
  return {
    ...(Object.keys(agent).length ? { agent } : {}),
    ...(draft.model ? { model: draft.model, reasoningEffort: draft.reasoningEffort } : {}),
    ...(draft.tools !== undefined ? { tools: draft.tools } : {}),
    ...(draft.installedSkillIds !== undefined
      ? { installedSkillIds: draft.installedSkillIds }
      : {}),
  };
}

export function AgentFormPage({ workspaceId, mode }: { workspaceId: string; mode: AgentFormMode }) {
  const navigate = useNavigate();
  const context = useAppContext();
  const profiles = useAppAgentProfiles();
  const modelCatalog = useWorkspaceModelCatalog(workspaceId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [sourceSession, setSourceSession] = useState<Session | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);

  const fromSession = mode.kind === "create" ? mode.fromSession : undefined;
  const draftKey = mode.kind === "create" ? mode.draftKey : undefined;
  const profileId = mode.kind === "edit" ? mode.profileId : undefined;

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        if (profileId) {
          const loaded = await profiles.get(profileId);
          if (!live) return;
          if (!loaded) throw new Error("This agent could not be loaded.");
          setProfile(loaded);
          setDraft(draftFromProfile(loaded));
          return;
        }
        const handoff = draftKey ? readAgentProfileDraftHandoff(draftKey) : null;
        if (fromSession) {
          const session = await context.client.getSession(workspaceId, fromSession);
          if (!live) return;
          setSourceSession(session);
          setDraft(draftFromSession(session, handoff));
          return;
        }
        const name = handoff?.name ?? "";
        setDraft({
          name,
          role: handoff?.role ?? "",
          avatar: handoff?.avatar ?? {
            ...DEFAULT_AVATAR,
            hue: agentAvatarHueForName(name || "agent"),
          },
          instructions: handoff?.instructions ?? "",
          model: null,
          reasoningEffort: "medium",
          capabilities: undefined,
          tools: undefined,
          installedSkillIds: undefined,
        });
      } catch (error) {
        if (live) setLoadError(error);
      }
    })();
    return () => {
      live = false;
    };
    // Load once per page identity; the profiles hook identity is stable per client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.client, draftKey, fromSession, profileId, workspaceId]);

  const update = (patch: Partial<Draft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const backToChat = sourceSession
    ? {
        label: "Back to chat",
        onClick: () =>
          void navigate({
            to: "/workspaces/$workspaceId/sessions/$sessionId",
            params: { workspaceId, sessionId: sourceSession.id },
          }),
      }
    : null;
  const back = backToChat ?? {
    label: "Back to agents",
    onClick: () =>
      void navigate({ to: "/workspaces/$workspaceId/agents", params: { workspaceId } }),
  };

  const title =
    mode.kind === "edit" ? (profile?.name ?? "Agent") : fromSession ? "Save as agent" : "New agent";
  const description =
    mode.kind === "edit"
      ? "Edits apply to new chats. Running chats keep the version they started with."
      : fromSession
        ? `Reuse how this chat works. We filled this in from “${sourceSession?.title ?? "this chat"}”; change anything.`
        : "A reusable agent anyone in this workspace can start a chat with.";

  const submit = async () => {
    if (!draft) return;
    setSubmitError(null);
    const name = draft.name.trim();
    if (!name) {
      setSubmitError(new Error("Give the agent a name."));
      return false;
    }
    const role = draft.role.trim();
    const config = configFromDraft(draft);
    if (mode.kind === "edit" && profile) {
      const saved = await profiles.update(profile.id, {
        expectedVersion: profile.version,
        name,
        role: role || null,
        avatar: draft.avatar,
        config,
      });
      if (!saved) {
        setSubmitError(profiles.mutationError ?? new Error("Couldn't save the agent."));
        return false;
      }
      setProfile(saved);
      toast.success(`Saved ${saved.name}`);
      return true;
    }
    const created = await profiles.create({
      name,
      ...(role ? { role } : {}),
      avatar: draft.avatar,
      config,
    });
    if (!created) {
      setSubmitError(profiles.mutationError ?? new Error("Couldn't save the agent."));
      return false;
    }
    if (sourceSession) {
      // The chat it came from becomes the agent's first chat.
      const worn = await profiles.applyToSession(
        sourceSession.id,
        created.id,
        sourceSession.toolPolicyVersion ?? 1,
      );
      if (worn) context.adoptUpdatedSession?.(worn);
      toast.success(`Saved ${created.name}`);
      void navigate({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId, sessionId: sourceSession.id },
      });
      return true;
    }
    toast.success(`Saved ${created.name}`);
    void navigate({
      to: "/workspaces/$workspaceId/agents/$profileId",
      params: { workspaceId, profileId: created.id },
    });
    return true;
  };

  const archived = profile?.status === "archived";

  return (
    <FormPage
      title={
        mode.kind === "edit" && profile ? (
          <span className="inline-flex items-center gap-3">
            <AgentMark avatar={profile.avatar} size={40} />
            {profile.name}
          </span>
        ) : (
          title
        )
      }
      description={description}
      back={back}
      loading={!draft && !loadError}
      loadingFields={5}
      error={
        loadError ? userErrorText(loadError) : submitError ? userErrorText(submitError) : undefined
      }
      submitLabel={mode.kind === "edit" ? "Save changes" : "Save agent"}
      pendingLabel="Saving…"
      submitDisabled={!draft || archived}
      disabledReason={archived ? "Restore this agent to edit it." : undefined}
      onSubmit={async () => {
        const ok = await submit();
        return ok === false ? false : undefined;
      }}
      onCancel={back.onClick}
      headerAside={
        mode.kind === "edit" && profile ? (
          <div className="flex items-center gap-2">
            {archived ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void profiles.restore(profile.id).then((p) => p && setProfile(p))}
              >
                <RotateCcwIcon aria-hidden="true" />
                Restore
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void profiles.archive(profile.id).then((p) => p && setProfile(p))}
                >
                  <ArchiveIcon aria-hidden="true" />
                  Archive
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void navigate({
                      to: "/workspaces/$workspaceId/sessions",
                      params: { workspaceId },
                      search: { agent: profile.id },
                    })
                  }
                >
                  <MessageSquareIcon aria-hidden="true" />
                  Start chat
                </Button>
              </>
            )}
          </div>
        ) : undefined
      }
      footerStart={
        mode.kind === "edit" && profile ? (
          <span className="text-xs text-fg-subtle">Version {profile.version}</span>
        ) : sourceSession ? (
          <span className="text-xs text-fg-subtle">This chat becomes the agent's first chat.</span>
        ) : null
      }
    >
      {draft ? (
        <AgentFormFields
          workspaceId={workspaceId}
          draft={draft}
          update={update}
          sourceSession={sourceSession}
          instructionsSource={
            draftKey && draft.instructions ? "suggestion" : sourceSession ? "session" : null
          }
          disabled={archived}
          modelCatalog={modelCatalog}
        />
      ) : null}
    </FormPage>
  );
}

function AgentFormFields({
  workspaceId,
  draft,
  update,
  sourceSession,
  instructionsSource,
  disabled,
  modelCatalog,
}: {
  workspaceId: string;
  draft: Draft;
  update: (patch: Partial<Draft>) => void;
  sourceSession: Session | null;
  instructionsSource: "suggestion" | "session" | null;
  disabled: boolean;
  modelCatalog: ReturnType<typeof useWorkspaceModelCatalog>;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId) ?? null;
  const availability = useMemo(
    () => capabilityAvailability(context.clientConfig.agentConfig),
    [context.clientConfig.agentConfig],
  );
  const workspaceCapabilities = useMemo(
    () =>
      workspaceAgentDefaultsDraft({
        capabilities: resolveWorkspaceAgentDefaults(workspace?.settings)?.capabilities,
        legacyHumanInputOff: workspace?.settings.agentHumanInputEnabled === false,
      }),
    [workspace?.settings],
  );
  const capabilitiesDraft =
    draft.capabilities !== undefined ? draftFromRequest(draft.capabilities) : workspaceCapabilities;

  return (
    <FieldStack>
      <div className="flex items-start gap-4">
        <AgentMark avatar={draft.avatar} size={56} className="mt-6" />
        <div className="grid min-w-0 flex-1 gap-4 sm:grid-cols-2">
          <Field label="Name">
            <TextInput
              value={draft.name}
              maxLength={60}
              placeholder="e.g. Annie"
              disabled={disabled}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <Field label="Role" optional hint="One line, shown under the name.">
            <TextInput
              value={draft.role}
              maxLength={160}
              placeholder="e.g. Reviews pull requests"
              disabled={disabled}
              onChange={(event) => update({ role: event.target.value })}
            />
          </Field>
        </div>
      </div>

      <Field label="Avatar" group>
        <AgentAvatarPicker
          value={draft.avatar}
          name={draft.name}
          onChange={(avatar) => update({ avatar })}
          className="max-w-sm"
        />
      </Field>

      <Field
        label="Instructions"
        optional
        hint={
          instructionsSource === "suggestion"
            ? "Drafted by the agent from this chat. Edit anything; it is added to every chat this agent runs."
            : sourceSession
              ? "Taken from this chat's instructions. Describe how the agent should work; it is added to every chat it runs."
              : "How this agent works. Added to every chat it runs."
        }
      >
        <TextArea
          rows={8}
          value={draft.instructions}
          disabled={disabled}
          placeholder="e.g. Review pull requests against our checklist. Lead with blocking issues, each with a file and line. Never approve; leave that to a person."
          onChange={(event) => update({ instructions: event.target.value })}
        />
      </Field>

      <Field label="Model" group hint="Used when a chat with this agent doesn't pick one.">
        <div className="flex flex-col gap-3">
          <SegmentedControl
            size="sm"
            aria-label="Model for this agent"
            className="self-start"
            disabled={disabled}
            value={draft.model ? "custom" : "default"}
            onValueChange={(value) =>
              update(
                value === "default"
                  ? { model: null }
                  : {
                      model: modelCatalog.defaultSelection?.model ?? context.model,
                      reasoningEffort:
                        modelCatalog.defaultSelection?.reasoningEffort ?? draft.reasoningEffort,
                    },
              )
            }
            options={[
              { value: "default", label: "Workspace default" },
              { value: "custom", label: "Choose a model" },
            ]}
          />
          {draft.model ? (
            <ModelPicker
              rows={modelCatalog.rows}
              model={draft.model}
              effort={draft.reasoningEffort}
              latencyMode="standard"
              allowLatencyMode={false}
              disabled={disabled}
              loading={modelCatalog.loading}
              error={modelCatalog.error}
              messages={{ label: "Agent model and reasoning" }}
              triggerStyle="field"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "max-w-full min-w-[220px] justify-start gap-2 self-start rounded-[10px] px-2.5",
              )}
              onModelChange={(model) => update({ model })}
              onEffortChange={(reasoningEffort) => update({ reasoningEffort })}
              onLatencyModeChange={() => {}}
            />
          ) : null}
        </div>
      </Field>

      <Field
        label="Capabilities"
        group
        hint={
          draft.capabilities === undefined
            ? `Workspace defaults · ${capabilitySummary(capabilitiesDraft.values, availability)}`
            : capabilitySummary(capabilitiesDraft.values, availability)
        }
      >
        <div className="flex flex-col gap-4">
          <SegmentedControl
            size="sm"
            aria-label="Capabilities for this agent"
            className="self-start"
            disabled={disabled}
            value={draft.capabilities === undefined ? "default" : "custom"}
            onValueChange={(value) =>
              update({
                capabilities:
                  value === "custom"
                    ? requestFromDraft(workspaceCapabilities, availability)
                    : undefined,
              })
            }
            options={[
              { value: "default", label: "Workspace defaults" },
              { value: "custom", label: "Choose for this agent" },
            ]}
          />
          {draft.capabilities !== undefined ? (
            <AgentCapabilityPicker
              draft={capabilitiesDraft}
              availability={availability}
              disabled={disabled}
              onChange={(next) => update({ capabilities: requestFromDraft(next, availability) })}
            />
          ) : null}
        </div>
      </Field>

      {draft.tools !== undefined ? (
        <Field
          label="Connectors"
          group
          hint="Chats with this agent start with these connectors instead of the workspace's."
        >
          <div className="flex flex-col gap-2">
            {draft.tools.length === 0 ? (
              <p className="text-sm text-fg-muted">None</p>
            ) : (
              draft.tools.map((tool) => (
                <span key={tool.id} className="text-sm text-fg-label">
                  {tool.id}
                </span>
              ))
            )}
            <CheckboxField
              checked
              disabled={disabled}
              onCheckedChange={() => update({ tools: undefined })}
              label="Keep this chat's connectors"
            />
          </div>
        </Field>
      ) : null}
    </FieldStack>
  );
}
