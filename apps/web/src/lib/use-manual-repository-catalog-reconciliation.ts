import { useEffect, type Dispatch, type SetStateAction } from "react";

import { reconcileManualRepositoriesWithCatalog, type RepoDraft } from "@/lib/session-tools";
import type { GitHubRepository } from "@/types";

/**
 * A restored draft can hold a manual row for a workspace repository: its
 * GitHub identity retained while the catalog was unknown, or a bare URL for the
 * same remote. Once the catalog is known, fold that row into the catalog
 * selection so the picker shows the repository checked and it is attached
 * exactly once. See reconcileManualRepositoriesWithCatalog for the rules.
 */
export function useManualRepositoryCatalogReconciliation(input: {
  manualRepos: RepoDraft[];
  selectedRepoIds: Set<number>;
  selectedRepoRefs: Record<number, string>;
  repositories: GitHubRepository[];
  catalogReady: boolean;
  setManualRepos: Dispatch<SetStateAction<RepoDraft[]>>;
  setSelectedRepoIds: Dispatch<SetStateAction<Set<number>>>;
  setSelectedRepoRefs: Dispatch<SetStateAction<Record<number, string>>>;
}): void {
  const {
    manualRepos,
    selectedRepoIds,
    selectedRepoRefs,
    repositories,
    catalogReady,
    setManualRepos,
    setSelectedRepoIds,
    setSelectedRepoRefs,
  } = input;
  useEffect(() => {
    const reconciled = reconcileManualRepositoriesWithCatalog(
      { manualRepos, selectedRepoIds, selectedRepoRefs },
      repositories,
      catalogReady,
    );
    if (!reconciled) return;
    setManualRepos(reconciled.manualRepos);
    setSelectedRepoIds(reconciled.selectedRepoIds);
    setSelectedRepoRefs(reconciled.selectedRepoRefs);
  }, [
    catalogReady,
    manualRepos,
    repositories,
    selectedRepoIds,
    selectedRepoRefs,
    setManualRepos,
    setSelectedRepoIds,
    setSelectedRepoRefs,
  ]);
}
