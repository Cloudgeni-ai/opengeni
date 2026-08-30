import type {
  AppRelease,
  AppRuntimeCatalogResponse,
  OpenGeniAppsClient,
  WorkspaceApp,
  WorkspaceAppDetailResponse,
  WorkspaceAppListResponse,
  CreateAppLaunchResponse,
} from "@opengeni/sdk/apps";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BoxesIcon,
  Clock3Icon,
  LockIcon,
  Loader2Icon,
  PlayIcon,
  PlusIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { AppCapabilityConfirmation } from "@/components/apps/app-capability-confirmation";
import type { AppsManagementAccess, AppsManagementClient } from "@/components/apps/app-management";
import { useAppsControlClient } from "@/components/apps/apps-control-context";
import { AppRunFrame } from "@/components/apps/app-run-frame";
import { EmptyState, LoadErrorState, PageHeader } from "@/components/common";
import { Button } from "@/components/ui/button";
import { ContentPage, ContentSurface } from "@/components/ui/content-layout";
import { MetaChip } from "@/components/ui/meta-chip";
import { Skeleton } from "@/components/ui/skeleton";

const NUMBER_FORMAT = new Intl.NumberFormat();
const LazyAppCreatePanel = lazy(async () => {
  const module = await import("@/components/apps/app-management");
  return { default: module.AppCreatePanel };
});
const LazyAppManagementPanel = lazy(async () => {
  const module = await import("@/components/apps/app-management");
  return { default: module.AppManagementPanel };
});

type AppsProductClient = Pick<
  OpenGeniAppsClient,
  "listApps" | "getApp" | "getRuntimeCatalog" | "createLaunch" | "callRuntimeTool"
> &
  AppsManagementClient;

export type AppsRouteAccess = AppsManagementAccess & { read: boolean };

const FULL_APPS_ACCESS: AppsRouteAccess = {
  read: true,
  write: true,
  publish: true,
  run: true,
  delete: true,
};

type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: Error };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function publishedRelease(detail: WorkspaceAppDetailResponse): AppRelease | null {
  return detail.releases.find((release) => release.id === detail.app.activeReleaseId) ?? null;
}

function AppsUnavailable() {
  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<BoxesIcon aria-hidden="true" className="size-4" />}
        title="Apps"
        description="Run workspace applications with explicit, per-run OpenGeni tool access."
      />
      <EmptyState>
        Apps are not connected in this host. Inject an Apps control transport to wire HTTP, Code
        Mode, or another product-owned adapter.
      </EmptyState>
    </ContentPage>
  );
}

function AppsPermissionDenied({ run = false }: { run?: boolean }) {
  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<LockIcon aria-hidden="true" className="size-4" />}
        title={run ? "Run app" : "Apps"}
        description={
          run
            ? "Running workspace apps requires explicit Apps run access."
            : "Workspace apps are available only to members with Apps access."
        }
      />
      <div className="mt-4">
        <EmptyState>
          You don&apos;t have permission to {run ? "run apps in" : "view apps for"} this workspace.
        </EmptyState>
      </div>
    </ContentPage>
  );
}

export function AppsRoute({
  workspaceId,
  appId,
  previewId,
  previewRequested = false,
  run = false,
  client: clientOverride,
  access = FULL_APPS_ACCESS,
}: {
  workspaceId: string;
  appId?: string;
  previewId?: string;
  previewRequested?: boolean;
  run?: boolean;
  client?: AppsProductClient;
  access?: AppsRouteAccess;
}) {
  const injectedClient = useAppsControlClient();
  const client = clientOverride ?? injectedClient;
  if (!access.read) return <AppsPermissionDenied />;
  if (run && !access.run) return <AppsPermissionDenied run />;
  if (!client) return <AppsUnavailable />;
  if (!appId) {
    return (
      <AppsListRoute
        key={workspaceId}
        workspaceId={workspaceId}
        client={client}
        canCreate={access.write}
      />
    );
  }
  return run ? (
    <AppRunRoute
      key={`${workspaceId}:${appId}:${previewRequested ? (previewId ?? "invalid-preview") : "published"}`}
      workspaceId={workspaceId}
      appId={appId}
      previewId={previewId}
      previewRequested={previewRequested || Boolean(previewId)}
      client={client}
    />
  ) : (
    <AppDetailRoute
      key={`${workspaceId}:${appId}`}
      workspaceId={workspaceId}
      appId={appId}
      client={client}
      access={access}
    />
  );
}

