import { Link } from "@tanstack/react-router";
import { useWorkspaceMachines } from "@/lib/use-workspace-machines";
// Machines: the workspace's bring-your-own-compute fleet — enrolled selfhosted
// machines, each with its connection-status pill, state badges, latest metrics
// (CPU/load/mem/disk/GPU), and an enroll affordance. The session-scoped attach/
// swap is exercised inside a session (the dock), where the active-sandbox pointer
// + the synthetic Modal group box are in scope. Here at the workspace level the
// fleet is the read-first overview + the zero-click enroll-token entry (with a
// manual code pairing kept as a secondary option inside the same dialog).
import {
  MachineDetail,
  MachinesDashboard,
  connectionStatusForState,
  MACHINES_DASHBOARD_POLL_MS,
  type MetricSample,
  type MetricWindow,
} from "@opengeni/react/machines";
import { copyTextToClipboard } from "@opengeni/react/clipboard";
import { usePageLiveActivity } from "@opengeni/react";
import { LaptopIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  OpenGeniApiError,
  type RemoveEnrollmentResponse,
  type SwapActiveSandboxResponse,
} from "@opengeni/sdk";

import { apiBaseUrl } from "@/api";
import { ConnectMachineDialog } from "@/components/machines/connect-machine-dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ContentPage } from "@/components/ui/content-layout";
import { TechnicalDetails } from "@/components/ui/error-message";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { useAppContext } from "@/context";
import { apiErrorTechnicalFacts, userErrorTextWithoutReference } from "@/lib/api-error";
import type { MachineView } from "@opengeni/react/machines";

/** While the connect dialog waits for the new machine, look for it sooner. */
const CONNECT_WATCH_POLL_MS = 3_000;

/** Copy to the clipboard and toast the outcome. The shared helper falls back to
 *  a temporary textarea when private HTTP origins cannot use navigator.clipboard. */
export async function copyToClipboard(text: string, successMessage: string) {
  if (await copyTextToClipboard(text)) {
    toast.success(successMessage);
    return true;
  }
  toast.error("Couldn't copy to the clipboard", { description: "Copy it manually instead." });
  return false;
}

