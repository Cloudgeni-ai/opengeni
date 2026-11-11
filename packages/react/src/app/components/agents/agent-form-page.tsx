/**
 * Make an agent, from scratch or from a chat ("Make this an agent"), or
 * change one. Only the name is required; the server says what else it can't
 * take.
 */
import { useEffect, useState } from "react";
import {
  AGENT_DESCRIPTION_MAX_LENGTH,
  AGENT_INSTRUCTIONS_MAX_LENGTH,
  AGENT_INSTRUCTIONS_SOFT_LIMIT,
  AGENT_NAME_MAX_LENGTH,
  type Agent,
  type AgentVisibility,
  type UpdateAgentRequest,
} from "@opengeni/contracts";
import type { SessionAvatar as SessionAvatarValue } from "@opengeni/sdk";

import { apiErrorDetails, userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import { ErrorMessage } from "../../../ui/error-message";
import { Field, FieldStack, TextArea, TextInput } from "../../../ui/field";
import { FormPage } from "../../../ui/form-dialog";
import { SegmentedControl } from "../../../ui/segmented-control";
import { SettingRow } from "../../../ui/setting-row";
import { Switch } from "../../../ui/switch";
import { useAppContext } from "../../app-context";
import { dismissAgentSuggestion } from "../../lib/agent-suggestion-dismissal";
import { agentErrorCode, useAgent } from "../../lib/agents";
import { useNavigate } from "../../lib/navigation";
import { forgetSessionAgent } from "../../lib/session-agent";
import { toast } from "../../lib/toast";
import { sessionAvatarFallbackHue } from "../session/session-avatar";
import {
  SessionAvatarPickerButton,
  sessionAvatarDraft,
  sessionAvatarDraftErrors,
  sessionAvatarFromDraft,
  sessionAvatarSeedHue,
} from "../session/session-avatar-picker";
import { AGENT_VERSION_CONFLICT, workspacePeopleLabel } from "./agent-page";

export const INSTRUCTIONS_HINT =
  "What it does and how. Applies in every chat. Put long reference material in Memory.";
export const INSTRUCTIONS_LONG_HINT =
  "Long instructions slow every reply. Move reference material to Memory.";
/** An older agent whose First message joined its Instructions can be over the limit. */
export const INSTRUCTIONS_OVER_LIMIT_HINT = `Over ${AGENT_INSTRUCTIONS_MAX_LENGTH.toLocaleString("en-US")} characters, so they stay as they are until you shorten them. Other changes save as usual.`;

export type AgentFormValues = {
  name: string;
  description: string;
  avatar: SessionAvatarValue | null;
  instructions: string;
  memoryEnabled: boolean;
  visibility: AgentVisibility;
};

const EMPTY: AgentFormValues = {
  name: "",
  description: "",
  avatar: null,
  instructions: "",
  // New agents remember by default; an existing agent keeps its own setting.
  memoryEnabled: true,
  visibility: "workspace",
};

export const ONLY_ME_UNAVAILABLE = "Only me chats aren't available here.";

/** The count beside a field once it is near its limit. */
export function lengthCount(value: string, max: number): string | undefined {
  // The same measure as lengthError: what is saved, without outer spaces.
  const length = value.trim().length;
  return length >= max * 0.9
    ? `${length.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`
    : undefined;
}

/** Why a field is too long, in words; undefined when it fits. */
export function lengthError(value: string, max: number): string | undefined {
  const length = value.trim().length;
  return length > max
    ? `Shorten it to ${max.toLocaleString("en-US")} characters. It has ${length.toLocaleString("en-US")}.`
    : undefined;
}

type FormErrors = {
  name?: string;
  description?: string;
  instructions?: string;
  emoji?: string;
  letters?: string;
};

/** What a refusal means here, in words; null for errors the form shows as they come. */
export function agentSaveErrorText(error: unknown): string | null {
  switch (agentErrorCode(error)) {
    case "agent_version_conflict":
      return AGENT_VERSION_CONFLICT;
    case "agent_limit_reached":
      return "This workspace has as many agents as it can keep. Delete one, then try again.";
    default:
      return null;
  }
}

/** Only what changed, at the version the form opened. */
export function agentChanges(agent: Agent, values: AgentFormValues): UpdateAgentRequest {
  const change: UpdateAgentRequest = { expectedVersion: agent.version };
  if (values.name.trim() !== agent.name) change.name = values.name.trim();
  if (values.description.trim() !== agent.description)
    change.description = values.description.trim();
  if (JSON.stringify(values.avatar) !== JSON.stringify(agent.avatar)) change.avatar = values.avatar;
  if (values.instructions.trim() !== agent.instructions)
    change.instructions = values.instructions.trim();
  // Memory on with no collection yet (it couldn't be set up when the agent was
  // made): saving sends it again, so the collection is set up now.
  if (
    values.memoryEnabled !== agent.memory.enabled ||
    (values.memoryEnabled && agent.memory.collectionId === null)
  )
    change.memoryEnabled = values.memoryEnabled;
  if (values.visibility !== agent.visibility) change.visibility = values.visibility;
  return change;
}

function optionalError<K extends keyof FormErrors>(
  key: K,
  error: string | undefined,
): Partial<FormErrors> {
  return error ? { [key]: error } : {};
}

/** Whether this workspace can start Only me chats; undefined until known. */
function usePrivateChatsAvailable(workspaceId: string): boolean | undefined {
  const { client } = useAppContext();
  const [available, setAvailable] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let live = true;
    client.getSessionTenancyCreateCapabilities(workspaceId).then(
      (capabilities) => {
        if (live) setAvailable(capabilities.canCreatePrivate);
      },
      // Unknown: the server says so if it refuses.
      () => {
        if (live) setAvailable(undefined);
      },
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  return available;
}

function AgentForm({
  workspaceId,
  agent,
  initial,
  sourceSessionId,
  sourceTitle,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  /** The agent to change; omitted to make one. */
  agent?: Agent | undefined;
  initial: AgentFormValues;
  sourceSessionId?: string | null | undefined;
  /** The chat it is made from, for the back link. */
  sourceTitle?: string | undefined;
  onClose: () => void;
  onSaved: (agent: Agent) => void;
}) {
  const { client, workspaces } = useAppContext();
  const privateChats = usePrivateChatsAvailable(workspaceId);
  const seedKey = agent?.id ?? sourceSessionId ?? "new-agent";
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [memoryEnabled, setMemoryEnabled] = useState(initial.memoryEnabled);
  const [visibility, setVisibility] = useState<AgentVisibility>(initial.visibility);
  const [draft, setDraft] = useState(() =>
    sessionAvatarDraft(
      // Image avatars are a chat's own files, which an agent doesn't have.
      initial.avatar?.kind === "image" ? null : initial.avatar,
      sessionAvatarSeedHue(sessionAvatarFallbackHue(seedKey)),
    ),
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const workspaceName =
    workspaces.find((row) => row.id === (agent?.workspaceId ?? workspaceId))?.name ?? null;
  const inSlack = (agent?.slack.length ?? 0) > 0;
  const long = instructions.length > AGENT_INSTRUCTIONS_SOFT_LIMIT;
  // Unchanged Instructions are never sent, so only changed ones must fit.
  const instructionsChanged = !agent || instructions.trim() !== agent.instructions;
  const overLimitAsStored =
    !instructionsChanged && lengthError(instructions, AGENT_INSTRUCTIONS_MAX_LENGTH) !== undefined;

  const values = (): AgentFormValues => ({
    name,
    description,
    avatar: sessionAvatarFromDraft(draft, name, null),
    instructions,
    memoryEnabled,
    visibility,
  });

  function validate(): boolean {
    const nameError = name.trim() ? lengthError(name, AGENT_NAME_MAX_LENGTH) : "Give it a name.";
    const next: FormErrors = {
      ...(nameError ? { name: nameError } : {}),
      ...optionalError("description", lengthError(description, AGENT_DESCRIPTION_MAX_LENGTH)),
      ...(instructionsChanged
        ? optionalError("instructions", lengthError(instructions, AGENT_INSTRUCTIONS_MAX_LENGTH))
        : {}),
      ...sessionAvatarDraftErrors(draft, name, null),
    };
    setErrors(next);
    if (!next.name && (next.emoji || next.letters)) setPickerOpen(true);
    return Object.values(next).every((value) => !value);
  }

  async function save(): Promise<boolean> {
    const current = values();
    try {
      if (agent) {
        const change = agentChanges(agent, current);
        if (Object.keys(change).length === 1) {
          onClose();
          return true;
        }
        onSaved(await client.updateAgent(workspaceId, agent.id, change));
        return true;
      }
      onSaved(
        await client.createAgent(workspaceId, {
          name: current.name.trim(),
          description: current.description.trim(),
          avatar: current.avatar,
          visibility: current.visibility,
          instructions: current.instructions.trim(),
          memoryEnabled: current.memoryEnabled,
          sourceSessionId: sourceSessionId ?? null,
        }),
      );
      return true;
    } catch (error) {
      // Its name is how people ask it in Slack: say so at the name.
      const code = agentErrorCode(error);
      if (code === "agent_slack_name_taken" || code === "agent_slack_name_invalid") {
        setErrors((previous) => ({ ...previous, name: userErrorText(error) }));
        return false;
      }
      const text = agentSaveErrorText(error);
      if (text) throw new Error(text, { cause: error });
      throw error;
    }
  }

  return (
    <FormPage
      title={agent ? `Edit ${agent.name}` : sourceSessionId ? "Make this an agent" : "New agent"}
      description={
        agent
          ? undefined
          : sourceSessionId
            ? "Starts from this chat's name, icon, description and instructions. Its history isn't included."
            : undefined
      }
      back={{
        label: agent ? agent.name : sourceSessionId ? sourceTitle || "Chat" : "Agents",
        onClick: onClose,
      }}
      onCancel={onClose}
      submitLabel={agent ? "Save" : "Create agent"}
      pendingLabel={agent ? "Saving…" : "Creating…"}
      onSubmit={async () => {
        if (!validate()) return false;
        return await save();
      }}
    >
      <FieldStack>
        <div className="flex items-start gap-4">
          <SessionAvatarPickerButton
            label="Icon"
            draft={draft}
            onChange={(next) => {
              setDraft(next);
              setErrors(({ emoji: _emoji, letters: _letters, ...rest }) => rest);
            }}
            name={name}
            image={null}
            errors={errors}
            workspaceId={workspaceId}
            seed={seedKey}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
          />
          <div className="min-w-0 flex-1">
            <Field
              label="Name"
              error={errors.name}
              aside={lengthCount(name, AGENT_NAME_MAX_LENGTH)}
            >
              <TextInput
                value={name}
                autoComplete="off"
                placeholder="Release manager"
                onChange={(event) => {
                  setName(event.target.value);
                  setErrors(({ name: _drop, ...rest }) => rest);
                }}
              />
            </Field>
          </div>
        </div>
        <Field
          label="What it helps with"
          optional
          hint="Shown with its name. One sentence."
          error={errors.description}
          aside={lengthCount(description, AGENT_DESCRIPTION_MAX_LENGTH)}
        >
          <TextInput
            value={description}
            autoComplete="off"
            placeholder="Plans and checks our weekly releases"
            onChange={(event) => {
              setDescription(event.target.value);
              setErrors(({ description: _drop, ...rest }) => rest);
            }}
          />
        </Field>
        <Field
          label="Instructions"
          optional
          error={errors.instructions}
          aside={lengthCount(instructions, AGENT_INSTRUCTIONS_MAX_LENGTH)}
          hint={
            <span
              data-agent-instructions-hint={
                overLimitAsStored ? "over-limit" : long ? "long" : undefined
              }
            >
              {overLimitAsStored
                ? INSTRUCTIONS_OVER_LIMIT_HINT
                : long
                  ? INSTRUCTIONS_LONG_HINT
                  : INSTRUCTIONS_HINT}
            </span>
          }
        >
          <TextArea
            value={instructions}
            rows={10}
            placeholder="You manage our releases. Check the open pull requests first, then write the release notes in our usual format."
            onChange={(event) => {
              setInstructions(event.target.value);
              setErrors(({ instructions: _drop, ...rest }) => rest);
            }}
          />
        </Field>
        <SettingRow
          label="Remember across chats"
          description={
            memoryEnabled
              ? "Its chats save what they learn to its Memory and read it in later chats."
              : "Each chat starts fresh."
          }
          control={
            <Switch
              aria-label="Remember across chats"
              checked={memoryEnabled}
              onCheckedChange={setMemoryEnabled}
            />
          }
        />
        <Field
          label="Who can use it"
          group
          hint={
            inSlack && visibility === "private"
              ? "Only me agents stay in the app, so it stops answering in Slack."
              : undefined
          }
        >
          <SegmentedControl
            size="sm"
            aria-label="Who can use it"
            options={[
              {
                value: "private",
                label: "Only me",
                disabled: visibility !== "private" && privateChats === false,
                disabledReason: ONLY_ME_UNAVAILABLE,
              },
              { value: "workspace", label: workspacePeopleLabel(workspaceName) },
            ]}
            value={visibility}
            onValueChange={(next) => setVisibility(next as AgentVisibility)}
          />
        </Field>
      </FieldStack>
    </FormPage>
  );
}

/**
 * The new-agent form; with `sourceSessionId`, prefilled from that chat, and
 * with `suggestionId`, from the draft in that chat's agent suggestion.
 */
export function NewAgentPage({
  workspaceId,
  sourceSessionId,
  suggestionId,
}: {
  workspaceId: string;
  sourceSessionId?: string | null | undefined;
  suggestionId?: string | null | undefined;
}) {
  const { client } = useAppContext();
  const navigate = useNavigate();
  const [initial, setInitial] = useState<AgentFormValues | null>(sourceSessionId ? null : EMPTY);
  const [sourceTitle, setSourceTitle] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!sourceSessionId) {
      setInitial(EMPTY);
      return;
    }
    let live = true;
    client.getSessionConfiguration(workspaceId, sourceSessionId).then(
      (session) => {
        if (!live) return;
        setSourceTitle(session.title?.trim() || undefined);
        // The agent's own draft, when the person came from its suggestion card.
        const draft =
          suggestionId &&
          session.agentSuggestion?.id === suggestionId &&
          session.agentSuggestion.kind === "create"
            ? session.agentSuggestion
            : null;
        setInitial({
          ...EMPTY,
          name: draft?.name ?? session.title?.trim() ?? "",
          description: draft ? (draft.description ?? "") : (session.description?.trim() ?? ""),
          avatar: draft ? draft.avatar : (session.avatar ?? null),
          instructions: draft?.instructions ?? session.instructions?.trim() ?? "",
          // Shared like the chat, so an Only me chat makes an Only me agent.
          visibility: session.tenancy?.visibility === "private" ? "private" : "workspace",
        });
      },
      // The chat may be gone; start from an empty form rather than block.
      () => {
        if (live) setInitial(EMPTY);
      },
    );
    return () => {
      live = false;
    };
  }, [client, sourceSessionId, suggestionId, workspaceId]);
  const close = () => {
    if (sourceSessionId) {
      void navigate({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId, sessionId: sourceSessionId },
      });
      return;
    }
    void navigate({ to: "/workspaces/$workspaceId/agents", params: { workspaceId } });
  };
  if (!initial) {
    return (
      <FormPage title="Make this an agent" submitLabel="Create agent" loading>
        {null}
      </FormPage>
    );
  }
  return (
    <AgentForm
      workspaceId={workspaceId}
      initial={initial}
      sourceSessionId={sourceSessionId}
      sourceTitle={sourceTitle}
      onClose={close}
      onSaved={(agent) => {
        // Its suggestion card has done its job.
        if (sourceSessionId && suggestionId) dismissAgentSuggestion(sourceSessionId, suggestionId);
        toast.success(`Created ${agent.name}`);
        void navigate({
          to: "/workspaces/$workspaceId/agents/$agentId",
          params: { workspaceId, agentId: agent.id },
          replace: true,
        });
      }}
    />
  );
}

