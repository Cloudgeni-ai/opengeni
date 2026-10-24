// App and rail state for the ⌘K Sites preview: the session sidebar's sample
// workspace (its Sites scenario), plus what the real ActionsProvider and
// command menu read. Sample data only; every component on the page is real.
import { useMemo, useRef, useState } from "react";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import { useNavigate } from "@opengeni/react/app/lib/navigation";
import {
  checklistSiteId,
  client,
  ipoSiteId,
  pricingSiteId,
  subjectId,
  usageSiteId,
  useAppContext as useSidebarContext,
  workspaceId,
} from "./session-sidebar-context";

export * from "./session-sidebar-context";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const site = (id: string, title: string, minutes: number): ArtifactCatalogItem => ({
  id,
  kind: "site",
  title,
  status: "active",
  visibility: "workspace",
  createdAt: minutesAgo(minutes + 10_000),
  updatedAt: minutesAgo(minutes),
});

/** Every Site the person may see in the workspace, as the artifact catalog answers. */
const catalogSites: ArtifactCatalogItem[] = [
  site(usageSiteId, "Opengeni usage", 2),
  site(ipoSiteId, "IPO research dashboard", 44),
  site(pricingSiteId, "Pricing calculator", 390),
  site(checklistSiteId, "Launch checklist", 2880),
  // Not in the sidebar: nobody here has opened or asked them anything lately.
  site("00000000-0000-4000-a000-000000000005", "Customer health dashboard", 4320),
  site("00000000-0000-4000-a000-000000000006", "Q4 revenue dashboard", 10_080),
  site("00000000-0000-4000-a000-000000000007", "Support usage report", 20_160),
];

export const catalogCalls: Array<Record<string, unknown>> = [];
Object.assign(client, {
  // The real endpoint's title match: a literal, case-insensitive substring.
  listArtifactCatalog: async (_workspace: string, options: Record<string, unknown> = {}) => {
    const { signal: _signal, ...recorded } = options;
    catalogCalls.push(recorded);
    if (new URLSearchParams(location.search).get("sites") === "fail")
      throw Object.assign(new Error("API 503: Site search unavailable"), { status: 503 });
    const q = typeof options.q === "string" ? options.q.toLowerCase() : "";
    const limit = typeof options.limit === "number" ? options.limit : 50;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      items: catalogSites
        .filter((item) => !q || item.title.toLowerCase().includes(q))
        .slice(0, limit),
      nextCursor: null,
    };
  },
});

const workspace = {
  id: workspaceId,
  accountId: "00000000-0000-4000-9000-000000000001",
  name: "Product engineering",
  kind: "shared",
};

export function useAppContext() {
  const base = useSidebarContext();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  return useMemo(
    () =>
      Object.assign(Object.create(base) as typeof base, {
        workspaces: [workspace],
        managedSelfContext: null,
        authSession: null,
        clientConfig: { auth: { mode: "local" } },
        inspectorOpen,
        setInspectorOpen,
        accessContext: {
          ...base.accessContext,
          subjectId,
          accountGrants: [
            {
              subjectId,
              accountId: workspace.accountId,
              role: "owner",
              metadata: { accountName: "Acme" },
            },
          ],
        },
      }),
    [base, inspectorOpen],
  );
}

export function useRail() {
  const navigate = useNavigate();
  const drawerTriggerRef = useRef<HTMLElement | null>(null);
  return {
    workspaceId,
    isMobile: window.innerWidth < 768,
    drawerOpen: false,
    drawerTriggerRef,
    setDrawerOpen: () => {},
    handOffDrawer: () => {},
    toggleCollapsed: () => {},
    startNewSession: () => {},
    openWorkspace: () => {},
    openSession: (sessionId: string) =>
      void navigate({
        to: "/workspaces/$workspaceId/sessions/$sessionId",
        params: { workspaceId, sessionId },
      }),
  };
}
