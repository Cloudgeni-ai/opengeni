import type {
  InternalApplicationBundle,
  InternalApplicationDataSource,
  InternalApplicationDeployment,
  InternalApplicationDeploymentActionResponse,
  InternalApplicationDeploymentOperation,
  InternalApplicationDeploymentTarget,
  InternalApplicationDetail,
  InternalApplicationEvent,
  InternalApplicationSummary,
} from "@opengeni/sdk";
import {
  AppWindowIcon,
  ArrowLeftIcon,
  BotIcon,
  CheckCircle2Icon,
  DatabaseIcon,
  HammerIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ServerIcon,
  ShieldCheckIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { Children, useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { EmptyState, PageHeader, ProblemPanel } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useAppContext } from "@/context";

type View = "applications" | "data" | "targets";
const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/30";

export function InternalApplicationsRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const enabled = context.clientConfig.advancedDeployments?.enabled === true;
  const [view, setView] = useState<View>("applications");
  const [applications, setApplications] = useState<InternalApplicationSummary[]>([]);
  const [dataSources, setDataSources] = useState<InternalApplicationDataSource[]>([]);
  const [targets, setTargets] = useState<InternalApplicationDeploymentTarget[]>([]);
  const [deployments, setDeployments] = useState<InternalApplicationDeployment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<InternalApplicationDetail | null>(null);
  const [bundles, setBundles] = useState<InternalApplicationBundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [targetOpen, setTargetOpen] = useState(false);
  const [bundleOpen, setBundleOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const [nextApplications, nextData, nextTargets, nextDeployments] = await Promise.all([
        context.client.listInternalApplications(workspaceId),
        context.client.listInternalApplicationDataSources(workspaceId),
        context.client.listInternalApplicationTargets(workspaceId),
        context.client.listInternalApplicationDeployments(workspaceId),
      ]);
      setApplications(nextApplications);
      setDataSources(nextData);
      setTargets(nextTargets);
      setDeployments(nextDeployments);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setLoading(false);
    }
  }, [context.client, enabled, workspaceId]);

  useEffect(() => void refresh(), [refresh]);

  useEffect(() => {
    if (!selectedId || !enabled) {
      setDetail(null);
      setBundles([]);
      return;
    }
    let disposed = false;
    void Promise.all([
      context.client.getInternalApplication(workspaceId, selectedId),
      context.client.listInternalApplicationBundles(workspaceId, selectedId),
    ])
      .then(([nextDetail, nextBundles]) => {
        if (disposed) return;
        setDetail(nextDetail);
        setBundles(nextBundles);
      })
      .catch((caught) => {
        if (!disposed)
          toast.error("Couldn't load the application", {
            description: String(caught),
          });
      });
    return () => {
      disposed = true;
    };
  }, [context.client, enabled, selectedId, workspaceId]);

  if (!enabled) {
    return (
      <ProblemPanel
        title="Page not found"
        description="Internal applications are not enabled for this deployment. An operator can enable the preview when the local data and compute targets are ready."
      />
    );
  }

  return (
    <ContentPage width="wide">
      <PageHeader
        icon={<AppWindowIcon className="size-4" />}
        title="Applications"
        description="Build internal AI apps, bind governed workspace data, preview every infrastructure change, and deploy to approved local compute."
        actions={
          <Button variant="secondary" size="sm" disabled={loading} onClick={() => void refresh()}>
            <RefreshCwIcon className={loading ? "animate-spin" : ""} /> Refresh
          </Button>
        }
      />

      <Tabs value={view} onValueChange={(value) => setView(value as View)} className="mt-5">
        <TabsList variant="line">
          <TabsTrigger value="applications">Applications</TabsTrigger>
          <TabsTrigger value="data">Data sources</TabsTrigger>
          <TabsTrigger value="targets">Compute targets</TabsTrigger>
        </TabsList>
        <TabsContent value="applications" className="pt-4">
          {selectedId && detail ? (
            <ApplicationDetailView
              workspaceId={workspaceId}
              detail={detail}
              bundles={bundles}
              targets={targets}
              deployments={deployments.filter(
                (deployment) => deployment.applicationId === selectedId,
              )}
              onBack={() => setSelectedId(null)}
              onRegisterBundle={() => setBundleOpen(true)}
              onChanged={async () => {
                await refresh();
                setDetail(await context.client.getInternalApplication(workspaceId, selectedId));
                setBundles(
                  await context.client.listInternalApplicationBundles(workspaceId, selectedId),
                );
              }}
            />
          ) : (
            <Catalog
              loading={loading}
              error={error}
              applications={applications}
              deployments={deployments}
              onCreate={() => setCreateOpen(true)}
              onSelect={setSelectedId}
            />
          )}
        </TabsContent>
        <TabsContent value="data" className="pt-4">
          <ResourceCatalog
            title="Governed data sources"
            description="Locations and policy metadata only. Credentials stay in workspace Connections and are brokered at runtime."
            actionLabel="Add data source"
            onAction={() => setDataOpen(true)}
            empty="Add local documents, databases, object stores, or APIs before binding them to an app."
          >
            {dataSources.map((source) => (
              <div key={source.id} className="rounded-lg border border-border bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">{source.name}</h3>
                    <p className="mt-1 text-xs text-fg-muted">
                      {source.description || source.governance.purpose}
                    </p>
                  </div>
                  <Badge variant="outline">{source.kind}</Badge>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-fg-muted sm:grid-cols-3">
                  <span>Site · {source.governance.residencySite}</span>
                  <span>Class · {source.governance.classification}</span>
                  <span>
                    Egress · {source.governance.externalEgressAllowed ? "allowed" : "blocked"}
                  </span>
                </div>
              </div>
            ))}
          </ResourceCatalog>
        </TabsContent>
        <TabsContent value="targets" className="pt-4">
          <ResourceCatalog
            title="Compute targets"
            description="Approved places where application bundles may run. The first native adapter is Kubernetes, including local clusters."
            actionLabel="Add Kubernetes target"
            onAction={() => setTargetOpen(true)}
            empty="Add the local Kubernetes cluster that should host internal applications."
          >
            {targets.map((target) => (
              <div key={target.id} className="rounded-lg border border-border bg-surface p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold">{target.name}</h3>
                    <p className="mt-1 text-xs text-fg-muted">
                      {target.site} · {target.environment}
                    </p>
                  </div>
                  <Badge variant="outline">{target.status}</Badge>
                </div>
                <div className="mt-3 text-xs text-fg-muted">
                  {target.capabilities.architectures.join(", ")} ·{" "}
                  {target.capabilities.cpuMillicoresMax / 1000} CPU ·{" "}
                  {Math.round(target.capabilities.memoryMiBMax / 1024)} GiB ·{" "}
                  {target.capabilities.supportsLocalModelRoute
                    ? "local AI route"
                    : "external AI route"}
                </div>
              </div>
            ))}
          </ResourceCatalog>
        </TabsContent>
      </Tabs>

      <CreateApplicationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        workspaceId={workspaceId}
        dataSources={dataSources}
        onCreated={async (created) => {
          setCreateOpen(false);
          await refresh();
          setSelectedId(created.application.id);
        }}
      />
      <DataSourceDialog
        open={dataOpen}
        onOpenChange={setDataOpen}
        workspaceId={workspaceId}
        onCreated={async () => {
          setDataOpen(false);
          await refresh();
        }}
      />
      <TargetDialog
        open={targetOpen}
        onOpenChange={setTargetOpen}
        workspaceId={workspaceId}
        onCreated={async () => {
          setTargetOpen(false);
          await refresh();
        }}
      />
      {detail ? (
        <BundleDialog
          open={bundleOpen}
          onOpenChange={setBundleOpen}
          workspaceId={workspaceId}
          detail={detail}
          onCreated={async () => {
            setBundleOpen(false);
            setBundles(
              await context.client.listInternalApplicationBundles(
                workspaceId,
                detail.application.id,
              ),
            );
          }}
        />
      ) : null}
    </ContentPage>
  );
}

