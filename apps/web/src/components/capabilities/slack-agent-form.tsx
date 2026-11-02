/**
 * Create or edit a Slack agent, and introduce it in Slack channels.
 *
 * Both are pages (DESIGN.md section 8). Creating offers the optional intro
 * step on the same page right after the agent exists.
 */
import { useEffect, useMemo, useState } from "react";
import {
  SLACK_AGENT_DESCRIPTION_MAX_LENGTH,
  SLACK_AGENT_INSTRUCTIONS_MAX_LENGTH,
  SLACK_AGENT_INTRO_CHANNELS_MAX,
  SLACK_AGENT_NAME_MAX_LENGTH,
  SLACK_AGENT_OPEN_LABEL,
  slackAgentCallText,
  slackAgentNameKey,
  slackAgentNameProblem,
  slackAgentNameProblemText,
  slackAgentNameWarning,
  slackAgentOpenDisclosure,
} from "@opengeni/contracts";
import type {
  SessionAvatar as SessionAvatarValue,
  SlackAgent,
  SlackAgentChannelListResponse,
  SlackAgentIntroResponse,
  UpdateSlackAgentRequest,
} from "@opengeni/sdk";
import { toast } from "sonner";
import { OpenGeniApiError } from "@opengeni/sdk/browser";

import { useAppContext } from "@opengeni/react/app/app-context";
import { useNavigate } from "@opengeni/react/app/lib/navigation";
import { hasAccountPermission, hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import type { ConnectionMetadata } from "@opengeni/react/app/types";
import { sessionAvatarFallbackHue } from "@opengeni/react/app/components/session/session-avatar";
import {
  SessionAvatarPickerButton,
  sessionAvatarDraft,
  sessionAvatarDraftErrors,
  sessionAvatarFromDraft,
  sessionAvatarSeedHue,
} from "@opengeni/react/app/components/session/session-avatar-picker";
import {
  apiErrorDetails,
  userErrorText,
  userErrorTextWithoutReference,
} from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { CheckboxField, Field, FieldStack, TextArea, TextInput } from "@opengeni/react/ui/field";
import { FormPage } from "@opengeni/react/ui/form-dialog";
import { inAppClick } from "@opengeni/react/ui/in-app-click";
import { Notice } from "@opengeni/react/ui/notice";
import { SelectMenu } from "@opengeni/react/ui/select-menu";
import { Skeleton } from "@opengeni/react/ui/skeleton";

import { openGeniSlackBotUiMetadata } from "@/lib/slack-bot";
import { previewPersonName, SlackAgentIntroPreview } from "./slack-agent-intro-preview";
import { slackAgentCall, slackAgentErrorCode } from "./slack-agents";

/** What a new agent starts from, such as a bot template. */
export type SlackAgentSeed = {
  name: string;
  description: string;
  avatar: SessionAvatarValue | null;
  instructions: string;
};

const EMPTY_SEED: SlackAgentSeed = { name: "", description: "", avatar: null, instructions: "" };

/**
 * Why a name can't be saved. Only a new or changed name meets every rule, so
 * an agent named before the stricter rules can still be saved unchanged.
 */
function nameError(name: string, current: string | undefined): string | null {
  if (current !== undefined && slackAgentNameKey(name) === slackAgentNameKey(current)) return null;
  const problem = slackAgentNameProblem(name);
  return problem ? slackAgentNameProblemText(name, problem) : null;
}

const DESCRIPTION_MISSING = "Say in one sentence what it helps with.";

/** "Works in the Platform workspace.", or "Works in this workspace." when the name already says it. */
function worksIn(workspaceName: string): string {
  return /workspace$/i.test(workspaceName.trim())
    ? `Works in ${workspaceName}.`
    : `Works in the ${workspaceName} workspace.`;
}

function installationName(connection: ConnectionMetadata): string {
  return openGeniSlackBotUiMetadata(connection)?.slackTeamName ?? "Slack workspace";
}

/** The agent's Memory: its Knowledge collection, opened on the Knowledge page. */
function MemoryField({
  workspaceId,
  collectionId,
  reviewFirst,
}: {
  workspaceId: string;
  collectionId: string;
  reviewFirst: boolean;
}) {
  const navigate = useNavigate();
  const href = `/workspaces/${workspaceId}/state?entry=${encodeURIComponent(collectionId)}`;
  return (
    <Field
      label="Memory"
      group
      hint={reviewFirst ? "New Memory is saved for review first." : undefined}
    >
      <a
        href={href}
        onClick={inAppClick(() => void navigate({ href }))}
        className="w-fit rounded-[4px] text-sm text-fg underline decoration-fg/25 underline-offset-2 hover:decoration-fg"
        data-slack-agent-memory=""
      >
        Open in Knowledge
      </a>
    </Field>
  );
}

export function SlackAgentFormPage({
  agent,
  seed = EMPTY_SEED,
  workspaceId,
  workspaceName,
  connections,
  connectionsLoaded = true,
  connectionsError = null,
  onRetryConnections,
  onClose,
  onSaved,
}: {
  /** The agent to edit; omitted to create one. */
  agent?: SlackAgent | undefined;
  seed?: SlackAgentSeed | undefined;
  /** Where a new agent works: the current workspace. */
  workspaceId: string;
  workspaceName: string;
  /** Opengeni bots a new agent can be called through. */
  connections: ConnectionMetadata[];
  /** False while the bots are still loading; the form can open before them. */
  connectionsLoaded?: boolean | undefined;
  /** Why the bots couldn't all load; then a missing bot may only have failed to load. */
  connectionsError?: string | null | undefined;
  onRetryConnections?: (() => void) | undefined;
  onClose: () => void;
  /** After a create or an edit. */
  onSaved: (agent: SlackAgent, created: boolean) => void;
}) {
  const { client, accessContext } = useAppContext();
  const initial: SlackAgentSeed = agent
    ? {
        name: agent.name,
        description: agent.description,
        avatar: agent.avatar,
        instructions: agent.instructions ?? "",
      }
    : seed;
  const seedKey = agent?.id ?? "new-slack-agent";
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [draft, setDraft] = useState(() =>
    sessionAvatarDraft(
      // Image avatars come from a chat's own files, which an agent doesn't have.
      initial.avatar?.kind === "image" ? null : initial.avatar,
      sessionAvatarSeedHue(sessionAvatarFallbackHue(seedKey)),
      "icon",
    ),
  );
  // Empty until someone picks one: the bots can arrive after the form opens.
  const [connectionId, setConnectionId] = useState("");
  const [errors, setErrors] = useState<{
    name?: string | null;
    description?: string | null;
    emoji?: string;
    letters?: string;
  }>({});
  const [unavailable, setUnavailable] = useState<ConnectionMetadata | null>(null);
  const [turningOn, setTurningOn] = useState(false);
  const [open, setOpen] = useState(agent?.open ?? false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const avatar = sessionAvatarFromDraft(draft, name, null);
  const connection = connections.find((row) => row.id === connectionId) ?? connections[0] ?? null;
  // Only when no bot arrived: with one, creating works and the Slack page behind says the rest.
  const loadFailed = !agent && !connection && connectionsLoaded && Boolean(connectionsError);
  const agentWorkspaceName = agent ? (agent.targetWorkspaceName ?? workspaceName) : workspaceName;
  const nameHint = name.trim()
    ? [
        `People ask it with ${slackAgentCallText(name)}.`,
        slackAgentNameKey(name) === (agent ? slackAgentNameKey(agent.name) : null)
          ? null
          : slackAgentNameWarning(name),
      ]
        .filter(Boolean)
        .join(" ")
    : undefined;
  // Opening an agent to anyone in Slack is an organization admin's call; any
  // admin of the workspace can close it again. The API enforces both.
  const agentAccountId = agent
    ? accessContext?.workspaceGrants.find((grant) => grant.workspaceId === agent.targetWorkspaceId)
        ?.accountId
    : undefined;
  const canOpen = Boolean(
    agentAccountId && hasAccountPermission(accessContext, agentAccountId, "account:admin"),
  );

  function validate(): boolean {
    const next = {
      name: nameError(name, agent?.name),
      description: description.trim() ? null : DESCRIPTION_MISSING,
      ...sessionAvatarDraftErrors(draft, name, null),
    };
    setErrors(next);
    // Name and description first; then the picker opens on the icon's error.
    if (!next.name && !next.description && (next.emoji || next.letters)) setPickerOpen(true);
    return !next.name && !next.description && !next.emoji && !next.letters && avatar !== null;
  }

  /** Resolves false when the form shows why it can't save. */
  async function create(): Promise<boolean> {
    if (!connection || !avatar) return false;
    try {
      const result = await client.createOpenGeniSlackAgent(workspaceId, {
        connectionId: connection.id,
        name: name.trim(),
        description: description.trim(),
        avatar,
        instructions: instructions.trim(),
      });
      setUnavailable(null);
      onSaved(result.agent, true);
      return true;
    } catch (failure) {
      const code = slackAgentErrorCode(failure);
      if (code === "slack_agent_name_taken") {
        setErrors((current) => ({
          ...current,
          name: "Another Slack agent is already called this.",
        }));
        return false;
      }
      if (code === "slack_bot_unavailable") {
        setUnavailable(connection);
        return false;
      }
      throw failure;
    }
  }

  async function update(current: SlackAgent): Promise<boolean> {
    if (!avatar) return false;
    const change: UpdateSlackAgentRequest = { expectedVersion: current.version };
    if (name.trim() !== current.name) change.name = name.trim();
    if (description.trim() !== current.description) change.description = description.trim();
    if (instructions.trim() !== (current.instructions ?? ""))
      change.instructions = instructions.trim();
    if (JSON.stringify(avatar) !== JSON.stringify(current.avatar)) change.avatar = avatar;
    if (open !== current.open) change.open = open;
    if (Object.keys(change).length === 1) {
      onClose();
      return true;
    }
    try {
      const result = await client.updateOpenGeniSlackAgent(
        current.targetWorkspaceId,
        current.id,
        change,
      );
      onSaved(result.agent, false);
      return true;
    } catch (failure) {
      const code = slackAgentErrorCode(failure);
      if (code === "slack_agent_name_taken") {
        setErrors((existing) => ({
          ...existing,
          name: "Another Slack agent is already called this.",
        }));
        return false;
      }
      if (failure instanceof OpenGeniApiError && failure.status === 409) {
        throw new Error(
          "Someone else changed this agent. Go back to see their change, then edit it again.",
          { cause: failure },
        );
      }
      throw failure;
    }
  }

  const canTurnOn =
    unavailable !== null &&
    hasAccountPermission(accessContext, unavailable.accountId, "account:admin") &&
    hasWorkspacePermission(accessContext, unavailable.workspaceId, "connections:write");

  async function turnOnAndCreate() {
    if (!unavailable) return;
    setTurningOn(true);
    try {
      const access = await client.getOpenGeniSlackBotOrganizationAccess(
        unavailable.workspaceId,
        unavailable.id,
      );
      if (!access.enabled || access.workspaceIds != null) {
        await client.setOpenGeniSlackBotOrganizationAccess(
          unavailable.workspaceId,
          unavailable.id,
          {
            enabled: true,
            workspaceIds: [
              ...new Set([...(access.enabled ? (access.workspaceIds ?? []) : []), workspaceId]),
            ],
          },
        );
      }
      await create();
    } catch (failure) {
      toast.error("Couldn't turn on the Opengeni bot", { description: userErrorText(failure) });
    } finally {
      setTurningOn(false);
    }
  }

  return (
    <FormPage
      title={agent ? `Edit ${agent.name}` : "New Slack agent"}
      description={worksIn(agentWorkspaceName)}
      back={{ label: "Slack", onClick: onClose }}
      onCancel={onClose}
      submitLabel={agent ? "Save" : "Create agent"}
      pendingLabel={agent ? "Saving…" : "Creating…"}
      pending={turningOn ? true : undefined}
      // Until every bot is in, the bot shared with this workspace may still be missing.
      submitDisabled={!agent && (!connection || !connectionsLoaded)}
      disabledReason={
        !agent && !connection && connectionsLoaded && !loadFailed
          ? "Add a Slack workspace to create Slack agents."
          : undefined
      }
      onSubmit={async () => {
        if (!validate()) return false;
        return agent ? await update(agent) : await create();
      }}
    >
      <FieldStack>
        {loadFailed ? (
          <Notice
            tone="failed"
            title="Couldn't load all Slack connections"
            action={
              onRetryConnections ? (
                <Button type="button" variant="outline" size="sm" onClick={onRetryConnections}>
                  Retry
                </Button>
              ) : undefined
            }
          >
            {connectionsError}
          </Notice>
        ) : null}
        {unavailable ? (
          <Notice
            tone="waiting"
            title={`The Opengeni bot isn't available in ${workspaceName}`}
            action={
              canTurnOn ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={turningOn}
                  onClick={() => void turnOnAndCreate()}
                >
                  Turn on and create
                </Button>
              ) : undefined
            }
          >
            {canTurnOn
              ? `Turn it on for ${workspaceName} to create this agent.`
              : `Ask an organization admin to turn it on for ${workspaceName}.`}
          </Notice>
        ) : null}
        <div className="flex items-start gap-4">
          <SessionAvatarPickerButton
            label="Icon"
            allowNone={false}
            draft={draft}
            onChange={(next) => {
              setDraft(next);
              setErrors((current) => ({ name: current.name, description: current.description }));
            }}
            name={name}
            image={null}
            errors={errors}
            workspaceId={agent?.targetWorkspaceId ?? workspaceId}
            seed={seedKey}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
          />
          <div className="min-w-0 flex-1">
            <Field label="Name" error={errors.name ?? undefined} hint={nameHint}>
              <TextInput
                value={name}
                maxLength={SLACK_AGENT_NAME_MAX_LENGTH}
                autoComplete="off"
                placeholder="Data team"
                onChange={(event) => {
                  setName(event.target.value);
                  setErrors((current) => ({ ...current, name: null }));
                }}
              />
            </Field>
          </div>
        </div>
        <Field
          label="What it helps with"
          error={errors.description ?? undefined}
          hint="Shown to people in Slack and used to suggest this agent. One sentence, starting with a verb."
        >
          <TextInput
            value={description}
            maxLength={SLACK_AGENT_DESCRIPTION_MAX_LENGTH}
            autoComplete="off"
            placeholder="Answers questions about our metrics and dashboards"
            onChange={(event) => {
              setDescription(event.target.value);
              setErrors((current) => ({ ...current, description: null }));
            }}
          />
        </Field>
        <SlackAgentIntroPreview
          name={name}
          description={description}
          avatar={avatar}
          workspaceId={agent?.targetWorkspaceId ?? workspaceId}
          seed={seedKey}
          addedBy={previewPersonName(accessContext?.subjectLabel)}
        />
        <Field
          label="Instructions"
          optional
          hint="What it does and how. Every chat it starts follows them."
        >
          <TextArea
            value={instructions}
            rows={8}
            maxLength={SLACK_AGENT_INSTRUCTIONS_MAX_LENGTH}
            placeholder="You answer questions about our product metrics. Check the dashboards first and link the chart you used."
            onChange={(event) => setInstructions(event.target.value)}
          />
        </Field>
        {!agent && connections.length > 1 ? (
          <Field label="Slack workspace" group>
            <SelectMenu
              aria-label="Slack workspace"
              value={connection?.id ?? ""}
              onValueChange={(value) => {
                setConnectionId(value);
                setUnavailable(null);
              }}
              options={connections.map((row) => ({ value: row.id, label: installationName(row) }))}
            />
          </Field>
        ) : null}
        {agent?.knowledgeCollectionId ? (
          <MemoryField
            workspaceId={agent.targetWorkspaceId}
            collectionId={agent.knowledgeCollectionId}
            reviewFirst={agent.memoryReviewFirst}
          />
        ) : null}
        {agent ? (
          <CheckboxField
            label={SLACK_AGENT_OPEN_LABEL}
            description={slackAgentOpenDisclosure(name.trim() || agent.name, agentWorkspaceName)}
            disabledReason="Only an organization admin can turn this on."
            checked={open}
            disabled={!open && !canOpen}
            onCheckedChange={setOpen}
          />
        ) : null}
      </FieldStack>
    </FormPage>
  );
}

type IntroChannel = SlackAgentChannelListResponse["channels"][number];
type IntroStatus = SlackAgentIntroResponse["results"][number]["status"];

const INTRO_STATUS_TEXT: Record<Exclude<IntroStatus, "posted">, string> = {
  not_in_channel: "Add the Opengeni app to this channel first.",
  restricted: "Opengeni can't post in this channel. Slack limits who can post here.",
  failed: "Couldn't post here. Try again.",
};

function channelLabel(channel: IntroChannel): string {
  return channel.isPrivate
    ? `Private · ${channel.name ?? channel.id}`
    : `#${channel.name ?? channel.id}`;
}

/** Channels by name, so a long list reads like Slack's. */
export function sortIntroChannels(channels: readonly IntroChannel[]): IntroChannel[] {
  return [...channels].sort((a, b) =>
    (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: "base" }),
  );
}

