import type {
  SiteCapabilityManifest,
  SiteDetailResponse,
  SiteListResponse,
  SiteRuntimeSessionReceipt,
  SiteUsageResponse,
  WorkspaceArtifactContentResponse,
  WorkspaceArtifactListResponse,
} from "@opengeni/sdk";
import type { SiteRuntimeRequest, SiteRuntimeResponse } from "@opengeni/sdk";
import { approvalsFromRequiresAction, type PendingApproval } from "@opengeni/react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArchiveIcon,
  BotIcon,
  Clock3Icon,
  ExternalLinkIcon,
  Globe2Icon,
  PlayIcon,
  RotateCcwIcon,
  RocketIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { request } from "@/api";
import { EmptyState, LoadErrorState, PageHeader } from "@/components/common";
import { SiteRuntimeFrame } from "@/components/sites/site-runtime-frame";
import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAppContext } from "@/context";

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultManifest(model: string): SiteCapabilityManifest {
  return {
    schemaVersion: 1,
    ai: {
      enabled: true,
      defaultModel: model,
      allowedModels: [model],
      reasoningEffort: "medium",
      instructions:
        "You are the AI capability for this OpenGeni Site. Help the signed-in workspace user with the Site's task. Use only the tools and data sources attached to this immutable release, keep answers grounded in available workspace data, and ask for human approval before any consequential write.",
      monthlyBudgetMicros: null,
    },
    integrations: {
      firstPartyPermissions: ["workspace:read", "documents:search", "connections:read"],
      firstPartyTools: ["memory_search"],
      mcpServers: [],
      allowedPersonalConnectionServerIds: [],
    },
    approvals: { writeActions: "platform_prompt" },
    access: { audience: "workspace" },
  };
}

const reasoningEfforts: SiteCapabilityManifest["ai"]["reasoningEffort"][] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

function csv(values: readonly string[]): string {
  return values.join(", ");
}

