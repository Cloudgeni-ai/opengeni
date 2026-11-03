import {
  issueSelfUserResourceGrant,
  listSelfUserResourceAuthorities,
  type Database,
} from "@opengeni/db";

/**
 * A person's own Codex, Claude or SuperGrok subscription added from a shared
 * workspace starts turned on there for the messages they send themselves
 * (D-53): things start usable where they are added. Being turned on is the
 * owner's standing `subscription_connection.use` grant in that workspace;
 * their Personal workspace needs none.
 *
 * Best effort: the account is already connected, and its page in that
 * workspace can turn it on if this fails.
 */
export async function turnOnOwnSubscriptionWhereAdded(
  db: Database,
  input: { accountId: string; workspaceId: string; subjectId: string; connectionId: string },
): Promise<void> {
  try {
    let cursor: string | undefined;
    // Bounded: a person has few subscriptions, and a broken cursor must not loop.
    for (let page = 0; page < 20; page += 1) {
      const listed = await listSelfUserResourceAuthorities(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        resourceKind: "subscription_connection",
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const authority = listed.authorities.find(
        (each) => each.resourceId === input.connectionId && each.status === "active",
      );
      if (authority) {
        await issueSelfUserResourceGrant(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          subjectId: input.subjectId,
          authorityId: authority.authorityId,
          resourceKind: "subscription_connection",
          mode: "always",
          context: "workspace_shared",
          workspaceSharedAcknowledged: true,
        });
        return;
      }
      if (!listed.nextCursor) break;
      cursor = listed.nextCursor;
    }
    console.warn("[api] own subscription has no authority to turn on where it was added", {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
    });
  } catch (error) {
    console.warn("[api] could not turn on an own subscription where it was added", {
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