function AppsListRoute({
  workspaceId,
  client,
  canCreate,
}: {
  workspaceId: string;
  client: AppsProductClient;
  canCreate: boolean;
}) {
  const [state, setState] = useState<LoadState<WorkspaceAppListResponse>>({
    status: "loading",
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const loadGeneration = useRef(0);
  const newAppButtonRef = useRef<HTMLButtonElement>(null);
  const inventoryRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const load = useCallback(
    async (signal?: AbortSignal, cursor?: string) => {
      const generation = ++loadGeneration.current;
      if (cursor) setLoadingMore(true);
      else {
        setLoadingMore(false);
        setState({ status: "loading" });
      }
      setPaginationError(null);
      try {
        const page = await client.listApps(
          workspaceId,
          { limit: 50, ...(cursor ? { cursor } : {}) },
          { signal },
        );
        if (signal?.aborted || generation !== loadGeneration.current) return;
        setState((current) => {
          if (!cursor || current.status !== "ready") return { status: "ready", data: page };
          const apps = new Map(current.data.apps.map((app) => [app.id, app]));
          for (const app of page.apps) apps.set(app.id, app);
          return {
            status: "ready",
            data: {
              apps: [...apps.values()],
              nextCursor: page.nextCursor,
              truncated: page.truncated,
            },
          };
        });
      } catch (error) {
        if (!signal?.aborted && generation === loadGeneration.current) {
          if (cursor) {
            setPaginationError(asError(error).message);
          } else {
            setState({ status: "error", error: asError(error) });
          }
        }
      } finally {
        if (cursor && generation === loadGeneration.current) setLoadingMore(false);
      }
    },
    [client, workspaceId],
  );
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);

  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<BoxesIcon aria-hidden="true" className="size-4" />}
        title="Apps"
        description="Create, publish, and run workspace apps with explicit tool access for every launch."
        actions={
          canCreate && !creating ? (
            <Button
              ref={newAppButtonRef}
              type="button"
              onClick={() => setCreating(true)}
              className="pointer-coarse:min-h-11"
            >
              <PlusIcon aria-hidden="true" />
              New app
            </Button>
          ) : undefined
        }
      />
      {creating ? (
        <Suspense fallback={<Skeleton className="mt-4 h-64" />}>
          <LazyAppCreatePanel
            workspaceId={workspaceId}
            client={client}
            onCancel={() => {
              setCreating(false);
              requestAnimationFrame(() => newAppButtonRef.current?.focus());
            }}
            onCreated={(app) => {
              if (state.status !== "ready") {
                setCreating(false);
                void navigate({
                  to: "/workspaces/$workspaceId/apps/$appId",
                  params: { workspaceId, appId: app.id },
                });
                return;
              }
              setState((current) =>
                current.status === "ready"
                  ? {
                      status: "ready",
                      data: {
                        ...current.data,
                        apps: [
                          app,
                          ...current.data.apps.filter((candidate) => candidate.id !== app.id),
                        ],
                      },
                    }
                  : current,
              );
              setCreating(false);
              requestAnimationFrame(() => {
                inventoryRef.current
                  ?.querySelector<HTMLElement>(`[data-app-id="${app.id}"]`)
                  ?.focus();
              });
            }}
          />
        </Suspense>
      ) : null}
      {state.status === "loading" ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-36" />
          <Skeleton className="h-36" />
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="mt-4">
          <LoadErrorState
            title="Couldn't load apps"
            error={state.error}
            onRetry={() => void load()}
          />
        </div>
      ) : null}
      {state.status === "ready" && state.data.apps.length === 0 ? (
        <div className="mt-4">
          <EmptyState>
            {canCreate
              ? "No Apps exist in this workspace yet. Create one, then deploy a checked build."
              : "No Apps exist in this workspace yet."}
          </EmptyState>
        </div>
      ) : null}
      {state.status === "ready" && state.data.apps.length > 0 ? (
        <div ref={inventoryRef} className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {state.data.apps.map((app) => (
            <AppListItem key={app.id} workspaceId={workspaceId} app={app} />
          ))}
        </div>
      ) : null}
      {state.status === "ready" && state.data.nextCursor ? (
        <div className="mt-4 flex justify-center">
          {paginationError ? (
            <span role="alert" className="mr-3 self-center text-sm text-status-failed">
              {paginationError}
            </span>
          ) : null}
          <Button
            type="button"
            variant="outline"
            disabled={loadingMore}
            onClick={() => void load(undefined, state.data.nextCursor ?? undefined)}
            className="pointer-coarse:min-h-11"
          >
            {loadingMore ? <Loader2Icon aria-hidden="true" className="animate-spin" /> : null}
            {loadingMore ? "Loading more…" : "Load more apps"}
          </Button>
        </div>
      ) : null}
    </ContentPage>
  );
}

