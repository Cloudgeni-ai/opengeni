/** A notice key a finished connection card may have opened. */
export type ConnectionCardWithdrawalKey = {
  key: string;
  /**
   * The key names one account, so its notices close in the person's chats in
   * every workspace. A capability or server is set up per workspace, so its
   * notices close only in that workspace's chats.
   */
  accountWide: boolean;
};

type InboxNotice = {
  kind: string;
  sourceKey: string;
  sessionId: string;
  workspaceId: string;
};

/**
 * The chats whose notices to withdraw once a card is done, with the keys for
 * each: the card's own chat always, and the person's other chats with an open
 * notice under one of the keys, within the scope that key covers.
 */
export function connectionCardWithdrawals(
  origin: { workspaceId: string; sessionId: string },
  keys: readonly ConnectionCardWithdrawalKey[],
  items: readonly InboxNotice[],
): Map<string, { workspaceId: string; keys: Set<string> }> {
  const wanted = new Map(keys.map((entry) => [entry.key, entry.accountWide]));
  const sessions = new Map<string, { workspaceId: string; keys: Set<string> }>([
    [origin.sessionId, { workspaceId: origin.workspaceId, keys: new Set(wanted.keys()) }],
  ]);
  for (const item of items) {
    if (item.kind !== "notification" || !wanted.has(item.sourceKey)) continue;
    if (item.workspaceId !== origin.workspaceId && !wanted.get(item.sourceKey)) continue;
    const entry = sessions.get(item.sessionId) ?? {
      workspaceId: item.workspaceId,
      keys: new Set<string>(),
    };
    entry.keys.add(item.sourceKey);
    sessions.set(item.sessionId, entry);
  }
  return sessions;
}