function parseCsv(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function CapabilityManifestEditor(props: {
  manifest: SiteCapabilityManifest;
  availableModels: readonly string[];
  onChange: (manifest: SiteCapabilityManifest) => void;
}) {
  const updateAi = (ai: Partial<SiteCapabilityManifest["ai"]>) =>
    props.onChange({ ...props.manifest, ai: { ...props.manifest.ai, ...ai } });
  const updateIntegrations = (integrations: Partial<SiteCapabilityManifest["integrations"]>) =>
    props.onChange({
      ...props.manifest,
      integrations: { ...props.manifest.integrations, ...integrations },
    });
  const modelOptions = [
    ...new Set([
      ...props.availableModels,
      ...props.manifest.ai.allowedModels,
      ...(props.manifest.ai.defaultModel ? [props.manifest.ai.defaultModel] : []),
    ]),
  ];

  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-xs font-medium">
          Native AI
          <span className="mt-2 flex h-9 items-center gap-2 rounded-md border border-input px-3">
            <input
              type="checkbox"
              checked={props.manifest.ai.enabled}
              onChange={(event) => updateAi({ enabled: event.target.checked })}
            />
            Enabled for this release
          </span>
        </label>
        <label className="text-xs font-medium">
          Default model
          <select
            className="mt-1 h-9 w-full rounded-md border border-input bg-surface px-3 text-sm"
            value={props.manifest.ai.defaultModel ?? ""}
            onChange={(event) => updateAi({ defaultModel: event.target.value || null })}
          >
            <option value="">No default model</option>
            {modelOptions.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium">
          Reasoning effort
          <select
            className="mt-1 h-9 w-full rounded-md border border-input bg-surface px-3 text-sm"
            value={props.manifest.ai.reasoningEffort}
            onChange={(event) =>
              updateAi({
                reasoningEffort: event.target
                  .value as SiteCapabilityManifest["ai"]["reasoningEffort"],
              })
            }
          >
            {reasoningEfforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-xs font-medium">
        Allowed models (comma separated)
        <input
          className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          value={csv(props.manifest.ai.allowedModels)}
          onChange={(event) => updateAi({ allowedModels: parseCsv(event.target.value) })}
        />
      </label>
      <label className="block text-xs font-medium">
        AI instructions
        <Textarea
          className="mt-1 min-h-36"
          value={props.manifest.ai.instructions}
          onChange={(event) => updateAi({ instructions: event.target.value })}
        />
      </label>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs font-medium">
          First-party permissions (comma separated)
          <input
            className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            value={csv(props.manifest.integrations.firstPartyPermissions)}
            onChange={(event) =>
              updateIntegrations({
                firstPartyPermissions: parseCsv(event.target.value),
              })
            }
          />
        </label>
        <label className="text-xs font-medium">
          First-party tools (comma separated)
          <input
            className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            value={csv(props.manifest.integrations.firstPartyTools)}
            onChange={(event) =>
              updateIntegrations({
                firstPartyTools: parseCsv(event.target.value),
              })
            }
          />
        </label>
        <label className="text-xs font-medium">
          Approved MCP server IDs (comma separated)
          <input
            className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            value={csv(props.manifest.integrations.mcpServers.map((item) => item.id))}
            onChange={(event) => {
              const existing = new Map(
                props.manifest.integrations.mcpServers.map((server) => [server.id, server]),
              );
              updateIntegrations({
                mcpServers: parseCsv(event.target.value).map(
                  (id) => existing.get(id) ?? { kind: "mcp", id, optional: false },
                ),
              });
            }}
          />
        </label>
        <label className="text-xs font-medium">
          Personal Connection server allowlist (comma separated)
          <input
            className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            value={csv(props.manifest.integrations.allowedPersonalConnectionServerIds)}
            onChange={(event) =>
              updateIntegrations({
                allowedPersonalConnectionServerIds: parseCsv(event.target.value),
              })
            }
          />
        </label>
        <label className="text-xs font-medium">
          Write actions
          <select
            className="mt-1 h-9 w-full rounded-md border border-input bg-surface px-3 text-sm"
            value={props.manifest.approvals.writeActions}
            onChange={(event) =>
              props.onChange({
                ...props.manifest,
                approvals: {
                  writeActions: event.target.value as "platform_prompt" | "deny",
                },
              })
            }
          >
            <option value="platform_prompt">Ask in OpenGeni</option>
            <option value="deny">Deny all writes</option>
          </select>
        </label>
        <label className="text-xs font-medium">
          Monthly AI budget (USD, blank = workspace policy)
          <input
            type="number"
            min="0.000001"
            step="1"
            className="mt-1 h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            value={
              props.manifest.ai.monthlyBudgetMicros === null
                ? ""
                : props.manifest.ai.monthlyBudgetMicros / 1_000_000
            }
            onChange={(event) => {
              const dollars = Number(event.target.value);
              updateAi({
                monthlyBudgetMicros:
                  event.target.value && dollars > 0 ? Math.round(dollars * 1_000_000) : null,
              });
            }}
          />
        </label>
      </div>
      <div className="rounded-md bg-surface-2 px-3 py-2 text-xs text-fg-muted">
        Audience is fixed to this workspace. Credentials and API keys are never included in the
        release or sent to the Site iframe.
      </div>
    </div>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

export function SitesRoute(props: { workspaceId: string; siteId?: string; run?: boolean }) {
  if (props.run && props.siteId)
    return <SiteRunRoute workspaceId={props.workspaceId} siteId={props.siteId} />;
  if (props.siteId)
    return <SiteDetailRoute workspaceId={props.workspaceId} siteId={props.siteId} />;
  return <SiteListRoute workspaceId={props.workspaceId} />;
}

function Disabled() {
  return (
    <ContentPage width="standard">
      <Notice title="Sites are not enabled">
        Set <code>OPENGENI_SITES_ENABLED=true</code> on the API and web deployment to test this
        preview. Advanced Deployments remain independently disabled.
      </Notice>
    </ContentPage>
  );
}

function SiteListRoute({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  const enabled = context.clientConfig.sites?.enabled === true;
  const [sites, setSites] = useState<SiteListResponse | null>(null);
  const [artifacts, setArtifacts] = useState<WorkspaceArtifactListResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    artifactId: string;
    artifactVersionId: string;
    title: string;
    manifest: SiteCapabilityManifest;
  } | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      setError(null);
      const [nextSites, nextArtifacts] = await Promise.all([
        request<SiteListResponse>(`/v1/workspaces/${workspaceId}/sites`),
        request<WorkspaceArtifactListResponse>(`/v1/workspaces/${workspaceId}/published-artifacts`),
      ]);
      setSites(nextSites);
      setArtifacts(nextArtifacts);
    } catch (nextError) {
      setError(asError(nextError));
    }
  }, [enabled, workspaceId]);
  useEffect(() => void load(), [load]);
  if (!enabled) return <Disabled />;
  const siteIds = new Set(sites?.sites.map((site) => site.id) ?? []);
  const publish = async () => {
    if (!draft) return;
    setPublishing(draft.artifactId);
    try {
      await request(`/v1/workspaces/${workspaceId}/sites/${draft.artifactId}/releases`, {
        method: "POST",
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedCurrentReleaseId: null,
          artifactVersionId: draft.artifactVersionId,
          manifest: draft.manifest,
          reason: "Initial Site release after capability review",
        }),
      });
      toast.success("Site published");
      setDraft(null);
      await load();
    } catch (nextError) {
      toast.error("Could not publish Site", {
        description: asError(nextError).message,
      });
    } finally {
      setPublishing(null);
    }
  };
  return (
    <ContentPage width="wide">
      <PageHeader
        icon={<Globe2Icon className="size-4" />}
        title="Sites"
        description="Publish workspace HTML as authenticated static apps with native OpenGeni AI and approved integrations—without provisioning a backend per app."
        actions={
          <Link to="/workspaces/$workspaceId/artifacts" params={{ workspaceId }}>
            <Button>
              <RocketIcon className="mr-2 size-4" />
              Build with Geni
            </Button>
          </Link>
        }
      />
      <Notice tone="info" title="Sites-first delivery model">
        OpenGeni hosts the immutable SPA. Data and credentials stay in OpenGeni or their connected
        source; the browser talks through a short-lived page bridge to the Site Runtime Gateway.
      </Notice>
      {!artifacts && !error ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-44" />
          <Skeleton className="h-44" />
        </div>
      ) : null}
      {error ? (
        <LoadErrorState title="Could not load Sites" error={error} onRetry={() => void load()} />
      ) : null}
      {artifacts?.artifacts.length === 0 ? (
        <EmptyState>
          No published HTML artifacts yet. Build one with Geni, then return here to release it as a
          Site.
        </EmptyState>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {artifacts?.artifacts.map((artifact) => {
          const published = siteIds.has(artifact.id);
          return (
            <section key={artifact.id} className="rounded-lg border border-border bg-surface p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="rounded-md bg-brand/10 p-2 text-brand">
                  <Globe2Icon className="size-4" />
                </span>
                <span className="rounded-full bg-surface-2 px-2 py-1 text-2xs text-fg-subtle">
                  {published ? "Live" : "Artifact"}
                </span>
              </div>
              <h2 className="mt-4 font-semibold text-fg">{artifact.title}</h2>
              <p className="mt-1 line-clamp-2 min-h-10 text-sm text-fg-muted">
                {artifact.description || "No description"}
              </p>
              <p className="mt-3 flex items-center gap-1 text-2xs text-fg-subtle">
                <Clock3Icon className="size-3" />
                Updated {formatDate(artifact.updatedAt)}
              </p>
              <div className="mt-4 flex gap-2">
                {published ? (
                  <Link
                    to="/workspaces/$workspaceId/sites/$siteId"
                    params={{ workspaceId, siteId: artifact.id }}
                  >
                    <Button size="sm">Manage</Button>
                  </Link>
                ) : (
                  <Button
                    size="sm"
                    disabled={!artifact.currentVersion || publishing === artifact.id}
                    onClick={() => {
                      if (!artifact.currentVersion) return;
                      setDraft({
                        artifactId: artifact.id,
                        artifactVersionId: artifact.currentVersion.id,
                        title: artifact.title,
                        manifest: defaultManifest(context.clientConfig.defaultModel),
                      });
                    }}
                  >
                    <RocketIcon className="mr-2 size-3.5" />
                    Configure &amp; publish
                  </Button>
                )}
                <Link
                  to="/workspaces/$workspaceId/artifacts/$artifactId"
                  params={{ workspaceId, artifactId: artifact.id }}
                >
                  <Button variant="outline" size="sm">
                    Artifact
                  </Button>
                </Link>
              </div>
            </section>
          );
        })}
      </div>
      {draft ? (
        <section className="mt-4 rounded-lg border border-brand/30 bg-surface p-4">
          <h2 className="text-sm font-semibold">Review capabilities for {draft.title}</h2>
          <p className="mt-1 text-xs text-fg-muted">
            Publishing freezes this artifact version and capability ceiling into release 1.
          </p>
          <CapabilityManifestEditor
            manifest={draft.manifest}
            availableModels={context.clientConfig.allowedModels}
            onChange={(manifest) =>
              setDraft((current) => (current ? { ...current, manifest } : null))
            }
          />
          <div className="mt-4 flex gap-2">
            <Button
              disabled={publishing === draft.artifactId || !draft.manifest.ai.instructions.trim()}
              onClick={() => void publish()}
            >
              <RocketIcon className="mr-2 size-4" />
              {publishing === draft.artifactId ? "Publishing…" : "Publish immutable release"}
            </Button>
            <Button variant="outline" disabled={Boolean(publishing)} onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </section>
      ) : null}
    </ContentPage>
  );
}

