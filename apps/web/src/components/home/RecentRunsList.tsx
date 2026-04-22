import { Link } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { ChevronRightIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { StatusDot } from "@/components/run/StatusDot";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { forgetRun, loadKnownRuns, type KnownRun } from "@/lib/known-runs";
import type { AgentRunStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

type KnownRunWithStatus = KnownRun & { status?: AgentRunStatus };

export function RecentRunsList() {
  const [runs, setRuns] = useState<KnownRunWithStatus[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setRuns(loadKnownRuns());
  }, []);

  if (!mounted) {
    return (
      <div className="mt-10 flex h-20 items-center justify-center text-sm text-[color:var(--color-fg-subtle)]">
        Loading recent runs...
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="mt-10 rounded-xl border border-dashed border-[color:var(--color-border)] px-6 py-10 text-center">
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          No runs yet. Start one above to see it here.
        </p>
      </div>
    );
  }

  return (
    <ul className="mt-8 divide-y divide-[color:var(--color-border)]/70 overflow-hidden rounded-xl border border-[color:var(--color-border)] bg-[color:var(--color-surface)]">
      {runs.map((run) => (
        <li key={run.id}>
          <RunRow
            run={run}
            onForget={() => setRuns((current) => current.filter((entry) => entry.id !== run.id))}
          />
        </li>
      ))}
    </ul>
  );
}

interface RunRowProps {
  run: KnownRunWithStatus;
  onForget: () => void;
}

function RunRow({ run, onForget }: RunRowProps) {
  const status: AgentRunStatus = run.status ?? "running";
  const relative = formatDistanceToNow(new Date(run.createdAt), { addSuffix: true });

  return (
    <div className="group relative">
      <Link
        to="/runs/$runId"
        params={{ runId: run.id }}
        className={cn(
          "flex items-center gap-3 px-4 py-3 transition-colors",
          "hover:bg-[color:var(--color-surface-2)]/70",
        )}
      >
        <StatusDot status={status} className="shrink-0" />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--color-fg)]">
              {run.prompt}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-sm">{run.prompt}</TooltipContent>
        </Tooltip>
        <span
          className="hidden shrink-0 font-mono text-[11px] text-[color:var(--color-fg-subtle)] sm:inline"
          aria-label={`Run id ${run.id}`}
        >
          {run.id.slice(0, 8)}
        </span>
        <span className="shrink-0 text-xs text-[color:var(--color-fg-muted)]">
          {relative}
        </span>
        <ChevronRightIcon className="size-4 shrink-0 text-[color:var(--color-fg-subtle)] transition-colors group-hover:text-[color:var(--color-fg)]" />
      </Link>
      <div className="absolute inset-y-0 right-10 flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label="Remove from recent runs"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            forgetRun(run.id);
            onForget();
          }}
        >
          <XIcon />
        </Button>
      </div>
    </div>
  );
}
