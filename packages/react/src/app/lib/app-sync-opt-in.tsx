import type { AppSyncOptInReview, AppSyncStatusResponse } from "@opengeni/sdk";
import { siteConnectCardDismissals } from "@opengeni/sdk/site";
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { Select } from "../../ui/select";
import { useAppApi, type AppApiHost } from "./app-api";
import { cn } from "./utils";

/**
 * Personal sync opt-in in the console. An App asks with
 * `site.data.syncs.optIn(id)`; only this platform-owned confirmation (naming
 * the tool, account and collection) posts the opt-in, after the viewer
 * confirms. The App's frame can't post it itself.
 */

type OptInRequest = {
  syncId: string;
  optedIn: boolean;
  resolve: (result: { optedIn: boolean }) => void;
  reject: (error: unknown) => void;
};

const optInHosts = new Map<string, Set<(request: OptInRequest) => void>>();
const syncListeners = new Map<string, Set<() => void>>();

function notifySiteSyncsChanged(siteId: string): void {
  for (const listener of [...(syncListeners.get(siteId) ?? [])]) {
    try {
      listener();
    } catch {
      // One listener's failure must not stop the others.
    }
  }
}

function subscribe<T>(map: Map<string, Set<T>>, siteId: string, listener: T): () => void {
  const listeners = map.get(siteId) ?? new Set<T>();
  listeners.add(listener);
  map.set(siteId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) map.delete(siteId);
  };
}

/**
 * Ask the console to confirm joining (or leave) one of this App's personal
 * syncs. Resolves the viewer's final state: `optedIn: false` when they cancel.
 */
export function requestSiteSyncOptIn(
  siteId: string,
  syncId: string,
  optedIn: boolean,
  signal?: AbortSignal,
): Promise<{ optedIn: boolean }> {
  const host = [...(optInHosts.get(siteId) ?? [])].at(-1);
  if (!host) return Promise.reject(new Error("Open this app in Opengeni to join its syncs."));
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ optedIn: false });
    signal?.addEventListener("abort", onAbort, { once: true });
    host({
      syncId,
      optedIn,
      resolve: (result) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      },
      reject: (error) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    });
  });
}

