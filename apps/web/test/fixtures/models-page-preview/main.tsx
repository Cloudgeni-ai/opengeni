import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { AppHostProvider } from "@opengeni/react/app/lib/app-host";
import { browserPage, type NavigationHost } from "@opengeni/react/app/lib/navigation";
import { useConsoleSharedQueries } from "@opengeni/react/app/lib/shared-query";
import type { ModelsView } from "@opengeni/react/app/lib/models-route";
import { useAppContext } from "./context";
import { WorkspaceModelsPage } from "../../../src/components/models/workspace-models-page";
import "../../../src/styles.css";

// Organization settings > Models for an owner of Acme, rendered with the real
// page against a synthetic client. Navigation is in memory: `account` and
// `view` start from the URL and change as the page navigates.
const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.ogTheme = params.get("theme") === "dark" ? "dark" : "light";

type Search = { account?: string; view?: ModelsView; workspace?: string };
let search: Search = {
  ...(params.get("account") ? { account: params.get("account")! } : {}),
  ...(params.get("view") ? { view: params.get("view") as ModelsView } : {}),
};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const locate = () => ({
  pathname: "/workspaces/design/organization",
  search,
  searchStr: "",
  hash: "",
  href: window.location.href,
  state: {},
});
// One location object per navigation, as the router keeps one.
let current = locate();
const navigate = async (options: { search?: unknown }) => {
  const next = typeof options.search === "function" ? options.search(search) : options.search;
  search = (next && typeof next === "object" ? next : {}) as Search;
  current = locate();
  document.body.dataset.search = JSON.stringify(search);
  for (const listener of listeners) listener();
};
const location = () => current;
const workspaces = [{ id: "design", name: "Design", kind: "shared" } as never];
const navigation: NavigationHost = {
  useNavigate: () => navigate,
  useLocation: () => location(),
  useRouterState: ({ select }) => select({ location: location() }),
  useRouter: () => ({ state: { location: location() } }),
  useSearch: () => search,
  Link: ({ children, onClick, ...rest }) => (
    <a
      href="#"
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
        void navigate(rest);
      }}
    >
      {typeof children === "function" ? children({ isActive: false, isTransitioning: false }) : children}
    </a>
  ),
  stringifySearch: (value) => new URLSearchParams(value as Record<string, string>).toString(),
  page: browserPage,
};

function Page() {
  const searchNow = useSyncExternalStore(subscribe, () => search);
  useConsoleSharedQueries(useAppContext().client as never);
  return (
    <WorkspaceModelsPage
      anchorWorkspaceId="design"
      workspacePage={Boolean(searchNow.workspace)}
      workspaces={workspaces}
      workspaceId="design"
      workspaceName="Design"
      organizationId="acme"
      organizationName="Acme"
      canManageSettings
      canManageConnections
      canManageOrganizationModels
      account={searchNow.account}
      view={searchNow.view}
      onConnectionChange={() => undefined}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <AppHostProvider host={{ navigation } as never}>
    <main className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8">
      <div className="mx-auto max-w-3xl">
        <Page />
      </div>
      <Toaster />
    </main>
  </AppHostProvider>,
);
