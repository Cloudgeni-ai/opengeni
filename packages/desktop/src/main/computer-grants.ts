import type { OpenGeniClient, UserResourceAuthoritySummary } from "@opengeni/sdk";

/** The part of the API client that lets the person's agents use their computer. */
export type ComputerGrantClient = Pick<
  OpenGeniClient,
  "listUserResourceAuthorities" | "issueUserResourceGrant"
>;

/** Chats are private to the person or shared with the workspace. */
const CHAT_CONTEXTS = ["user_private", "workspace_shared"] as const;

/**
 * Connecting this computer is the person's consent for their agents to use
 * it. A personal machine otherwise needs that consent again in every chat,
 * so standing permission is given for the person's private and shared chats
 * in this workspace. The server still admits only turns the owner started,
 * so no one else can use the computer. Permission that already stands is
 * left alone.
 */
export async function allowAgentsOnComputer(
  client: ComputerGrantClient,
  workspaceId: string,
  enrollmentId: string,
  now: () => number = Date.now,
): Promise<void> {
  const authority = await findAuthority(client, workspaceId, enrollmentId);
  if (!authority) throw new Error("This computer isn't listed as yours yet. Try again.");
  for (const context of CHAT_CONTEXTS) {
    if (hasStandingGrant(authority, workspaceId, context, now())) continue;
    await client.issueUserResourceGrant(workspaceId, authority.authorityId, {
      scope: "user",
      resourceKind: "connected_machine",
      mode: "always",
      context,
      ...(context === "workspace_shared" ? { workspaceSharedAcknowledged: true } : {}),
    });
  }
}

async function findAuthority(
  client: ComputerGrantClient,
  workspaceId: string,
  enrollmentId: string,
): Promise<UserResourceAuthoritySummary | null> {
  let cursor: string | undefined;
  // Bounded: a person has few machines, and a broken cursor must not loop.
  for (let page = 0; page < 20; page += 1) {
    const listed = await client.listUserResourceAuthorities(workspaceId, {
      resourceKind: "connected_machine",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const found = listed.authorities.find(
      (authority) => authority.resourceId === enrollmentId && authority.status === "active",
    );
    if (found) return found;
    if (!listed.nextCursor) return null;
    cursor = listed.nextCursor;
  }
  return null;
}

function hasStandingGrant(
  authority: UserResourceAuthoritySummary,
  workspaceId: string,
  context: (typeof CHAT_CONTEXTS)[number],
  now: number,
): boolean {
  return authority.grants.some(
    (grant) =>
      grant.status === "active" &&
      grant.mode === "always" &&
      grant.action === "connected_machine.use" &&
      grant.context === context &&
      grant.targetWorkspaceId === workspaceId &&
      grant.targetSessionId === null &&
      (grant.expiresAt === null || Date.parse(grant.expiresAt) > now),
  );
}
