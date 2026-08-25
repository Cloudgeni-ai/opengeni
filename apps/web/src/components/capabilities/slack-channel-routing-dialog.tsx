import type { SlackChannelRoute, SlackReactionChannel } from "@opengeni/sdk";
import { Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { hasWorkspacePermission } from "@/lib/permissions";

/** The null option: the channel asks the person once and remembers the answer. */
const ASK_ONCE = "";

/**
 * Which OpenGeni workspace each Slack channel starts work in.
 *
 * Opened from the Slack sheet. A channel with no choice is not broken: it asks
 * the first person who uses it and remembers what they pick, so the only reason
 * to come here is to decide up front or to change an answer.
 */
export function SlackChannelRoutingDialog({
  workspaceId,
  connectionId,
  open,
  canManage,
  onOpenChange,
  onSaved,
}: {
  workspaceId: string;
  connectionId: string | null;
  open: boolean;
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && connectionId ? (
        <SlackChannelRoutingDialogBody
          workspaceId={workspaceId}
          connectionId={connectionId}
          canManage={canManage}
          onClose={() => onOpenChange(false)}
          onSaved={onSaved}
        />
      ) : null}
    </Dialog>
  );
}

function SlackChannelRoutingDialogBody({
  workspaceId,
  connectionId,
  canManage,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  connectionId: string;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const context = useAppContext();
  const [channels, setChannels] = useState<SlackReactionChannel[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Save must never run on a draft built from a failed load, and it sends only
  // what changed, so it needs the loaded set to compare against.
  const [loadedRoutes, setLoadedRoutes] = useState<Record<string, SlackChannelRoute> | null>(null);

  // Only workspaces this admin could start work in themselves. The API refuses
  // anything else, so offering it here would be a promise it cannot keep.
  // Only workspaces in this installation's own organization, and only ones this
  // admin could start work in themselves. The API refuses anything else, so
  // offering it here would be a promise it cannot keep.
  // A personal workspace is excluded even though this admin can start work in
  // it: a channel routed there would put every message in that channel
  // somewhere nobody else in it can see. The API refuses it with a 422, and the
  // routing resolver does not treat one as a candidate in a channel either.
  const account = context.workspaces.find((candidate) => candidate.id === workspaceId)?.accountId;
  const choices = context.workspaces.filter(
    (candidate) =>
      candidate.accountId === account &&
      hasWorkspacePermission(context.accessContext, candidate.id, "sessions:create") &&
      !isPersonalWorkspace(candidate, context.managedSelfContext),
  );

  /**
   * A stored route already pointing at this admin's own personal workspace.
   *
   * Excluding personal workspaces from `choices` would otherwise make such a
   * route unreachable, which renders it as "set by someone else" - false, since
   * only this admin could have set it - and removes the control needed to
   * change it. It stays selectable so it can be cleared, which is the whole
   * point of surfacing it.
   */
  function personalRouteTarget(channelId: string) {
    const stored = loadedRoutes?.[channelId];
    if (!stored?.targetWorkspaceId) return null;
    if (choices.some((candidate) => candidate.id === stored.targetWorkspaceId)) return null;
    const workspace = context.workspaces.find(
      (candidate) => candidate.id === stored.targetWorkspaceId,
    );
    if (!workspace || !isPersonalWorkspace(workspace, context.managedSelfContext)) return null;
    return workspace;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const collected: SlackReactionChannel[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page += 1) {
          const result = await context.client.listOpenGeniSlackReactionChannels(
            workspaceId,
            connectionId,
            cursor,
          );
          collected.push(...result.channels);
          cursor = result.nextCursor ?? undefined;
          if (!cursor) break;
        }
        const routes = await context.client.listOpenGeniSlackChannelRoutes(
          workspaceId,
          connectionId,
        );
        if (cancelled) return;
        setChannels([...new Map(collected.map((channel) => [channel.id, channel])).values()]);
        const byChannel = Object.fromEntries(
          routes.routes.map((route: SlackChannelRoute) => [route.slackChannelId, route]),
        );
        setLoadedRoutes(byChannel);
        setDraft(
          Object.fromEntries(
            Object.entries(byChannel).map(([channelId, route]) => [
              channelId,
              route.targetWorkspaceId,
            ]),
          ),
        );
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
          setLoadedRoutes(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, context.client, workspaceId]);

  /**
   * Only what the admin actually changed.
   *
   * Resending every channel would rewrite the provenance of routes nobody
   * touched, turning somebody else's picker answer into an admin decision, and
   * would make the payload grow with the installation rather than with the
   * edit. A route pointing somewhere this admin cannot reach is deliberately
   * never in here.
   */
  function changedRoutes() {
    return channels
      .filter((channel) => reachable(channel.id))
      .map((channel) => ({
        slackChannelId: channel.id,
        targetWorkspaceId: draft[channel.id] ? draft[channel.id]! : null,
      }))
      .filter((entry) => {
        const stored = loadedRoutes?.[entry.slackChannelId]?.targetWorkspaceId ?? null;
        return stored !== entry.targetWorkspaceId;
      });
  }

  /** False when a route points at a workspace this admin cannot choose. */
  function reachable(channelId: string) {
    const stored = loadedRoutes?.[channelId];
    if (!stored) return true;
    if (personalRouteTarget(channelId)) return true;
    return choices.some((candidate) => candidate.id === stored.targetWorkspaceId);
  }

  async function save() {
    const routes = changedRoutes();
    if (routes.length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await context.client.updateOpenGeniSlackChannelRoutes(workspaceId, {
        connectionId,
        routes,
      });
      toast.success("Slack channel routing saved");
      onSaved();
      onClose();
    } catch (caught) {
      toast.error("Couldn't save Slack channel routing", {
        description: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>Where Slack channels start work</DialogTitle>
        <DialogDescription>
          Pick the OpenGeni workspace each channel uses. A channel with no choice asks the person
          once and remembers the answer. Direct messages always use each person's own workspace.
        </DialogDescription>
      </DialogHeader>

      <div className="rounded-md border border-border bg-bg p-3">
        {loading ? (
          <p className="flex items-center gap-2 text-2xs text-fg-subtle">
            <Loader2Icon className="size-3 animate-spin" /> Loading conversations OpenGeni has
            joined
          </p>
        ) : error ? (
          <p className="text-2xs text-danger">{error}</p>
        ) : channels.length === 0 ? (
          <p className="text-2xs text-fg-subtle">
            OpenGeni has not been invited anywhere yet. Tag @OpenGeni in Slack, then return here.
          </p>
        ) : (
          <div className="grid max-h-72 gap-2 overflow-y-auto">
            {channels.map((channel) => (
              <label
                key={channel.id}
                className="grid grid-cols-[1fr_auto] items-center gap-2 text-xs text-fg-muted"
              >
                <span className="truncate">
                  {channel.isPrivate ? "Private · " : "#"}
                  {channel.name ?? channel.id}
                </span>
                {reachable(channel.id) ? (
                  <Select
                    value={draft[channel.id] ?? ASK_ONCE}
                    disabled={!canManage || saving}
                    onChange={(event) => setDraft({ ...draft, [channel.id]: event.target.value })}
                  >
                    <option value={ASK_ONCE}>Ask me</option>
                    {choices.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                    {(() => {
                      // Only ever the current value of a route set before a
                      // channel could no longer point at a personal workspace.
                      // Listed so the control shows what it is set to, and
                      // named so it is obvious why it should change.
                      const personal = personalRouteTarget(channel.id);
                      return personal ? (
                        <option value={personal.id}>{personal.name} · only you can see this</option>
                      ) : null;
                    })()}
                  </Select>
                ) : (
                  // Somebody with access this admin does not have pointed this
                  // channel somewhere. Say so rather than rendering a blank
                  // control that cannot be saved.
                  <span className="text-2xs text-fg-subtle">
                    {loadedRoutes?.[channel.id]?.targetWorkspaceName ?? "another workspace"} · set
                    by someone else
                  </span>
                )}
              </label>
            ))}
          </div>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={!canManage || saving || loading || loadedRoutes === null}
          onClick={() => void save()}
        >
          {saving ? <Loader2Icon className="animate-spin" /> : null}
          Save
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
