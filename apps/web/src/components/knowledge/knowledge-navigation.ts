import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import type { KnowledgeSearch, KnowledgeSubpage, KnowledgeTab } from "@/lib/knowledge-route";

export type { KnowledgeSearch, KnowledgeSubpage, KnowledgeTab } from "@/lib/knowledge-route";
export { parseKnowledgeSearch } from "@/lib/knowledge-route";

/* ----------------------------------------------------------------------------
   Where the Knowledge page is: which tab, or which page you opened from it.
   Everything lives in the /state URL so every page has a link and the
   browser's back button works. The page component stays mounted while the
   search changes, so the Library keeps its search and filters when you come
   back from an entry.
   -------------------------------------------------------------------------- */

export interface KnowledgeNavigation {
  showTab: (tab: KnowledgeTab, options?: { replace?: boolean }) => void;
  /** Opens one change waiting in Review; `replace` moves on without a new history entry. */
  openProposal: (key: string, options?: { replace?: boolean }) => void;
  /** Opens an entry's page; `from` is the tab its back link returns to. */
  openEntry: (entryId: string, options?: { revision?: string; from?: KnowledgeTab }) => void;
  openPage: (
    page: KnowledgeSubpage,
    extra?: { entry?: string; collection?: string; view?: KnowledgeTab },
  ) => void;
  /** Replace the URL without adding history, for legacy links. */
  replace: (search: KnowledgeSearch) => void;
}

export function useKnowledgeNavigation(workspaceId: string): KnowledgeNavigation {
  const navigate = useNavigate();
  const go = useCallback(
    (search: KnowledgeSearch, replace = false) => {
      void navigate({
        to: "/workspaces/$workspaceId/state",
        params: { workspaceId },
        search,
        replace,
      });
    },
    [navigate, workspaceId],
  );
  const showTab = useCallback(
    (tab: KnowledgeTab, options: { replace?: boolean } = {}) =>
      go(tab === "library" ? {} : { view: tab }, options.replace),
    [go],
  );
  const openProposal = useCallback(
    (proposal: string, options: { replace?: boolean } = {}) =>
      go({ view: "review", proposal }, options.replace),
    [go],
  );
  const openEntry = useCallback(
    (entry: string, options: { revision?: string; from?: KnowledgeTab } = {}) =>
      go({
        entry,
        ...(options.revision ? { revision: options.revision } : {}),
        ...(options.from && options.from !== "library" ? { view: options.from } : {}),
      }),
    [go],
  );
  const openPage = useCallback<KnowledgeNavigation["openPage"]>(
    (page, extra = {}) =>
      go({
        page,
        ...(extra.entry ? { entry: extra.entry } : {}),
        ...(extra.collection ? { collection: extra.collection } : {}),
        ...(extra.view && extra.view !== "library" ? { view: extra.view } : {}),
      }),
    [go],
  );
  const replace = useCallback((search: KnowledgeSearch) => go(search, true), [go]);
  // Stable across renders: pages depend on it in effects (legacy-link redirects).
  return useMemo(
    () => ({ showTab, openProposal, openEntry, openPage, replace }),
    [showTab, openProposal, openEntry, openPage, replace],
  );
}
