import type {
  MemorySlackImportance,
  MemorySlackPublication,
  MemorySlackPublicationConfiguration,
  MemorySlackPublicationState,
  SlackPublicationChannel,
} from "@opengeni/sdk";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Clock3Icon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";
import { openGeniSlackBotConnectionLabel } from "@/lib/slack-bot";
import type { ConnectionMetadata } from "@/types";

const IMPORTANCES: MemorySlackImportance[] = ["major", "normal", "minor"];

type DraftPolicy = Record<MemorySlackImportance, "auto" | "review" | "never">;

export function MemorySlackPublicationCard({
  workspaceId,
  connections,
  canManage,
}: {
  workspaceId: string;
  connections: ConnectionMetadata[];
  canManage: boolean;
}) {
  const { client } = useAppContext();
  const activeConnections = useMemo(
    () => connections.filter((connection) => connection.status === "active"),
    [connections],
  );
  const [configuration, setConfiguration] = useState<MemorySlackPublicationConfiguration | null>(
    null,
  );
  const [publications, setPublications] = useState<MemorySlackPublication[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [channelName, setChannelName] = useState<string | null>(null);
  const [policy, setPolicy] = useState<DraftPolicy>({
    major: "auto",
    normal: "review",
    minor: "never",
  });
  const [channels, setChannels] = useState<SlackPublicationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyConfiguration = useCallback(
    (next: MemorySlackPublicationConfiguration | null) => {
      setConfiguration(next);
      setEnabled(next?.enabled ?? false);
      setConnectionId(next?.connectionId ?? activeConnections[0]?.id ?? null);
      setChannelId(next?.slackChannelId ?? null);
      setChannelName(next?.slackChannelName ?? null);
      setPolicy({
        major: policyForImportance(next, "major"),
        normal: policyForImportance(next, "normal"),
        minor: policyForImportance(next, "minor"),
      });
    },
    [activeConnections],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [config, history] = await Promise.all([
        client.getMemorySlackPublicationConfiguration(workspaceId),
        client.listMemorySlackPublications(workspaceId),
      ]);
      applyConfiguration(config.current);
      setPublications(history.publications);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [applyConfiguration, client, workspaceId]);

  useEffect(() => void refresh(), [refresh]);

  useEffect(() => {
    if (!canManage || !connectionId) {
      setChannels([]);
      return;
    }
    let cancelled = false;
    setChannelsLoading(true);
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
          toast.error("Could not load eligible Slack channels", {
            description:
              channelError instanceof Error ? channelError.message : String(channelError),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setChannelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [canManage, client, connectionId, workspaceId]);

  async function save() {
    if (enabled && (!connectionId || !channelId)) {
      toast.error("Choose a verified Slack installation and an eligible channel first");
      return;
    }
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
      applyConfiguration(next);
      toast.success("Slack decision publication settings saved");
      await refresh();
    } catch (saveError) {
      toast.error("Could not save Slack publication settings", {
        description: saveError instanceof Error ? saveError.message : String(saveError),
      });
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
        action === "approve"
          ? "Publication approved"
          : action === "reject"
            ? "Publication rejected"
            : "Retry queued",
      );
      await refresh();
    } catch (actionError) {
      toast.error("Publication state changed before the action completed", {
        description: actionError instanceof Error ? actionError.message : String(actionError),
      });
      await refresh();
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-border bg-bg/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-fg">Publish important decisions to Slack</p>
          <p className="mt-1 max-w-2xl text-2xs leading-5 text-fg-muted">
            Route bounded summaries of workspace Memory changes and completed governed-learning
            outcomes to one verified, bot-member channel. Major items can publish automatically;
            lower-signal items can wait for review or stay quiet. Slack is a notification surface,
            never the authoritative record.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            Refresh
          </Button>
          <label className="flex items-center gap-2 text-xs font-medium text-fg">
            <input
              type="checkbox"
              checked={enabled}
              disabled={!canManage || saving || activeConnections.length === 0}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enabled
          </label>
        </div>
      </div>

      {error ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-3 text-2xs text-danger">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" /> {error}
        </div>
      ) : null}

      {activeConnections.length === 0 ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-2xs text-fg-muted">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" />
          Install or reinstall the workspace Slack bot before configuring a publication destination.
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="text-2xs font-medium text-fg-muted">
          Verified Slack installation
          <Select
            className="mt-1"
            value={connectionId ?? ""}
            disabled={!canManage || saving}
            onChange={(event) => {
              setConnectionId(event.target.value || null);
              setChannelId(null);
              setChannelName(null);
            }}
          >
            <option value="">Choose an installation</option>
            {activeConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {openGeniSlackBotConnectionLabel(connection) ?? connection.id}
              </option>
            ))}
          </Select>
        </label>

        <label className="text-2xs font-medium text-fg-muted">
          Destination channel
          <Select
            className="mt-1"
            value={channelId ?? ""}
            disabled={!canManage || saving || channelsLoading || !connectionId}
            onChange={(event) => {
              const selected = channels.find((channel) => channel.id === event.target.value);
              setChannelId(selected?.id ?? null);
              setChannelName(selected?.name ?? null);
            }}
          >
            <option value="">
              {channelsLoading ? "Loading eligible channels…" : "Choose a bot-member channel"}
            </option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.isPrivate ? "Private · " : "#"}
                {channel.name ?? channel.id}
              </option>
            ))}
          </Select>
          <span className="mt-1 block font-normal text-fg-subtle">
            Archived and shared Slack Connect conversations are excluded. OpenGeni never auto-joins.
          </span>
        </label>
      </div>

      <div className="mt-3 overflow-x-auto rounded-md border border-border bg-bg">
        <table className="w-full text-left text-2xs">
          <thead className="border-b border-border text-fg-subtle">
            <tr>
              <th className="p-2 font-medium">Importance</th>
              <th className="p-2 font-medium">Behavior</th>
              <th className="p-2 font-medium">Example</th>
            </tr>
          </thead>
          <tbody>
            {IMPORTANCES.map((importance) => (
              <tr key={importance} className="border-b border-border/60 last:border-0">
                <td className="p-2 font-semibold capitalize text-fg">{importance}</td>
                <td className="p-2">
                  <Select
                    aria-label={`${importance} publication behavior`}
                    value={policy[importance]}
                    disabled={!canManage || saving}
                    onChange={(event) =>
                      setPolicy({
                        ...policy,
                        [importance]: event.target.value as DraftPolicy[MemorySlackImportance],
                      })
                    }
                  >
                    <option value="auto">Publish automatically</option>
                    <option value="review">Require review</option>
                    <option value="never">Do not publish</option>
                  </Select>
                </td>
                <td className="p-2 text-fg-muted">{importanceExample(importance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-2xs text-fg-subtle">
          Configuration revisions are immutable; queued work is cancelled if its exact destination
          revision changes.
        </p>
        {canManage ? (
          <Button type="button" size="sm" disabled={saving || loading} onClick={() => void save()}>
            {saving ? <Loader2Icon className="animate-spin" /> : null}Save publication settings
          </Button>
        ) : (
          <p className="text-2xs text-fg-subtle">
            Workspace administrator permission is required to change this setting.
          </p>
        )}
      </div>

      <div className="mt-4 border-t border-border/70 pt-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-fg">Recent delivery history</p>
          <p className="text-2xs text-fg-subtle">Attempts and receipts are durable</p>
        </div>
        {loading ? (
          <p className="mt-3 flex items-center gap-2 text-2xs text-fg-subtle">
            <Loader2Icon className="size-3 animate-spin" /> Loading delivery history…
          </p>
        ) : publications.length === 0 ? (
          <p className="mt-3 text-2xs text-fg-subtle">
            No Slack publication attempts have been recorded yet.
          </p>
        ) : (
          <div className="mt-2 grid gap-2">
            {publications.slice(0, 12).map((publication) => (
              <PublicationRow
                key={publication.id}
                publication={publication}
                canManage={canManage}
                acting={actingId === publication.id}
                onAct={act}
              />
            ))}
          </div>
        )}
      </div>
    </div>
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
  const latestReceipt = publication.receipts.at(-1);
  return (
    <div className="rounded-md border border-border bg-bg p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {stateIcon(publication.state)}
            <p className="text-xs font-semibold text-fg">{publication.sourceLabel}</p>
            <span className="rounded bg-bg-muted px-1.5 py-0.5 text-2xs capitalize text-fg-muted">
              {publication.importance}
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-2xs leading-5 text-fg-muted">{publication.summary}</p>
          <p className="mt-1 text-2xs text-fg-subtle">
            {stateLabel(publication.state)} · {publication.attemptCount} delivery attempt
            {publication.attemptCount === 1 ? "" : "s"} · {formatDate(publication.updatedAt)}
            {publication.lastErrorCode ? ` · ${publication.lastErrorCode}` : ""}
          </p>
          {latestReceipt ? (
            <p className="mt-1 font-mono text-[10px] text-fg-subtle">
              receipt {latestReceipt.sequence}: {latestReceipt.kind}
            </p>
          ) : null}
        </div>
        {canManage ? (
          <div className="flex shrink-0 gap-2">
            {publication.state === "review_pending" ? (
              <>
                <Button
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
      </div>
    </div>
  );
}

function policyForImportance(
  configuration: MemorySlackPublicationConfiguration | null,
  importance: MemorySlackImportance,
): "auto" | "review" | "never" {
  if (configuration?.autoImportances.includes(importance)) return "auto";
  if (configuration?.reviewImportances.includes(importance)) return "review";
  return importance === "major" ? "auto" : importance === "normal" ? "review" : "never";
}

function importanceExample(importance: MemorySlackImportance) {
  if (importance === "major") return "A durable decision, rollback, or high-impact policy change";
  if (importance === "normal")
    return "A useful operational learning that benefits from human review";
  return "Low-signal maintenance context that should normally stay in the authoritative record";
}

function stateIcon(state: MemorySlackPublicationState) {
  if (state === "delivered") return <CheckCircle2Icon className="size-4 shrink-0 text-success" />;
  if (state === "failed" || state === "cancelled" || state === "rejected")
    return <AlertTriangleIcon className="size-4 shrink-0 text-warning" />;
  return <Clock3Icon className="size-4 shrink-0 text-fg-subtle" />;
}

function stateLabel(state: MemorySlackPublicationState) {
  return state.replaceAll("_", " ");
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
