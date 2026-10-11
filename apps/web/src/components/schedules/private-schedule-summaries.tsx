/**
 * Admins see that other people's Only me schedules exist: whose they are, how
 * often they run, when they last ran and what they cost. Never their name,
 * message or runs. An admin can pause one; only its owner can resume it.
 */
import { useCallback, useEffect, useState } from "react";
import { LockIcon, PauseIcon } from "lucide-react";
import { toast } from "sonner";

import { formatMoney } from "@/components/insights/usage-format";
import { Button } from "@/components/ui/button";
import { ListRow, RowList, type RowListColumn } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { RelativeTime } from "@/components/ui/relative-time";
import { useAppContext } from "@/context";
import type { PrivateScheduledTaskSummary } from "@/types";

import { scheduleWords } from "./schedule-model";

const COLUMNS: RowListColumn[] = [
  { id: "last", label: "Last run", width: 128 },
  // On phones the cost stays on the folded line: it is what the row is for.
  { id: "cost", label: "30-day cost", width: 112, leadsWhenFolded: true },
];

/** What the schedule's runs cost: credits when it used them, otherwise the provider estimate. */
function costMicros(summary: PrivateScheduledTaskSummary): number {
  const usd =
    summary.last30Days.creditUsd > 0
      ? summary.last30Days.creditUsd
      : summary.last30Days.estimatedProviderUsd;
  return Math.round(usd * 1_000_000);
}

function ownerLabel(summary: PrivateScheduledTaskSummary): string {
  return summary.ownerName?.trim() || "A member";
}

export function PrivateScheduleSummaries({ workspaceId, now }: { workspaceId: string; now: Date }) {
  const { client } = useAppContext();
  const [summaries, setSummaries] = useState<PrivateScheduledTaskSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { schedules } = await client.listPrivateScheduledTaskSummaries(workspaceId);
      setSummaries(schedules);
    } catch {
      // Advisory: the section stays as it was until the next successful read.
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pause = async (summary: PrivateScheduledTaskSummary) => {
    setBusyId(summary.id);
    try {
      const paused = await client.pausePrivateScheduledTask(workspaceId, summary.id);
      setSummaries((current) =>
        current ? current.map((item) => (item.id === paused.id ? paused : item)) : current,
      );
      toast.success(`Paused ${ownerLabel(summary)}'s schedule`, {
        description: "Only they can resume it.",
      });
    } catch {
      toast.error("Couldn't pause the schedule", { description: "Try again in a moment." });
    } finally {
      setBusyId(null);
    }
  };

  if (!summaries || summaries.length === 0) return null;

  return (
    <section aria-labelledby="private-schedules-heading" className="mt-10 min-w-0">
      <h2 id="private-schedules-heading" className="text-sm font-semibold text-fg">
        Other people's private schedules
      </h2>
      <p className="mt-1 max-w-prose text-xs leading-4.5 text-fg-muted">
        You can see who owns them, how often they run and what they cost, and pause them. What they
        do stays private to their owner.
      </p>
      <div className="mt-3 min-w-0">
        <RowList label="Other people's private schedules" columns={COLUMNS} flush>
          {summaries.map((summary) => {
            const paused = summary.status === "paused";
            const cost = formatMoney(costMicros(summary));
            // "Only when you run it" would be wrong here: only the owner can run it.
            const cadence =
              summary.schedule.type === "manual"
                ? "Only when its owner runs it"
                : scheduleWords(summary.schedule, now).short;
            return (
              <ListRow
                key={summary.id}
                leading={<LogoTile icon={paused ? <PauseIcon /> : <LockIcon />} />}
                title={`${ownerLabel(summary)}'s schedule`}
                // A chip, not a status badge: on a phone the badge would fold
                // into the meta line and lose its words to the cost.
                titleAddon={paused ? <MetaChip icon={<PauseIcon />}>Paused</MetaChip> : undefined}
                description={cadence}
                cells={{
                  last: summary.lastRunAt ? (
                    <RelativeTime date={summary.lastRunAt} inSentence />
                  ) : (
                    <span className="text-fg-subtle">Never run</span>
                  ),
                  cost: <span className="tabular-nums">{cost}</span>,
                }}
                control={
                  paused ? null : (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busyId === summary.id}
                      onClick={() => void pause(summary)}
                      aria-label={`Pause ${ownerLabel(summary)}'s schedule`}
                      className="h-7 rounded-[10px] px-2 pointer-coarse:h-11"
                    >
                      <PauseIcon aria-hidden="true" />
                      Pause
                    </Button>
                  )
                }
              />
            );
          })}
        </RowList>
      </div>
    </section>
  );
}
