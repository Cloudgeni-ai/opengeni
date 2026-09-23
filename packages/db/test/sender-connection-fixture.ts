import type { McpPersonalConnectionDelegation } from "@opengeni/contracts";
import type postgres from "postgres";

/** Real owned accounts for tests of immutable turn/queue provenance. */
export async function seedSenderConnections(
  sql: postgres.Sql,
  scope: { accountId: string; workspaceId: string },
  selections: McpPersonalConnectionDelegation[],
) {
  for (const selection of selections) {
    const [membership] = await sql`select id from organization_memberships
      where account_id = ${scope.accountId} and subject_id = ${selection.ownerSubjectId}`;
    if (!membership) {
      const [personal] = await sql`insert into workspaces (account_id, name)
        values (${scope.accountId}, 'Personal fixture') returning id`;
      await sql`insert into organization_memberships
        (account_id, subject_id, status, personal_workspace_id)
        values (${scope.accountId}, ${selection.ownerSubjectId}, 'active', ${personal!.id})`;
    }
    await sql`insert into workspace_memberships (account_id, workspace_id, subject_id)
      values (${scope.accountId}, ${scope.workspaceId}, ${selection.ownerSubjectId})
      on conflict do nothing`;
    await sql.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${scope.accountId}, true),
        set_config('opengeni.workspace_id', ${scope.workspaceId}, true),
        set_config('opengeni.subject_id', ${selection.ownerSubjectId}, true)`;
      await tx`insert into connections
        (id, account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted)
        values (${selection.connectionId}, ${scope.accountId}, ${scope.workspaceId},
          ${selection.ownerSubjectId}, ${selection.providerDomain}, ${selection.kind ?? "oauth2"},
          'fixture-ciphertext') on conflict do nothing`;
    });
    selection.originWorkspaceId = scope.workspaceId;
  }
}
