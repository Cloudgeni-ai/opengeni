import type {
  AppAvailableRuntimeCatalogResponse,
  AppRelease,
  AppToolPolicyRevision,
  OpenGeniAppsClient,
  WorkspaceApp,
  WorkspaceAppDetailResponse,
} from "@opengeni/sdk/apps";
import {
  ArchiveIcon,
  DownloadIcon,
  EyeIcon,
  Loader2Icon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  ShieldCheckIcon,
  UploadCloudIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  ContentSurface,
  ContentSurfaceHeader,
  FormField,
  FormGrid,
} from "@/components/ui/content-layout";
import { FormDisclosure } from "@/components/ui/form-disclosure";
import { Input } from "@/components/ui/input";
import { MetaChip } from "@/components/ui/meta-chip";
import { Textarea } from "@/components/ui/textarea";

const NUMBER_FORMAT = new Intl.NumberFormat();

export type AppsManagementClient = Pick<
  OpenGeniAppsClient,
  | "createApp"
  | "updateApp"
  | "getAvailableRuntimeCatalog"
  | "createToolPolicy"
  | "getSourceDownload"
  | "createPreview"
  | "publish"
  | "rollback"
  | "unpublish"
  | "archive"
>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function useUnsavedChanges(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
}

function latestToolPolicy(detail: WorkspaceAppDetailResponse): AppToolPolicyRevision | null {
  let latest: AppToolPolicyRevision | null = null;
  for (const policy of detail.toolPolicies) {
    if (!latest || policy.revision > latest.revision) latest = policy;
  }
  return latest;
}

function toolKey(identity: { serverId: string; toolName: string }): string {
  return `${identity.serverId}\u0000${identity.toolName}`;
}

export function releaseMutationKind(
  detail: WorkspaceAppDetailResponse,
  target: AppRelease,
): "publish" | "rollback" {
  const active = detail.releases.find((release) => release.id === detail.app.activeReleaseId);
  return active && target.revision < active.revision ? "rollback" : "publish";
}