function Catalog(props: {
  loading: boolean;
  error: Error | null;
  applications: InternalApplicationSummary[];
  deployments: InternalApplicationDeployment[];
  onCreate: () => void;
  onSelect: (id: string) => void;
}) {
  if (props.loading)
    return (
      <div className="grid min-h-52 place-items-center text-sm text-fg-muted">
        <Loader2Icon className="mr-2 inline size-4 animate-spin" />
        Loading applications
      </div>
    );
  if (props.error) return <Notice tone="failed">{props.error.message}</Notice>;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Internal application catalog</h2>
          <p className="mt-1 text-xs text-fg-muted">
            A private app factory: source intent, immutable bundle, governed data, explicit compute,
            and native AI policy.
          </p>
        </div>
        <Button size="sm" onClick={props.onCreate}>
          <PlusIcon />
          New application
        </Button>
      </div>
      {props.applications.length === 0 ? (
        <EmptyState>
          Describe the first internal app. It starts as a draft and cannot reach data or compute
          until you create and apply a reviewed plan.
        </EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {props.applications.map((app) => {
            const deployment = props.deployments.find(
              (candidate) => candidate.applicationId === app.id,
            );
            return (
              <button
                key={app.id}
                type="button"
                onClick={() => props.onSelect(app.id)}
                className="rounded-xl border border-border bg-surface p-4 text-left transition hover:border-brand/50 hover:bg-surface-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <AppWindowIcon className="size-5 text-brand" />
                  <Badge variant="outline">{deployment?.status ?? app.status}</Badge>
                </div>
                <h3 className="mt-4 font-semibold">{app.name}</h3>
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-fg-muted">
                  {app.description || "No description"}
                </p>
                <div className="mt-4 text-2xs text-fg-subtle">
                  Revision {app.headRevision} · {deployment?.environment ?? "not deployed"}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ResourceCatalog(props: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  empty: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{props.title}</h2>
          <p className="mt-1 text-xs text-fg-muted">{props.description}</p>
        </div>
        <Button size="sm" onClick={props.onAction}>
          <PlusIcon />
          {props.actionLabel}
        </Button>
      </div>
      {Children.count(props.children) === 0 ? (
        <EmptyState>{props.empty}</EmptyState>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">{props.children}</div>
      )}
    </div>
  );
}

function ApplicationDetailView(props: {
  workspaceId: string;
  detail: InternalApplicationDetail;
  bundles: InternalApplicationBundle[];
  targets: InternalApplicationDeploymentTarget[];
  deployments: InternalApplicationDeployment[];
  onBack: () => void;
  onRegisterBundle: () => void;
  onChanged: () => Promise<void>;
}) {
  const context = useAppContext();
  const [bundleId, setBundleId] = useState(props.bundles[0]?.id ?? "");
  const [targetId, setTargetId] = useState(props.targets[0]?.id ?? "");
  const [planResult, setPlanResult] = useState<InternalApplicationDeploymentActionResponse | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [operations, setOperations] = useState<InternalApplicationDeploymentOperation[]>([]);
  const [events, setEvents] = useState<InternalApplicationEvent[]>([]);
  useEffect(() => {
    if (!bundleId && props.bundles[0]) setBundleId(props.bundles[0].id);
  }, [bundleId, props.bundles]);
  useEffect(() => {
    if (!targetId && props.targets[0]) setTargetId(props.targets[0].id);
  }, [props.targets, targetId]);
  const target = props.targets.find((candidate) => candidate.id === targetId);
  const deployment =
    props.deployments.find((candidate) => candidate.environment === target?.environment) ??
    props.deployments[0];
  const deploymentId = deployment?.id;
  const deploymentRevision = deployment?.revision;
  const unknownOperation = operations.find((operation) => operation.status === "outcome_unknown");
  useEffect(() => {
    let disposed = false;
    void Promise.all([
      deploymentId
        ? context.client.listInternalApplicationDeploymentOperations(
            props.workspaceId,
            deploymentId,
          )
        : Promise.resolve([]),
      context.client.listInternalApplicationEvents(props.workspaceId, props.detail.application.id),
    ])
      .then(([nextOperations, nextEvents]) => {
        if (disposed) return;
        setOperations(nextOperations);
        setEvents(nextEvents);
      })
      .catch((caught) => {
        if (!disposed)
          toast.error("Couldn't load operation evidence", {
            description: String(caught),
          });
      });
    return () => {
      disposed = true;
    };
  }, [
    context.client,
    deploymentId,
    deploymentRevision,
    props.detail.application.id,
    props.workspaceId,
  ]);
  async function plan() {
    if (!target || !bundleId) return;
    setBusy("plan");
    try {
      const result = await context.client.planInternalApplicationDeployment(props.workspaceId, {
        operationId: crypto.randomUUID(),
        applicationId: props.detail.application.id,
        expectedApplicationRevision: props.detail.application.headRevision,
        bundleId,
        targetId: target.id,
        expectedTargetRevision: target.revision,
        environment: target.environment,
      });
      setPlanResult(result);
      toast.success("Deployment plan is ready");
    } catch (error) {
      toast.error("Planning failed", { description: String(error) });
    } finally {
      setBusy(null);
    }
  }
  async function startBuildSession() {
    setBusy("build");
    try {
      const receipt = await context.client.createInternalApplicationBuildSession(
        props.workspaceId,
        props.detail.application.id,
        {
          operationId: crypto.randomUUID(),
          expectedApplicationRevision: props.detail.application.headRevision,
          targetId: target?.id ?? null,
        },
      );
      window.location.assign(`/workspaces/${props.workspaceId}/sessions/${receipt.sessionId}`);
    } catch (error) {
      toast.error("Build session couldn't start", {
        description: String(error),
      });
      setBusy(null);
    }
  }
  async function approve() {
    if (!planResult?.operation.plan) return;
    setBusy("approve");
    try {
      const operation = await context.client.approveInternalApplicationDeploymentPlan(
        props.workspaceId,
        planResult.operation.id,
        { expectedPlanDigest: planResult.operation.plan.digest },
      );
      setPlanResult({ ...planResult, operation });
    } finally {
      setBusy(null);
    }
  }
  async function apply() {
    if (!planResult?.operation.plan) return;
    setBusy("apply");
    try {
      const result = await context.client.applyInternalApplicationDeployment(props.workspaceId, {
        operationId: crypto.randomUUID(),
        planOperationId: planResult.operation.id,
        expectedPlanDigest: planResult.operation.plan.digest,
      });
      setPlanResult(result);
      await props.onChanged();
      if (result.deployment.status === "running") {
        toast.success("Application is running");
      } else {
        toast.error("Deployment needs attention", {
          description: result.operation.errorMessage ?? result.operation.status,
        });
      }
    } finally {
      setBusy(null);
    }
  }
  async function observe() {
    if (!deployment) return;
    setBusy("observe");
    try {
      const result = await context.client.observeInternalApplicationDeployment(
        props.workspaceId,
        deployment.id,
        { operationId: crypto.randomUUID() },
      );
      setPlanResult(result);
      await props.onChanged();
    } finally {
      setBusy(null);
    }
  }
  async function rollback() {
    if (!deployment) return;
    setBusy("rollback");
    try {
      const result = await context.client.rollbackInternalApplicationDeployment(
        props.workspaceId,
        deployment.id,
        {
          operationId: crypto.randomUUID(),
          expectedDeploymentRevision: deployment.revision,
        },
      );
      setPlanResult(result);
      await props.onChanged();
    } finally {
      setBusy(null);
    }
  }
  async function retire() {
    if (!deployment) return;
    setBusy("retire");
    try {
      const result = await context.client.retireInternalApplicationDeployment(
        props.workspaceId,
        deployment.id,
        {
          operationId: crypto.randomUUID(),
          expectedDeploymentRevision: deployment.revision,
        },
      );
      setPlanResult(result);
      await props.onChanged();
      if (result.deployment.status === "retired") toast.success("Deployment retired");
      else
        toast.error("Retirement needs attention", {
          description: result.operation.errorMessage ?? result.operation.status,
        });
    } finally {
      setBusy(null);
    }
  }
  async function reconcile() {
    if (!deployment || !unknownOperation) return;
    setBusy("reconcile");
    try {
      const result = await context.client.reconcileInternalApplicationDeploymentOperation(
        props.workspaceId,
        unknownOperation.id,
        {
          operationId: crypto.randomUUID(),
          expectedDeploymentRevision: deployment.revision,
        },
      );
      setPlanResult(result);
      await props.onChanged();
      if (result.operation.status === "completed") toast.success("Provider outcome reconciled");
      else
        toast.error("Outcome is still unknown", {
          description: "The provider observation did not prove a settled result.",
        });
    } finally {
      setBusy(null);
    }
  }
  const definition = props.detail.headRevision.definition;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" className="-ml-2 mb-2" onClick={props.onBack}>
            <ArrowLeftIcon />
            Applications
          </Button>
          <h2 className="text-xl font-semibold">{props.detail.application.name}</h2>
          <p className="mt-1 text-sm text-fg-muted">{props.detail.application.description}</p>
        </div>
        <div className="flex gap-2">
          <Badge variant="outline">revision {props.detail.application.headRevision}</Badge>
          <Badge variant="outline">{deployment?.status ?? props.detail.application.status}</Badge>
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <SummaryCard
          icon={<DatabaseIcon />}
          title="Data"
          value={`${definition.dataBindings.length} bound source${definition.dataBindings.length === 1 ? "" : "s"}`}
          detail={
            definition.dataBindings.length
              ? definition.dataBindings.map((binding) => binding.mountName).join(", ")
              : "No data access"
          }
        />
        <SummaryCard
          icon={<ServerIcon />}
          title="Compute"
          value={`${definition.compute.cpuMillicores / 1000} CPU · ${definition.compute.memoryMiB} MiB`}
          detail={`${definition.compute.architecture} · ${definition.compute.minReplicas}–${definition.compute.maxReplicas} replicas`}
        />
        <SummaryCard
          icon={<BotIcon />}
          title="Native AI"
          value={definition.ai.enabled ? definition.ai.route.replaceAll("_", " ") : "disabled"}
          detail={definition.ai.defaultModel ?? "No model selected"}
        />
      </div>
      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Immutable application bundle</h3>
            <p className="mt-1 text-xs text-fg-muted">
              Images are digest-pinned with declared health, SBOM, and provenance digests.
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => void startBuildSession()}
            >
              <HammerIcon />
              Build in OpenGeni
            </Button>
            <Button size="sm" variant="secondary" onClick={props.onRegisterBundle}>
              <PlusIcon />
              Register bundle
            </Button>
          </div>
        </div>
        {props.bundles.length === 0 ? (
          <div className="mt-4">
            <EmptyState>
              Register the image produced by your internal build pipeline before planning a
              deployment.
            </EmptyState>
          </div>
        ) : (
          <div className="mt-4 grid gap-2">
            {props.bundles.map((bundle) => (
              <label
                key={bundle.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-border p-3"
              >
                <input
                  type="radio"
                  checked={bundleId === bundle.id}
                  onChange={() => setBundleId(bundle.id)}
                />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {bundle.manifest.image.reference}
                  </div>
                  <div className="truncate font-mono text-2xs text-fg-subtle">{bundle.digest}</div>
                </div>
              </label>
            ))}
          </div>
        )}
      </section>
      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="text-sm font-semibold">Plan before apply</h3>
        <p className="mt-1 text-xs text-fg-muted">
          The plan freezes exact app, data, target, and bundle revisions. Production and data-write
          plans require explicit approval.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
          <select
            className={selectClass}
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
          >
            <option value="">Select a compute target</option>
            {props.targets
              .filter((candidate) => candidate.status !== "disabled")
              .map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} · {candidate.environment}
                </option>
              ))}
          </select>
          <Button disabled={!bundleId || !targetId || busy !== null} onClick={() => void plan()}>
            {busy === "plan" ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
            Preview plan
          </Button>
        </div>
        {planResult?.operation.plan ? (
          <PlanPreview
            result={planResult}
            busy={busy}
            onApprove={() => void approve()}
            onApply={() => void apply()}
          />
        ) : null}
      </section>
      {deployment ? (
        <section className="rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Running deployment</h3>
              <p className="mt-1 text-xs text-fg-muted">
                {deployment.internalUrl ?? "No internal URL observed yet"} · revision{" "}
                {deployment.revision}
              </p>
            </div>
            <div className="flex gap-2">
              {unknownOperation ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void reconcile()}
                >
                  <RefreshCwIcon className={busy === "reconcile" ? "animate-spin" : ""} />
                  Reconcile
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null}
                onClick={() => void observe()}
              >
                <RefreshCwIcon className={busy === "observe" ? "animate-spin" : ""} />
                Observe
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null || !deployment.activeBundleId}
                onClick={() => void rollback()}
              >
                <RotateCcwIcon />
                Rollback
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy !== null || deployment.status === "retired"}
                onClick={() => void retire()}
              >
                <Trash2Icon />
                Retire
              </Button>
            </div>
          </div>
        </section>
      ) : null}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="text-sm font-semibold">Operation evidence</h3>
        <p className="mt-1 text-xs text-fg-muted">
          Immutable plan, approval, provider, observation, rollback, and retirement facts.
        </p>
        {operations.length === 0 && events.length === 0 ? (
          <div className="mt-4">
            <EmptyState>No deployment evidence has been recorded yet.</EmptyState>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {operations.slice(0, 8).map((operation) => (
              <div
                key={operation.id}
                className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 p-3 text-xs"
              >
                <span className="font-medium capitalize">
                  {operation.kind.replaceAll("_", " ")}
                </span>
                <span className="text-fg-muted">{operation.status.replaceAll("_", " ")}</span>
              </div>
            ))}
            {events.slice(0, 4).map((event) => (
              <div key={event.id} className="px-1 text-2xs text-fg-subtle">
                {new Date(event.createdAt).toLocaleString()} · {event.type}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SummaryCard(props: { icon: ReactNode; title: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-fg-muted">
        <span className="text-brand [&>svg]:size-4">{props.icon}</span>
        {props.title}
      </div>
      <div className="mt-3 text-sm font-semibold capitalize">{props.value}</div>
      <div className="mt-1 truncate text-xs text-fg-subtle">{props.detail}</div>
    </div>
  );
}

function PlanPreview(props: {
  result: InternalApplicationDeploymentActionResponse;
  busy: string | null;
  onApprove: () => void;
  onApply: () => void;
}) {
  const plan = props.result.operation.plan!;
  const failed = plan.policyChecks.some((check) => check.status === "fail");
  const approved = props.result.operation.status === "approved";
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      <div className="grid gap-2 md:grid-cols-2">
        {plan.policyChecks.map((check) => (
          <div key={check.id} className="flex gap-2 rounded-lg bg-surface-2 p-3">
            {check.status === "pass" ? (
              <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-status-success" />
            ) : (
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-status-waiting" />
            )}
            <div>
              <div className="text-xs font-medium">{check.id.replaceAll("-", " ")}</div>
              <div className="mt-1 text-2xs text-fg-muted">{check.message}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-lg border border-border p-3 text-xs text-fg-muted">
        <strong className="text-fg">Data movement</strong>
        {plan.dataFlows.length === 0 ? (
          <p className="mt-1">No governed data leaves a source.</p>
        ) : (
          plan.dataFlows.map((flow) => (
            <p key={flow.dataSourceId} className="mt-1">
              {flow.sourceSite} → {flow.destinationSite} · {flow.accessMode} ·{" "}
              {flow.externalEgress ? "site transfer" : "stays local"}
            </p>
          ))
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="font-mono text-2xs text-fg-subtle">{plan.digest}</div>
        <div className="flex gap-2">
          {plan.destructive && !approved ? (
            <Button
              size="sm"
              variant="secondary"
              disabled={failed || props.busy !== null}
              onClick={props.onApprove}
            >
              Approve high-risk plan
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={failed || props.busy !== null || (plan.destructive && !approved)}
            onClick={props.onApply}
          >
            {props.busy === "apply" ? <Loader2Icon className="animate-spin" /> : null}
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

function CreateApplicationDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  dataSources: InternalApplicationDataSource[];
  onCreated: (detail: InternalApplicationDetail) => Promise<void>;
}) {
  const { client } = useAppContext();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const slug = name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-|-$/gu, "")
        .slice(0, 63);
      const chosen = props.dataSources.filter((source) => selected.includes(source.id));
      const detail = await client.createInternalApplication(props.workspaceId, {
        operationId: crypto.randomUUID(),
        slug,
        name,
        description,
        definition: {
          schemaVersion: 1,
          source: { kind: "prompt", prompt },
          dataBindings: chosen.map((source) => ({
            dataSourceId: source.id,
            expectedRevision: source.revision,
            accessMode: "attach",
            permissions: ["read"],
            mountName: source.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/gu, "-")
              .replace(/^-|-$/gu, "")
              .slice(0, 63),
          })),
          compute: {
            architecture: "amd64",
            cpuMillicores: 500,
            memoryMiB: 1024,
            storageMiB: 2048,
            gpu: null,
            minReplicas: 1,
            maxReplicas: 2,
          },
          ai: {
            enabled: true,
            route: "local",
            defaultModel: "local-model",
            allowedModels: ["local-model"],
            capabilities: ["document-search", "structured-output"],
            monthlyBudgetMicros: null,
            requireHumanApprovalForWrites: true,
          },
          routes: [{ name: "web", path: "/", port: 3000, visibility: "workspace" }],
          variableSetIds: [],
          metadata: { createdFrom: "prompt" },
        },
      });
      await props.onCreated(detail);
      toast.success("Application draft created");
    } catch (error) {
      toast.error("Couldn't create application", {
        description: String(error),
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Describe an internal application</DialogTitle>
          <DialogDescription>
            The draft freezes your intent, local data bindings, compute profile, and native AI
            policy. No infrastructure is changed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Input
            placeholder="Application name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Textarea
            placeholder="What should this app do? Who will use it?"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={5}
          />
          <Input
            placeholder="Short description (optional)"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
          {props.dataSources.length ? (
            <div>
              <p className="mb-2 text-xs font-medium">Attach local data</p>
              <div className="grid gap-2">
                {props.dataSources.map((source) => (
                  <label key={source.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(source.id)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, source.id]
                            : current.filter((id) => id !== source.id),
                        )
                      }
                    />
                    {source.name}
                    <span className="text-xs text-fg-subtle">
                      · {source.governance.residencySite}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!name.trim() || !prompt.trim() || busy} onClick={() => void submit()}>
            {busy ? <Loader2Icon className="animate-spin" /> : null}Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DataSourceDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onCreated: () => Promise<void>;
}) {
  const { client } = useAppContext();
  const [kind, setKind] = useState<"documents" | "postgres">("documents");
  const [name, setName] = useState("");
  const [site, setSite] = useState("Local site");
  const [host, setHost] = useState("");
  const [database, setDatabase] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await client.putInternalApplicationDataSource(props.workspaceId, crypto.randomUUID(), {
        expectedRevision: 0,
        name,
        description: "",
        kind,
        allowedAccessModes: ["attach"],
        locator:
          kind === "documents"
            ? {
                kind: "documents",
                scope: "workspace",
                sourceKind: null,
                aclTags: [],
              }
            : {
                kind: "postgres",
                host,
                port: 5432,
                database,
                schemas: ["public"],
                sslMode: "require",
                credentialConnectionId: connectionId || null,
              },
        governance: {
          classification: "restricted",
          residencySite: site,
          residencyRegion: null,
          externalEgressAllowed: false,
          retentionDays: null,
          owner: "Workspace administrators",
          purpose: "Internal application access",
        },
        schemaDefinition: {},
        metadata: {},
        status: "active",
      });
      await props.onCreated();
      toast.success("Data source added");
    } catch (error) {
      toast.error("Couldn't add data source", { description: String(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add governed data</DialogTitle>
          <DialogDescription>
            Store a credential-free locator and explicit residency policy. Database credentials
            remain in Connections.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <select
            className={selectClass}
            value={kind}
            onChange={(event) => setKind(event.target.value as "documents" | "postgres")}
          >
            <option value="documents">Workspace documents</option>
            <option value="postgres">PostgreSQL</option>
          </select>
          <Input
            placeholder="Display name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            placeholder="Residency site, e.g. SINTEF Oslo"
            value={site}
            onChange={(event) => setSite(event.target.value)}
          />
          {kind === "postgres" ? (
            <>
              <Input
                placeholder="Database host"
                value={host}
                onChange={(event) => setHost(event.target.value)}
              />
              <Input
                placeholder="Database name"
                value={database}
                onChange={(event) => setDatabase(event.target.value)}
              />
              <Input
                placeholder="Workspace Connection ID"
                value={connectionId}
                onChange={(event) => setConnectionId(event.target.value)}
              />
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name || !site || busy || (kind === "postgres" && (!host || !database))}
            onClick={() => void submit()}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : null}Add source
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TargetDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  onCreated: () => Promise<void>;
}) {
  const { client } = useAppContext();
  const [name, setName] = useState("");
  const [site, setSite] = useState("Local site");
  const [apiServer, setApiServer] = useState("");
  const [namespace, setNamespace] = useState("internal-apps");
  const [domain, setDomain] = useState("apps.internal");
  const [runtimeApiUrl, setRuntimeApiUrl] = useState("http://opengeni-api.opengeni.svc:8000");
  const [runtimeSecretName, setRuntimeSecretName] = useState("opengeni-internal-app-runtime");
  const [dataSecretPrefix, setDataSecretPrefix] = useState("opengeni-internal-app-data");
  const [egressCidrs, setEgressCidrs] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await client.putInternalApplicationTarget(props.workspaceId, crypto.randomUUID(), {
        expectedRevision: 0,
        name,
        description: "",
        kind: "kubernetes",
        environment: "development",
        site,
        config: {
          kind: "kubernetes",
          apiServer,
          namespace,
          serviceAccount: "opengeni-internal-apps",
          ingressClass: "nginx",
          ingressNamespace: "ingress-nginx",
          internalDomain: domain,
          registry: "registry.internal",
          storageClasses: [],
          runtimeApiUrl,
          runtimeCredentialSecretPrefix: runtimeSecretName || null,
          dataCredentialSecretPrefix: dataSecretPrefix || null,
          allowedEgressCidrs: egressCidrs
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          credentialConnectionId: connectionId || null,
        },
        capabilities: {
          architectures: ["amd64", "arm64"],
          cpuMillicoresMax: 16000,
          memoryMiBMax: 65536,
          storageMiBMax: 1048576,
          gpuTypes: [],
          supportsNetworkPolicy: true,
          supportsPersistentVolumes: true,
          supportsInternalIngress: true,
          supportsLocalModelRoute: true,
        },
        metadata: {},
        status: "active",
      });
      await props.onCreated();
      toast.success("Compute target added");
    } catch (error) {
      toast.error("Couldn't add target", { description: String(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add local Kubernetes</DialogTitle>
          <DialogDescription>
            OpenGeni uses server-side apply. The bearer token is read just-in-time from the
            workspace Connection ID.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Input
            placeholder="Target name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            placeholder="Site, e.g. SINTEF Oslo"
            value={site}
            onChange={(event) => setSite(event.target.value)}
          />
          <Input
            placeholder="https://kubernetes.internal"
            value={apiServer}
            onChange={(event) => setApiServer(event.target.value)}
          />
          <Input
            placeholder="Namespace"
            value={namespace}
            onChange={(event) => setNamespace(event.target.value)}
          />
          <Input
            placeholder="Internal app domain"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
          />
          <Input
            placeholder="OpenGeni runtime API URL"
            value={runtimeApiUrl}
            onChange={(event) => setRuntimeApiUrl(event.target.value)}
          />
          <Input
            placeholder="Runtime credential Secret prefix"
            value={runtimeSecretName}
            onChange={(event) => setRuntimeSecretName(event.target.value)}
          />
          <Input
            placeholder="Data credential Secret prefix"
            value={dataSecretPrefix}
            onChange={(event) => setDataSecretPrefix(event.target.value)}
          />
          <Input
            placeholder="Allowed egress CIDRs, comma separated (optional)"
            value={egressCidrs}
            onChange={(event) => setEgressCidrs(event.target.value)}
          />
          <Input
            placeholder="Workspace Connection ID"
            value={connectionId}
            onChange={(event) => setConnectionId(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              !name ||
              !site ||
              !apiServer ||
              !namespace ||
              !domain ||
              !runtimeApiUrl ||
              !runtimeSecretName ||
              !connectionId ||
              busy
            }
            onClick={() => void submit()}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : null}Add target
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BundleDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  detail: InternalApplicationDetail;
  onCreated: () => Promise<void>;
}) {
  const { client } = useAppContext();
  const [image, setImage] = useState("");
  const [digest, setDigest] = useState("");
  const [sbom, setSbom] = useState("");
  const [provenance, setProvenance] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await client.registerInternalApplicationBundle(
        props.workspaceId,
        props.detail.application.id,
        {
          operationId: crypto.randomUUID(),
          applicationRevisionId: props.detail.headRevision.id,
          digest,
          manifest: {
            schemaVersion: 1,
            image: {
              reference: image,
              digest,
              architecture: props.detail.headRevision.definition.compute.architecture,
            },
            staticAssetsDigest: null,
            migrationsDigest: null,
            runtime: {
              command: ["bun", "run", "start"],
              workingDirectory: "/app",
            },
            health: {
              path: "/healthz",
              port: props.detail.headRevision.definition.routes[0]?.port ?? 3000,
            },
            configurationKeys: [
              "OPENGENI_RUNTIME_URL",
              "OPENGENI_API_KEY",
              "OPENGENI_INTERNAL_APPLICATION_ID",
              "OPENGENI_DATA_BINDINGS_JSON",
            ],
            sbomDigest: sbom,
            provenanceDigest: provenance,
          },
        },
      );
      await props.onCreated();
      toast.success("Immutable bundle registered");
    } catch (error) {
      toast.error("Couldn't register bundle", { description: String(error) });
    } finally {
      setBusy(false);
    }
  }
  const valid = /^sha256:[a-f0-9]{64}$/u;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register immutable bundle</DialogTitle>
          <DialogDescription>
            Use the exact registry image digest and independently generated SBOM and provenance
            digests.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Input
            placeholder="registry.internal/team/app"
            value={image}
            onChange={(event) => setImage(event.target.value)}
          />
          <Input
            placeholder="Image digest · sha256:…"
            value={digest}
            onChange={(event) => setDigest(event.target.value)}
          />
          <Input
            placeholder="SBOM digest · sha256:…"
            value={sbom}
            onChange={(event) => setSbom(event.target.value)}
          />
          <Input
            placeholder="Provenance digest · sha256:…"
            value={provenance}
            onChange={(event) => setProvenance(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={
              !image || !valid.test(digest) || !valid.test(sbom) || !valid.test(provenance) || busy
            }
            onClick={() => void submit()}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : null}Register
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
