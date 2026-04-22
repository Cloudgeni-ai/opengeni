import { format, formatDistanceToNow } from "date-fns";
import { CheckIcon, ChevronDownIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentRun, EventType, RunEvent, RunProgress } from "@/lib/types";
import { cn } from "@/lib/utils";

const EVENT_LABEL: Record<EventType, string> = {
  "run.created": "Created",
  "run.dispatched": "Dispatched",
  "run.started": "Turn started",
  "run.waiting": "Waiting",
  "run.follow_up_requested": "Follow-up requested",
  "run.follow_up": "Follow-up accepted",
  "run.cancel_requested": "Cancel requested",
  "run.completed": "Turn completed",
  "run.failed": "Failed",
  "run.cancelled": "Cancelled",
  "artifact.created": "Artifact created",
};

export interface InspectorProps {
  run: AgentRun;
  events: RunEvent[];
  progress: RunProgress | null;
  connectionState: "connecting" | "live" | "closed" | "error";
}

export function Inspector({
  run,
  events,
  progress,
  connectionState,
}: InspectorProps) {
  return (
    <div className="flex h-full flex-col">
      <Tabs
        defaultValue="overview"
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="px-4 pt-3">
          <TabsList className="w-full justify-start bg-transparent p-0">
            {["overview", "events", "timeline", "raw"].map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                className="capitalize text-xs data-[state=active]:bg-[color:var(--color-surface-2)]"
              >
                {value}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <Separator className="bg-[color:var(--color-border)]" />
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-hidden">
          <OverviewPane
            run={run}
            progress={progress}
            connectionState={connectionState}
          />
        </TabsContent>
        <TabsContent value="events" className="min-h-0 flex-1 overflow-hidden">
          <EventsPane events={events} />
        </TabsContent>
        <TabsContent value="timeline" className="min-h-0 flex-1 overflow-hidden">
          <TimelinePane events={events} />
        </TabsContent>
        <TabsContent value="raw" className="min-h-0 flex-1 overflow-hidden">
          <RawPane run={run} events={events} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ConnectionPill({
  state,
}: {
  state: InspectorProps["connectionState"];
}) {
  const labels: Record<InspectorProps["connectionState"], string> = {
    connecting: "Connecting",
    live: "Live",
    closed: "Closed",
    error: "Disconnected",
  };
  const tones: Record<InspectorProps["connectionState"], string> = {
    connecting: "bg-[color:var(--color-status-waiting)]",
    live: "bg-[color:var(--color-status-success)]",
    closed: "bg-[color:var(--color-fg-subtle)]",
    error: "bg-[color:var(--color-status-failed)]",
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--color-fg-muted)]">
      <span className={cn("inline-block size-1.5 rounded-full", tones[state])} />
      {labels[state]}
    </span>
  );
}

function OverviewPane({
  run,
  progress,
  connectionState,
}: {
  run: AgentRun;
  progress: RunProgress | null;
  connectionState: InspectorProps["connectionState"];
}) {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 px-4 py-4 text-sm">
        <InfoRow label="Status" value={<code className="font-mono text-xs">{run.status}</code>} />
        <InfoRow
          label="Run ID"
          value={<CopyableMono text={run.id} />}
        />
        <InfoRow
          label="Workflow ID"
          value={
            run.temporal_workflow_id ? (
              <CopyableMono text={run.temporal_workflow_id} />
            ) : (
              <span className="text-[color:var(--color-fg-subtle)]">—</span>
            )
          }
        />
        <InfoRow
          label="Created"
          value={
            <span>
              {format(new Date(run.created_at), "PP p")}
              <span className="ml-1 text-[color:var(--color-fg-subtle)]">
                ({formatDistanceToNow(new Date(run.created_at), { addSuffix: true })})
              </span>
            </span>
          }
        />
        <InfoRow
          label="Updated"
          value={
            <span>
              {format(new Date(run.updated_at), "PP p")}
              <span className="ml-1 text-[color:var(--color-fg-subtle)]">
                ({formatDistanceToNow(new Date(run.updated_at), { addSuffix: true })})
              </span>
            </span>
          }
        />
        <InfoRow label="Stream" value={<ConnectionPill state={connectionState} />} />
        <Separator className="bg-[color:var(--color-border)]" />
        <div className="space-y-2">
          <div className="text-[11px] font-medium uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
            Workflow progress
          </div>
          {progress ? (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <dt className="text-[color:var(--color-fg-subtle)]">State</dt>
              <dd className="font-mono text-xs">{progress.state}</dd>
              <dt className="text-[color:var(--color-fg-subtle)]">Turn</dt>
              <dd className="font-mono text-xs">{progress.turn}</dd>
              <dt className="text-[color:var(--color-fg-subtle)]">Queue depth</dt>
              <dd className="font-mono text-xs">{progress.queue_depth}</dd>
              <dt className="text-[color:var(--color-fg-subtle)]">Waiting for follow-up</dt>
              <dd className="font-mono text-xs">{progress.waiting_for_follow_up ? "yes" : "no"}</dd>
              <dt className="text-[color:var(--color-fg-subtle)]">Cancel requested</dt>
              <dd className="font-mono text-xs">{progress.cancellation_requested ? "yes" : "no"}</dd>
            </dl>
          ) : (
            <p className="text-[color:var(--color-fg-subtle)]">No live progress yet.</p>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-[color:var(--color-fg-subtle)]">{label}</span>
      <span className="min-w-0 text-right text-[color:var(--color-fg)]">{value}</span>
    </div>
  );
}

function CopyableMono({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            } catch {
              toast.error("Unable to copy to clipboard");
            }
          }}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-xs",
            "text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-surface-2)] hover:text-[color:var(--color-fg)]",
          )}
        >
          <span className="truncate max-w-[180px]">{text}</span>
          {copied ? (
            <CheckIcon className="size-3 text-[color:var(--color-status-success)]" />
          ) : (
            <CopyIcon className="size-3" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
    </Tooltip>
  );
}

