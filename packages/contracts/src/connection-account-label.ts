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
      metadata.accountLabel,
      metadata.displayName,
      metadata.providerDisplayName,
      metadata.googleDisplayName,
      metadata.accountName,
      metadata.name,
      metadata.slackUserName,
      metadata.username,
      metadata.slackUserId,
    ]
      .map(text)
      .find(Boolean) ?? fallback;
  const workspace = [
    metadata.slackTeamName,
    metadata.teamName,
    metadata.workspaceName,
    metadata.team_name,
    metadata.workspace_name,
    nestedName(metadata.team),
    nestedName(metadata.workspace),
    metadata.slackTeamId,
  ]
    .map(text)
    .find(Boolean);
  return [...new Set([name, workspace].filter(Boolean))].join(" · ");
}