export function MachinesRoute({ workspaceId }: { workspaceId: string }) {
  const { client, workspaces } = useAppContext();
  const [enrollOpen, setEnrollOpen] = useState(false);
  const machines = useWorkspaceMachines({
    pollIntervalMs: enrollOpen ? CONNECT_WATCH_POLL_MS : MACHINES_DASHBOARD_POLL_MS,
  });
  const pageLive = usePageLiveActivity();
  const personalWorkspace =
    workspaces.find((workspace) => workspace.id === workspaceId)?.kind === "personal";
  const [removeTarget, setRemoveTarget] = useState<MachineView | null>(null);
  const [removeBlocked, setRemoveBlocked] = useState<RemoveEnrollmentResponse | null>(null);
  const [removeMoveError, setRemoveMoveError] = useState<Error | null>(null);

  // The machine whose telemetry detail is open (by sandboxId), and its history.
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailWindow, setDetailWindow] = useState<MetricWindow>("1h");
  const [detailSeries, setDetailSeries] = useState<MetricSample[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  // Short (15m) history per machine for the card sparklines, keyed by sandboxId.
  const [cardSeries, setCardSeries] = useState<Record<string, MetricSample[]>>({});
  // A shared, slowly-ticking clock so "Live / updated Xago" stays honest without
  // re-rendering on every animation frame.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);

  const { fetchSeries } = machines;
  const selectedMachine = detailId
    ? (machines.machines.find((m) => m.sandboxId === detailId) ?? null)
    : null;
  const selectedEnrollmentId = selectedMachine?.enrollmentId ?? null;

  // Fetch the compact card sparkline history for every enrolled machine. Keyed on
  // the SET of enrollment ids (not the 5s-polled array identity) + a 30s refresh,
  // so it doesn't refetch on every liveness poll.
  const enrolledKey = machines.machines
    .filter((m) => m.enrollmentId && !m.isSessionGroup)
    .map((m) => m.enrollmentId)
    .sort()
    .join(",");
  useEffect(() => {
    const enrolled = machines.machines.filter((m) => m.enrollmentId && !m.isSessionGroup);
    if (!pageLive || enrolled.length === 0) {
      setCardSeries({});
      return;
    }
    let cancelled = false;
    const load = async () => {
      const entries = await Promise.all(
        enrolled.map(async (m) => {
          try {
            return [m.sandboxId, await fetchSeries(m.enrollmentId!, "15m")] as const;
          } catch {
            return [m.sandboxId, [] as MetricSample[]] as const;
          }
        }),
      );
      if (!cancelled) setCardSeries(Object.fromEntries(entries));
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!cancelled) timer = setTimeout(() => void load().finally(schedule), 30_000);
    };
    void load().finally(schedule);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrolledKey, fetchSeries, pageLive]);

  // Fetch the open machine's detail history: on select, on window change, and on
  // a 10s refresh while open.
  useEffect(() => {
    if (!pageLive || !selectedEnrollmentId) {
      setDetailSeries([]);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    const load = async () => {
      try {
        const samples = await fetchSeries(selectedEnrollmentId, detailWindow);
        if (!cancelled) setDetailSeries(samples);
      } catch {
        if (!cancelled) setDetailSeries([]);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!cancelled) timer = setTimeout(() => void load().finally(schedule), 10_000);
    };
    void load().finally(schedule);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [selectedEnrollmentId, detailWindow, fetchSeries, pageLive]);

  // "Machine connected" moment: watch the polled fleet and, once a machine first
  // shows online (a fresh enrollment coming up, or a reconnect), toast it. The
  // first loaded list seeds the baseline silently so existing machines don't
  // announce; the empty placeholder before that load is not a baseline.
  const onlineSeenRef = useRef<Set<string> | null>(null);
  const enrollOpenRef = useRef(enrollOpen);
  enrollOpenRef.current = enrollOpen;
  useEffect(() => {
    if (onlineSeenRef.current === null && (machines.loading || machines.error)) return;
    const online = new Set(
      machines.machines
        .filter(
          (machine) =>
            !machine.isSessionGroup && connectionStatusForState(machine.state) === "online",
        )
        .map((machine) => machine.sandboxId),
    );
    const previous = onlineSeenRef.current;
    if (previous) {
      for (const machine of machines.machines) {
        if (
          !machine.isSessionGroup &&
          connectionStatusForState(machine.state) === "online" &&
          !previous.has(machine.sandboxId) &&
          // The connect dialog shows its own success for the machine it connected.
          !enrollOpenRef.current
        ) {
          toast.success(`${machine.name} connected`, {
            description: "It's ready to run sessions.",
          });
        }
      }
    }
    onlineSeenRef.current = online;
  }, [machines.error, machines.loading, machines.machines]);

  // The install/approve URLs are deployment-relative: same origin as the API
  // (falling back to the page origin), never a hardcoded marketing domain.
  const origin = apiBaseUrl || (typeof window !== "undefined" ? window.location.origin : "");

  // A 404 from the machines API means the deployment doesn't enable connected
  // machines at all. That's a configuration fact, not a failure — render a calm
  // explanation instead of a red load error with a pointless retry (mirrors the
  // composer's handling in sessions-index).
  const featureUnavailable =
    machines.error instanceof OpenGeniApiError && machines.error.status === 404;

  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<LaptopIcon className="size-4" />}
        title="Machines"
        description="Your own computers, connected as agent sandboxes. One agent can serve this workspace alongside any other Opengeni workspaces or deployments already connected to the machine."
      />

      <div className="pt-6">
        {!machines.canRead ? (
          <Notice tone="muted" title="Machines are managed by your workspace admin">
            You do not have permission to view connected machines in this workspace. Ask a workspace
            admin for access.
          </Notice>
        ) : featureUnavailable ? (
          <Notice tone="muted">
            Connected machines aren't enabled on this deployment. Sessions run on the managed
            sandbox.
          </Notice>
        ) : selectedMachine ? (
          <MachineDetail
            machine={selectedMachine}
            series={detailSeries}
            window={detailWindow}
            onWindowChange={setDetailWindow}
            loadingSeries={detailLoading}
            onBack={() => setDetailId(null)}
            {...(machines.canRemove
              ? {
                  onRemove: (machine: MachineView) => {
                    machines.clearMutationError();
                    setRemoveBlocked(null);
                    setRemoveMoveError(null);
                    setRemoveTarget(machine);
                  },
                }
              : {})}
            {...(machines.canUpdateOperationPolicy
              ? {
                  onUpdateOperationPolicy: async (machine, request) => {
                    if (!machine.enrollmentId) return;
                    const updated = await machines.updateOperationPolicy(
                      machine.enrollmentId,
                      request,
                    );
                    if (updated) {
                      toast.success(`Updated command policy for ${machine.name}`);
                    }
                  },
                  updatingOperationPolicy:
                    machines.updatingOperationPolicyEnrollmentId === selectedMachine.enrollmentId,
                }
              : {})}
            now={now}
          />
        ) : (
          <MachinesDashboard
            machines={machines.machines}
            activeSandboxId={machines.activeSandboxId}
            loading={machines.loading}
            error={machines.error}
            seriesByMachine={cardSeries}
            onOpenDetail={(m) => setDetailId(m.sandboxId)}
            now={now}
            onRefresh={() => void machines.refresh()}
            onEnroll={machines.canManage ? () => setEnrollOpen(true) : undefined}
            {...(machines.canUpdateAgent
              ? {
                  onUpdateAgent: (machine: MachineView) => {
                    if (!machine.enrollmentId) return;
                    void machines.updateAgent(machine.enrollmentId).then((result) => {
                      if (result?.accepted) {
                        toast.success(`Update requested for ${machine.name}`, {
                          description: `Installing v${result.targetVersion} requires an idle machine. If it is busy, retry after its work finishes.`,
                        });
                      }
                    });
                  },
                  updatingEnrollmentId: machines.updatingEnrollmentId,
                }
              : {})}
            {...(machines.canAttach
              ? {
                  onAttach: (m) => void machines.attach(m.sandboxId),
                  attachingSandboxId: machines.attachingSandboxId,
                }
              : {})}
          />
        )}
      </div>

      {machines.mutationError && !removeTarget ? (
        <Notice tone="failed" title="Machine action failed">
          <FailureText error={machines.mutationError} />
        </Notice>
      ) : null}

      {machines.canManage ? (
        <ConnectMachineDialog
          open={enrollOpen}
          onOpenChange={setEnrollOpen}
          workspaceId={workspaceId}
          origin={origin}
          machines={machines.machines}
          machinesLoading={machines.loading}
          personalWorkspace={personalWorkspace}
        />
      ) : null}

      <ConfirmDialog
        open={removeTarget !== null && machines.canManage}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null);
            setRemoveBlocked(null);
            setRemoveMoveError(null);
            machines.clearMutationError();
          }
        }}
        title={removeTarget ? `Remove machine “${removeTarget.name}”?` : "Remove machine?"}
        description="Access will be revoked immediately while the machine is offline. Its session, route, lease, archive, and audit history will be kept; reconnecting later requires a fresh human-approved enrollment."
        confirmLabel={
          removeBlocked?.code === "active_route"
            ? machines.canControl
              ? "Move sessions and remove machine"
              : "Close"
            : "Remove machine"
        }
        onConfirm={async () => {
          const target = removeTarget;
          if (!target?.enrollmentId || !machines.canManage) return false;
          if (removeBlocked?.code === "active_route" && !machines.canControl) return true;
          const sessionsToMove =
            removeBlocked?.code === "active_route" ? removeBlocked.dependentSessions : [];
          if (sessionsToMove.length > 0) {
            try {
              setRemoveMoveError(null);
              await moveDependentSessionsToDefault(client, workspaceId, sessionsToMove);
            } catch (error) {
              setRemoveMoveError(
                error instanceof Error ? error : new Error("A session could not be moved."),
              );
              return false;
            }
          }
          const result = await machines.remove(target.enrollmentId);
          if (!result) {
            return false;
          }
          if (result.outcome === "blocked") {
            setRemoveBlocked(result);
            return false;
          }
          toast.success(
            result.outcome === "already_removed"
              ? `${target.name} was already removed`
              : `${target.name} removed`,
            {
              description:
                sessionsToMove.length > 0
                  ? `${sessionsToMove.length} ${sessionsToMove.length === 1 ? "session now uses its" : "sessions now use their"} verified default managed sandbox.`
                  : "It will disappear from the active machine list.",
            },
          );
          setRemoveTarget(null);
          setDetailId(null);
          setRemoveBlocked(null);
          setRemoveMoveError(null);
          return true;
        }}
      >
        {removeTarget ? (
          <div className="space-y-3">
            <div className="space-y-2 rounded-og-md border border-og-border bg-og-surface-2/40 px-3 py-2 text-og-sm text-og-fg-muted">
              <p>
                <span className="font-medium text-og-fg">Machine:</span> {removeTarget.name}
              </p>
              <p>
                <span className="font-medium text-og-fg">Last seen:</span>{" "}
                {removeTarget.lastSeenAt
                  ? new Date(removeTarget.lastSeenAt).toLocaleString()
                  : "Never connected"}
              </p>
            </div>
            {removeBlocked?.code === "active_route" && !machines.canControl ? (
              <Notice tone="muted">
                Ask a workspace admin to move the active sessions before removing this machine.
              </Notice>
            ) : null}
            {removeMoveError ? (
              <Notice tone="failed" title="Couldn't move every session">
                <FailureText error={removeMoveError} />
              </Notice>
            ) : null}
            {removeBlocked ? (
              <MachineRemovalBlockNotice workspaceId={workspaceId} result={removeBlocked} />
            ) : machines.mutationError ? (
              <Notice tone="failed" title="Removal failed">
                <FailureText error={machines.mutationError} />
              </Notice>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </ContentPage>
  );
}

/** What to do next, with an API error's status and reference behind Technical details. */
function FailureText({ error }: { error: unknown }) {
  const facts = apiErrorTechnicalFacts(error);
  return (
    <>
      {userErrorTextWithoutReference(error)}
      {facts.length > 0 ? (
        <div className="mt-1">
          <TechnicalDetails facts={facts} />
        </div>
      ) : null}
    </>
  );
}

type DefaultSandboxClient = {
  swapActiveSandbox: (
    workspaceId: string,
    sessionId: string,
    request: { target: string },
  ) => Promise<SwapActiveSandboxResponse>;
};

export async function moveDependentSessionsToDefault(
  client: DefaultSandboxClient,
  workspaceId: string,
  sessions: Array<{ id: string; title: string | null }>,
): Promise<void> {
  for (const session of sessions) {
    const result = await client.swapActiveSandbox(workspaceId, session.id, {
      target: "default",
    });
    if (!result.swapped) {
      const sessionName = session.title?.trim() || session.id;
      throw new Error(
        result.reason?.trim() ||
          `Session ${sessionName} could not reach a verified default managed sandbox${result.code ? ` (${result.code})` : ""}.`,
      );
    }
  }
}

export function MachineRemovalBlockNotice({
  workspaceId,
  result,
}: {
  workspaceId: string;
  result: RemoveEnrollmentResponse;
}) {
  return (
    <Notice
      tone="waiting"
      title={result.code === "active_route" ? "Sessions still use this machine" : "Not safe yet"}
    >
      <p>{result.message}</p>
      {result.dependentSessions.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {result.dependentSessions.map((session) => (
            <li key={session.id}>
              <Link
                to="/workspaces/$workspaceId/sessions/$sessionId"
                params={{ workspaceId, sessionId: session.id }}
                className="font-medium text-fg underline decoration-border-strong underline-offset-2 hover:text-brand"
              >
                {session.title?.trim() || session.id}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-2">{result.action}</p>
    </Notice>
  );
}
