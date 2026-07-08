import {
  SessionStatus as SessionStatusBadge,
  type SessionEventsConnectionState,
} from "@opengeni/react";
import { useMachines } from "@opengeni/react/machines";
import { CopyIcon, FileJsonIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConnectionPill, CopyableMono, InfoRow, InspectorSection } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { eventDisplayLabel, isTerminalSessionStatus, sanitizeEventForDisplay } from "@/lib/events";
import { formatTimestamp } from "@/lib/format";
import { repositoryDisplayName } from "@/lib/session-tools";
import type { Session, SessionEvent } from "@/types";

export function SessionInspector(props: {
  session: Session;
  events: SessionEvent[];
  connectionState: SessionEventsConnectionState;
}) {
  const terminalSession = isTerminalSessionStatus(props.session.status);
  // The session's ACTIVE compute, not its home backend: when a connected machine
  // is active (live-swapped or targeted at create) show the machine name, so the
  // inspector agrees with the "Run on" header instead of reading "modal" while a
  // selfhosted box runs the turn. Degrades to the home backend when no machine is
  // active (or selfhosted is disabled → the fleet 404s to empty).
  const fleet = useMachines({ sessionId: props.session.id, pollIntervalMs: 10000 });
  const activeMachine =
    fleet.machines.find((machine) => machine.active && machine.kind === "selfhosted") ?? null;
  // Compute context, honestly: don't fall back to the home backend while the
  // fleet is still resolving — that reads "modal" even when a machine runs the
  // turn. Show a loading/unavailable note until we actually know.
  const computeUnknown = fleet.machines.length === 0 && (fleet.loading || Boolean(fleet.error));
  const computeLabel = activeMachine ? "Machine" : "Sandbox";
  const computeValue = activeMachine
    ? activeMachine.name
    : computeUnknown
      ? fleet.loading
        ? "Checking…"
        : "Unavailable"
      : props.session.sandboxBackend;
  const displayEvents = props.events.map((event) =>
    sanitizeEventForDisplay(event, props.session.status),
  );
  const sortedEvents = [...displayEvents].sort((a, b) => b.sequence - a.sequence);
  const lifecycleEvents = [...displayEvents]
    .filter((event) => !event.type.endsWith(".delta"))
    .sort((a, b) => b.sequence - a.sequence);
  const repositories = props.session.resources.filter((resource) => resource.kind === "repository");

  return (
    <div className="flex h-full min-h-[28rem] w-full min-w-0 flex-col overflow-hidden">
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <FileJsonIcon className="size-4 shrink-0 text-brand" />
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {terminalSession ? "Archived debug" : "Debug"}
            </div>
            <div className="truncate text-xs text-fg-subtle">
              {props.events.length} events{terminalSession ? " · sanitized" : ""}
            </div>
          </div>
        </div>
        <ConnectionPill state={props.connectionState} />
      </div>

      <Tabs defaultValue="overview" className="min-h-0 min-w-0 flex-1 gap-0 overflow-hidden">
        <div className="min-w-0 border-b border-border px-2 py-2">
          <TabsList className="grid h-8 w-full min-w-0 grid-cols-4 rounded-md bg-bg p-1">
            <TabsTrigger value="overview" className="h-6 min-w-0 rounded px-1 text-2xs">
              Overview
            </TabsTrigger>
            <TabsTrigger value="events" className="h-6 min-w-0 rounded px-1 text-2xs">
              Events
            </TabsTrigger>
            <TabsTrigger value="timeline" className="h-6 min-w-0 rounded px-1 text-2xs">
              Timeline
            </TabsTrigger>
            <TabsTrigger value="raw" className="h-6 min-w-0 rounded px-1 text-2xs">
              Raw
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="min-h-0 min-w-0 overflow-hidden">
          <ScrollArea className="h-full min-w-0">
            <div className="min-w-0 space-y-4 p-3">
              <InspectorSection title="Session">
                <InfoRow label="ID" value={<CopyableMono value={props.session.id} />} />
                <InfoRow
                  label="Status"
                  value={<SessionStatusBadge status={props.session.status} />}
                />
                <InfoRow
                  label="Workflow"
                  value={
                    props.session.temporalWorkflowId ? (
                      <CopyableMono value={props.session.temporalWorkflowId} />
                    ) : (
                      "none"
                    )
                  }
                />
                <InfoRow
                  label="Active turn"
                  value={
                    props.session.activeTurnId ? (
                      <CopyableMono value={props.session.activeTurnId} />
                    ) : (
                      "none"
                    )
                  }
                />
                <InfoRow label="Last seq" value={String(props.session.lastSequence)} />
                <InfoRow label="Created" value={formatTimestamp(props.session.createdAt)} />
                <InfoRow label="Updated" value={formatTimestamp(props.session.updatedAt)} />
              </InspectorSection>

              <InspectorSection title="Runtime">
                <InfoRow label="Model" value={props.session.model} />
                <InfoRow
                  label="Effort"
                  value={String(props.session.metadata.reasoningEffort ?? "low")}
                />
                <InfoRow label={computeLabel} value={computeValue} />
                <InfoRow
                  label="Environment"
                  value={
                    props.session.environmentId ? (
                      <CopyableMono value={props.session.environmentId} />
                    ) : (
                      "none"
                    )
                  }
                />
                <InfoRow label="Stream" value={props.connectionState} />
              </InspectorSection>

              <InspectorSection title="Repositories">
                {repositories.length === 0 ? (
                  <p className="text-xs text-fg-subtle">
                    No repositories selected for this session.
                  </p>
                ) : (
                  <div className="min-w-0 space-y-2">
                    {repositories.map((resource, index) => (
                      <div
                        key={`${resource.uri}:${index}`}
                        className="min-w-0 rounded-md border border-border bg-bg/35 p-2"
                      >
                        <div className="min-w-0 truncate text-xs font-medium">
                          {repositoryDisplayName(resource)}
                        </div>
                        <div className="mt-1 min-w-0 truncate font-mono text-2xs text-fg-subtle">
                          {resource.uri}
                        </div>
                        <div className="mt-2 flex min-w-0 flex-wrap gap-1.5 text-2xs text-fg-subtle">
                          <span className="max-w-full truncate rounded border border-border px-1.5 py-0.5">
                            ref {resource.ref}
                          </span>
                          {resource.mountPath ? (
                            <span className="max-w-full truncate rounded border border-border px-1.5 py-0.5">
                              {resource.mountPath}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </InspectorSection>
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="events" className="min-h-0 min-w-0 overflow-hidden">
          <ScrollArea className="h-full min-w-0">
            <div className="min-w-0 space-y-2 p-3">
              {sortedEvents.map((event) => (
                <EventDebugRow key={event.id} event={event} />
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="timeline" className="min-h-0 min-w-0 overflow-hidden">
          <ScrollArea className="h-full min-w-0">
            <div className="min-w-0 space-y-2 p-3">
              {lifecycleEvents.map((event) => (
                <div key={event.id} className="rounded-md border border-border bg-bg/35 p-2">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate font-medium">{eventDisplayLabel(event)}</span>
                    <span className="shrink-0 font-mono text-2xs text-fg-subtle">
                      #{event.sequence}
                    </span>
                  </div>
                  <div className="mt-1 text-2xs text-fg-subtle">
                    {formatTimestamp(event.occurredAt)}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent value="raw" className="min-h-0 min-w-0 overflow-hidden">
          <RawJsonPane value={{ session: props.session, events: displayEvents }} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EventDebugRow({ event }: { event: SessionEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="min-w-0 overflow-hidden rounded-md border border-border bg-bg/35"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full min-w-0 items-center justify-between gap-2 p-2 text-left"
        >
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{eventDisplayLabel(event)}</div>
            <div className="mt-1 truncate font-mono text-2xs text-fg-subtle">
              {event.turnId ?? event.id}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-mono text-2xs text-fg-muted">#{event.sequence}</div>
            <div className="mt-1 text-2xs text-fg-subtle">{formatTimestamp(event.occurredAt)}</div>
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-72 max-w-full overflow-auto border-t border-border p-2 text-2xs leading-5 text-fg-muted">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RawJsonPane({ value }: { value: unknown }) {
  const json = JSON.stringify(value, null, 2);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <div className="flex items-center justify-end border-b border-border p-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            void navigator.clipboard.writeText(json);
            toast.success("Copied raw JSON");
          }}
        >
          <CopyIcon className="size-3" />
          Copy
        </Button>
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <pre className="max-w-full overflow-auto p-3 text-2xs leading-5 text-fg-muted">{json}</pre>
      </ScrollArea>
    </div>
  );
}