function EventsPane({ events }: { events: RunEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="px-4 py-8 text-sm text-[color:var(--color-fg-subtle)]">
        No events yet.
      </div>
    );
  }
  return (
    <ScrollArea className="h-full">
      <ol className="divide-y divide-[color:var(--color-border)]/70">
        {events.map((event) => (
          <EventRow key={event.id} event={event} />
        ))}
      </ol>
    </ScrollArea>
  );
}

function EventRow({ event }: { event: RunEvent }) {
  const [open, setOpen] = useState(false);
  const hasPayload = Object.keys(event.payload ?? {}).length > 0;

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <li className="px-4 py-2">
        <CollapsibleTrigger
          disabled={!hasPayload}
          className={cn(
            "group/event flex w-full items-center gap-3 rounded-md py-1 text-left text-xs",
            hasPayload && "cursor-pointer hover:bg-[color:var(--color-surface-2)]/50",
          )}
        >
          <span className="w-7 shrink-0 font-mono text-[11px] text-[color:var(--color-fg-subtle)]">
            #{event.sequence}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-[color:var(--color-fg)]">
            {EVENT_LABEL[event.type] ?? event.type}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-[color:var(--color-fg-subtle)]">
            {format(new Date(event.created_at), "HH:mm:ss")}
          </span>
          {hasPayload ? (
            <ChevronDownIcon
              className={cn(
                "size-3 shrink-0 text-[color:var(--color-fg-subtle)] transition-transform",
                open && "rotate-180",
              )}
            />
          ) : null}
        </CollapsibleTrigger>
        {hasPayload ? (
          <CollapsibleContent className="mt-1">
            <pre className="max-h-60 overflow-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/40 p-2 font-mono text-[11px] leading-relaxed text-[color:var(--color-fg-muted)]">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          </CollapsibleContent>
        ) : null}
      </li>
    </Collapsible>
  );
}

function TimelinePane({ events }: { events: RunEvent[] }) {
  const lifecycleEvents = events.filter((event) =>
    [
      "run.created",
      "run.dispatched",
      "run.started",
      "run.completed",
      "run.waiting",
      "run.follow_up_requested",
      "run.follow_up",
      "run.cancel_requested",
      "run.cancelled",
      "run.failed",
    ].includes(event.type),
  );

  if (lifecycleEvents.length === 0) {
    return (
      <div className="px-4 py-8 text-sm text-[color:var(--color-fg-subtle)]">
        No lifecycle events yet.
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <ol className="relative ml-5 border-l border-[color:var(--color-border)] py-4 pr-4">
        {lifecycleEvents.map((event) => (
          <li key={event.id} className="relative pl-5 pb-4 last:pb-1">
            <span
              className={cn(
                "absolute -left-[5px] top-[5px] size-2.5 rounded-full border-2",
                event.type === "run.failed" || event.type === "run.cancelled"
                  ? "border-[color:var(--color-status-failed)] bg-[color:var(--color-bg)]"
                  : "border-[color:var(--color-brand)] bg-[color:var(--color-bg)]",
              )}
              aria-hidden="true"
            />
            <div className="flex flex-col gap-0.5 text-xs">
              <span className="font-medium text-[color:var(--color-fg)]">
                {EVENT_LABEL[event.type] ?? event.type}
              </span>
              <span className="font-mono text-[10px] text-[color:var(--color-fg-subtle)]">
                {format(new Date(event.created_at), "PP HH:mm:ss")}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </ScrollArea>
  );
}

function RawPane({ run, events }: { run: AgentRun; events: RunEvent[] }) {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 px-4 py-4 text-xs">
        <section>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
            Run
          </div>
          <pre className="overflow-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/40 p-2 font-mono leading-relaxed text-[color:var(--color-fg-muted)]">
            {JSON.stringify(run, null, 2)}
          </pre>
        </section>
        <section>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-[color:var(--color-fg-subtle)]">
            Events ({events.length})
          </div>
          <pre className="overflow-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-surface-2)]/40 p-2 font-mono leading-relaxed text-[color:var(--color-fg-muted)]">
            {JSON.stringify(events, null, 2)}
          </pre>
        </section>
      </div>
    </ScrollArea>
  );
}
