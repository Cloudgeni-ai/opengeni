import { Component, type ReactNode } from "react";

const RELOAD_TARGET_STORAGE_KEY = "northstar-support:agent-panel-reload-target";
const RELOAD_QUERY_PARAMETER = "__northstar_agent_panel_reload";

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type AgentPanelLoadEnvironment = {
  loadedBuildId: string;
  readCurrentBuildId: () => Promise<string | null>;
  reload: (targetBuildId: string) => void;
  storage: SessionStorageLike | null;
  waitForNavigation: (cause: unknown) => Promise<never>;
};

export function createBrowserAgentPanelLoadEnvironment(
  loadedEntryUrl: string,
): AgentPanelLoadEnvironment {
  const pageUrl = new URL(window.location.href);
  pageUrl.hash = "";
  pageUrl.searchParams.set(RELOAD_QUERY_PARAMETER, Date.now().toString(36));

  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    // Storage can be unavailable in restricted browser contexts. In that case
    // fail visibly instead of attempting an unguarded reload.
  }

  return {
    loadedBuildId: buildIdFromUrl(loadedEntryUrl, window.location.href),
    readCurrentBuildId: async () => {
      try {
        const response = await fetch(pageUrl, { cache: "no-store" });
        if (!response.ok) return null;
        const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
        const entry = parsed.querySelector<HTMLScriptElement>('script[type="module"][src]');
        const source = entry?.getAttribute("src");
        return source ? buildIdFromUrl(source, response.url || pageUrl.href) : null;
      } catch {
        return null;
      }
    },
    reload: (targetBuildId) => {
      const reloadUrl = new URL(window.location.href);
      reloadUrl.hash = "";
      reloadUrl.searchParams.set(RELOAD_QUERY_PARAMETER, targetBuildId);
      window.location.replace(reloadUrl);
    },
    storage,
    waitForNavigation: (cause) =>
      new Promise<never>((_resolve, reject) => {
        window.setTimeout(() => reject(cause), 5_000);
      }),
  };
}

export function removeAgentPanelReloadParameter(): void {
  const currentUrl = new URL(window.location.href);
  if (!currentUrl.searchParams.has(RELOAD_QUERY_PARAMETER)) return;
  currentUrl.searchParams.delete(RELOAD_QUERY_PARAMETER);
  window.history.replaceState(window.history.state, "", currentUrl);
}

export function shouldRestoreAgentPanel(environment: AgentPanelLoadEnvironment): boolean {
  return readReloadTarget(environment.storage) !== null;
}

export async function loadAgentPanelModule<T>(
  load: () => Promise<T>,
  environment: AgentPanelLoadEnvironment,
): Promise<T> {
  try {
    const loaded = await load();
    if (readReloadTarget(environment.storage) === environment.loadedBuildId) {
      removeReloadTarget(environment.storage);
    }
    return loaded;
  } catch (cause) {
    if (await reloadForCurrentBuildOnce(environment)) {
      return await environment.waitForNavigation(cause);
    }
    throw cause;
  }
}

async function reloadForCurrentBuildOnce(environment: AgentPanelLoadEnvironment): Promise<boolean> {
  const currentBuildId = await environment.readCurrentBuildId();
  const attemptedTarget = readReloadTarget(environment.storage);
  if (
    !currentBuildId ||
    currentBuildId === environment.loadedBuildId ||
    attemptedTarget === currentBuildId
  ) {
    if (attemptedTarget !== null) removeReloadTarget(environment.storage);
    return false;
  }
  if (!writeReloadTarget(environment.storage, currentBuildId)) return false;
  try {
    environment.reload(currentBuildId);
    return true;
  } catch {
    removeReloadTarget(environment.storage);
    return false;
  }
}

function buildIdFromUrl(value: string, base: string): string {
  return new URL(value, base).pathname;
}

function readReloadTarget(storage: SessionStorageLike | null): string | null {
  try {
    return storage?.getItem(RELOAD_TARGET_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeReloadTarget(storage: SessionStorageLike | null, target: string): boolean {
  if (!storage) return false;
  try {
    storage.setItem(RELOAD_TARGET_STORAGE_KEY, target);
    return storage.getItem(RELOAD_TARGET_STORAGE_KEY) === target;
  } catch {
    return false;
  }
}

function removeReloadTarget(storage: SessionStorageLike | null): void {
  try {
    storage?.removeItem(RELOAD_TARGET_STORAGE_KEY);
  } catch {
    // A failed cleanup must not hide the original module failure.
  }
}

export class AgentPanelLoadBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    return this.state.failed ? <AgentPanelLoadError /> : this.props.children;
  }
}

export function AgentPanelLoadError() {
  return (
    <aside
      className="flex h-full min-h-0 flex-col border-l border-[#302a40] bg-white"
      data-agent-panel-load-error
      role="alert"
    >
      <div className="flex h-[72px] items-center border-b border-[#302a40] bg-[#252131] px-5 text-sm font-semibold text-white">
        OpenGeni panel unavailable
      </div>
      <div className="m-auto max-w-sm px-8 text-center">
        <p className="text-sm font-semibold text-[#30332f]">The agent panel could not be loaded.</p>
        <p className="mt-2 text-xs leading-5 text-[#777771]">
          Reload the demo to try again. If it keeps failing, the current build needs attention.
        </p>
        <button
          type="button"
          className="mt-5 rounded-lg bg-[#6254c7] px-4 py-2 text-xs font-semibold text-white"
          onClick={() => window.location.reload()}
        >
          Reload demo
        </button>
      </div>
    </aside>
  );
}