export function AppCreatePanel({
  workspaceId,
  client,
  onCreated,
  onCancel,
}: {
  workspaceId: string;
  client: Pick<AppsManagementClient, "createApp">;
  onCreated: (app: WorkspaceApp) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  useUnsavedChanges(!busy && Boolean(title || slug || description));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const result = await client.createApp(workspaceId, {
        title: normalizedTitle,
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        ...(description ? { description } : {}),
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success("App created", {
        description: `${result.app.title} is ready for a build.`,
      });
      onCreated(result.app);
    } catch (error) {
      const message = errorMessage(error);
      setFormError(message);
      toast.error("Couldn't create app", { description: message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ContentSurface className="mt-4">
      <ContentSurfaceHeader
        title="Create an app"
        description="Create the workspace record now, then upload a checked immutable build with og-app."
      />
      <form
        aria-label="Create app"
        className="mt-4 grid gap-4"
        onSubmit={(event) => void submit(event)}
      >
        <FormGrid>
          <FormField label="Name">
            <Input
              name="app-title"
              value={title}
              maxLength={120}
              autoComplete="off"
              required
              onChange={(event) => setTitle(event.target.value)}
            />
          </FormField>
          <FormField
            label="URL slug (optional)"
            hint="Lowercase letters, numbers, and hyphens. Leave blank to derive it from the name."
          >
            <Input
              name="app-slug"
              value={slug}
              maxLength={96}
              autoComplete="off"
              pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
              placeholder="e.g. status-console…"
              spellCheck={false}
              onChange={(event) => setSlug(event.target.value)}
            />
          </FormField>
        </FormGrid>
        <FormField label="Description (optional)">
          <Textarea
            name="app-description"
            value={description}
            maxLength={2_000}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
          />
        </FormField>
        {formError ? (
          <p role="alert" className="text-sm text-status-failed">
            {formError}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onCancel}
            className="pointer-coarse:min-h-11"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={busy || !title.trim()}
            className="pointer-coarse:min-h-11"
          >
            {busy ? (
              <Loader2Icon aria-hidden="true" className="animate-spin" />
            ) : (
              <PlusIcon aria-hidden="true" />
            )}
            {busy ? "Creating…" : "Create app"}
          </Button>
        </div>
      </form>
    </ContentSurface>
  );
}

function AppMetadataEditor({
  workspaceId,
  detail,
  client,
  onRefresh,
}: {
  workspaceId: string;
  detail: WorkspaceAppDetailResponse;
  client: Pick<AppsManagementClient, "updateApp">;
  onRefresh: () => Promise<void>;
}) {
  const [title, setTitle] = useState(detail.app.title);
  const [description, setDescription] = useState(detail.app.description ?? "");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const changed =
    title.trim() !== detail.app.title || description !== (detail.app.description ?? "");
  useUnsavedChanges(changed && !busy);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!title.trim() || !changed || busy) return;
    setBusy(true);
    setFormError(null);
    try {
      await client.updateApp(workspaceId, detail.app.id, {
        title: title.trim(),
        description: description || null,
        expectedVersion: detail.app.version,
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success("App details saved");
      await onRefresh();
    } catch (error) {
      const message = errorMessage(error);
      setFormError(message);
      toast.error("Couldn't save app details", {
        description: message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ContentSurface>
      <ContentSurfaceHeader title="App details" description={`Stable slug: ${detail.app.slug}`} />
      <form
        aria-label={`Edit ${detail.app.title}`}
        className="mt-4 grid gap-4"
        onSubmit={(event) => void submit(event)}
      >
        <FormField label="Name">
          <Input
            name="app-title"
            value={title}
            maxLength={120}
            autoComplete="off"
            required
            onChange={(event) => setTitle(event.target.value)}
          />
        </FormField>
        <FormField label="Description">
          <Textarea
            name="app-description"
            value={description}
            maxLength={2_000}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
          />
        </FormField>
        {formError ? (
          <p role="alert" className="text-sm text-status-failed">
            {formError}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button
            type="submit"
            size="sm"
            disabled={busy || !title.trim() || !changed}
            className="pointer-coarse:min-h-11"
          >
            {busy ? (
              <Loader2Icon aria-hidden="true" className="animate-spin" />
            ) : (
              <SaveIcon aria-hidden="true" />
            )}
            {busy ? "Saving…" : "Save details"}
          </Button>
        </div>
      </form>
    </ContentSurface>
  );
}

function AppToolPolicyEditor({
  workspaceId,
  detail,
  client,
  onDetailChange,
}: {
  workspaceId: string;
  detail: WorkspaceAppDetailResponse;
  client: Pick<AppsManagementClient, "getAvailableRuntimeCatalog" | "createToolPolicy">;
  onDetailChange: (detail: WorkspaceAppDetailResponse) => void;
}) {
  const currentPolicy = latestToolPolicy(detail);
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<
    | { status: "loading" }
    | { status: "ready"; data: AppAvailableRuntimeCatalogResponse }
    | { status: "error"; error: Error }
    | null
  >(null);
  const [selected, setSelected] = useState(
    () => new Set((currentPolicy?.allowedTools ?? []).map(toolKey)),
  );
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || catalog !== null) return;
    const abort = new AbortController();
    setCatalog({ status: "loading" });
    void client
      .getAvailableRuntimeCatalog(workspaceId, detail.app.id, {
        signal: abort.signal,
      })
      .then((data) => setCatalog({ status: "ready", data }))
      .catch((error) => {
        if (!abort.signal.aborted) {
          setCatalog({
            status: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      });
    return () => abort.abort();
  }, [catalog, client, detail.app.id, open, workspaceId]);

  const availableKeys = useMemo(
    () =>
      new Set(
        catalog?.status === "ready" ? catalog.data.tools.map((tool) => toolKey(tool.identity)) : [],
      ),
    [catalog],
  );
  const unavailableSelections = (currentPolicy?.allowedTools ?? []).filter(
    (identity) => !availableKeys.has(toolKey(identity)),
  ).length;

  const save = async () => {
    if (catalog?.status !== "ready" || busy) return;
    setBusy(true);
    setSaveError(null);
    try {
      const allowedTools = catalog.data.tools
        .filter((tool) => selected.has(toolKey(tool.identity)))
        .map((tool) => tool.identity);
      const next = await client.createToolPolicy(workspaceId, detail.app.id, {
        allowedTools,
        catalogDigest: catalog.data.catalogDigest,
        expectedAppVersion: detail.app.version,
        idempotencyKey: crypto.randomUUID(),
      });
      toast.success("App tool access updated", {
        description:
          allowedTools.length === 0
            ? "The next release will run without OpenGeni tools."
            : `${formatCount(allowedTools.length)} read-only ${allowedTools.length === 1 ? "tool" : "tools"} selected.`,
      });
      onDetailChange(next);
      setOpen(false);
    } catch (error) {
      const message = errorMessage(error);
      setSaveError(message);
      toast.error("Couldn't update app tools", {
        description: message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ContentSurface>
      <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <ShieldCheckIcon aria-hidden="true" className="size-4 text-brand" />
        Tool access
      </h2>
      <p className="mt-2 text-sm leading-5 text-fg-muted">
        Apps can receive only closed-world, read-only, replay-safe tools that require no approval.
      </p>
      <div className="mt-3">
        <FormDisclosure
          title="Allowed tools"
          summary={
            currentPolicy
              ? `${formatCount(currentPolicy.allowedTools.length)} selected in policy revision ${formatCount(currentPolicy.revision)}`
              : "No policy yet"
          }
          open={open}
          onOpenChange={setOpen}
        >
          {catalog?.status === "loading" ? (
            <div role="status" className="flex items-center gap-2 text-sm text-fg-muted">
              <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
              Loading available tools…
            </div>
          ) : null}
          {catalog?.status === "error" ? (
            <div role="alert" className="grid gap-2 text-sm text-status-failed">
              <span>{catalog.error.message}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setCatalog(null)}
                className="pointer-coarse:min-h-11"
              >
                Retry
              </Button>
            </div>
          ) : null}
          {catalog?.status === "ready" && catalog.data.tools.length === 0 ? (
            <p className="text-sm text-fg-muted">No App-safe tools are available right now.</p>
          ) : null}
          {catalog?.status === "ready" && catalog.data.tools.length > 0 ? (
            <div className="max-h-80 space-y-1 overflow-y-auto pr-1 [content-visibility:auto]">
              {catalog.data.tools.map((tool) => {
                const key = toolKey(tool.identity);
                return (
                  <label
                    key={key}
                    className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-surface-2/50"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 accent-brand"
                      checked={selected.has(key)}
                      onChange={(event) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(key);
                          else next.delete(key);
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0">
                      <span className="block break-words text-sm font-medium text-fg">
                        {tool.title ?? tool.identity.toolName}
                      </span>
                      <span
                        translate="no"
                        className="mt-0.5 block break-words text-xs text-fg-muted"
                      >
                        {tool.identity.serverId}/{tool.identity.toolName}
                        {tool.description ? ` — ${tool.description}` : ""}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          ) : null}
          {catalog?.status === "ready" && unavailableSelections > 0 ? (
            <p className="text-xs leading-5 text-status-waiting">
              {formatCount(unavailableSelections)} previously selected{" "}
              {unavailableSelections === 1 ? "tool is" : "tools are"} no longer available and will
              be removed if you save.
            </p>
          ) : null}
          {saveError ? (
            <p role="alert" className="text-sm text-status-failed">
              {saveError}
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={catalog?.status !== "ready" || busy}
              onClick={() => void save()}
              className="pointer-coarse:min-h-11"
            >
              {busy ? (
                <Loader2Icon aria-hidden="true" className="animate-spin" />
              ) : (
                <WrenchIcon aria-hidden="true" />
              )}
              {busy ? "Saving…" : "Save tool access"}
            </Button>
          </div>
        </FormDisclosure>
      </div>
    </ContentSurface>
  );
}

function AppAuthoringStatus({
  workspaceId,
  detail,
  client,
}: {
  workspaceId: string;
  detail: WorkspaceAppDetailResponse;
  client: Pick<AppsManagementClient, "getSourceDownload">;
}) {
  const [downloading, setDownloading] = useState(false);
  const latestSource = [...detail.sourceRevisions]
    .sort((left, right) => right.revision - left.revision)
    .find((source) => source.status === "ready");
  const recentBuilds = [...detail.builds]
    .sort((left, right) => right.revision - left.revision)
    .slice(0, 5);

  const download = async () => {
    if (!latestSource || downloading) return;
    setDownloading(true);
    try {
      const response = await client.getSourceDownload(workspaceId, detail.app.id, latestSource.id);
      window.open(response.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error("Couldn't download app source", {
        description: errorMessage(error),
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <ContentSurface>
      <ContentSurfaceHeader
        title="Immutable builds"
        description="Source and build bytes are verified before a release can be promoted."
        actions={
          latestSource?.status === "ready" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={downloading}
              onClick={() => void download()}
              className="pointer-coarse:min-h-11"
            >
              {downloading ? (
                <Loader2Icon aria-hidden="true" className="animate-spin" />
              ) : (
                <DownloadIcon aria-hidden="true" />
              )}
              {downloading ? "Preparing…" : "Download source"}
            </Button>
          ) : undefined
        }
      />
      {recentBuilds.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border p-3 text-sm text-fg-muted">
          No builds yet. Run <code className="font-mono text-xs">og-app deploy</code> from the
          checked source directory.
        </div>
      ) : (
        <div className="mt-3 divide-y divide-border/70">
          {recentBuilds.map((build) => (
            <div
              key={build.id}
              className="flex min-w-0 items-center justify-between gap-3 py-2.5 text-sm"
            >
              <span className="min-w-0">
                <span className="block font-medium text-fg">Build {build.revision}</span>
                <span className="block truncate text-xs text-fg-muted">
                  {formatCount(build.fileCount)} files · {formatDate(build.createdAt)}
                </span>
              </span>
              <MetaChip>{build.status}</MetaChip>
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 rounded-md bg-surface-2/50 p-3 text-xs leading-5 text-fg-muted">
        <div className="font-medium text-fg">CLI handoff</div>
        <code translate="no" className="mt-1 block break-all font-mono">
          og-app deploy . --workspace {workspaceId} --app-id {detail.app.id}
        </code>
      </div>
    </ContentSurface>
  );
}

function AppReleaseManager({
  workspaceId,
  detail,
  client,
  onRefresh,
}: {
  workspaceId: string;
  detail: WorkspaceAppDetailResponse;
  client: Pick<
    AppsManagementClient,
    "createPreview" | "publish" | "rollback" | "unpublish" | "archive"
  >;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"unpublish" | "archive" | null>(null);
  const releases = [...detail.releases].sort((left, right) => right.revision - left.revision);
  const activeRelease =
    releases.find((release) => release.id === detail.app.activeReleaseId) ?? null;
  const mutable = detail.app.status === "active";

  const preview = async (release: AppRelease) => {
    const action = `preview:${release.id}`;
    setBusy(action);
    setActionError(null);
    try {
      const result = await client.createPreview(workspaceId, detail.app.id, {
        releaseId: release.id,
        idempotencyKey: crypto.randomUUID(),
      });
      setPreviewUrls((current) => ({ ...current, [release.id]: result.url }));
      toast.success("Preview ready", {
        description: `Release ${release.revision} has a private preview link.`,
      });
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      toast.error("Couldn't create preview", {
        description: message,
      });
    } finally {
      setBusy(null);
    }
  };

  const activate = async (release: AppRelease) => {
    const kind = releaseMutationKind(detail, release);
    const action = `${kind}:${release.id}`;
    setBusy(action);
    setActionError(null);
    try {
      const request = {
        releaseId: release.id,
        expectedAppVersion: detail.app.version,
        reason:
          kind === "rollback"
            ? `Roll back to release ${release.revision} from the OpenGeni console`
            : `Publish release ${release.revision} from the OpenGeni console`,
        idempotencyKey: crypto.randomUUID(),
      };
      if (kind === "rollback") await client.rollback(workspaceId, detail.app.id, request);
      else await client.publish(workspaceId, detail.app.id, request);
      toast.success(kind === "rollback" ? "App rolled back" : "App published", {
        description: `Release ${release.revision} is now live.`,
      });
      await onRefresh();
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      toast.error(kind === "rollback" ? "Couldn't roll back app" : "Couldn't publish app", {
        description: message,
      });
    } finally {
      setBusy(null);
    }
  };

  const destructive = async (): Promise<boolean> => {
    if (!confirmation) return false;
    const action = confirmation;
    setBusy(action);
    setActionError(null);
    try {
      if (action === "unpublish") {
        await client.unpublish(workspaceId, detail.app.id, {
          expectedAppVersion: detail.app.version,
          reason: "Unpublish from the OpenGeni console",
          idempotencyKey: crypto.randomUUID(),
        });
        toast.success("App unpublished");
      } else {
        await client.archive(workspaceId, detail.app.id, {
          expectedAppVersion: detail.app.version,
          reason: "Archive from the OpenGeni console",
          idempotencyKey: crypto.randomUUID(),
        });
        toast.success("App archived");
      }
      await onRefresh();
      return true;
    } catch (error) {
      const message = errorMessage(error);
      setActionError(message);
      toast.error(action === "unpublish" ? "Couldn't unpublish app" : "Couldn't archive app", {
        description: message,
      });
      return false;
    } finally {
      setBusy(null);
    }
  };

  return (
    <ContentSurface className="sm:col-span-2">
      <ContentSurfaceHeader
        title="Releases"
        description="Preview a frozen release, make it live, or restore a prior verified version."
        actions={
          <div className="flex flex-wrap gap-2">
            {activeRelease ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null || !mutable}
                onClick={() => setConfirmation("unpublish")}
                className="pointer-coarse:min-h-11"
              >
                Unpublish
              </Button>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy !== null || !mutable}
              onClick={() => setConfirmation("archive")}
              className="pointer-coarse:min-h-11"
            >
              <ArchiveIcon aria-hidden="true" />
              Archive app
            </Button>
          </div>
        }
      />
      {actionError ? (
        <p role="alert" className="mt-3 text-sm text-status-failed">
          {actionError}
        </p>
      ) : null}
      {releases.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border p-3 text-sm text-fg-muted">
          No releases yet. A checked build must succeed before it can be promoted.
        </div>
      ) : (
        <div className="mt-3 divide-y divide-border/70">
          {releases.map((release) => {
            const active = release.id === detail.app.activeReleaseId;
            const kind = releaseMutationKind(detail, release);
            return (
              <div
                key={release.id}
                className="grid min-w-0 gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">Release {release.revision}</span>
                    {active ? <MetaChip>Live</MetaChip> : null}
                  </div>
                  <p className="mt-1 text-xs text-fg-muted">
                    {formatCount(release.fileCount)} files · {formatDate(release.createdAt)}
                  </p>
                  {previewUrls[release.id] ? (
                    <a
                      href={previewUrls[release.id]}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex text-xs font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      Open preview
                    </a>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Create preview for release ${release.revision}`}
                    disabled={busy !== null || !mutable}
                    onClick={() => void preview(release)}
                    className="pointer-coarse:min-h-11"
                  >
                    {busy === `preview:${release.id}` ? (
                      <Loader2Icon aria-hidden="true" className="animate-spin" />
                    ) : (
                      <EyeIcon aria-hidden="true" />
                    )}
                    {busy === `preview:${release.id}` ? "Creating…" : "Preview"}
                  </Button>
                  {!active ? (
                    <Button
                      type="button"
                      size="sm"
                      aria-label={`${kind === "rollback" ? "Roll back to" : "Publish"} release ${release.revision}`}
                      disabled={busy !== null || !mutable}
                      onClick={() => void activate(release)}
                      className="pointer-coarse:min-h-11"
                    >
                      {busy === `${kind}:${release.id}` ? (
                        <Loader2Icon aria-hidden="true" className="animate-spin" />
                      ) : kind === "rollback" ? (
                        <RotateCcwIcon aria-hidden="true" />
                      ) : (
                        <UploadCloudIcon aria-hidden="true" />
                      )}
                      {busy === `${kind}:${release.id}`
                        ? kind === "rollback"
                          ? "Rolling back…"
                          : "Publishing…"
                        : kind === "rollback"
                          ? "Roll back"
                          : "Publish"}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open) => (open ? undefined : setConfirmation(null))}
        title={
          confirmation === "unpublish"
            ? `Unpublish ${detail.app.title}?`
            : `Archive ${detail.app.title}?`
        }
        description={
          confirmation === "unpublish"
            ? "New launches will stop, but immutable releases and history remain available for a later publish or rollback."
            : "The app will leave the active inventory. Its immutable source, builds, releases, and audit history are retained."
        }
        confirmLabel={confirmation === "unpublish" ? "Unpublish app" : "Archive app"}
        cancelAutoFocus
        onConfirm={destructive}
      />
    </ContentSurface>
  );
}

export function AppManagementPanel({
  workspaceId,
  detail,
  client,
  onDetailChange,
  onRefresh,
}: {
  workspaceId: string;
  detail: WorkspaceAppDetailResponse;
  client: AppsManagementClient;
  onDetailChange: (detail: WorkspaceAppDetailResponse) => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      {detail.app.status === "active" ? (
        <AppMetadataEditor
          key={`metadata:${detail.app.version}`}
          workspaceId={workspaceId}
          detail={detail}
          client={client}
          onRefresh={onRefresh}
        />
      ) : (
        <ContentSurface>
          <ContentSurfaceHeader
            title="App details"
            description={`Stable slug: ${detail.app.slug}`}
          />
          <dl className="mt-3 grid gap-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-fg-subtle">Name</dt>
              <dd className="text-right text-fg">{detail.app.title}</dd>
            </div>
            <div className="grid gap-1">
              <dt className="text-fg-subtle">Description</dt>
              <dd className="text-fg">{detail.app.description || "No description"}</dd>
            </div>
          </dl>
        </ContentSurface>
      )}
      {detail.app.status === "active" ? (
        <AppToolPolicyEditor
          key={`policy:${detail.app.version}`}
          workspaceId={workspaceId}
          detail={detail}
          client={client}
          onDetailChange={onDetailChange}
        />
      ) : (
        <ContentSurface>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
            <ShieldCheckIcon aria-hidden="true" className="size-4 text-brand" />
            Tool access
          </h2>
          <p className="mt-2 text-sm leading-5 text-fg-muted">
            This app is archived. Its last tool-policy revision remains in the audit history and
            cannot be changed.
          </p>
        </ContentSurface>
      )}
      <AppAuthoringStatus workspaceId={workspaceId} detail={detail} client={client} />
      <ContentSurface>
        <h2 className="text-sm font-semibold text-fg">Lifecycle summary</h2>
        <dl className="mt-3 grid gap-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-fg-subtle">Status</dt>
            <dd className="text-right capitalize text-fg">{detail.app.status}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-fg-subtle">Sources</dt>
            <dd className="text-right text-fg">{formatCount(detail.sourceRevisions.length)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-fg-subtle">Builds</dt>
            <dd className="text-right text-fg">{formatCount(detail.builds.length)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-fg-subtle">Releases</dt>
            <dd className="text-right text-fg">{formatCount(detail.releases.length)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-fg-subtle">Previews</dt>
            <dd className="text-right text-fg">{formatCount(detail.previews.length)}</dd>
          </div>
        </dl>
      </ContentSurface>
      <AppReleaseManager
        workspaceId={workspaceId}
        detail={detail}
        client={client}
        onRefresh={onRefresh}
      />
    </div>
  );
}