/** Show the search box once the list is longer than this. */
const INTRO_SEARCH_FROM = 8;

/** Post a short intro of an agent in channels the Opengeni app is already in. */
export function SlackAgentIntroPage({
  agent,
  justCreated = false,
  onClose,
}: {
  agent: SlackAgent;
  /** Opened right after creating: the step is optional, so Cancel reads Skip. */
  justCreated?: boolean | undefined;
  onClose: () => void;
}) {
  const { client, accessContext } = useAppContext();
  const [channels, setChannels] = useState<IntroChannel[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [announcementChannelId, setAnnouncementChannelId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Record<string, IntroStatus>>({});
  useEffect(() => {
    let live = true;
    setLoadError(null);
    void (async () => {
      try {
        const collected: IntroChannel[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page += 1) {
          const result = await client.listOpenGeniSlackAgentChannels(
            agent.targetWorkspaceId,
            agent.id,
            cursor,
          );
          collected.push(...result.channels);
          cursor = result.nextCursor ?? undefined;
          if (!cursor) break;
        }
        if (live) {
          setChannels(
            sortIntroChannels([...new Map(collected.map((row) => [row.id, row])).values()]),
          );
        }
      } catch (failure) {
        if (live) setLoadError(failure);
      }
    })();
    return () => {
      live = false;
    };
  }, [client, agent.targetWorkspaceId, agent.id, revision]);
  // The organization's announcement channel, picked by default. Without it
  // (or without access to the setting) nothing is picked.
  useEffect(() => {
    let live = true;
    void client
      .getOpenGeniSlackAgentUpdateSettings(agent.targetWorkspaceId, agent.connectionId)
      .then((settings) => {
        if (live) setAnnouncementChannelId(settings.announcementChannelId ?? null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, agent.targetWorkspaceId, agent.connectionId]);
  useEffect(() => {
    if (touched || !channels || !announcementChannelId) return;
    if (channels.some((channel) => channel.id === announcementChannelId)) {
      setSelected([announcementChannelId]);
    }
  }, [touched, channels, announcementChannelId]);
  const visible = useMemo(() => {
    const needle = query.trim().replace(/^#/u, "").toLowerCase();
    if (!channels || !needle) return channels;
    return channels.filter(
      (channel) =>
        selected.includes(channel.id) ||
        (channel.name ?? channel.id).toLowerCase().includes(needle),
    );
  }, [channels, query, selected]);
  const full = selected.length >= SLACK_AGENT_INTRO_CHANNELS_MAX;
  const empty = channels !== null && channels.length === 0;
  const call = slackAgentCall(agent);
  return (
    <FormPage
      title={`Introduce ${agent.name}`}
      description={
        justCreated
          ? `${agent.name} is ready. Post a short intro so people know to ask ${call}.`
          : `Post a short intro so people know to ask ${call}.`
      }
      back={{ label: "Slack", onClick: onClose }}
      onCancel={onClose}
      cancelLabel={justCreated ? "Skip" : "Cancel"}
      submitLabel="Post intro"
      pendingLabel="Posting…"
      submitDisabled={selected.length === 0}
      disabledReason={channels && !empty ? "Pick at least one channel." : undefined}
      onSubmit={async () => {
        const response = await client.postOpenGeniSlackAgentIntro(
          agent.targetWorkspaceId,
          agent.id,
          { channelIds: selected },
        );
        const byChannel = Object.fromEntries(
          response.results.map((result) => [result.channelId, result.status]),
        );
        const failed = response.results.filter((result) => result.status !== "posted");
        const posted = response.results.length - failed.length;
        if (failed.length === 0) {
          toast.success(
            posted === 1 ? "Intro posted in 1 channel" : `Intro posted in ${posted} channels`,
          );
          onClose();
          return true;
        }
        setResults(byChannel);
        // Keep the channels a retry could fix.
        setTouched(true);
        setSelected(
          failed
            .filter((result) => result.status !== "restricted")
            .map((result) => result.channelId),
        );
        return false;
      }}
    >
      <FieldStack>
        <SlackAgentIntroPreview
          name={agent.name}
          description={agent.description}
          avatar={agent.avatar}
          workspaceId={agent.targetWorkspaceId}
          seed={agent.id}
          addedBy={previewPersonName(accessContext?.subjectLabel)}
        />
        {loadError ? (
          <ErrorMessage
            variant="inline"
            title="Couldn't load Slack channels"
            {...apiErrorDetails(loadError)}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRevision((value) => value + 1)}
              >
                Try again
              </Button>
            }
          >
            {userErrorTextWithoutReference(loadError)}
          </ErrorMessage>
        ) : channels === null || visible === null ? (
          <div className="grid gap-3" aria-busy="true" aria-label="Loading channels">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-56" />
          </div>
        ) : empty ? (
          <p className="text-sm text-fg-muted">
            Opengeni isn't in any channels yet. Invite @Opengeni to a channel in Slack, then come
            back.
          </p>
        ) : (
          <fieldset className="grid gap-3" aria-label="Channels">
            {channels.length > INTRO_SEARCH_FROM ? (
              <TextInput
                type="search"
                aria-label="Search channels"
                placeholder="Search channels"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            ) : null}
            {visible.map((channel) => {
              const checked = selected.includes(channel.id);
              const status = results[channel.id];
              const blocked = status === "restricted";
              return (
                <CheckboxField
                  key={channel.id}
                  label={channelLabel(channel)}
                  description={
                    status === "posted"
                      ? "Posted."
                      : status
                        ? INTRO_STATUS_TEXT[status]
                        : channel.introduced
                          ? "Intro already posted."
                          : undefined
                  }
                  checked={checked}
                  disabled={!checked && (full || blocked)}
                  onCheckedChange={(next) => {
                    setTouched(true);
                    setSelected((current) =>
                      next ? [...current, channel.id] : current.filter((id) => id !== channel.id),
                    );
                  }}
                />
              );
            })}
            {visible.length === 0 ? (
              <p className="text-sm text-fg-muted">No channels match.</p>
            ) : null}
            {full ? (
              <p className="text-xs text-fg-muted">
                Up to {SLACK_AGENT_INTRO_CHANNELS_MAX} channels at a time.
              </p>
            ) : null}
          </fieldset>
        )}
      </FieldStack>
    </FormPage>
  );
}