export function EditAgentPage({ workspaceId, agentId }: { workspaceId: string; agentId: string }) {
  const navigate = useNavigate();
  const state = useAgent(workspaceId, agentId);
  const close = () =>
    void navigate({
      to: "/workspaces/$workspaceId/agents/$agentId",
      params: { workspaceId, agentId },
    });
  const agent = state.agent;
  if (agent === undefined) {
    return (
      <FormPage title="Edit agent" submitLabel="Save" loading>
        {null}
      </FormPage>
    );
  }
  if (agent === null || !agent.viewer.canEdit) {
    return (
      <div className="mx-auto w-full max-w-[960px] px-8 pt-6 max-sm:px-4">
        <ErrorMessage
          title={agent ? "You can't change this agent" : "This agent isn't available"}
          {...(state.error ? apiErrorDetails(state.error) : {})}
          action={
            <Button type="button" variant="outline" size="sm" onClick={close}>
              Back
            </Button>
          }
        >
          {state.error
            ? userErrorText(state.error)
            : agent
              ? "Whoever made it, or a workspace admin, can."
              : "It was deleted, or you can't use it."}
        </ErrorMessage>
      </div>
    );
  }
  return (
    <AgentForm
      workspaceId={workspaceId}
      agent={agent}
      initial={{
        name: agent.name,
        description: agent.description,
        avatar: agent.avatar,
        instructions: agent.instructions,
        memoryEnabled: agent.memory.enabled,
        visibility: agent.visibility,
      }}
      onClose={close}
      onSaved={(saved) => {
        forgetSessionAgent(workspaceId, saved.id);
        toast.success(`Saved ${saved.name}`);
        close();
      }}
    />
  );
}
