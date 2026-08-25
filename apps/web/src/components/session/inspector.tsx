import {
  SessionStatus as SessionStatusBadge,
  type SessionEventsConnectionState,
} from "@opengeni/react";
import { useRigs, useVariableSets } from "@opengeni/react";
import { MACHINES_SESSION_POLL_MS, useMachines } from "@opengeni/react/machines";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  FileJsonIcon,
  Loader2Icon,
  RotateCcwIcon,
  SaveIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { ConnectionPill, CopyableMono, InfoRow, InspectorSection } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select } from "@/components/ui/select";
import { useAppContext } from "@/context";
import { eventDisplayLabel, isTerminalSessionStatus } from "@/lib/events";
import { formatTimestamp } from "@/lib/format";
import { withOccurrenceKeys } from "@/lib/react-key";
import { repositoryDisplayName } from "@/lib/session-tools";
import type { Session, SessionEvent } from "@/types";

export function SessionInspector(props: {
  session: Session;
  events: SessionEvent[];
  connectionState: SessionEventsConnectionState;
  onReloadSession: () => Promise<void>;
}) {
  const context = useAppContext();
  const navigate = useNavigate();
  const variableSets = useVariableSets({ workspaceId: props.session.workspaceId });
  const rigs = useRigs({ workspaceId: props.session.workspaceId });
  const sessionVariableSetIds = useMemo(
    () =>
      props.session.variableSetIds ??
      (props.session.variableSetId ? [props.session.variableSetId] : []),
    [props.session.variableSetId, props.session.variableSetIds],
  );
  const [selectedVariableSetIds, setSelectedVariableSetIds] = useState(sessionVariableSetIds);
  const [selectedRigId, setSelectedRigId] = useState(props.session.rigId ?? "");
  const [savingVariableSets, setSavingVariableSets] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [runtimeFailure, setRuntimeFailure] = useState<string | null>(null);
  useEffect(() => {
    setSelectedVariableSetIds(sessionVariableSetIds);
    setSelectedRigId(props.session.rigId ?? "");
  }, [props.session.id, props.session.rigId, sessionVariableSetIds]);
  const selectedChanged =
    selectedVariableSetIds.join("\u0000") !== sessionVariableSetIds.join("\u0000");
  const availableVariableSets = variableSets.variableSets.filter(
    (variableSet) => !selectedVariableSetIds.includes(variableSet.id),
  );
  const saveVariableSets = async () => {
    setSavingVariableSets(true);
    setRuntimeFailure(null);
    try {
      await context.client.updateSessionVariableSets(props.session.workspaceId, props.session.id, {
        variableSetIds: selectedVariableSetIds,
      });
      await props.onReloadSession();
      toast.success("Variable Sets updated", {
        description: "The new ordered selection applies to the next turn after sandbox rotation.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeFailure(message);
      toast.error("Variable Sets were not updated", { description: message });
    } finally {
      setSavingVariableSets(false);
    }
  };
  const restartWithSetup = async () => {
    if (!props.session.tenancy) return;
    setRestarting(true);
    setRuntimeFailure(null);
    try {
      const result = await context.client.forkSession(props.session.workspaceId, props.session.id, {
        idempotencyKey: crypto.randomUUID(),
        visibility: props.session.tenancy.visibility,
        workspaceSharedAcknowledged: false,
        rigId: selectedRigId || null,
        variableSetIds: selectedVariableSetIds,
      });
      toast.success("Restarted with new setup", {
        description: "The original session and sandbox were left unchanged.",
      });
      void navigate({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId: result.workspaceId, sessionId: result.sessionId },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRuntimeFailure(message);
      toast.error("Session could not be restarted", { description: message });
    } finally {
      setRestarting(false);
    }
  };
  const terminalSession = isTerminalSessionStatus(props.session.status);
  // The session's ACTIVE compute, not its home backend: when a connected machine
  // is active (live-swapped or targeted at create) show the machine name, so the
  // inspector agrees with the "Run on" header instead of reading "modal" while a
  // selfhosted box runs the turn. Degrades to the home backend when no machine is
  // active (or selfhosted is disabled → the fleet 404s to empty).
  const fleet = useMachines({
    sessionId: props.session.id,
    pollIntervalMs: MACHINES_SESSION_POLL_MS,
  });
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
  const displayEvents = props.events;
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
            <div className="truncate text-xs text-fg-subtle">{props.events.length} events</div>
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
                <InfoRow label="Effort" value={props.session.reasoningEffort} />
                <InfoRow label={computeLabel} value={computeValue} />
                <InfoRow label="Rig" value={props.session.rigId ?? "none"} />
                <div className="space-y-2 rounded-md border border-border bg-bg/35 p-2">
                  <div className="text-xs font-medium">Variable Sets</div>
                  {selectedVariableSetIds.length === 0 ? (
                    <p className="text-2xs text-fg-subtle">No explicit Variable Sets attached.</p>
                  ) : (
                    <div className="space-y-1">
                      {selectedVariableSetIds.map((variableSetId, index) => {
                        const variableSet = variableSets.variableSets.find(
                          (candidate) => candidate.id === variableSetId,
                        );
                        return (
                          <div
                            key={variableSetId}
                            className="flex min-w-0 items-center gap-1 rounded border border-border px-1.5 py-1"
                          >
                            <span className="w-4 text-center font-mono text-2xs text-fg-subtle">
                              {index + 1}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-xs">
                              {variableSet?.name ?? variableSetId}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Move Variable Set earlier"
                              disabled={index === 0 || savingVariableSets || restarting}
                              onClick={() => {
                                const next = [...selectedVariableSetIds];
                                [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                                setSelectedVariableSetIds(next);
                              }}
                            >
                              <ChevronUpIcon />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Move Variable Set later"
                              disabled={
                                index === selectedVariableSetIds.length - 1 ||
                                savingVariableSets ||
                                restarting
                              }
                              onClick={() => {
                                const next = [...selectedVariableSetIds];
                                [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                                setSelectedVariableSetIds(next);
                              }}
                            >
                              <ChevronDownIcon />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              aria-label="Detach Variable Set"
                              disabled={savingVariableSets || restarting}
                              onClick={() =>
                                setSelectedVariableSetIds((current) =>
                                  current.filter((id) => id !== variableSetId),
                                )
                              }
                            >
                              <XIcon />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {availableVariableSets.length > 0 && selectedVariableSetIds.length < 25 ? (
                    <Select
                      value=""
                      disabled={savingVariableSets || restarting}
                      onChange={(event) => {
                        if (!event.target.value) return;
                        setSelectedVariableSetIds((current) => [...current, event.target.value]);
                      }}
                      className="h-8 w-full text-xs"
                    >
                      <option value="">Attach Variable Set…</option>
                      {availableVariableSets.map((variableSet) => (
                        <option key={variableSet.id} value={variableSet.id}>
                          {variableSet.name} ({variableSet.variables.length} vars)
                        </option>
                      ))}
                    </Select>
                  ) : null}
                  <p className="text-2xs text-fg-subtle">
                    Later sets override earlier sets. Changes are allowed only between turns and
                    rotate the managed sandbox before reuse.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={!selectedChanged || savingVariableSets || restarting}
                    onClick={() => void saveVariableSets()}
                  >
                    {savingVariableSets ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
                    Save Variable Sets
                  </Button>
                </div>
                {props.session.tenancy ? (
                  <div className="space-y-2 rounded-md border border-border bg-bg/35 p-2">
                    <div className="text-xs font-medium">Restart with rig</div>
                    <Select
                      value={selectedRigId}
                      disabled={savingVariableSets || restarting}
                      onChange={(event) => setSelectedRigId(event.target.value)}
                      className="h-8 w-full text-xs"
                    >
                      <option value="">No rig</option>
                      {rigs.rigs.map((rig) => (
                        <option key={rig.id} value={rig.id}>
                          {rig.name}
                          {rig.activeVersion ? ` (v${rig.activeVersion.version})` : ""}
                        </option>
                      ))}
                    </Select>
                    <p className="text-2xs text-fg-subtle">
                      Rig setup is immutable for a live sandbox. Restart creates an independent
                      history fork with a fresh sandbox and leaves this session unchanged.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={savingVariableSets || restarting}
                      onClick={() => void restartWithSetup()}
                    >
                      {restarting ? <Loader2Icon className="animate-spin" /> : <RotateCcwIcon />}
                      Restart with setup
                    </Button>
                  </div>
                ) : null}
                {runtimeFailure ? (
                  <p className="text-2xs text-status-waiting">{runtimeFailure}</p>
                ) : null}
                <InfoRow label="Stream" value={props.connectionState} />
              </InspectorSection>

              <InspectorSection title="Repositories">
                {repositories.length === 0 ? (
                  <p className="text-xs text-fg-subtle">
                    No repositories selected for this session.
                  </p>
                ) : (
                  <div className="min-w-0 space-y-2">
                    {withOccurrenceKeys(repositories, (resource) => JSON.stringify(resource)).map(
                      ({ key, item: resource }) => (
                        <div
                          key={key}
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
                      ),
                    )}
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