function SiteDetailRoute({ workspaceId, siteId }: { workspaceId: string; siteId: string }) {
  const context = useAppContext();
  const enabled = context.clientConfig.sites?.enabled === true;
  const [detail, setDetail] = useState<SiteDetailResponse | null>(null);
  const [usage, setUsage] = useState<SiteUsageResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [manifest, setManifest] = useState<SiteCapabilityManifest | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      const [nextDetail, nextUsage] = await Promise.all([
        request<SiteDetailResponse>(`/v1/workspaces/${workspaceId}/sites/${siteId}`),
        request<SiteUsageResponse>(`/v1/workspaces/${workspaceId}/sites/${siteId}/usage`),
      ]);
      setDetail(nextDetail);
      setUsage(nextUsage);
      setManifest(nextDetail.currentRelease?.manifest ?? null);
      setError(null);
    } catch (nextError) {
      setError(asError(nextError));
    }
  }, [enabled, siteId, workspaceId]);
  useEffect(() => void load(), [load]);
  if (!enabled) return <Disabled />;
  const publish = async () => {
    if (!detail?.currentRelease || !manifest) return;
    setBusy(true);
    try {
      await request(`/v1/workspaces/${workspaceId}/sites/${siteId}/releases`, {
        method: "POST",
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedCurrentReleaseId: detail.site.currentReleaseId,
          artifactVersionId: detail.currentRelease.artifactVersionId,
          manifest,
          reason: "Updated Site capability manifest",
        }),
      });
      toast.success("New Site release published");
      await load();
    } catch (nextError) {
      toast.error("Could not publish release", {
        description: asError(nextError).message,
      });
    } finally {
      setBusy(false);
    }
  };
  const rollback = async (releaseId: string) => {
    if (!detail?.site.currentReleaseId) return;
    setBusy(true);
    try {
      await request(`/v1/workspaces/${workspaceId}/sites/${siteId}/rollback`, {
        method: "POST",
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedCurrentReleaseId: detail.site.currentReleaseId,
          releaseId,
          reason: "Rolled back from Site release history",
        }),
      });
      toast.success("Site rolled back");
      await load();
    } catch (nextError) {
      toast.error("Could not roll back", {
        description: asError(nextError).message,
      });
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    if (!detail?.site.currentReleaseId) return;
    if (!window.confirm("Archive this Site? Its stable URL will stop admitting new AI work."))
      return;
    setBusy(true);
    try {
      await request(`/v1/workspaces/${workspaceId}/sites/${siteId}/archive`, {
        method: "POST",
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          expectedCurrentReleaseId: detail.site.currentReleaseId,
          reason: "Archived from the Site management surface",
        }),
      });
      toast.success("Site archived");
      await load();
    } catch (nextError) {
      toast.error("Could not archive Site", {
        description: asError(nextError).message,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <ContentPage width="wide">
      <Link
        to="/workspaces/$workspaceId/sites"
        params={{ workspaceId }}
        className="inline-flex items-center gap-1 text-xs text-fg-muted"
      >
        <ArrowLeftIcon className="size-3.5" />
        Back to Sites
      </Link>
      {error ? (
        <LoadErrorState title="Could not load Site" error={error} onRetry={() => void load()} />
      ) : null}
      {!detail && !error ? <Skeleton className="h-96" /> : null}
      {detail ? (
        <>
          <PageHeader
            icon={<Globe2Icon className="size-4" />}
            title={detail.site.title}
            description={detail.site.description || "Authenticated OpenGeni Site"}
            actions={
              <div className="flex gap-2">
                {detail.site.status === "active" ? (
                  <>
                    <Button variant="outline" disabled={busy} onClick={() => void archive()}>
                      <ArchiveIcon className="mr-2 size-4" />
                      Archive
                    </Button>
                    <Link
                      to="/workspaces/$workspaceId/sites/$siteId/run"
                      params={{ workspaceId, siteId }}
                    >
                      <Button>
                        <PlayIcon className="mr-2 size-4" />
                        Open Site
                      </Button>
                    </Link>
                  </>
                ) : (
                  <span className="rounded-full bg-surface-2 px-3 py-2 text-xs text-fg-muted">
                    Archived
                  </span>
                )}
              </div>
            }
          />
          {detail.site.status === "archived" ? (
            <Notice title="This Site is archived">
              The stable Site route remains authenticated but no new runtime work is admitted.
              Release and audit evidence is retained.
            </Notice>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-3">
            <section className="rounded-lg border border-border bg-surface p-4">
              <ShieldCheckIcon className="size-4 text-brand" />
              <h2 className="mt-2 text-sm font-semibold">Access</h2>
              <p className="mt-1 text-sm text-fg-muted">
                Workspace-authenticated. The iframe receives no credential or cookie.
              </p>
            </section>
            <section className="rounded-lg border border-border bg-surface p-4">
              <BotIcon className="size-4 text-brand" />
              <h2 className="mt-2 text-sm font-semibold">Native AI</h2>
              <p className="mt-1 text-sm text-fg-muted">
                {detail.currentRelease?.manifest.ai.defaultModel ?? "Disabled"} · durable sessions
              </p>
            </section>
            <section className="rounded-lg border border-border bg-surface p-4">
              <Clock3Icon className="size-4 text-brand" />
              <h2 className="mt-2 text-sm font-semibold">Usage this month</h2>
              <p className="mt-1 text-sm text-fg-muted">
                {usage?.modelCalls ?? 0} calls · {usage?.totalTokens ?? 0} tokens
              </p>
            </section>
          </div>
          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold">Release capabilities</h2>
            <p className="mt-1 text-xs text-fg-muted">
              This becomes an immutable manifest on publish. MCP server IDs resolve only through
              OpenGeni’s configured integration authority.
            </p>
            {manifest ? (
              <CapabilityManifestEditor
                manifest={manifest}
                availableModels={context.clientConfig.allowedModels}
                onChange={setManifest}
              />
            ) : null}
            <Button
              className="mt-4"
              disabled={
                busy || !manifest?.ai.instructions.trim() || detail.site.status === "archived"
              }
              onClick={() => void publish()}
            >
              <RocketIcon className="mr-2 size-4" />
              Publish new release
            </Button>
          </section>
          <section className="rounded-lg border border-border bg-surface p-4">
            <h2 className="text-sm font-semibold">Release history</h2>
            <div className="mt-2 divide-y divide-border">
              {detail.releases.map((release) => (
                <div key={release.id} className="flex items-center justify-between py-3 text-sm">
                  <div>
                    <span className="font-medium">Release {release.revision}</span>
                    <p className="text-xs text-fg-subtle">
                      {formatDate(release.createdAt)} · {release.manifestHash.slice(0, 20)}…
                    </p>
                  </div>
                  {release.id !== detail.site.currentReleaseId ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void rollback(release.id)}
                    >
                      <RotateCcwIcon className="mr-2 size-3.5" />
                      Rollback
                    </Button>
                  ) : (
                    <span className="text-xs text-brand">Current</span>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}
    </ContentPage>
  );
}

function SiteRunRoute({ workspaceId, siteId }: { workspaceId: string; siteId: string }) {
  const context = useAppContext();
  const enabled = context.clientConfig.sites?.enabled === true;
  const [detail, setDetail] = useState<SiteDetailResponse | null>(null);
  const [content, setContent] = useState<WorkspaceArtifactContentResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [approval, setApproval] = useState<(PendingApproval & { sessionId: string }) | null>(null);
  const streamControllers = useRef(new Map<string, AbortController>());
  useEffect(
    () => () => {
      for (const controller of streamControllers.current.values()) controller.abort();
    },
    [],
  );
  useEffect(() => {
    if (!enabled) return;
    void (async () => {
      try {
        const nextDetail = await request<SiteDetailResponse>(
          `/v1/workspaces/${workspaceId}/sites/${siteId}`,
        );
        if (!nextDetail.currentRelease) throw new Error("Site has no active release");
        const nextContent = await request<WorkspaceArtifactContentResponse>(
          `/v1/workspaces/${workspaceId}/published-artifacts/${nextDetail.site.artifactId}/content?versionId=${nextDetail.currentRelease.artifactVersionId}`,
        );
        setDetail(nextDetail);
        setContent(nextContent);
      } catch (nextError) {
        setError(asError(nextError));
      }
    })();
  }, [enabled, siteId, workspaceId]);
  const onRequest = useCallback(
    async (runtimeRequest: SiteRuntimeRequest, emit: (value: SiteRuntimeResponse) => void) => {
      if (runtimeRequest.method === "ai.start") {
        const receipt = await request<SiteRuntimeSessionReceipt>(
          `/v1/workspaces/${workspaceId}/sites/${siteId}/runtime/sessions`,
          {
            method: "POST",
            body: JSON.stringify({
              operationId: crypto.randomUUID(),
              initialMessage: runtimeRequest.params.message,
              ...(runtimeRequest.params.model ? { model: runtimeRequest.params.model } : {}),
              ...(runtimeRequest.params.modelContext
                ? { modelContext: runtimeRequest.params.modelContext }
                : {}),
            }),
          },
        );
        const controller = new AbortController();
        streamControllers.current.set(receipt.sessionId, controller);
        void (async () => {
          try {
            for await (const event of context.client.streamEvents(workspaceId, receipt.sessionId, {
              signal: controller.signal,
            })) {
              if (event.type === "session.requiresAction") {
                const [pending] = approvalsFromRequiresAction(event.payload);
                if (pending) setApproval({ ...pending, sessionId: receipt.sessionId });
              }
              if (
                event.type === "user.approvalDecision" ||
                event.type === "turn.completed" ||
                event.type === "turn.failed" ||
                event.type === "turn.cancelled"
              )
                setApproval(null);
              emit({ type: "event", sessionId: receipt.sessionId, event });
            }
          } catch (streamError) {
            if (!controller.signal.aborted)
              emit({
                type: "event",
                sessionId: receipt.sessionId,
                event: {
                  type: "site.runtime.stream_failed",
                  message: asError(streamError).message,
                },
              });
          } finally {
            streamControllers.current.delete(receipt.sessionId);
          }
        })();
        return receipt;
      }
      if (runtimeRequest.method === "ai.send")
        return await request(
          `/v1/workspaces/${workspaceId}/sites/${siteId}/runtime/sessions/${runtimeRequest.params.runtimeSessionId}/messages`,
          {
            method: "POST",
            body: JSON.stringify({
              text: runtimeRequest.params.text,
              clientEventId: crypto.randomUUID(),
            }),
          },
        );
      await context.client.controlSession(workspaceId, runtimeRequest.params.sessionId, {
        action: "cancel",
        reason: "Cancelled from Site runtime",
        clientEventId: crypto.randomUUID(),
      });
      return { cancelled: true };
    },
    [context.client, siteId, workspaceId],
  );
  const decide = async (decision: "approve" | "reject") => {
    if (!approval) return;
    await context.client.sendApprovalDecision(workspaceId, approval.sessionId, {
      approvalId: approval.id,
      decision,
      clientEventId: crypto.randomUUID(),
    });
    setApproval(null);
  };
  if (!enabled) return <Disabled />;
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-surface">
      <header className="flex h-12 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2">
          <Link to="/workspaces/$workspaceId/sites/$siteId" params={{ workspaceId, siteId }}>
            <Button variant="ghost" size="sm">
              <ArrowLeftIcon className="mr-2 size-3.5" />
              Manage
            </Button>
          </Link>
          <span className="text-sm font-semibold">{detail?.site.title ?? "Site"}</span>
          <span className="rounded-full bg-brand/10 px-2 py-0.5 text-2xs text-brand">
            Workspace authenticated
          </span>
        </div>
        <ExternalLinkIcon className="size-4 text-fg-subtle" />
      </header>
      {approval ? (
        <div className="border-b border-status-waiting/30 bg-status-waiting/[0.06] p-3">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold">Approval required outside the Site</p>
              <p className="text-xs text-fg-muted">
                {approval.name}{" "}
                {approval.arguments ? `· ${JSON.stringify(approval.arguments).slice(0, 240)}` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void decide("reject")}>
                Reject
              </Button>
              <Button size="sm" onClick={() => void decide("approve")}>
                Approve once
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {error ? (
        <div className="p-4">
          <LoadErrorState
            title="Could not open Site"
            error={error}
            onRetry={() => window.location.reload()}
          />
        </div>
      ) : null}
      {!content || !detail ? (
        !error ? (
          <Skeleton className="m-4 flex-1" />
        ) : null
      ) : (
        <SiteRuntimeFrame
          html={content.html}
          title={detail.site.title}
          className="min-h-0 flex-1 border-0 bg-white"
          onRequest={onRequest}
        />
      )}
    </div>
  );
}