function AppListItem({ workspaceId, app }: { workspaceId: string; app: WorkspaceApp }) {
  const status =
    app.status === "archived" ? "Archived" : app.activeReleaseId ? "Published" : "Draft";
  return (
    <Link
      to="/workspaces/$workspaceId/apps/$appId"
      params={{ workspaceId, appId: app.id }}
      data-app-id={app.id}
      className="rounded-xl border border-border bg-surface p-4 outline-none transition-colors hover:bg-surface-2/40 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="rounded-md bg-brand/10 p-2 text-brand">
          <BoxesIcon aria-hidden="true" className="size-4" />
        </span>
        <MetaChip>{status}</MetaChip>
      </div>
      <h2 className="mt-4 break-words text-sm font-semibold text-fg">{app.title}</h2>
      <p className="mt-1 line-clamp-2 text-sm text-fg-muted">
        {app.description || "No description"}
      </p>
      <p className="mt-4 flex items-center gap-1 text-2xs text-fg-subtle">
        <Clock3Icon aria-hidden="true" className="size-3" />
        Updated {formatDate(app.updatedAt)}
      </p>
    </Link>
  );
}

function useAppDetail(workspaceId: string, appId: string, client: AppsProductClient) {
  const [state, setState] = useState<LoadState<WorkspaceAppDetailResponse>>({
    status: "loading",
  });
  const loadGeneration = useRef(0);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const generation = ++loadGeneration.current;
      setState({ status: "loading" });
      try {
        const data = await client.getApp(workspaceId, appId, { signal });
        if (signal?.aborted || generation !== loadGeneration.current) return;
        setState({
          status: "ready",
          data,
        });
      } catch (error) {
        if (!signal?.aborted && generation === loadGeneration.current) {
          setState({ status: "error", error: asError(error) });
        }
      }
    },
    [appId, client, workspaceId],
  );
  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);
  return {
    state,
    load,
    setData: (data: WorkspaceAppDetailResponse) => setState({ status: "ready", data }),
  };
}

function BackToApps({ workspaceId }: { workspaceId: string }) {
  return (
    <Link
      to="/workspaces/$workspaceId/apps"
      params={{ workspaceId }}
      className="mb-4 inline-flex w-fit items-center gap-1.5 rounded text-xs font-medium text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
      Back to Apps
    </Link>
  );
}

function BackToApp({
  workspaceId,
  appId,
  title,
}: {
  workspaceId: string;
  appId: string;
  title: string;
}) {
  return (
    <Link
      to="/workspaces/$workspaceId/apps/$appId"
      params={{ workspaceId, appId }}
      className="mb-4 inline-flex max-w-full items-center gap-1.5 rounded text-xs font-medium text-fg-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ArrowLeftIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">Back to {title}</span>
    </Link>
  );
}

