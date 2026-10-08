import type {
  MemorySlackImportance,
  MemorySlackPublication,
  MemorySlackPublicationConfiguration,
  MemorySlackPublicationState,
  SlackPublicationChannel,
} from "@opengeni/sdk";
import { OpenGeniMemorySlackClient } from "@opengeni/sdk/memory-slack";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiErrorFacts, userErrorText } from "@/lib/api-error";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { RelativeTime } from "@/components/ui/relative-time";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { SelectMenu, type SelectOption } from "@/components/ui/select-menu";
import { StatusBadge, type StatusBadgeProps } from "@/components/ui/status-badge";
import { useAppContext } from "@/context";
import { openGeniSlackBotConnectionOptions } from "@/lib/slack-bot";
import type { ConnectionMetadata } from "@/types";

const IMPORTANCES: MemorySlackImportance[] = ["major", "normal", "minor"];

/** The memory-slack SDK client, created here so the SDK stays behind this lazy boundary. */
export function createMemorySlackClient(
  coreClient: ConstructorParameters<typeof OpenGeniMemorySlackClient>[0],
): OpenGeniMemorySlackClient {
  return new OpenGeniMemorySlackClient(coreClient);
}

type PolicyChoice = "auto" | "review" | "never";
type DraftPolicy = Record<MemorySlackImportance, PolicyChoice>;

/** The same three words as the Agent learning settings. */
const POLICY_OPTIONS: readonly SegmentedControlOption<PolicyChoice>[] = [
  { value: "auto", label: "Automatic" },
  { value: "review", label: "Review first" },
  { value: "never", label: "Off" },
];

const IMPORTANCE_COPY: Record<MemorySlackImportance, { label: string; example: string }> = {
  major: { label: "Major", example: "Decisions, rollbacks and policy changes" },
  normal: { label: "Normal", example: "Useful lessons from agent work" },
  minor: { label: "Minor", example: "Routine maintenance notes" },
};

/**
 * Where Knowledge and Agent learning summaries are posted in Slack, and which
 * ones. Opened from the Slack integration's "Publish important decisions to
 * Slack" option; the on/off switch itself lives there. Opened by an attempt to
 * turn it on (`enableOnSave`), saving here also turns it on.
 */
