import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { LoadingPanel } from "@/components/common";
import type {
  AccessContext,
  OrganizationAdministrationOverview,
  OrganizationWorkspaceAccess,
} from "@/types";

export type OrganizationWorkspaceAdministration = {
  organizationId: string;
  overview: OrganizationAdministrationOverview;
  workspace: OrganizationWorkspaceAccess;
  refresh: () => void;
};

const OrganizationWorkspaceAdministrationContext =
  createContext<OrganizationWorkspaceAdministration | null>(null);

export function useOrganizationWorkspaceAdministration(): OrganizationWorkspaceAdministration | null {
  return useContext(OrganizationWorkspaceAdministrationContext);
}

export function organizationAdministrationAccountIds(accessContext: AccessContext): string[] {
  return accessContext.accountGrants
    .filter(
      (grant) =>
        grant.subjectId === accessContext.subjectId &&
        (grant.role === "owner" || grant.role === "admin"),
    )
    .map((grant) => grant.accountId)
    .sort();
}

export function OrganizationWorkspaceAdministrationBoundary(props: {
  client: OpenGeniBrowserClient;
  accessContext: AccessContext;
  accessKeyVersion: number;
  workspaceId: string;
  unavailable: ReactNode;
  children: (administration: OrganizationWorkspaceAdministration) => ReactNode;
}) {
  const organizationIds = useMemo(
    () => organizationAdministrationAccountIds(props.accessContext),
    [props.accessContext],
  );
  const authorityKey = `${props.accessKeyVersion}:${props.workspaceId}:${organizationIds.join(",")}`;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    key: string;
    value: Omit<OrganizationWorkspaceAdministration, "refresh"> | null;
    loading: boolean;
  }>({ key: "", value: null, loading: true });
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let disposed = false;
    setState({ key: authorityKey, value: null, loading: true });
    void Promise.allSettled(
      organizationIds.map(async (organizationId) => {
        const overview = await props.client.getOrganizationAdministrationOverview(organizationId);
        const workspace = overview.workspaces.find(
          (candidate) => candidate.id === props.workspaceId,
        );
        return workspace ? { organizationId, overview, workspace } : null;
      }),
    ).then((outcomes) => {
      if (disposed) return;
      const match = outcomes.find(
        (outcome) => outcome.status === "fulfilled" && outcome.value !== null,
      );
      setState({
        key: authorityKey,
        value: match?.status === "fulfilled" ? match.value : null,
        loading: false,
      });
    });
    return () => {
      disposed = true;
    };
  }, [authorityKey, organizationIds, props.client, props.workspaceId, revision]);

  const visible = state.key === authorityKey ? state : { ...state, value: null, loading: true };
  const administration = useMemo(
    () => (visible.value ? { ...visible.value, refresh } : null),
    [refresh, visible.value],
  );
  if (visible.loading) return <LoadingPanel label="Checking workspace administration" />;
  if (!administration) return props.unavailable;
  return (
    <OrganizationWorkspaceAdministrationContext.Provider value={administration}>
      {props.children(administration)}
    </OrganizationWorkspaceAdministrationContext.Provider>
  );
}