function syncsPath(workspaceId: string, siteId: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/published-artifacts/${encodeURIComponent(siteId)}`;
}

async function setOptIn(
  api: AppApiHost,
  workspaceId: string,
  siteId: string,
  syncId: string,
  optedIn: boolean,
  account: string | null,
): Promise<void> {
  await api.request<unknown>(
    `${syncsPath(workspaceId, siteId)}/syncs/${encodeURIComponent(syncId)}/subscription`,
    optedIn
      ? { method: "PUT", body: JSON.stringify(account ? { account } : {}) }
      : { method: "DELETE" },
  );
}

/** What the viewer confirms: the sync, its tool and connector, their account and the collection. */
export function AppSyncOptInDialogView({
  review,
  open,
  account,
  error,
  onAccountChange,
  onOpenChange,
  onConfirm,
}: {
  review: AppSyncOptInReview | null;
  open: boolean;
  account: string | null;
  error: string | null;
  onAccountChange: (account: string) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<boolean>;
}) {
  const accounts = review?.accounts ?? [];
  const chosen = accounts.find((choice) => choice.id === account) ?? accounts[0] ?? null;
  const where = review?.tool.connector ?? review?.tool.toolName ?? "";
  return (
    <ConfirmDialog
      open={open && review !== null}
      onOpenChange={onOpenChange}
      destructive={false}
      title={review ? `Join ${review.name}?` : ""}
      description={
        review
          ? `It reads ${review.tool.toolName}${
              review.tool.connector ? ` from your ${review.tool.connector} account` : ""
            } and fills your own records in ${review.collection}.`
          : undefined
      }
      confirmLabel="Join"
      confirmDisabled={!review || review.blocked !== null}
      onConfirm={onConfirm}
    >
      <div data-app-sync-opt-in="" className="flex flex-col gap-2 text-sm">
        {accounts.length > 1 ? (
          <label className="flex flex-col gap-1">
            <span className="text-fg-muted">Account</span>
            <Select
              value={chosen?.id ?? ""}
              aria-label={`${where} account`}
              onChange={(event) => onAccountChange(event.target.value)}
            >
              {accounts.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </Select>
          </label>
        ) : chosen ? (
          <p className="text-fg-muted">
            Account: <span className="text-fg">{chosen.label}</span>
          </p>
        ) : null}
        {review?.blocked ? <p className="text-fg-muted">{review.blocked}</p> : null}
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

/**
 * The console's answer to an App's `site.data.syncs.optIn/optOut`: the
 * confirmation dialog for joining (leaving needs none). Mount one per App on
 * screen.
 */
export function AppSyncOptInHost({ workspaceId, siteId }: { workspaceId: string; siteId: string }) {
  const api = useAppApi();
  const apiRef = useRef(api);
  apiRef.current = api;
  const [pending, setPending] = useState<OptInRequest | null>(null);
  const [review, setReview] = useState<AppSyncOptInReview | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<OptInRequest | null>(null);

  const settle = useCallback((optedIn: boolean) => {
    pendingRef.current?.resolve({ optedIn });
    pendingRef.current = null;
    setPending(null);
    setReview(null);
    setError(null);
  }, []);

  useEffect(
    () =>
      subscribe(optInHosts, siteId, (request: OptInRequest) => {
        if (!request.optedIn) {
          void setOptIn(apiRef.current, workspaceId, siteId, request.syncId, false, null).then(
            () => {
              notifySiteSyncsChanged(siteId);
              request.resolve({ optedIn: false });
            },
            request.reject,
          );
          return;
        }
        // One confirmation at a time; an earlier one counts as cancelled.
        pendingRef.current?.resolve({ optedIn: false });
        pendingRef.current = request;
        setPending(request);
        setReview(null);
        setError(null);
        apiRef.current
          .request<AppSyncOptInReview>(
            `${syncsPath(workspaceId, siteId)}/syncs/${encodeURIComponent(request.syncId)}/opt-in`,
          )
          .then(
            (value) => {
              if (pendingRef.current !== request) return;
              if (!value || typeof value.syncId !== "string") throw new Error("No such sync");
              if (value.optedIn) return settle(true);
              setReview(value);
              setAccount(value.account ?? value.accounts[0]?.id ?? null);
            },
            (cause: unknown) => {
              if (pendingRef.current !== request) return;
              pendingRef.current = null;
              setPending(null);
              request.reject(cause);
            },
          );
      }),
    [settle, siteId, workspaceId],
  );
  useEffect(() => () => pendingRef.current?.resolve({ optedIn: false }), []);

  return (
    <AppSyncOptInDialogView
      review={review}
      open={pending !== null}
      account={account}
      error={error}
      onAccountChange={setAccount}
      onOpenChange={(open) => {
        if (!open && pendingRef.current) settle(false);
      }}
      onConfirm={async () => {
        const request = pendingRef.current;
        if (!request || !review) return false;
        try {
          await setOptIn(apiRef.current, workspaceId, siteId, request.syncId, true, account);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Couldn't join this sync.");
          return false;
        }
        notifySiteSyncsChanged(siteId);
        settle(true);
        return true;
      }}
    />
  );
}

/** Personal syncs the viewer hasn't joined, one Join button each, and a close button. */
export function AppSyncJoinCardView({
  syncs,
  busyId = null,
  onJoin,
  onDismiss,
  className,
}: {
  syncs: readonly { id: string; name: string }[];
  busyId?: string | null;
  onJoin: (id: string) => void;
  onDismiss: () => void;
  className?: string | undefined;
}) {
  if (syncs.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Personal syncs for this app"
      data-app-sync-join-card=""
      className={cn(
        "pointer-events-auto flex max-w-[min(22rem,calc(100%-1.5rem))] items-start gap-1 rounded-lg border border-border bg-bg p-1.5 shadow-lg",
        className,
      )}
    >
      <ul className="flex min-w-0 flex-col gap-1">
        {syncs.map((sync) => (
          <li key={sync.id} className="min-w-0">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="w-full justify-start truncate"
              disabled={busyId !== null}
              aria-busy={busyId === sync.id}
              onClick={() => onJoin(sync.id)}
            >
              <span className="truncate">{`Join ${sync.name}`}</span>
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
 * The App's personal syncs this viewer hasn't joined (active ones only).
 * Join opens the same confirmation the App's `optIn` does. Closing hides
 * those syncs for this App until a new one appears. A failed read shows nothing.
 */
export function AppSyncJoinCard({
  workspaceId,
  siteId,
  className,
}: {
  workspaceId: string;
  siteId: string;
  className?: string | undefined;
}) {
  const api = useAppApi();
  const apiRef = useRef(api);
  apiRef.current = api;
  const [syncs, setSyncs] = useState<{ id: string; key: string; name: string }[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [reloadToken, setReloadToken] = useState(0);
  const dismissals = useMemo(() => siteConnectCardDismissals(`${siteId}:syncs`), [siteId]);

  useEffect(() => {
    const abort = new AbortController();
    apiRef.current
      .request<AppSyncStatusResponse>(`${syncsPath(workspaceId, siteId)}/data/syncs`, {
        signal: abort.signal,
      })
      .then(
        (response) => {
          if (abort.signal.aborted) return;
          const list = Array.isArray(response?.syncs) ? response.syncs : [];
          setSyncs(
            list
              .filter((sync) => sync.mode === "personal" && sync.active && sync.optedIn === false)
              .map((sync) => ({ id: sync.id, key: `sync:${sync.id}`, name: sync.name })),
          );
        },
        () => {
          if (!abort.signal.aborted) setSyncs([]);
        },
      );
    return () => abort.abort();
  }, [reloadToken, siteId, workspaceId]);
  useEffect(
    () => subscribe(syncListeners, siteId, () => setReloadToken((value) => value + 1)),
    [siteId],
  );

  const visible = useMemo(
    () => dismissals.visible(syncs),
    // Dismissals live in storage; the generation re-reads them.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [dismissals, generation, syncs],
  );
  return (
    <AppSyncJoinCardView
      syncs={visible}
      busyId={busyId}
      className={className}
      onJoin={(id) => {
        setBusyId(id);
        void requestSiteSyncOptIn(siteId, id, true)
          .catch(() => ({ optedIn: false }))
          .finally(() => setBusyId(null));
      }}
      onDismiss={() => {
        dismissals.dismiss(visible.map((sync) => sync.key));
        setGeneration((value) => value + 1);
      }}
    />
  );
}
