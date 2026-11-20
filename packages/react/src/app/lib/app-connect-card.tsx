import type { ToolGatewaySiteSetupItem, ToolGatewaySiteSetupResponse } from "@opengeni/sdk";
import { siteConnectCardDismissals, siteConnectCardLabel } from "@opengeni/sdk/site";
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../ui/button";
import { useAppApi } from "./app-api";
import {
  notifySiteToolReadinessChanged,
  subscribeSiteConnectCardShow,
  subscribeSiteToolReadiness,
} from "./console-site";
import { useSiteToolConsentHost, type SiteToolConsentHost } from "./site-tool-consent";
import { cn } from "./utils";

/**
 * Run one card item's single action with the console's own dialogs: Connect
 * opens the connect card, Reconnect signs that same account in again. The
 * same dialogs a Site call opens; resolves whether it finished.
 */
export async function runSiteConnectCardItem(
  consent: Pick<SiteToolConsentHost, "connectForToolCall" | "recoverToolCall">,
  workspaceId: string,
  item: ToolGatewaySiteSetupItem,
  signal: AbortSignal,
): Promise<boolean> {
  if (!item.capabilityId) return false;
  if (item.action === "connect")
    return await consent.connectForToolCall({
      connect: { capabilityId: item.capabilityId, name: item.connector, providerDomain: "" },
      signal,
      workspaceId,
    });
  if (!item.connectionId) return false;
  return await consent.recoverToolCall({
    failure: {
      code: "site_tool_reconnect_required",
      system: item.connector,
      message: `Sign in to ${item.connector} again to continue.`,
      reconnect: {
        connectionId: item.connectionId,
        capabilityId: item.capabilityId,
        name: item.connector,
        shared: item.shared,
      },
      retryable: false,
      detail: "",
      sourceCode: null,
    },
    signal,
    workspaceId,
  });
}

/**
 * The card itself: one button per tool still to connect, and a close button.
 * Nothing when there is nothing to connect.
 */
export function AppConnectCardView({
  items,
  busyKey = null,
  onConnect,
  onDismiss,
  className,
}: {
  items: readonly Pick<ToolGatewaySiteSetupItem, "key" | "action" | "connector" | "account">[];
  busyKey?: string | null;
  onConnect: (key: string) => void;
  onDismiss: () => void;
  className?: string | undefined;
}) {
  if (items.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Connect tools for this app"
      data-app-connect-card=""
      className={cn(
        "pointer-events-auto flex max-w-[min(22rem,calc(100%-1.5rem))] items-start gap-1 rounded-lg border border-border bg-bg p-1.5 shadow-lg",
        className,
      )}
    >
      <ul className="flex min-w-0 flex-col gap-1">
        {items.map((item) => (
          <li key={item.key} className="min-w-0">
            <Button
              type="button"
              size="sm"
              className="w-full justify-start truncate"
              disabled={busyKey !== null}
              aria-busy={busyKey === item.key}
              title={item.account ?? undefined}
              onClick={() => onConnect(item.key)}
            >
              <span className="truncate">{siteConnectCardLabel(item)}</span>
            </Button>
          </li>
        ))}
      </ul>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss"
        className="text-fg-muted hover:text-fg"
        onClick={onDismiss}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/**
 * The platform's connect card for an App open in the console, built from the
 * tools its current version declares: what this viewer still has to connect
 * or reconnect, one click each. Closing it hides those items for this App
 * until something new is missing or the App asks to show it again. Reads
 * nothing it can't show: a failed read shows nothing.
 */
export function AppConnectCard({
  workspaceId,
  siteId,
  versionId,
  connectKey,
  onConnectKeyHandled,
  className,
}: {
  workspaceId: string;
  siteId: string;
  /** The version on screen; no card without one. */
  versionId: string | null | undefined;
  /** Open this item's connect dialog once loaded (`?connect=` from a published App). */
  connectKey?: string | undefined;
  onConnectKeyHandled?: (() => void) | undefined;
  className?: string | undefined;
}) {
  const api = useAppApi();
  // Read through a ref: a new host object alone is no reason to read again.
  const apiRef = useRef(api);
  apiRef.current = api;
  const consent = useSiteToolConsentHost();
  const [items, setItems] = useState<ToolGatewaySiteSetupItem[] | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [dismissedGeneration, setDismissedGeneration] = useState(0);
  const dismissals = useMemo(() => siteConnectCardDismissals(siteId), [siteId]);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  useEffect(() => {
    if (!versionId) {
      setItems(null);
      return;
    }
    const abort = new AbortController();
    apiRef.current
      .request<ToolGatewaySiteSetupResponse>(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/tools/site-setup`,
        {
          method: "POST",
          signal: abort.signal,
          body: JSON.stringify({ siteArtifactId: siteId, siteVersionId: versionId }),
        },
      )
      .then(
        (response) => {
          if (!abort.signal.aborted) setItems(Array.isArray(response?.items) ? response.items : []);
        },
        () => {
          // The card is advisory: an answer it can't read shows nothing.
          if (!abort.signal.aborted) setItems([]);
        },
      );
    return () => abort.abort();
  }, [reloadToken, siteId, versionId, workspaceId]);

  // Connecting finishes in another window: read again on return, and when
  // anything in the console changes what this viewer can do here.
  useEffect(() => {
    const stop = subscribeSiteToolReadiness(siteId, reload);
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => {
      stop();
      window.removeEventListener("focus", onFocus);
    };
  }, [reload, siteId]);

  useEffect(
    () =>
      subscribeSiteConnectCardShow(siteId, () => {
        dismissals.reset();
        setDismissedGeneration((value) => value + 1);
        reload();
      }),
    [dismissals, reload, siteId],
  );

  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  const connect = useCallback(
    (key: string) => {
      const item = items?.find((candidate) => candidate.key === key);
      if (!item || !consent || running.current) return;
      const abort = new AbortController();
      running.current = abort;
      setBusyKey(key);
      void runSiteConnectCardItem(consent, workspaceId, item, abort.signal)
        .catch(() => false)
        .then((done) => {
          if (done) notifySiteToolReadinessChanged(siteId);
        })
        .finally(() => {
          if (running.current === abort) running.current = null;
          setBusyKey(null);
          reload();
        });
    },
    [consent, items, reload, siteId, workspaceId],
  );

  // Arrived from a published App's "Connect": open that dialog once.
  const handledKey = useRef<string | null>(null);
  useEffect(() => {
    if (!connectKey || !items || handledKey.current === connectKey) return;
    handledKey.current = connectKey;
    onConnectKeyHandled?.();
    if (items.some((item) => item.key === connectKey)) connect(connectKey);
  }, [connect, connectKey, items, onConnectKeyHandled]);

  const visible = useMemo(
    () => (items ? dismissals.visible(items) : []),
    // Dismissals live in storage; the generation re-reads them.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [dismissals, dismissedGeneration, items],
  );
  if (!consent || visible.length === 0) return null;
  return (
    <AppConnectCardView
      items={visible}
      busyKey={busyKey}
      onConnect={connect}
      onDismiss={() => {
        dismissals.dismiss(visible.map((item) => item.key));
        setDismissedGeneration((value) => value + 1);
      }}
      className={className}
    />
  );
}