export function MemorySlackPublicationDialog({
  workspaceId,
  connections,
  canManage,
  enableOnSave = false,
  open,
  onOpenChange,
  onSaved,
}: {
  workspaceId: string;
  connections: ConnectionMetadata[];
  canManage: boolean;
  enableOnSave?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (configuration: MemorySlackPublicationConfiguration) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Publish important decisions to Slack</DialogTitle>
          <DialogDescription>
            Posts short summaries of Knowledge changes and Agent learning to one Slack channel.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <MemorySlackPublicationSettings
            workspaceId={workspaceId}
            connections={connections}
            canManage={canManage}
            enableOnSave={enableOnSave}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MemorySlackPublicationSettings({
  workspaceId,
  connections,
  canManage,
  enableOnSave,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  connections: ConnectionMetadata[];
  canManage: boolean;
  enableOnSave: boolean;
  onClose: () => void;
  onSaved?: (configuration: MemorySlackPublicationConfiguration) => void;
}) {
  const { client: coreClient } = useAppContext();
  const client = useMemo(() => new OpenGeniMemorySlackClient(coreClient), [coreClient]);
  const installations = useMemo(
    () =>
      openGeniSlackBotConnectionOptions(
        connections.filter((connection) => connection.status === "active"),
      ),
    [connections],
  );
  const [configuration, setConfiguration] = useState<MemorySlackPublicationConfiguration | null>(
    null,
  );
  const [publications, setPublications] = useState<MemorySlackPublication[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [channelName, setChannelName] = useState<string | null>(null);
  const [policy, setPolicy] = useState<DraftPolicy>({
    major: "auto",
    normal: "review",
    minor: "never",
  });
  const [channels, setChannels] = useState<SlackPublicationChannel[]>([]);
  const [channelsVersion, setChannelsVersion] = useState(0);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The saved installation is no longer connected, so its channel was dropped.
  const [installationReplaced, setInstallationReplaced] = useState(false);

  // Read through a ref: a new connections array must never reload the saved
  // settings over unsaved edits.
  const installationsRef = useRef(installations);
  useEffect(() => {
    installationsRef.current = installations;
  }, [installations]);

  /** The only writer of `configuration`: its revision and on/off state back the next save. */
  const applyConfiguration = useCallback((next: MemorySlackPublicationConfiguration | null) => {
    const available = installationsRef.current;
    const storedConnectionId = next?.connectionId ?? null;
    const storedAvailable =
      storedConnectionId !== null &&
      available.some((option) => option.connection.id === storedConnectionId);
    const replaced = storedConnectionId !== null && !storedAvailable;
    setConfiguration(next);
    setInstallationReplaced(replaced);
    setConnectionId(storedAvailable ? storedConnectionId : (available[0]?.connection.id ?? null));
    setChannelId(replaced ? null : (next?.slackChannelId ?? null));
    setChannelName(replaced ? null : (next?.slackChannelName ?? null));
    setPolicy({
      major: policyForImportance(next, "major"),
      normal: policyForImportance(next, "normal"),
      minor: policyForImportance(next, "minor"),
    });
  }, []);

  const loadSettings = useCallback(async () => {
    setError(null);
    try {
      const [config, history] = await Promise.all([
        client.getMemorySlackPublicationConfiguration(workspaceId),
        client.listMemorySlackPublications(workspaceId),
      ]);
      applyConfiguration(config.current);
      setPublications(history.publications);
    } catch (loadError) {
      setError(`Couldn't load Slack publication settings. ${userErrorText(loadError)}`);
    } finally {
      setLoading(false);
    }
  }, [applyConfiguration, client, workspaceId]);

  /** Re-reads only the history, so unsaved edits and the saved revision stay as they are. */
  const loadHistory = useCallback(async () => {
    try {
      const history = await client.listMemorySlackPublications(workspaceId);
      setPublications(history.publications);
    } catch (loadError) {
      toast.error("Couldn't refresh recent posts", { description: userErrorText(loadError) });
    }
  }, [client, workspaceId]);

  useEffect(() => void loadSettings(), [loadSettings]);

  // Installations that arrive after the settings loaded still get a default.
  useEffect(() => {
    if (!loading && connectionId === null && installations.length > 0) {
      setConnectionId(installations[0]!.connection.id);
    }
  }, [connectionId, installations, loading]);

  useEffect(() => {
    if (!canManage || !connectionId) {
      setChannels([]);
      return;
    }
    let cancelled = false;
    setChannelsLoading(true);
    setChannelsError(null);
    void (async () => {
      const collected: SlackPublicationChannel[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const response = await client.listMemorySlackPublicationChannels(
          workspaceId,
          connectionId,
          cursor,
        );
        collected.push(...response.channels);
        cursor = response.nextCursor ?? undefined;
        if (!cursor) break;
      }
      return [...new Map(collected.map((channel) => [channel.id, channel])).values()];
    })()
      .then((eligibleChannels) => {
        if (!cancelled) setChannels(eligibleChannels);
      })
      .catch((channelError) => {
        if (!cancelled) {
          setChannels([]);
          setChannelsError(`Couldn't load Slack channels. ${userErrorText(channelError)}`);
        }
      })
      .finally(() => {
        if (!cancelled) setChannelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canManage, channelsVersion, client, connectionId, workspaceId]);

  // Saving keeps the current on/off state unless this dialog was opened to turn it on.
  const enabled = enableOnSave || (configuration?.enabled ?? false);
  const missingChannel = enabled && (!connectionId || !channelId);
  const editable = canManage && !saving && !loading;

  async function save() {
    if (missingChannel) return;
    setSaving(true);
    try {
      const next = await client.updateMemorySlackPublicationConfiguration(workspaceId, {
        expectedRevision: configuration?.revision ?? 0,
        enabled,
        connectionId,
        slackChannelId: channelId,
        slackChannelName: channelName,
        autoImportances: IMPORTANCES.filter((importance) => policy[importance] === "auto"),
        reviewImportances: IMPORTANCES.filter((importance) => policy[importance] === "review"),
      });
      onSaved?.(next);
      toast.success(
        enableOnSave && !configuration?.enabled
          ? "Decision publication turned on"
          : "Slack publication settings saved",
      );
      onClose();
    } catch (saveError) {
      if (apiErrorFacts(saveError).status === 409) {
        // Someone else saved first: show their settings rather than failing every retry.
        toast.error("These settings changed while you were editing", {
          description: "The latest settings are shown. Make your change again and save.",
        });
        await loadSettings();
      } else {
        toast.error("Could not save Slack publication settings", {
          description: userErrorText(saveError),
        });
      }
    } finally {
      setSaving(false);
    }
  }

  async function act(publication: MemorySlackPublication, action: "approve" | "reject" | "retry") {
    setActingId(publication.id);
    try {
      await client.actOnMemorySlackPublication(workspaceId, publication.id, {
        action,
        expectedState: publication.state,
      });
      toast.success(
        action === "approve" ? "Post approved" : action === "reject" ? "Post rejected" : "Retrying",
      );
    } catch (actionError) {
      toast.error(`Couldn't ${action} this post`, {
        description: userErrorText(actionError),
      });
    } finally {
      await loadHistory();
      setActingId(null);
    }
  }

  const storedChannelMissing =
    Boolean(channelId) &&
    !channelsLoading &&
    !channelsError &&
    !channels.some((channel) => channel.id === channelId);
  const channelOptions: SelectOption[] = [
    ...(storedChannelMissing && channelId
      ? [
          {
            value: channelId,
            label: channelName ? `#${channelName}` : "The chosen channel",
            meta: "Unavailable",
            disabled: true,
          },
        ]
      : []),
    ...channels.map((channel) => ({
      value: channel.id,
      label: channel.isPrivate ? (channel.name ?? channel.id) : `#${channel.name ?? channel.id}`,
      ...(channel.isPrivate ? { meta: "Private" } : {}),
    })),
  ];
  const channelHint = storedChannelMissing
    ? "Opengeni can no longer post there. Invite it back in Slack, or choose another channel."
    : !channelsLoading && channels.length === 0 && connectionId
      ? "Opengeni isn't in any channel yet. Invite it to one in Slack, then reload."
      : "Only channels Opengeni has been invited to.";

  return (
    <>
      <div className="-mx-1 min-h-0 overflow-y-auto px-1">
        {error ? (
          <Notice tone="failed" className="mb-4">
            {error}
          </Notice>
        ) : null}
        {installations.length === 0 ? (
          <Notice tone="waiting" className="mb-4">
            Install or reconnect the Opengeni Slack bot first.
          </Notice>
        ) : installationReplaced ? (
          <Notice tone="waiting" className="mb-4">
            The saved Slack installation is no longer connected. Choose a channel again.
          </Notice>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 py-6 text-sm text-fg-muted">
            <Loader2Icon className="size-4 animate-spin" /> Loading settings…
          </p>
        ) : installations.length === 0 ? null : (
          <div className="flex flex-col gap-6">
            {installations.length > 1 ? (
              <Field label="Slack workspace">
                <SelectMenu
                  options={installations.map((option) => ({
                    value: option.connection.id,
                    label: option.label,
                  }))}
                  value={connectionId}
                  onValueChange={(value) => {
                    setConnectionId(value);
                    setChannelId(null);
                    setChannelName(null);
                  }}
                  placeholder="Choose a Slack workspace"
                  disabled={!editable}
                  className="w-full"
                />
              </Field>
            ) : null}

            <Field
              label="Channel"
              hint={channelsError ? undefined : channelHint}
              error={channelsError ?? undefined}
              aside={
                canManage && connectionId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={channelsLoading}
                    onClick={() => setChannelsVersion((version) => version + 1)}
                  >
                    <RefreshCwIcon className={channelsLoading ? "animate-spin" : undefined} />
                    Reload
                  </Button>
                ) : null
              }
            >
              <SelectMenu
                variant={channelOptions.length > 8 ? "combobox" : "menu"}
                options={channelOptions}
                value={channelId}
                onValueChange={(value) => {
                  const selected = channels.find((channel) => channel.id === value);
                  setChannelId(selected?.id ?? null);
                  setChannelName(selected?.name ?? null);
                }}
                placeholder={connectionId ? "Choose a channel" : "Choose a Slack workspace first"}
                searchPlaceholder="Search channels"
                emptyMessage="No channels yet"
                disabled={!editable || !connectionId}
                loading={channelsLoading}
                loadingLabel="Loading channels…"
                invalid={Boolean(channelsError)}
                className="w-full"
              />
            </Field>

            <Field
              label="What to post"
              hint="Review first holds a post in Recent posts until an admin approves it."
              group
            >
              <div className="flex flex-col divide-y divide-border">
                {IMPORTANCES.map((importance) => (
                  <div
                    key={importance}
                    className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-fg">
                        {IMPORTANCE_COPY[importance].label}
                      </p>
                      <p className="text-xs leading-4.5 text-fg-muted">
                        {IMPORTANCE_COPY[importance].example}
                      </p>
                    </div>
                    <SegmentedControl
                      aria-label={`${IMPORTANCE_COPY[importance].label} items`}
                      options={POLICY_OPTIONS}
                      value={policy[importance]}
                      onValueChange={(value) => setPolicy({ ...policy, [importance]: value })}
                      disabled={!editable}
                      size="sm"
                      className="shrink-0 max-sm:w-full max-sm:[&_[data-slot=segmented-control-item]]:flex-1"
                    />
                  </div>
                ))}
              </div>
            </Field>

            <section aria-labelledby="slack-publication-history">
              <h3 id="slack-publication-history" className="text-sm font-medium text-fg">
                Recent posts
              </h3>
              {publications.length === 0 ? (
                <p className="mt-1.5 text-xs text-fg-muted">Nothing posted yet.</p>
              ) : (
                <ul className="mt-1 flex flex-col divide-y divide-border">
                  {publications.slice(0, 12).map((publication) => (
                    <PublicationRow
                      key={publication.id}
                      publication={publication}
                      canManage={canManage}
                      acting={actingId === publication.id}
                      onAct={act}
                    />
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>

      <DialogFooter className="sm:items-center">
        {!canManage ? (
          <p className="mr-auto text-xs text-fg-muted">Only workspace admins can change this.</p>
        ) : null}
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        {canManage ? (
          <Button
            type="button"
            disabled={!editable || missingChannel || installations.length === 0}
            onClick={() => void save()}
          >
            {saving ? <Loader2Icon className="animate-spin" /> : null}
            {enableOnSave && !configuration?.enabled ? "Turn on" : "Save"}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}

function PublicationRow({
  publication,
  canManage,
  acting,
  onAct,
}: {
  publication: MemorySlackPublication;
  canManage: boolean;
  acting: boolean;
  onAct: (
    publication: MemorySlackPublication,
    action: "approve" | "reject" | "retry",
  ) => Promise<void>;
}) {
  const status = publicationStatus(publication.state);
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <p className="text-sm text-fg">{publication.summary}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
          <StatusBadge variant="dot" {...status} />
          <span aria-hidden>·</span>
          <span>{publication.sourceLabel}</span>
          <MetaChip variant="soft">{IMPORTANCE_COPY[publication.importance].label}</MetaChip>
          <span aria-hidden>·</span>
          <RelativeTime date={publication.updatedAt} focusable={false} />
          {publication.attemptCount > 1 ? (
            <>
              <span aria-hidden>·</span>
              <span>{publication.attemptCount} attempts</span>
            </>
          ) : null}
          {publication.state === "failed" && publication.lastErrorCode ? (
            <>
              <span aria-hidden>·</span>
              <span className="font-mono">{publication.lastErrorCode}</span>
            </>
          ) : null}
        </div>
      </div>
      {canManage ? (
        <div className="flex shrink-0 gap-2">
          {publication.state === "review_pending" ? (
            <>
              <Button
                variant="outline"
                type="button"
                size="sm"
                disabled={acting}
                onClick={() => void onAct(publication, "approve")}
              >
                Approve
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={acting}
                onClick={() => void onAct(publication, "reject")}
              >
                Reject
              </Button>
            </>
          ) : null}
          {publication.state === "failed" ? (
            <Button
              variant="outline"
              type="button"
              size="sm"
              disabled={acting}
              onClick={() => void onAct(publication, "retry")}
            >
              {acting ? <Loader2Icon className="animate-spin" /> : null}Retry
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function policyForImportance(
  configuration: MemorySlackPublicationConfiguration | null,
  importance: MemorySlackImportance,
): PolicyChoice {
  if (configuration?.autoImportances.includes(importance)) return "auto";
  if (configuration?.reviewImportances.includes(importance)) return "review";
  if (configuration) return "never";
  return importance === "major" ? "auto" : importance === "normal" ? "review" : "never";
}

function publicationStatus(
  state: MemorySlackPublicationState,
): Pick<StatusBadgeProps, "status" | "tone" | "children"> {
  switch (state) {
    case "review_pending":
      return { status: "pending_review" };
    case "queued":
      return { status: "queued" };
    case "delivering":
      return { tone: "progress", children: "Posting" };
    case "retry_wait":
      return { tone: "progress", children: "Retrying soon" };
    case "delivered":
      return { tone: "success", children: "Posted" };
    case "rejected":
      return { tone: "neutral", children: "Rejected" };
    case "cancelled":
      return { tone: "neutral", children: "Cancelled" };
    case "failed":
      return { status: "failed" };
  }
}
