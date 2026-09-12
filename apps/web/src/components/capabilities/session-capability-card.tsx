import { authorizeSessionPersonalConnection } from "./session-connection-authority";
import { attachSessionCapability } from "./attach-session-capability";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { AuthNeededItem } from "@opengeni/react";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { useAppContext } from "@/context";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SessionCapabilityFrame } from "./session-capability-frame";
import { capabilityLogoSource } from "./capability-logo-source";
import { DetailBody, type ConnectAction } from "./capability-detail-sheet";
import { performCapabilityAction } from "./perform-capability-action";
import { useCapabilitiesCatalog } from "./use-capabilities-catalog";
import { capabilityConnectPlan, capabilityErrorToast, connectionHealth } from "@/lib/capabilities";
import { hasWorkspacePermission } from "@/lib/permissions";
import type { CapabilityCatalogItem } from "@/types";

const CodexSubscriptionsCard = lazy(async () => ({
  default: (await import("@/components/codex-connection")).CodexSubscriptionsCard,
}));

/** Recommendations carry identity and rationale, never connection configuration.
 * Expand against the current authenticated catalog before rendering any form. */
export function SessionCapabilityCard({
  item,
  workspaceId,
  sessionId,
  visibility = "workspace",
  onConfigured,
}: {
  visibility?: "private" | "workspace";
  onConfigured?: (() => Promise<void>) | undefined;
  item: AuthNeededItem;
  workspaceId: string;
  sessionId: string;
}) {
  const context = useAppContext();
  const recommendation = item.capability!;
  const [expanded, setExpanded] = useState(false);
  const [complete, setComplete] = useState(false);
  const [resolvedItem, setResolvedItem] = useState<CapabilityCatalogItem | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLElement>(null);
  const catalogItem =
    resolvedItem ??
    context.workspaceCapabilityCatalog.find((entry) => entry.id === recommendation.id);
  const logo = catalogItem
    ? capabilityLogoSource(catalogItem, (path) => context.client.catalogAssetUrl(path))
    : null;
  const close = () => {
    setExpanded(false);
    requestAnimationFrame(() => (opener.current ?? cardRef.current)?.focus());
  };
  const skill = recommendation.kind === "skill";
  const apiKey = catalogItem ? capabilityConnectPlan(catalogItem).mode === "api_key" : false;
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
      actionLabel={
        catalogItem?.enabled
          ? "Review"
          : skill
            ? "Review skill"
            : apiKey
              ? "Add API key"
              : `Connect ${catalogItem?.name ?? recommendation.name}`
      }
      note={
        skill
          ? "Skill content is reviewed separately from permission to use any integration."
          : apiKey
            ? "Add credentials in the protected form, not in a chat message."
            : "Review access before signing in. You'll return to this conversation after authorization."
      }
      onOpen={() => setExpanded(true)}
      opener={opener}
      cardRef={cardRef}
    >
      {recommendation.id === "api:github-app" ? (
        <SessionGitHubSetup
          workspaceId={workspaceId}
          sessionId={sessionId}
          onClose={close}
          onComplete={() => {
            setComplete(true);
            close();
          }}
        />
      ) : recommendation.id === "mcp:codex_apps" ? (
        <SessionCodexAppsSetup
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
          key={`${workspaceId}:${sessionId}:${recommendation.id}`}
          capabilityId={recommendation.id}
          onResolvedItem={setResolvedItem}
          visibility={visibility}
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
  capabilityId,
  onResolvedItem,
  visibility,
  onConfigured,
  workspaceId,
  sessionId,
  onClose,
  onComplete,
}: {
  capabilityId: string;
  onResolvedItem: (item: CapabilityCatalogItem) => void;
  visibility: "private" | "workspace";
  onConfigured?: (() => Promise<void>) | undefined;
  workspaceId: string;
  sessionId: string;
  onClose: () => void;
  onComplete: () => void;
}) {
  const context = useAppContext();
  const catalog = useCapabilitiesCatalog(workspaceId);
  const [sharedAcknowledged, setSharedAcknowledged] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const scope = useRef({ client: context.client, workspaceId, sessionId, alive: true });
  scope.current = { client: context.client, workspaceId, sessionId, alive: true };
  useEffect(() => {
    void catalog.refresh();
    return () => {
      scope.current.alive = false;
    };
    // Catalog refresh is intentionally invoked once per mounted scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context.client, workspaceId, sessionId]);
  const item = catalog.items.find((entry) => entry.id === capabilityId);
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
    const current = () =>
      scope.current.alive &&
      scope.current.client === invocation.client &&
      scope.current.workspaceId === invocation.workspaceId &&
      scope.current.sessionId === invocation.sessionId;
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
            if (updated.connectionRef?.subjectScope === "subject") {
              setNotice(
                "Your account is connected. Choose how to use it in this conversation below.",
              );
              return;
            }
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
    const current = () =>
      scope.current.alive &&
      scope.current.client === invocation.client &&
      scope.current.workspaceId === invocation.workspaceId &&
      scope.current.sessionId === invocation.sessionId;
    try {
      if (item.connectionRef?.subjectScope === "subject") {
        await authorizeSessionPersonalConnection(
          context.client,
          workspaceId,
          sessionId,
          item,
          visibility,
          sharedAcknowledged,
          current,
        );
      }
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
    <div>
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
          inline
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
      {notice ? (
        <p role="status" className="mt-2 text-xs text-fg-muted">
          {notice}
        </p>
      ) : null}
      {item?.enabled && item.connectionRef?.subjectScope === "subject" ? (
        <div className="mt-3 text-xs text-fg-muted">
          {visibility === "workspace" ? (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={sharedAcknowledged}
                onChange={(event) => setSharedAcknowledged(event.target.checked)}
                disabled={busy}
                className="mt-0.5 size-4"
              />
              <span>
                Allow this conversation to use my personal account. Results shared here will be
                visible to other workspace members.
              </span>
            </label>
          ) : (
            <p>
              Allow your personal account only in this private conversation and its continuations.
            </p>
          )}
        </div>
      ) : null}
      <div className="mt-2 flex justify-end gap-2">
        {!ownsActionRow ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        ) : null}
        {item?.enabled && health?.state !== "attention" && health?.state !== "unverified" ? (
          <Button
            size="sm"
            disabled={
              busy ||
              (item.connectionRef?.subjectScope === "subject" &&
                visibility === "workspace" &&
                !sharedAcknowledged)
            }
            onClick={() => void useConnected()}
          >
            {busy ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}Use in this
            conversation
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function SessionGitHubSetup({
  workspaceId,
  sessionId,
  onClose,
  onComplete,
}: {
  workspaceId: string;
  sessionId: string;
  onClose: () => void;
  onComplete: () => void;
}) {
  const { client } = useAppContext();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  async function connect() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const status = await client.getGitHubApp(workspaceId, {
        returnPath: `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`,
      });
      if (!active.current) return;
      if (status.status === "bound") {
        onComplete();
        return;
      }
      if (!status.linkUrl)
        throw new Error(
          status.configured
            ? "Your account cannot manage this workspace's GitHub connection."
            : "GitHub is not configured on this deployment.",
        );
      window.location.assign(status.linkUrl);
    } catch (failure) {
      if (active.current)
        setError(
          failure instanceof Error ? failure.message : "Couldn't start GitHub setup. Try again.",
        );
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-xs leading-[1.7] text-fg-muted">
        Choose the account and repositories to share with this workspace on GitHub, then return to
        this conversation.
      </p>
      {error ? <Notice tone="failed">{error}</Notice> : null}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void connect()}>
          {busy ? <Loader2Icon className="animate-spin" /> : null}Continue to GitHub
        </Button>
      </div>
    </div>
  );
}

function SessionCodexAppsSetup({
  workspaceId,
  sessionId,
  onClose,
  onComplete,
}: {
  workspaceId: string;
  sessionId: string;
  onClose: () => void;
  onComplete: () => void;
}) {
  const context = useAppContext();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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
    <div>
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
