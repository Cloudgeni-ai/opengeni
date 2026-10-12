import { expect, test } from "bun:test";

import {
  invalidateSubscriptionAccountQueries,
  peekSharedQuery,
  retainSharedQueries,
  sharedQueryWriter,
  type SharedQueryKey,
} from "./shared-query";

test("an access change drops every retained subscription account list, and only those", async () => {
  const client = {};
  const release = retainSharedQueries(client);
  try {
    const lists: SharedQueryKey[] = [
      ["codex-accounts", "workspace-a"],
      ["codex-accounts", "workspace-a", "session", "session-1"],
      ["codex-accounts", "organization", "organization-a"],
      ["subscription-pool", "Claude", "workspaces", "workspace-a"],
      ["supergrok-accounts", "workspace-a"],
    ];
    // Live usage readings are per account, not which accounts a workspace sees.
    const kept: SharedQueryKey = ["codex-live-usage", "workspace-a"];
    const write = sharedQueryWriter(client);
    for (const key of [...lists, kept]) expect(write(key, { rows: [] })).toBe(true);

    await invalidateSubscriptionAccountQueries(client);

    for (const key of lists) expect(peekSharedQuery(client, key)).toBeNull();
    expect(peekSharedQuery(client, kept)?.data).toEqual({ rows: [] });
  } finally {
    release();
  }
});
