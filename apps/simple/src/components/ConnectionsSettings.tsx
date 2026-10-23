import {
  authorizeConnectAttempt,
  ConnectController,
  ConnectPopupClosedError,
  reserveBrowserConnectNavigation,
  type ConnectAccount,
} from "@opengeni/connect";
import { FIRST_PARTY_CAPABILITY_LOGOS } from "@opengeni/react/app/components/capabilities/capability-logo-source";
import { capabilityLogoFallback, ConnectionLogo, McpConnectionCard } from "@opengeni/react/connect";
import type { CapabilityCatalogItem, ConnectionMetadata } from "@opengeni/sdk";
import {
  Check,
  Ellipsis,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Unplug,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { client } from "../lib/app-api";
import { bundledLogo, GOOGLE_DRIVE_LOGO } from "../lib/brand-logos";
import {
  accountSubtitle,
  catalogCurationFeatured,
  categoryLabel,
  connectableCatalog,
  connectedServices,
  searchCatalog,
  type ConnectedAccountView,
  type ConnectedServiceView,
} from "../lib/connections";

const GITHUB_TILE_ID = "api:github-app";
const PAGE = 12;
const OAUTH_MCP_PROVIDERS = new Set(["mcp-oauth", "gmail", "slack-personal"]);
const COLLAPSE_AFTER = 8;
const COLLAPSED_ROWS = 6;

// The catalog is large and slow to build; keep the last copy per workspace so
// reopening Settings shows the list at once while a fresh copy loads.
const catalogCache = new Map<string, CapabilityCatalogItem[]>();

type Inventory = {
  accounts: ConnectAccount[];
  connections: ConnectionMetadata[];
};

/** Follows the app's `.dark` class so Opengeni's own components (the connect
 * dialog) render with the matching palette. */
function useDarkMode() {
  const read = () => document.documentElement.classList.contains("dark");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/** Catalog marks come through this origin's `/v1` proxy, like every API call. */
function logoFor(item: CapabilityCatalogItem): string | null {
  const firstParty = FIRST_PARTY_CAPABILITY_LOGOS[item.id];
  if (firstParty) return firstParty;
  const asset = client.catalogAssetUrl(item.logoAssetPath) ?? bundledLogo(item);
  if (asset) return asset;
  // Community rows never hotlink a third-party mark (many are blank or white).
  return item.tier === "community" ? null : capabilityLogoFallback(item);
}

function firstPartyLogo(providerId: string): string | null {
  if (providerId.startsWith("github-")) return FIRST_PARTY_CAPABILITY_LOGOS["api:github-app"]!;
  if (providerId === "x") return FIRST_PARTY_CAPABILITY_LOGOS["api:x"]!;
  if (providerId === "reddit") return FIRST_PARTY_CAPABILITY_LOGOS["api:reddit"]!;
  if (providerId.startsWith("fiken-")) return FIRST_PARTY_CAPABILITY_LOGOS["api:fiken"]!;
  if (providerId.startsWith("google-drive-")) return GOOGLE_DRIVE_LOGO;
  return null;
}

const MONOGRAM_HUES = [262, 215, 160, 25, 340, 190, 45, 290];

function Monogram({ name }: { name: string }) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = MONOGRAM_HUES[hash % MONOGRAM_HUES.length]!;
  return (
    <span className="simple-connection-monogram" style={{ "--monogram-hue": hue } as CSSProperties}>
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function Logo({
  src,
  name,
  size = 36,
  loading = false,
}: {
  src: string | null;
  name: string;
  size?: number;
  loading?: boolean;
}) {
  return (
    <span className="simple-connection-logo" style={{ width: size, height: size }}>
      <ConnectionLogo
        src={src}
        name={name}
        size={size}
        loading={loading}
        fallback={<Monogram name={name} />}
      />
    </span>
  );
}

export function ConnectionsSettings({ workspaceId }: { workspaceId: string }) {
  const dark = useDarkMode();
  // Owned by the effect, so React's development double-mount can't hand a
  // flow a controller that was already disposed.
  const [controller, setController] = useState<ConnectController | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [inventoryFailed, setInventoryFailed] = useState(false);
  const [catalog, setCatalog] = useState<CapabilityCatalogItem[] | null>(
    () => catalogCache.get(workspaceId) ?? null,
  );
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const next = new ConnectController(client.connectTransport(), workspaceId);
    setController(next);
    return () => next.dispose();
  }, [workspaceId]);

  useEffect(() => {
    let live = true;
    setInventoryFailed(false);
    const transport = client.connectTransport();
    void Promise.all([
      transport.accounts(workspaceId),
      client.listConnections(workspaceId).catch(() => [] as ConnectionMetadata[]),
    ])
      .then(([accounts, connections]) => {
        if (live) setInventory({ accounts, connections });
      })
      .catch(() => {
        if (live) setInventoryFailed(true);
      });
    return () => {
      live = false;
    };
  }, [workspaceId, revision]);

  useEffect(() => {
    let live = true;
    setCatalogFailed(false);
    setCatalog(catalogCache.get(workspaceId) ?? null);
    void client
      .listCapabilities(workspaceId)
      .then((response) => {
        catalogCache.set(workspaceId, response.items);
        if (live) setCatalog(response.items);
      })
      .catch(() => {
        if (live && !catalogCache.has(workspaceId)) setCatalogFailed(true);
      });
    return () => {
      live = false;
    };
  }, [workspaceId, catalogRevision]);

  const services = useMemo(
    () =>
      inventory
        ? connectedServices({
            accounts: inventory.accounts,
            connections: inventory.connections,
            catalog: catalog ?? [],
            logo: logoFor,
            firstPartyLogo,
          })
        : null,
    [inventory, catalog],
  );

  return (
    <section className="simple-connections mb-8" data-og-theme={dark ? "dark" : "light"}>
      <h2 className="text-lg font-semibold tracking-tight">Connections</h2>
      <p className="mt-0.5 mb-4 max-w-xl text-sm text-[var(--app-muted)]">
        Agents ask to connect what they need right in the chat. You can also connect things here.
      </p>
      <ConnectedList
        workspaceId={workspaceId}
        controller={controller}
        services={services}
        catalogLoading={!catalog && !catalogFailed}
        failed={inventoryFailed}
        onChanged={reload}
      />
      <AddConnection
        workspaceId={workspaceId}
        catalog={catalog}
        failed={catalogFailed}
        services={services ?? []}
        onRetry={() => setCatalogRevision((value) => value + 1)}
        onConnected={reload}
      />
    </section>
  );
}

function SubHeading({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-baseline justify-between gap-3 px-1">
      <h3 className="text-sm font-semibold">{children}</h3>
      {aside}
    </div>
  );
}

function ConnectedList({
  workspaceId,
  controller,
  services,
  catalogLoading,
  failed,
  onChanged,
}: {
  workspaceId: string;
  controller: ConnectController | null;
  services: ConnectedServiceView[] | null;
  catalogLoading: boolean;
  failed: boolean;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const count = services?.reduce((total, service) => total + service.accounts.length, 0) ?? 0;
  const collapsed = !expanded && services !== null && services.length > COLLAPSE_AFTER;
  const visible = collapsed ? services.slice(0, COLLAPSED_ROWS) : services;
  return (
    <div className="mb-8">
      <SubHeading
        aside={
          services && count ? (
            <span className="text-xs text-[var(--app-muted)]">
              {count} {count === 1 ? "account" : "accounts"}
            </span>
          ) : null
        }
      >
        Connected
      </SubHeading>
      {failed ? (
        <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] px-4 py-5 text-sm text-[var(--app-muted)]">
          Couldn't load your connections.{" "}
          <button
            type="button"
            onClick={onChanged}
            className="font-medium text-[var(--app-accent)] hover:underline"
          >
            Try again
          </button>
        </div>
      ) : !services ? (
        <ListSkeleton rows={3} />
      ) : services.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[var(--app-border)] px-4 py-6 text-center text-sm text-[var(--app-muted)]">
          Nothing connected yet. Pick a service below, or let an agent ask when it needs one.
        </div>
      ) : (
        <ul className="divide-y divide-[var(--app-border)] overflow-visible rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)]">
          {visible?.map((service) => (
            <ServiceRow
              key={service.key}
              service={service}
              logoLoading={catalogLoading}
              workspaceId={workspaceId}
              controller={controller}
              onChanged={onChanged}
            />
          ))}
          {collapsed ? (
            <li>
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="w-full rounded-b-2xl px-4 py-3 text-left text-sm font-medium text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
              >
                Show all {services.length} services
              </button>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div
      role="status"
      aria-label="Loading connections"
      className="divide-y divide-[var(--app-border)] rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)]"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3.5">
          <span className="h-9 w-9 shrink-0 animate-pulse rounded-[10px] bg-[var(--app-hover)]" />
          <span className="flex-1 space-y-2">
            <span className="block h-3 w-28 animate-pulse rounded-full bg-[var(--app-hover)]" />
            <span className="block h-2.5 w-44 animate-pulse rounded-full bg-[var(--app-hover)]" />
          </span>
        </div>
      ))}
    </div>
  );
}

function ServiceRow({
  service,
  logoLoading,
  workspaceId,
  controller,
  onChanged,
}: {
  service: ConnectedServiceView;
  logoLoading: boolean;
  workspaceId: string;
  controller: ConnectController | null;
  onChanged: () => void;
}) {
  const single = service.accounts.length === 1 ? service.accounts[0]! : null;
  return (
    <li className="flex gap-3 px-4 py-3">
      <Logo src={service.logo} name={service.name} loading={logoLoading} />
      <div className="min-w-0 flex-1">
        {single ? (
          <div className="flex min-h-9 items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{service.name}</div>
              <div className="truncate text-xs text-[var(--app-muted)]">
                {accountSubtitle(single)}
              </div>
            </div>
            <AccountActions
              account={single}
              serviceName={service.name}
              workspaceId={workspaceId}
              controller={controller}
              onChanged={onChanged}
            />
          </div>
        ) : (
          <>
            <div className="flex min-h-9 items-center text-sm font-medium">
              {service.name}
              <span className="ml-2 rounded-full bg-[var(--app-hover)] px-1.5 py-px text-[11px] font-medium text-[var(--app-muted)]">
                {service.accounts.length}
              </span>
            </div>
            <ul className="-mt-0.5 space-y-0.5">
              {service.accounts.map((account) => (
                <li key={account.id} className="flex min-h-8 items-center gap-2">
                  <span className="h-1 w-1 shrink-0 rounded-full bg-[var(--app-muted)] opacity-50" />
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-muted)]">
                    {accountSubtitle(account)}
                  </span>
                  <AccountActions
                    account={account}
                    serviceName={service.name}
                    workspaceId={workspaceId}
                    controller={controller}
                    onChanged={onChanged}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </li>
  );
}

function AccountActions({
  account,
  serviceName,
  workspaceId,
  controller,
  onChanged,
}: {
  account: ConnectedAccountView;
  serviceName: string;
  workspaceId: string;
  controller: ConnectController | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<"reconnect" | "disconnect" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const name = account.label ? `${serviceName} (${account.label})` : serviceName;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Keep Escape from also closing the settings dialog.
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setConfirming(false);
  }

  function reconnect() {
    if (!controller || busy) return;
    setMessage(null);
    // Open the sign-in window inside the click, before any await, so the
    // browser treats it as user-initiated.
    let reserved: ReturnType<typeof reserveBrowserConnectNavigation>;
    try {
      reserved = reserveBrowserConnectNavigation(window);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't open the sign-in window.");
      return;
    }
    close();
    setBusy("reconnect");
    void (async () => {
      try {
        let attempt = await controller.begin({
          // Gmail and personal Slack sign in with their own OAuth client.
          providerId: OAUTH_MCP_PROVIDERS.has(account.providerId)
            ? account.providerId
            : "mcp-oauth",
          ownership: account.ownership,
          reconnectAccountId: account.id,
          returnUrl: window.location.href,
          idempotencyKey: crypto.randomUUID(),
        });
        if (attempt.state === "credential_input" && account.mcpUrl)
          attempt = await controller.advance(
            { type: "credentials", values: { mcpUrl: account.mcpUrl } },
            crypto.randomUUID(),
          );
        if (attempt.nextAction.type !== "authorize")
          throw new Error("This one can't be reconnected from here.");
        const result = await authorizeConnectAttempt(
          controller.transport,
          attempt,
          reserved.navigation,
          { mode: "popup" },
        );
        if (result?.state === "complete") onChanged();
        else if (result?.state === "cancelled") setMessage("Sign-in was cancelled.");
        else if (result) setMessage("Sign-in didn't finish. Try again.");
      } catch (error) {
        setMessage(
          error instanceof ConnectPopupClosedError
            ? "Sign-in window was closed."
            : error instanceof Error
              ? error.message
              : "Couldn't reconnect.",
        );
      } finally {
        reserved.close();
        setBusy(null);
      }
    })();
  }

  async function disconnect() {
    if (!controller || busy) return;
    setBusy("disconnect");
    setMessage(null);
    try {
      await controller.transport.disconnect(
        workspaceId,
        account.id,
        account.version !== undefined ? { expectedVersion: account.version } : {},
      );
      close();
      onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Couldn't disconnect.");
      close();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={root} className="relative flex shrink-0 items-center gap-2">
      {message ? (
        <span className="max-w-48 truncate text-xs text-rose-600 dark:text-rose-400" role="alert">
          {message}
        </span>
      ) : null}
      {busy ? (
        <LoaderCircle size={15} className="animate-spin text-[var(--app-muted)]" />
      ) : account.needsAttention ? (
        <button
          type="button"
          onClick={account.canReconnect ? reconnect : () => setOpen(true)}
          className="rounded-full bg-amber-500/12 px-2 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
        >
          {account.canReconnect ? "Sign in again" : "Needs attention"}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={`Manage ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!controller}
        onClick={() => (open ? close() : setOpen(true))}
        className={`rounded-lg p-1.5 text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)] ${open ? "bg-[var(--app-hover)] text-[var(--app-fg)]" : ""}`}
      >
        <Ellipsis size={16} />
      </button>
      {open ? (
        <div
          role="menu"
          className="card-in absolute top-full right-0 z-20 mt-1 w-60 rounded-xl border border-[var(--app-border)] bg-[var(--app-card)] p-1 shadow-lg"
        >
          {confirming ? (
            <div className="p-2">
              <div className="text-sm font-medium">Disconnect {serviceName}?</div>
              <p className="mt-1 text-xs text-[var(--app-muted)]">
                {account.ownership === "workspace"
                  ? "Agents in this workspace lose access. You can connect it again later."
                  : "Your agents lose access. You can connect it again later."}
              </p>
              <div className="mt-3 flex justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="rounded-lg px-2.5 py-1 text-xs font-medium hover:bg-[var(--app-hover)]"
                >
                  Keep
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void disconnect()}
                  className="rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-rose-700 disabled:opacity-60"
                >
                  Disconnect
                </button>
              </div>
            </div>
          ) : (
            <>
              {account.canReconnect ? (
                <MenuItem icon={RefreshCw} onClick={reconnect}>
                  Reconnect
                </MenuItem>
              ) : null}
              <MenuItem icon={Unplug} danger onClick={() => setConfirming(true)}>
                Disconnect
              </MenuItem>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  danger,
  onClick,
  children,
}: {
  icon: LucideIcon;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-[var(--app-hover)] ${danger ? "text-rose-600 dark:text-rose-400" : ""}`}
    >
      <Icon size={15} />
      {children}
    </button>
  );
}

type Tile = {
  id: string;
  name: string;
  detail: string | null;
  logo: string | null;
  connected: boolean;
  item: CapabilityCatalogItem | null;
};

/** Browsing, popular services not connected yet lead; searching keeps relevance. */
function browseOrder(tiles: Tile[], needle: string): Tile[] {
  if (needle) return tiles;
  const rank = (tile: Tile) =>
    !tile.item || catalogCurationFeatured(tile.item) ? (tile.connected ? 1 : 0) : 2;
  return [...tiles].sort((a, b) => rank(a) - rank(b));
}

function AddConnection({
  workspaceId,
  catalog,
  failed,
  services,
  onRetry,
  onConnected,
}: {
  workspaceId: string;
  catalog: CapabilityCatalogItem[] | null;
  failed: boolean;
  services: ConnectedServiceView[];
  onRetry: () => void;
  onConnected: () => void;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Tile | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const connectedNames = useMemo(
    () =>
      new Set(
        services
          .filter((service) => service.accounts.some((account) => !account.needsAttention))
          .map((service) => service.name.toLowerCase()),
      ),
    [services],
  );
  const connectable = useMemo(() => (catalog ? connectableCatalog(catalog) : []), [catalog]);
  // GitHub connects through its app install rather than the catalog, so it is
  // offered whenever this Opengeni has the app set up.
  const [githubReady, setGitHubReady] = useState(false);
  useEffect(() => {
    let live = true;
    void client
      .getGitHubApp(workspaceId)
      .then((info) => {
        if (live) setGitHubReady(info.configured && Boolean(info.installUrl ?? info.linkUrl));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspaceId]);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const tiles = searchCatalog(connectable, query).map(
      (item): Tile => ({
        id: item.id,
        name: item.name,
        detail: item.description?.split(/(?<=\.)\s/u)[0] ?? categoryLabel(item.category),
        logo: logoFor(item),
        connected: connectedNames.has(item.name.toLowerCase()),
        item,
      }),
    );
    if (!githubReady || (needle && !"github".includes(needle))) return browseOrder(tiles, needle);
    const githubTile: Tile = {
      id: GITHUB_TILE_ID,
      name: "GitHub",
      detail: "Repositories, issues, and pull requests",
      logo: FIRST_PARTY_CAPABILITY_LOGOS[GITHUB_TILE_ID] ?? null,
      connected: connectedNames.has("github"),
      item: null,
    };
    return browseOrder([githubTile, ...tiles], needle);
  }, [connectable, githubReady, query, connectedNames]);

  async function openGitHub() {
    setNotice(null);
    // Reserve the tab inside the click; the install URL arrives after a request.
    const tab = window.open("about:blank", "_blank");
    try {
      const info = await client.getGitHubApp(workspaceId, { returnPath: window.location.pathname });
      const url = info.installUrl ?? info.linkUrl;
      if (!url) {
        tab?.close();
        setNotice(
          info.configured
            ? "GitHub can't be connected from here."
            : "GitHub isn't set up on this Opengeni yet.",
        );
        return;
      }
      if (tab) {
        tab.opener = null;
        tab.location.replace(url);
      } else window.open(url, "_blank", "noopener");
      setNotice("Finish installing GitHub in the new tab, then come back here.");
    } catch {
      tab?.close();
      setNotice("Couldn't reach GitHub setup. Try again.");
    }
  }

  return (
    <div>
      <SubHeading>Add a connection</SubHeading>
      <div className="relative mb-3">
        <Search
          size={16}
          className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-[var(--app-muted)]"
        />
        <input
          type="search"
          aria-label="Search services"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setLimit(PAGE);
          }}
          placeholder="Search Gmail, Notion, Linear..."
          className="w-full rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] py-2.5 pr-10 pl-10 [&::-webkit-search-cancel-button]:appearance-none text-sm outline-none placeholder:text-[var(--app-muted)] focus:border-[var(--app-accent)] focus:ring-4 focus:ring-[var(--app-accent-soft)]"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              setLimit(PAGE);
            }}
            className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-full p-1 text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>
      {notice ? (
        <p role="status" className="mb-3 px-1 text-xs text-[var(--app-muted)]">
          {notice}
        </p>
      ) : null}
      {failed ? (
        <div className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] px-4 py-5 text-sm text-[var(--app-muted)]">
          Couldn't load services.{" "}
          <button
            type="button"
            onClick={onRetry}
            className="font-medium text-[var(--app-accent)] hover:underline"
          >
            Try again
          </button>
        </div>
      ) : !catalog ? (
        <TileSkeleton />
      ) : matches.length === 0 ? (
        <p role="status" className="px-1 py-6 text-center text-sm text-[var(--app-muted)]">
          No services match "{query.trim()}".
        </p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {matches.slice(0, limit).map((tile) => (
              <button
                key={tile.id}
                type="button"
                onClick={() => {
                  if (tile.id === GITHUB_TILE_ID) void openGitHub();
                  else setSelected(tile);
                }}
                className="group flex min-w-0 items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] px-3 py-2.5 text-left transition-colors hover:border-transparent hover:bg-[var(--app-hover)]"
              >
                <Logo src={tile.logo} name={tile.name} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{tile.name}</span>
                  {tile.detail ? (
                    <span className="block truncate text-xs text-[var(--app-muted)]">
                      {tile.detail}
                    </span>
                  ) : null}
                </span>
                {tile.connected ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    <Check size={14} />
                    Connected
                  </span>
                ) : (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-muted)] group-hover:bg-[var(--app-card)] group-hover:text-[var(--app-fg)]">
                    <Plus size={16} />
                  </span>
                )}
              </button>
            ))}
          </div>
          {matches.length > limit ? (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={() => setLimit((value) => value + PAGE * 2)}
                className="rounded-full px-3 py-1.5 text-sm font-medium text-[var(--app-muted)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]"
              >
                {query.trim() ? `Show more (${matches.length - limit})` : "Show more services"}
              </button>
            </div>
          ) : null}
        </>
      )}
      {selected?.item ? (
        <McpConnectionCard
          client={client}
          workspaceId={workspaceId}
          capabilityId={selected.item.id}
          name={selected.name}
          logoSrc={selected.logo}
          dialogSubtitle={categoryLabel(selected.item.category) ?? "Connection"}
          returnUrl={window.location.href}
          dialogOnly
          onClose={() => setSelected(null)}
          onConfigured={() => {
            setSelected(null);
            onConnected();
          }}
        />
      ) : null}
    </div>
  );
}

function TileSkeleton() {
  return (
    <div role="status" aria-label="Loading services" className="grid gap-2 sm:grid-cols-2">
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-card)] px-3 py-2.5"
        >
          <span className="h-8 w-8 shrink-0 animate-pulse rounded-[9px] bg-[var(--app-hover)]" />
          <span className="flex-1 space-y-2">
            <span className="block h-3 w-20 animate-pulse rounded-full bg-[var(--app-hover)]" />
            <span className="block h-2.5 w-32 animate-pulse rounded-full bg-[var(--app-hover)]" />
          </span>
        </div>
      ))}
    </div>
  );
}
