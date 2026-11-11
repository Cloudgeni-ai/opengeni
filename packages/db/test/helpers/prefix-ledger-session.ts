import type postgres from "postgres";

/**
 * Seed a chat and its first queued turn with raw SQL for a migration test whose
 * database stops before a historical migration. The Drizzle helpers describe
 * the head schema, so they write every column head has, including columns a
 * later migration adds that this database does not have yet. The session
 * triggers read tenant rows as their definer, so this admits the workspace the
 * way the application does.
 */
export async function seedPrefixLedgerSession(
  admin: postgres.Sql,
  input: {
    accountId: string;
    workspaceId: string;
    initialMessage: string;
    latencyMode?: string;
  },
): Promise<{ sessionId: string; turnId: string }> {
  return await admin.begin(async (tx) => {
    await tx`
      select set_config('opengeni.account_id', ${input.accountId}, true),
        set_config('opengeni.workspace_id', ${input.workspaceId}, true),
        set_config('opengeni.session_variable_set_attachments_v1', '1', true)`;
    const [session] = await tx<{ id: string }[]>`
      insert into sessions (
        account_id, workspace_id, initial_message, model, reasoning_effort, latency_mode,
        sandbox_backend, sandbox_group_id, tool_policy
      ) values (
        ${input.accountId}, ${input.workspaceId}, ${input.initialMessage}, 'test-model',
        'medium', ${input.latencyMode ?? "standard"}, 'none', gen_random_uuid(),
        jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
      )
      returning id`;
    const [turn] = await tx<{ id: string }[]>`
      insert into session_turns (
        session_id, account_id, workspace_id, trigger_event_id, temporal_workflow_id, source,
        status, position, prompt, model, reasoning_effort, sandbox_backend
      ) values (
        ${session!.id}, ${input.accountId}, ${input.workspaceId}, gen_random_uuid(),
        ${`prefix-ledger-${session!.id}`}, 'user', 'queued', 1, ${input.initialMessage},
        'test-model', 'medium', 'none'
      )
      returning id`;
    return { sessionId: session!.id, turnId: turn!.id };
  });
}
