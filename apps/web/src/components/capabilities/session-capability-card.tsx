import { attachSessionCapability } from "./attach-session-capability";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionMcpCapabilityCard, type AuthNeededItem } from "@opengeni/react";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SessionCapabilityFrame } from "./session-capability-frame";
import { capabilityLogoSource } from "./capability-logo-source";
import { DetailBody, type ConnectAction } from "./capability-detail-sheet";
import { performCapabilityAction } from "./perform-capability-action";
import { useCapabilitiesCatalog } from "./use-capabilities-catalog";
import { SessionCustomMcpCard } from "./session-custom-mcp-card";
import { capabilityConnectPlan, capabilityErrorToast, connectionHealth } from "@/lib/capabilities";
import { hasWorkspacePermission } from "@/lib/permissions";
import type { CapabilityCatalogItem } from "@/types";

const CodexSubscriptionsCard = lazy(async () => ({
  default: (await import("@/components/codex-connection")).CodexSubscriptionsCard,
}));

/** Recommendations carry identity and rationale, never connection configuration.
 * Expand against the current authenticated catalog before rendering any form. */
type SessionCapabilityCardProps = {
  visibility?: "private" | "workspace";
  onConfigured?: (() => Promise<void>) | undefined;
  item: AuthNeededItem;
  workspaceId: string;
  sessionId: string;
};

export function SessionCapabilityCard(props: SessionCapabilityCardProps) {
  const context = useAppContext();
  const [registered, setRegistered] = useState<{ id: string; restoreFocus: boolean } | null>(null);
  const onRegistered = useCallback(
    (id: string, restoreFocus: boolean) => setRegistered({ id, restoreFocus }),
    [],
  );
  if (props.item.setupRequest && !registered) {
    return (
      <SessionCustomMcpCard
        key={`${props.workspaceId}:${props.item.id}`}
        item={props.item}
        workspaceId={props.workspaceId}
        onRegistered={onRegistered}
      />
    );
  }
  const item = registered
    ? {
        ...props.item,
        setupRequest: null,
        capability: {
          id: registered.id,
          name: props.item.setupRequest!.name,
          kind: "mcp" as const,
          source: "manual" as const,
          action: "connect" as const,
          rationale: props.item.setupRequest!.rationale,
          requiredVariables: [],
        },
      }
    : props.item;
  const capability = item.capability;
  const resolved = context.workspaceCapabilityCatalog.find((entry) => entry.id === capability?.id);
  if (capability && resolved?.kind === "mcp" && resolved.authKind === "oauth2") {
    return (
      <SessionMcpCapabilityCard
        client={context.client}
        workspaceId={props.workspaceId}
        sessionId={props.sessionId}
        capabilityId={capability.id}
        name={capability.name}
        rationale={capability.rationale}
        returnUrl={window.location.href}
        onConfigured={props.onConfigured}
      />
    );
  }
  return (
    <ScopedSessionCapabilityCard
      key={`${props.workspaceId}:${props.sessionId}:${capability!.id}`}
      {...props}
      item={item}
      restoreFocus={registered?.restoreFocus ?? false}
    />
  );
}

