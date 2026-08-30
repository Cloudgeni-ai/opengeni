import type {
  AppRelease,
  AppRuntimeCatalogResponse,
  OpenGeniAppsClient,
  WorkspaceApp,
  WorkspaceAppDetailResponse,
  WorkspaceAppListResponse,
  CreateAppLaunchResponse,
} from "@opengeni/sdk/apps";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BoxesIcon,
  Clock3Icon,
  Loader2Icon,
  PlayIcon,
  PlusIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { AppCapabilityConfirmation } from "@/components/apps/app-capability-confirmation";
import type { AppsManagementClient } from "@/components/apps/app-management";
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

type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: Error };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
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

export function AppsRoute({
  workspaceId,
  appId,
  run = false,
  client: clientOverride,
}: {
  workspaceId: string;
  appId?: string;
  run?: boolean;
  client?: AppsProductClient;
}) {
  const injectedClient = useAppsControlClient();
  const client = clientOverride ?? injectedClient;
  if (!client) return <AppsUnavailable />;
  if (!appId) return <AppsListRoute workspaceId={workspaceId} client={client} />;
  return run ? (
    <AppRunRoute workspaceId={workspaceId} appId={appId} client={client} />
  ) : (
    <AppDetailRoute workspaceId={workspaceId} appId={appId} client={client} />
  );
}

function AppsListRoute({
  workspaceId,
  client,
}: {
  workspaceId: string;
  client: AppsProductClient;
}) {
  const [state, setState] = useState<LoadState<WorkspaceAppListResponse>>({
    status: "loading",
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(
    async (signal?: AbortSignal, cursor?: string) => {
      if (cursor) setLoadingMore(true);
      else setState({ status: "loading" });
      setPaginationError(null);
      try {
        const page = await client.listApps(
          workspaceId,
          { limit: 50, ...(cursor ? { cursor } : {}) },
          { signal },
        );
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
        if (!signal?.aborted) {
          if (cursor) {
            setPaginationError(asError(error).message);
          } else {
            setState({ status: "error", error: asError(error) });
          }
        }
      } finally {
        if (cursor) setLoadingMore(false);
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
        description="Governed workspace applications with immutable checked releases, separate from generated HTML Artifacts."
        actions={
          !creating ? (
            <Button
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
            onCancel={() => setCreating(false)}
            onCreated={(app) => {
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
                  : {
                      status: "ready",
                      data: { apps: [app], nextCursor: null, truncated: false },
                    },
              );
              setCreating(false);
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
            No Apps exist in this workspace yet. Create one, then deploy a checked build.
          </EmptyState>
        </div>
      ) : null}
      {state.status === "ready" && state.data.apps.length > 0 ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
  return (
    <Link
      to="/workspaces/$workspaceId/apps/$appId"
      params={{ workspaceId, appId: app.id }}
      className="rounded-xl border border-border bg-surface p-4 outline-none transition-colors hover:bg-surface-2/40 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="rounded-md bg-brand/10 p-2 text-brand">
          <BoxesIcon aria-hidden="true" className="size-4" />
        </span>
        <MetaChip>{app.activeReleaseId ? "Published" : "Draft"}</MetaChip>
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
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState({ status: "loading" });
      try {
        setState({
          status: "ready",
          data: await client.getApp(workspaceId, appId, { signal }),
        });
      } catch (error) {
        if (!signal?.aborted) setState({ status: "error", error: asError(error) });
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

function AppDetailRoute({
  workspaceId,
  appId,
  client,
}: {
  workspaceId: string;
  appId: string;
  client: AppsProductClient;
}) {
  const { state, load, setData } = useAppDetail(workspaceId, appId, client);
  if (state.status === "loading") {
    return (
      <ContentPage width="standard">
        <Skeleton className="h-48" />
      </ContentPage>
    );
  }
  if (state.status === "error") {
    return (
      <ContentPage width="standard">
        <BackToApps workspaceId={workspaceId} />
        <LoadErrorState title="Couldn't load app" error={state.error} onRetry={() => void load()} />
      </ContentPage>
    );
  }
  const detail = state.data;
  const release = detail.app.status === "active" ? publishedRelease(detail) : null;
  return (
    <ContentPage width="standard">
      <BackToApps workspaceId={workspaceId} />
      <PageHeader
        icon={<BoxesIcon aria-hidden="true" className="size-4" />}
        title={detail.app.title}
        description={detail.app.description || "A workspace application."}
        actions={
          release ? (
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
              <dd className="text-right text-fg">{release ? "Published" : "Not published"}</dd>
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
      {!release ? (
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
  client,
}: {
  workspaceId: string;
  appId: string;
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
  const release =
    state.status === "ready" && state.data.app.status === "active"
      ? publishedRelease(state.data)
      : null;
  const releaseId = release?.id ?? null;

  useEffect(() => {
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
      .then((data) => setCatalogState({ status: "ready", data }))
      .catch((error) => {
        if (!abort.signal.aborted) setCatalogState({ status: "error", error: asError(error) });
      });
    return () => abort.abort();
  }, [appId, catalogRevision, client, releaseId, workspaceId]);

  useEffect(() => {
    setConfirmed(false);
    setLaunch(null);
    setLaunchError(null);
  }, [releaseId]);

  const start = async () => {
    if (!release || catalogState?.status !== "ready") return;
    if (catalogState.data.tools.length > 0 && !confirmed) return;
    setBusy(true);
    setLaunchError(null);
    try {
      setLaunch(
        await client.createLaunch(workspaceId, appId, {
          releaseId: release.id,
        }),
      );
    } catch (error) {
      setLaunchError(asError(error));
    } finally {
      setBusy(false);
    }
  };

  if (state.status === "loading") {
    return (
      <ContentPage width="wide">
        <Skeleton className="h-[32rem]" />
      </ContentPage>
    );
  }
  if (state.status === "error") {
    return (
      <ContentPage width="standard">
        <BackToApps workspaceId={workspaceId} />
        <LoadErrorState title="Couldn't load app" error={state.error} onRetry={() => void load()} />
      </ContentPage>
    );
  }
  if (!release) {
    return (
      <ContentPage width="standard">
        <BackToApps workspaceId={workspaceId} />
        <EmptyState>This app has no published release to run.</EmptyState>
      </ContentPage>
    );
  }

  return (
    <ContentPage width="wide" className="min-h-full">
      <BackToApps workspaceId={workspaceId} />
      <PageHeader
        icon={<PlayIcon aria-hidden="true" className="size-4" />}
        title={`Run ${state.data.app.title}`}
        description="Apps run in an isolated frame and receive only the tools confirmed below."
      />
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
        <div role="alert" className="rounded-lg border border-status-failed/40 p-3 text-sm text-fg">
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
          onStop={() => setLaunch(null)}
        />
      ) : null}
    </ContentPage>
  );
}