function AppDetailRoute({
  workspaceId,
  appId,
  client,
  access,
}: {
  workspaceId: string;
  appId: string;
  client: AppsProductClient;
  access: AppsRouteAccess;
}) {
  const { state, load, setData } = useAppDetail(workspaceId, appId, client);
  if (state.status === "loading") {
    return (
      <ContentPage width="standard">
        <PageHeader
          icon={<BoxesIcon aria-hidden="true" className="size-4" />}
          title="App"
          description="Loading app details…"
        />
        <div role="status" aria-label="Loading app details" className="mt-4">
          <Skeleton aria-hidden="true" className="h-48" />
        </div>
      </ContentPage>
    );
  }
  if (state.status === "error") {
    return (
      <ContentPage width="standard">
        <BackToApps workspaceId={workspaceId} />
        <PageHeader
          icon={<BoxesIcon aria-hidden="true" className="size-4" />}
          title="App"
          description="View app details, releases, and runtime access."
        />
        <div className="mt-4">
          <LoadErrorState
            title="Couldn't load app"
            error={state.error}
            onRetry={() => void load()}
          />
        </div>
      </ContentPage>
    );
  }
  const detail = state.data;
  const release = detail.app.status === "active" ? publishedRelease(detail) : null;
  const published = detail.app.status === "active" && detail.app.activeReleaseId !== null;
  return (
    <ContentPage width="standard">
      <BackToApps workspaceId={workspaceId} />
      <PageHeader
        icon={<BoxesIcon aria-hidden="true" className="size-4" />}
        title={detail.app.title}
        description={detail.app.description || "A workspace application."}
        actions={
          published && access.run ? (
            <Button asChild className="pointer-coarse:min-h-11">
              <Link to="/workspaces/$workspaceId/apps/$appId/run" params={{ workspaceId, appId }}>
                <PlayIcon aria-hidden="true" className="mr-2 size-4" />
                Run app
              </Link>
            </Button>
          ) : undefined
        }
      />
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <ContentSurface>
          <h2 className="text-sm font-semibold text-fg">Release</h2>
          <dl className="mt-3 grid gap-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-fg-subtle">Status</dt>
              <dd className="text-right text-fg">{published ? "Published" : "Not published"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-fg-subtle">App revision</dt>
              <dd className="text-right text-fg">v{detail.app.version}</dd>
            </div>
            {release ? (
              <div className="flex justify-between gap-3">
                <dt className="text-fg-subtle">Files</dt>
                <dd className="text-right text-fg">{formatCount(release.fileCount)}</dd>
              </div>
            ) : null}
          </dl>
        </ContentSurface>
        <ContentSurface>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
            <ShieldCheckIcon aria-hidden="true" className="size-4 text-brand" />
            Runtime access
          </h2>
          <p className="mt-2 text-sm leading-5 text-fg-muted">
            Every launch requires a fresh confirmation before this app can use its read-only,
            replay-safe OpenGeni tool catalog.
          </p>
        </ContentSurface>
      </div>
      {!published ? (
        <div className="mt-4">
          <EmptyState>This app needs a ready published release before it can run.</EmptyState>
        </div>
      ) : null}
      <Suspense
        fallback={
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        }
      >
        <LazyAppManagementPanel
          workspaceId={workspaceId}
          detail={detail}
          client={client}
          access={access}
          onDetailChange={setData}
          onRefresh={() => load()}
        />
      </Suspense>
    </ContentPage>
  );
}

function AppRunRoute({
  workspaceId,
  appId,
  previewId,
  previewRequested,
  client,
}: {
  workspaceId: string;
  appId: string;
  previewId?: string;
  previewRequested: boolean;
  client: AppsProductClient;
}) {
  const { state, load } = useAppDetail(workspaceId, appId, client);
  const [catalogState, setCatalogState] = useState<LoadState<AppRuntimeCatalogResponse> | null>(
    null,
  );
  const [confirmed, setConfirmed] = useState(false);
  const [launch, setLaunch] = useState<CreateAppLaunchResponse | null>(null);
  const [launchError, setLaunchError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const catalogGeneration = useRef(0);
  const launchGeneration = useRef(0);
  const runContentRef = useRef<HTMLDivElement>(null);
  const restoreConfirmationFocus = useRef(false);
  const preview =
    state.status === "ready" && previewRequested && previewId
      ? (state.data.previews.find(
          (candidate) =>
            candidate.id === previewId &&
            candidate.status === "active" &&
            new Date(candidate.expiresAt).getTime() > Date.now(),
        ) ?? null)
      : null;
  const releaseId =
    state.status === "ready" && state.data.app.status === "active"
      ? previewRequested
        ? (preview?.releaseId ?? null)
        : state.data.app.activeReleaseId
      : null;
  const release =
    state.status === "ready" && releaseId
      ? (state.data.releases.find((candidate) => candidate.id === releaseId) ?? null)
      : null;
  const launchTargetId = preview?.id ?? releaseId;

  useEffect(() => {
    const generation = ++catalogGeneration.current;
    if (!releaseId) {
      setCatalogState(null);
      return;
    }
    const abort = new AbortController();
    setCatalogState({ status: "loading" });
    void client
      .getRuntimeCatalog(workspaceId, appId, releaseId, {
        signal: abort.signal,
      })
      .then((data) => {
        if (!abort.signal.aborted && generation === catalogGeneration.current) {
          setCatalogState({ status: "ready", data });
        }
      })
      .catch((error) => {
        if (!abort.signal.aborted && generation === catalogGeneration.current) {
          setCatalogState({ status: "error", error: asError(error) });
        }
      });
    return () => abort.abort();
  }, [appId, catalogRevision, client, releaseId, workspaceId]);

  useEffect(() => {
    launchGeneration.current += 1;
    setConfirmed(false);
    setLaunch(null);
    setLaunchError(null);
    setBusy(false);
  }, [launchTargetId]);

  useEffect(() => {
    if (launch || !restoreConfirmationFocus.current) return;
    restoreConfirmationFocus.current = false;
    requestAnimationFrame(() => {
      runContentRef.current
        ?.querySelector<HTMLInputElement | HTMLButtonElement>('input[type="checkbox"], button')
        ?.focus();
    });
  }, [launch]);

  const start = async () => {
    if (!releaseId || catalogState?.status !== "ready") return;
    if (catalogState.data.tools.length > 0 && !confirmed) return;
    const generation = launchGeneration.current;
    setBusy(true);
    setLaunchError(null);
    try {
      const created = await client.createLaunch(
        workspaceId,
        appId,
        preview ? { previewId: preview.id } : { releaseId },
      );
      if (generation === launchGeneration.current) setLaunch(created);
    } catch (error) {
      if (generation === launchGeneration.current) setLaunchError(asError(error));
    } finally {
      if (generation === launchGeneration.current) setBusy(false);
    }
  };

  if (state.status === "loading") {
    return (
      <ContentPage width="wide" className="min-h-full">
        <BackToApps workspaceId={workspaceId} />
        <PageHeader
          icon={<PlayIcon aria-hidden="true" className="size-4" />}
          title="Run app"
          description="Loading the app and its runtime access…"
        />
        <div role="status" aria-label="Loading app runtime" className="mt-4 flex min-h-0 flex-1">
          <Skeleton aria-hidden="true" className="min-h-64 flex-1" />
        </div>
      </ContentPage>
    );
  }
  if (state.status === "error") {
    return (
      <ContentPage width="standard">
        <BackToApps workspaceId={workspaceId} />
        <PageHeader
          icon={<PlayIcon aria-hidden="true" className="size-4" />}
          title="Run app"
          description="Confirm runtime access, then start the app in its isolated frame."
        />
        <div className="mt-4">
          <LoadErrorState
            title="Couldn't load app"
            error={state.error}
            onRetry={() => void load()}
          />
        </div>
      </ContentPage>
    );
  }
  if (!releaseId) {
    return (
      <ContentPage width="standard">
        <BackToApp workspaceId={workspaceId} appId={appId} title={state.data.app.title} />
        <PageHeader
          icon={<PlayIcon aria-hidden="true" className="size-4" />}
          title={`Run ${state.data.app.title}`}
          description="Confirm runtime access, then start the app in its isolated frame."
        />
        <div className="mt-4">
          <EmptyState>
            {previewRequested
              ? "This app preview is unavailable, expired, or no longer active."
              : "This app has no published release to run."}
          </EmptyState>
        </div>
      </ContentPage>
    );
  }

  return (
    <ContentPage width="wide" className="min-h-full">
      <BackToApp workspaceId={workspaceId} appId={appId} title={state.data.app.title} />
      <PageHeader
        icon={<PlayIcon aria-hidden="true" className="size-4" />}
        title={`Run ${state.data.app.title}`}
        description={
          preview
            ? `Private preview${release ? ` of release ${release.revision}` : ""}, available until ${formatDate(preview.expiresAt)}. It runs in an isolated frame with only the tools confirmed below.`
            : "Apps run in an isolated frame and receive only the tools confirmed below."
        }
        actions={
          preview ? (
            <MetaChip dot="waiting">
              Preview{release ? ` · Release ${release.revision}` : ""}
            </MetaChip>
          ) : undefined
        }
      />
      <div ref={runContentRef} className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
        {catalogState?.status === "loading" || catalogState === null ? (
          <Skeleton className="h-48" />
        ) : null}
        {catalogState?.status === "error" ? (
          <LoadErrorState
            title="Couldn't load app access"
            error={catalogState.error}
            onRetry={() => setCatalogRevision((value) => value + 1)}
          />
        ) : null}
        {launchError ? (
          <div
            role="alert"
            className="rounded-lg border border-status-failed/40 p-3 text-sm text-fg"
          >
            {launchError.message}
          </div>
        ) : null}
        {catalogState?.status === "ready" && !launch ? (
          <AppCapabilityConfirmation
            tools={catalogState.data.tools}
            confirmed={confirmed}
            busy={busy}
            onConfirmedChange={setConfirmed}
            onStart={() => void start()}
          />
        ) : null}
        {catalogState?.status === "ready" && launch ? (
          <AppRunFrame
            workspaceId={workspaceId}
            app={state.data.app}
            catalog={catalogState.data}
            launch={launch}
            client={client}
            productOrigin={window.location.origin}
            onStop={() => {
              restoreConfirmationFocus.current = true;
              setConfirmed(false);
              setLaunch(null);
            }}
          />
        ) : null}
      </div>
    </ContentPage>
  );
}