function ScopedSessionCapabilityCard({
  item,
  workspaceId,
  sessionId,
  onConfigured,
  restoreFocus = false,
}: SessionCapabilityCardProps & { restoreFocus?: boolean }) {
  const context = useAppContext();
  const refreshGitHub = context.refreshGitHub;
  const recommendation = item.capability!;
  const [expanded, setExpanded] = useState(false);
  const [complete, setComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [resolvedItem, setResolvedItem] = useState<CapabilityCatalogItem | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const githubInFlight = useRef(false);
  const githubRequestSequence = useRef(0);
  const active = useRef(true);
  const github = recommendation.id === "api:github-app";
  useEffect(() => {
    if (!restoreFocus) return;
    // The review dialog's opener is removed when the new connection card
    // replaces it. Focus the next actionable control after Radix closes it.
    const frame = requestAnimationFrame(() => opener.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [restoreFocus]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (github && context.githubStatus) setComplete(context.githubStatus.status === "bound");
  }, [github, context.githubStatus]);
  useEffect(() => {
    if (!github) return;
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || !githubInFlight.current) return;
      // A cancelled authorization can restore this exact React tree from the
      // back/forward cache. Its prior request must not navigate or settle a
      // newer attempt after the card becomes usable again.
      githubRequestSequence.current += 1;
      githubInFlight.current = false;
      setBusy(false);
      void refreshGitHub(workspaceId);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [github, refreshGitHub, workspaceId]);
  const catalogItem =
    resolvedItem ??
    context.workspaceCapabilityCatalog.find((entry) => entry.id === recommendation.id);
  const logo = catalogItem
    ? capabilityLogoSource(catalogItem, (path) => context.client.catalogAssetUrl(path))
    : github
      ? capabilityLogoSource({ id: recommendation.id, logoAssetPath: null }, () => null)
      : null;
  const close = () => {
    setExpanded(false);
  };
  const skill = recommendation.kind === "skill";
  const apiKey = catalogItem ? capabilityConnectPlan(catalogItem).mode === "api_key" : false;
  async function connectGitHub() {
    if (githubInFlight.current) return;
    const requestSequence = ++githubRequestSequence.current;
    githubInFlight.current = true;
    setBusy(true);
    setGithubError(null);
    let navigating = false;
    try {
      const status = await context.client.getGitHubApp(workspaceId, {
        returnPath: `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
      });
      if (!active.current || requestSequence !== githubRequestSequence.current) return;
      if (status.status === "bound") {
        setComplete(true);
        void context.refreshGitHub(workspaceId);
        return;
      }
      if (!status.linkUrl)
        throw new Error(
          status.configured
            ? "Your account cannot manage this workspace's GitHub connection."
            : "GitHub is not configured on this deployment.",
        );
      navigating = true;
      window.location.assign(status.linkUrl);
    } catch (failure) {
      navigating = false;
      if (active.current && requestSequence === githubRequestSequence.current) {
        setGithubError(
          failure instanceof Error ? failure.message : "Couldn't start GitHub setup. Try again.",
        );
        setExpanded(true);
      }
    } finally {
      if (requestSequence === githubRequestSequence.current && !navigating) {
        githubInFlight.current = false;
        if (active.current) setBusy(false);
      }
    }
  }
  return (
    <SessionCapabilityFrame
      name={catalogItem?.name ?? recommendation.name}
      subtitle={catalogItem ? (catalogItem.providerDomain ?? "") : item.providerDomain}
      logo={logo}
      typeLabel={skill ? "Skill" : recommendation.kind === "mcp" ? "MCP server" : "API"}
      description={catalogItem?.description || recommendation.rationale}
      skill={skill}
      expanded={expanded}
      complete={complete}
      completeLabel={github ? "Connected to this workspace" : undefined}
      actionLabel={
        github && busy
          ? "Opening GitHub…"
          : catalogItem?.enabled
            ? "Review"
            : skill
              ? "Review skill"
              : apiKey
                ? "Add API key"
                : `Connect ${catalogItem?.name ?? recommendation.name}`
      }
      opensDialog={!github}
      note={
        github
          ? "Choose which account and repositories this workspace can access on GitHub."
          : skill
            ? "Skill content is reviewed separately from permission to use any integration."
            : apiKey
              ? "Add credentials in the protected form, not in a chat message."
              : "Review access before signing in. You'll return to this conversation after authorization."
      }
      onOpen={() => (github ? void connectGitHub() : setExpanded(true))}
      onClose={close}
      busy={busy}
      opener={opener}
      cardRef={cardRef}
    >
      {github ? (
        <SessionGitHubSetup
          busy={busy}
          error={githubError}
          onRetry={() => void connectGitHub()}
          onClose={close}
        />
      ) : recommendation.id === "mcp:codex_apps" ? (
        <SessionCodexAppsSetup
          busy={busy}
          setBusy={setBusy}
          workspaceId={workspaceId}
          sessionId={sessionId}
          onClose={close}
          onComplete={() => {
            setComplete(true);
            close();
          }}
        />
      ) : (
        <SessionCapabilitySetup
          busy={busy}
          setBusy={setBusy}
          key={`${workspaceId}:${sessionId}:${recommendation.id}`}
          capabilityId={recommendation.id}
          onResolvedItem={setResolvedItem}
          onConfigured={onConfigured}
          workspaceId={workspaceId}
          sessionId={sessionId}
          onClose={close}
          onComplete={() => {
            setComplete(true);
            close();
          }}
        />
      )}
    </SessionCapabilityFrame>
  );
}

function SessionCapabilitySetup({
  busy,
  setBusy,
  capabilityId,
  onResolvedItem,
  onConfigured,
  workspaceId,
  sessionId,
  onClose,
  onComplete,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  capabilityId: string;
  onResolvedItem: (item: CapabilityCatalogItem) => void;
  onConfigured?: (() => Promise<void>) | undefined;
  workspaceId: string;
  sessionId: string;
  onClose: () => void;
  onComplete: () => void;
}) {
  const context = useAppContext();
  const catalog = useCapabilitiesCatalog(workspaceId);
  const canReadConnections =
    context.accessContext === null
      ? null
      : hasWorkspacePermission(context.accessContext, workspaceId, "connections:read");
  const [error, setError] = useState<string | null>(null);
  const [authInspection, setAuthInspection] = useState<{
    id: string;
    url: string;
    kind: "oauth2" | "none" | "unknown";
  } | null>(null);
  const inFlight = useRef(false);
  const scope = useRef({
    client: context.client,
    workspaceId,
    sessionId,
    canReadConnections,
    alive: true,
  });
  if (
    scope.current.client !== context.client ||
    scope.current.workspaceId !== workspaceId ||
    scope.current.sessionId !== sessionId ||
    scope.current.canReadConnections !== canReadConnections
  ) {
    scope.current = {
      client: context.client,
      workspaceId,
      sessionId,
      canReadConnections,
      alive: true,
    };
  }
  useEffect(() => {
    const activeScope = scope.current;
    void catalog.refresh();
    return () => {
      activeScope.alive = false;
    };
    // Refetch on a live read-grant change; the hook masks prior rows during render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.client, workspaceId, sessionId, canReadConnections]);
  const rawItem = catalog.items.find((entry) => entry.id === capabilityId);
  const rawItemId = rawItem?.id;
  const inspectUrl = rawItem?.mcpUrl ?? rawItem?.endpointUrl;
  const needsAuthInspection =
    rawItem?.kind === "mcp" &&
    !rawItem.enabled &&
    capabilityConnectPlan(rawItem).mode === "setup_required" &&
    Boolean(inspectUrl);
  useEffect(() => {
    if (!needsAuthInspection || !rawItemId || !inspectUrl) return;
    let active = true;
    setAuthInspection(null);
    void context.client.inspectMcpAuthentication(workspaceId, inspectUrl).then(
      (result) => {
        if (active) setAuthInspection({ id: rawItemId, url: inspectUrl, kind: result.kind });
      },
      () => {
        if (active) setAuthInspection({ id: rawItemId, url: inspectUrl, kind: "unknown" });
      },
    );
    return () => {
      active = false;
    };
  }, [context.client, workspaceId, rawItemId, inspectUrl, needsAuthInspection]);
  const item = useMemo(() => {
    if (!rawItem || !needsAuthInspection) return rawItem;
    const inspection =
      authInspection?.id === rawItem.id && authInspection.url === inspectUrl
        ? authInspection.kind
        : "checking";
    return {
      ...rawItem,
      authKind:
        inspection === "oauth2"
          ? ("oauth2" as const)
          : inspection === "none"
            ? ("none" as const)
            : null,
      metadata: { ...rawItem.metadata, authDiscovery: inspection },
    };
  }, [rawItem, needsAuthInspection, inspectUrl, authInspection]);
  useEffect(() => {
    if (item) onResolvedItem(item);
  }, [item, onResolvedItem]);
  const refreshRuntime = useCallback(() => {
    void context.refreshWorkspaceMcpServers(workspaceId);
  }, [context, workspaceId]);
  async function act(action: ConnectAction) {
    if (!item || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const invocation = scope.current;
    const current = () => scope.current === invocation && invocation.alive;
    try {
      await performCapabilityAction(
        {
          client: context.client,
          workspaceId,
          item,
          connections: catalog.connectionsLoadFailed ? null : catalog.connections,
          canManageSkills: hasWorkspacePermission(
            context.accessContext,
            workspaceId,
            "capabilities:manage",
          ),
          refresh: catalog.refresh,
          onRuntimeChanged: () => {
            if (current()) refreshRuntime();
          },
          onComplete: async () => {
            if (!current()) return;
            const updated = (await context.client.listCapabilities(workspaceId)).items.find(
              (entry) => entry.id === item.id,
            );
            if (!current()) return;
            if (!updated?.enabled)
              throw new Error("Setup could not be verified. Refresh and try again.");
            await attachSessionCapability(context.client, workspaceId, sessionId, updated, current);
            await onConfigured?.();
            if (current()) onComplete();
          },
          onSkillRemoval: () => {
            throw new Error(
              "Use the workspace Skill controls to review removal and its other owners.",
            );
          },
          returnPathFor: (id) =>
            `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}?capability_auth=${encodeURIComponent(id)}`,
          redirect: (url) => {
            if (current()) window.location.assign(url);
          },
        },
        action,
      );
    } catch (failure) {
      // A credential may have committed before enabling failed. Reconcile before
      // offering Retry so it reuses that row instead of minting a duplicate.
      if (current()) await catalog.refresh();
      if (current()) setError(capabilityErrorToast(failure, "Couldn't complete setup").description);
    } finally {
      inFlight.current = false;
      if (current()) setBusy(false);
    }
  }
  async function useConnected() {
    if (!item || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const invocation = scope.current;
    const current = () => scope.current === invocation && invocation.alive;
    try {
      await attachSessionCapability(context.client, workspaceId, sessionId, item, current);
      if (current()) await onConfigured?.();
      if (current()) onComplete();
    } catch (failure) {
      if (current())
        setError(
          failure instanceof Error ? failure.message : "Couldn't add this connection. Try again.",
        );
    } finally {
      inFlight.current = false;
      if (current()) setBusy(false);
    }
  }
  const ownsActionRow =
    !catalog.loadError && item && !item.enabled && (item.kind === "skill" || item.kind === "mcp");
  const health = item
    ? connectionHealth(item, catalog.connections ?? [], catalog.connections !== null)
    : null;
  return (
    <div className="p-6 sm:p-8">
      {catalog.loading && !item ? (
        <p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2Icon className="size-4 animate-spin" />
          Loading connection details…
        </p>
      ) : catalog.loadError || !item ? (
        <Notice
          tone="failed"
          action={
            <Button size="sm" onClick={() => void catalog.refresh()}>
              Retry
            </Button>
          }
        >
          {catalog.loadError
            ? "Couldn't load the integration catalog."
            : "This recommendation is no longer in the current catalog."}
        </Notice>
      ) : (
        <DetailBody
          setupOnly
          showIdentity={false}
          onCancel={ownsActionRow ? onClose : undefined}
          item={item}
          health={connectionHealth(item, catalog.connections ?? [], catalog.connections !== null)}
          logoSrc={capabilityLogoSource(item, (path) => context.client.catalogAssetUrl(path))}
          busy={busy}
          errorMessage={error}
          socialConnections={catalog.socialConnections}
          canManageSocial={hasWorkspacePermission(
            context.accessContext,
            workspaceId,
            "connections:write",
          )}
          canManageSkills={hasWorkspacePermission(
            context.accessContext,
            workspaceId,
            "capabilities:manage",
          )}
          onAction={(action) => void act(action)}
        />
      )}
      <div className="mt-2 flex justify-end gap-2">
        {!ownsActionRow ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        ) : null}
        {item?.enabled && health?.state !== "attention" && health?.state !== "unverified" ? (
          <Button size="sm" disabled={busy} onClick={() => void useConnected()}>
            {busy ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}Add tools
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SessionGitHubSetup({
  busy,
  error,
  onRetry,
  onClose,
}: {
  busy: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3 p-6 sm:p-8">
      <p className="text-xs leading-[1.7] text-fg-muted">
        Choose the account and repositories to share with this workspace on GitHub, then return to
        this conversation.
      </p>
      {error ? <Notice tone="failed">{error}</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={onRetry}>
          {busy ? <Loader2Icon className="animate-spin" /> : null}Try again
        </Button>
      </div>
    </div>
  );
}

function SessionCodexAppsSetup({
  busy,
  setBusy,
  workspaceId,
  sessionId,
  onClose,
  onComplete,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  workspaceId: string;
  sessionId: string;
  onClose: () => void;
  onComplete: () => void;
}) {
  const context = useAppContext();
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const active = useRef(true);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  async function useApps() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const catalog = await context.client.listCapabilities(workspaceId);
      const item = catalog.items.find((entry) => entry.id === "mcp:codex_apps");
      if (!active.current) return;
      if (!item?.enabled || !item.runtime.available)
        throw new Error("Choose an active subscription for Codex Apps before continuing.");
      await attachSessionCapability(
        context.client,
        workspaceId,
        sessionId,
        item,
        () => active.current,
      );
      await context.refreshWorkspaceMcpServers(workspaceId);
      if (active.current) onComplete();
    } catch (failure) {
      if (active.current)
        setError(
          failure instanceof Error ? failure.message : "Couldn't enable Apps in this conversation.",
        );
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className="p-6 sm:p-8">
      <Suspense fallback={<p role="status">Loading connection controls…</p>}>
        <CodexSubscriptionsCard
          workspaceId={workspaceId}
          canManage={hasWorkspacePermission(
            context.accessContext,
            workspaceId,
            "connections:write",
          )}
        />
      </Suspense>
      {error ? <Notice tone="failed">{error}</Notice> : null}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void useApps()}>
          {busy ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}Use in this conversation
        </Button>
      </div>
    </div>
  );
}
