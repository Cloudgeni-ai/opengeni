/**
 * Support for hand-written fake database executors in unit tests.
 *
 * A tenant-scoped transaction establishes its whole RLS scope in one setup
 * statement (see `applyRlsScope` in `@opengeni/db`): it resolves the account
 * (given, or looked up from the workspace), sets the tenant, subject and actor
 * settings, takes advisory locks and reads the applied values back. Fakes that
 * model those settings recognise the statement here instead of re-parsing it.
 */
export type FakeRlsSettings = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  privateFileOwnerSubjectId: string;
  initiatingHumanSubjectId: string;
  personalResourceHumanSubjectId: string;
  personalResourceActorSubjectId: string;
  agentRootSessionId: string;
  siteId: string;
  siteViewerPrincipal: string;
};

export const emptyFakeRlsSettings: FakeRlsSettings = {
  accountId: "",
  workspaceId: "",
  subjectId: "",
  privateFileOwnerSubjectId: "",
  initiatingHumanSubjectId: "",
  personalResourceHumanSubjectId: "",
  personalResourceActorSubjectId: "",
  agentRootSessionId: "",
  siteId: "",
  siteViewerPrincipal: "",
};

export type FakeRlsScopeSetup = {
  /** Settings after the statement; equal to `current` when it returned no row. */
  settings: FakeRlsSettings;
  /** Rows the statement returns: none when the workspace has no account. */
  rows: Record<string, string>[];
};

/** True when compiled SQL is the one-statement RLS scope setup. */
export function isRlsScopeSetup(sqlText: string): boolean {
  return sqlText.includes("parent as materialized") && sqlText.includes("resolved as materialized");
}

/**
 * Apply the RLS scope setup statement to `current` fake settings. `sqlText` and
 * `params` are the compiled statement (for example from `PgDialect.sqlToQuery`).
 * Returns null for any other statement.
 */
export function applyFakeRlsScopeSetup(
  sqlText: string,
  params: readonly unknown[],
  current: FakeRlsSettings,
  accountForWorkspace: (workspaceId: string) => string | undefined = () => undefined,
): FakeRlsScopeSetup | null {
  if (!isRlsScopeSetup(sqlText)) return null;
  const param = (pattern: RegExp): string | undefined => {
    const match = pattern.exec(sqlText);
    return match ? String(params[Number(match[1]) - 1]) : undefined;
  };
  const setting = (name: string) =>
    param(new RegExp(`set_config\\('opengeni\\.${name.replaceAll(".", "\\.")}', \\$(\\d+)`));
  const workspaceId = setting("workspace_id") ?? "";
  const accountId =
    param(/resolved as materialized \(select \$(\d+)::text as account_id/) ??
    accountForWorkspace(workspaceId);
  if (!accountId) return { settings: current, rows: [] };
  const settings: FakeRlsSettings = {
    ...current,
    accountId,
    workspaceId,
    subjectId: setting("subject_id") ?? current.subjectId,
    privateFileOwnerSubjectId: setting("private_file_owner") ?? current.privateFileOwnerSubjectId,
    initiatingHumanSubjectId:
      setting("initiating_human_subject_id") ?? current.initiatingHumanSubjectId,
    agentRootSessionId: setting("agent_root_session_id") ?? current.agentRootSessionId,
    siteId: setting("site_id") ?? current.siteId,
    siteViewerPrincipal: setting("site_viewer_principal") ?? current.siteViewerPrincipal,
  };
  return {
    settings,
    rows: [
      {
        resolved_account_id: accountId,
        account_id: settings.accountId,
        workspace_id: settings.workspaceId,
        subject_id: settings.subjectId,
        parent_account_id: current.accountId,
        parent_workspace_id: current.workspaceId,
        parent_subject_id: current.subjectId,
        parent_private_file_owner: current.privateFileOwnerSubjectId,
        parent_initiating_human_subject_id: current.initiatingHumanSubjectId,
        parent_personal_resource_human_subject_id: current.personalResourceHumanSubjectId,
        parent_personal_resource_actor_subject_id: current.personalResourceActorSubjectId,
        parent_agent_root_session_id: current.agentRootSessionId,
        parent_site_id: current.siteId,
        parent_site_viewer_principal: current.siteViewerPrincipal,
      },
    ],
  };
}
