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

  // Only workspaces this admin could start work in themselves. The API refuses
  // anything else, so offering it here would be a promise it cannot keep.
  const choices = context.workspaces.filter((candidate) =>
    hasWorkspacePermission(context.accessContext, candidate.id, "sessions:create"),
  );

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
        setDraft(
          Object.fromEntries(
            routes.routes.map((route: SlackChannelRoute) => [
              route.slackChannelId,
              route.targetWorkspaceId,
            ]),
          ),
        );
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId, context.client, workspaceId]);

  async function save() {
    setSaving(true);
    try {
      await context.client.updateOpenGeniSlackChannelRoutes(workspaceId, {
        connectionId,
        routes: channels.map((channel) => ({
          slackChannelId: channel.id,
          targetWorkspaceId: draft[channel.id] ? draft[channel.id]! : null,
        })),
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
                </Select>
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
          disabled={!canManage || saving || loading}
          onClick={() => void save()}
        >
          {saving ? <Loader2Icon className="animate-spin" /> : null}
          Save
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
