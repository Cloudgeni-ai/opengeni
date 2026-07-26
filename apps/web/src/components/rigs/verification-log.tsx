// The verification evidence for a rig change: the per-check outcomes (command,
// exit code, expandable output) and the raw replay log. This is the "fidelity is
// tested, not trusted" surface — it shows exactly what ran in the clean sandbox
// and how each check exited.
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { StatusDot } from "@/components/ui/status-dot";
import { formatTimestamp } from "@/lib/format";
import { withOccurrenceKeys } from "@/lib/react-key";
import { cn } from "@/lib/utils";
import type { RigChangeVerification, RigCheckResult } from "@/types";

export function VerificationLog({ verification }: { verification: RigChangeVerification }) {
  const checkResults = verification.checkResults ?? [];
  const passed = typeof verification.passed === "boolean" ? verification.passed : undefined;
  return (
    <div className="grid gap-3">
      {verification.startedAt || verification.finishedAt ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-subtle">
          {verification.startedAt ? (
            <span>Started {formatTimestamp(verification.startedAt)}</span>
          ) : null}
          {verification.finishedAt ? (
            <span>Finished {formatTimestamp(verification.finishedAt)}</span>
          ) : null}
          {passed !== undefined ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 font-medium",
                passed ? "text-status-idle" : "text-status-failed",
              )}
            >
              <StatusDot tone={passed ? "idle" : "failed"} />
              {passed ? "All checks passed" : "Checks failed"}
            </span>
          ) : null}
        </div>
      ) : null}

      {checkResults.length > 0 ? (
        <div className="grid gap-1.5">
          <div className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">Checks</div>
          {withOccurrenceKeys(
            checkResults,
            (result) =>
              `${result.name}\u0000${result.command}\u0000${result.exitCode}\u0000${result.output}`,
          ).map(({ key, item: result }) => (
            <CheckResultRow key={key} result={result} />
          ))}
        </div>
      ) : null}

      {verification.log ? (
        <div className="grid gap-1.5">
          <div className="text-2xs font-medium uppercase tracking-wide text-fg-subtle">
            Replay log
          </div>
          <pre className="max-h-72 overflow-auto rounded-md border border-border/70 bg-bg/40 p-2.5 font-mono text-2xs leading-4 text-fg-muted">
            {verification.log}
          </pre>
        </div>
      ) : null}

      {checkResults.length === 0 && !verification.log ? (
        <p className="text-xs text-fg-subtle">No verification output was captured for this run.</p>
      ) : null}
    </div>
  );
}

function CheckResultRow({ result }: { result: RigCheckResult }) {
  const [open, setOpen] = useState(false);
  const ok = result.exitCode === 0;
  const hasOutput = Boolean(result.output && result.output.length > 0);
  return (
    <div className="rounded-md border border-border/70 bg-bg/25">
      <button
        type="button"
        disabled={!hasOutput}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left",
          hasOutput ? "cursor-pointer hover:bg-surface-2/40" : "cursor-default",
        )}
      >
        <StatusDot tone={ok ? "idle" : "failed"} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {result.name || "Unnamed check"}
          </span>
          <span className="block truncate font-mono text-2xs text-fg-subtle">{result.command}</span>
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-2xs",
            ok ? "text-status-idle" : "text-status-failed",
          )}
        >
          {result.exitCode === null ? "no exit" : `exit ${result.exitCode}`}
        </span>
        {hasOutput ? (
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 text-fg-subtle transition-transform",
              open ? "rotate-180" : "",
            )}
          />
        ) : null}
      </button>
      {open && hasOutput ? (
        <pre className="max-h-56 overflow-auto border-t border-border/70 p-2.5 font-mono text-2xs leading-4 text-fg-muted">
          {result.output}
        </pre>
      ) : null}
    </div>
  );
}
