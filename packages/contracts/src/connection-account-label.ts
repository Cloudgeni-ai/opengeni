/** The longest name a person can give one of their connections. */
export const CONNECTION_LABEL_MAX_LENGTH = 80;

/**
 * A person's name for a connection as stored and shown: control characters
 * become spaces, runs of whitespace collapse, and an empty name is no name.
 * Longer names are cut to {@link CONNECTION_LABEL_MAX_LENGTH} characters.
 */
export function normalizeConnectionLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = Array.from(
    value
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  )
    .slice(0, CONNECTION_LABEL_MAX_LENGTH)
    .join("")
    .trim();
  return normalized || null;
}

/**
 * Who a connection is, for people and agents: the account the provider
 * identified (email or account name), otherwise the name the person gave the
 * connection, otherwise `fallback`. A verified identity always wins, so a name
 * can never make one account read as another. Display only; never used to
 * select credentials.
 */
export function connectionAccountLabel(
  connection: { metadata: Record<string, unknown>; label?: string | null | undefined },
  fallback: string,
): string {
  return connectionAccountIdentityLabel(
    connection.metadata,
    normalizeConnectionLabel(connection.label) ?? fallback,
  );
}

/**
 * Labels a person and an agent can tell apart among one service's accounts.
 * Accounts whose label and scope read the same get when they were connected
 * (`connectedOn(createdAt, false)`), then the time as well
 * (`connectedOn(createdAt, true)`), and finally a short piece of their ID.
 * Accounts that already differ keep their label unchanged.
 */
export function distinctConnectionAccountLabels(
  accounts: readonly { id: string; label: string; scope: string; createdAt: string }[],
  connectedOn: (createdAt: string, withTime: boolean) => string | null,
): Map<string, string> {
  const key = (label: string, scope: string) => `${label}\u0000${scope}`;
  const repeated = (labels: readonly string[]) => {
    const counts = new Map<string, number>();
    labels.forEach((label, index) => {
      const at = key(label, accounts[index]!.scope);
      counts.set(at, (counts.get(at) ?? 0) + 1);
    });
    return (label: string, index: number) =>
      (counts.get(key(label, accounts[index]!.scope)) ?? 0) > 1;
  };
  const base = accounts.map((account) => account.label);
  const sameAsAnother = repeated(base);
  const dated = base.map((label, index) => {
    if (!sameAsAnother(label, index)) return label;
    const day = connectedOn(accounts[index]!.createdAt, false);
    return day ? `${label} · ${day}` : label;
  });
  const sameDay = repeated(dated);
  const timed = dated.map((label, index) => {
    if (!sameDay(label, index) || !sameAsAnother(base[index]!, index)) return label;
    const time = connectedOn(accounts[index]!.createdAt, true);
    return time ? `${base[index]} · ${time}` : label;
  });
  const sameMinute = repeated(timed);
  return new Map(
    accounts.map((account, index) => [
      account.id,
      sameMinute(timed[index]!, index)
        ? `${timed[index]} · ${account.id.replace(/[^0-9a-z]/giu, "").slice(0, 6)}`
        : timed[index]!,
    ]),
  );
}

/** Display identity from an already authorized connection. Never used to select credentials. */
export function connectionAccountIdentityLabel(
  metadata: Record<string, unknown>,
  fallback: string,
): string {
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim()
      ? value
          .replace(/[\u0000-\u001f\u007f]/gu, " ")
          .trim()
          .slice(0, 180)
      : undefined;
  const nestedName = (value: unknown): unknown =>
    value && typeof value === "object" ? (value as Record<string, unknown>).name : value;
  const name =
    [
      metadata.email,
      metadata.providerEmail,
      metadata.googleEmail,
      metadata.gmailEmail,
      metadata.googleCalendarEmail,
      metadata.googleDriveEmail,
      metadata.atlassianEmail,
      metadata.linearEmail,
      metadata.notionEmail,
      metadata.asanaEmail,
      metadata.stripeEmail,
      metadata.oidcEmail,
      metadata.accountLabel,
      metadata.displayName,
      metadata.providerDisplayName,
      metadata.googleDisplayName,
      metadata.accountName,
      metadata.name,
      metadata.slackUserName,
      metadata.atlassianName,
      metadata.linearName,
      metadata.notionName,
      metadata.asanaName,
      metadata.oidcName,
      metadata.username,
    ]
      .map(text)
      .find(Boolean) ?? fallback;
  const workspace = [
    metadata.slackTeamName,
    metadata.linearWorkspaceName,
    metadata.notionWorkspaceName,
    metadata.stripeAccountName,
    metadata.teamName,
    metadata.workspaceName,
    metadata.team_name,
    metadata.workspace_name,
    nestedName(metadata.team),
    nestedName(metadata.workspace),
  ]
    .map(text)
    .find(Boolean);
  return [...new Set([name, workspace].filter(Boolean))].join(" · ");
}
