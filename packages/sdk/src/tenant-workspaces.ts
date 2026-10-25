import type { OpenGeniEmbeddingClient } from "./embedding-client";
import type { Permission } from "./types";
import { OpenGeniApiError } from "./errors";
import { uuidV5 } from "./chat/ids";

const ISOLATION_NAMESPACE = "fc398712-b4db-5b0b-8842-57cb4f2a65f9";
/**
 * Conversation-only member permissions. The API grants exactly this set when
 * an organization key first acts as a user on a workspace (keep equal to
 * `EXTERNAL_FIRST_USE_MEMBER_PERMISSIONS` in `packages/core/src/access`).
 */
const CONVERSATION_PERMISSIONS = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:upload",
  "files:read",
  "mcp_servers:attach",
] as const;

/**
 * Conversation permissions plus `connections:personal`: connect one's own
 * accounts (for example Gmail) from the chat, turn on a reviewed OAuth
 * integration for personal accounts, and use it in one's own chats.
 */
const PERSONAL_SETUP_PERMISSIONS = [...CONVERSATION_PERMISSIONS, "connections:personal"] as const;

/**
 * Whether each product user acts as their own Opengeni user (`per_user`:
 * `resolve` returns a distinct `user` per person) or many product users share
 * one (`shared`: for example one `user` per team or per tenant).
 */
export type SessionIdentities = "per_user" | "shared";

export type WorkspaceIdTarget = {
  /**
   * Your tenant id. With user isolation and no tenant, the user gets one
   * workspace of their own, independent of any tenant.
   */
  tenant?: string | undefined;
  user?: string | undefined;
  /** External user identity source; defaults to the resolver's source. */
  source?: string | undefined;
};

export type WorkspaceIdOptions = {
  /**
   * `tenant`: one workspace per tenant. `user`: a separate workspace for the
   * user (per tenant when a tenant is given, otherwise one per user).
   */
  isolation: "tenant" | "user";
};

export type WorkspaceIdResolverOptions = {
  /** The organization id, or a lazy lookup (for example derived from the API key). */
  organizationId: string | (() => Promise<string>);
  source: string;
  /** Workspace display name; receives the tenant id, or the user id for a per-user workspace. */
  workspaceName?: ((tenant: string) => string) | undefined;
  /**
   * The permissions of the members this resolver adds, so the product chooses
   * its users' role instead of patching grants afterwards.
   *
   * A per-user workspace (user isolation) always gets its one owner from this
   * resolver, with these permissions or the defaults: workspace read, session
   * create/read/control (including sending messages), file upload/read,
   * attaching the host's per-session MCP servers, and connecting their own
   * accounts from the chat (`connections:personal`, unless `identities` is
   * `shared`). No admin permissions are granted by default.
   *
   * A tenant workspace's users are added here only when this is set: a tenant
   * resolution that names a user adds that user with exactly these
   * permissions before their first request. Without it, the API adds a
   * missing member with the defaults on their first request.
   *
   * Existing grants are never changed here, including members the API added
   * earlier with the defaults; change them with
   * `updateExternalWorkspaceMember`. The organization API key must also allow
   * the selected permissions.
   */
  memberPermissions?: readonly Permission[] | undefined;
  /**
   * Whether each product user is their own Opengeni user. It decides whether
   * people may connect their own accounts from the chat (`connections:personal`),
   * because a personal connection belongs to the Opengeni user: with a shared
   * identity, one person's Gmail would be usable by everyone behind it.
   *
   * - Unset: per-user workspaces (`{ user }` alone, `chats: "isolated"`) get
   *   it; tenant workspaces do not.
   * - `per_user`: per-user and tenant workspaces get it. Tenant users are
   *   then added by this resolver, like with `memberPermissions`.
   * - `shared`: nobody gets it by default.
   *
   * `memberPermissions` overrides this either way. Existing memberships are
   * never changed.
   */
  identities?: SessionIdentities | undefined;
};

/**
 * Server-only workspace resolution using external workspace provisioning.
 * Workspaces are created on first use and cached. A tenant workspace's members
 * are added by the API on their first `asUser` request (the organization key
 * needs `members:manage`), or by this resolver with `memberPermissions` when
 * that is set. A per-user workspace stays single-user: the API never
 * auto-admits anyone there, and this resolver adds its owner. Every explicit
 * grant uses a stable onboarding key, so retries never restore a revoked
 * grant.
 */
export function createWorkspaceIdResolver(
  client: Pick<OpenGeniEmbeddingClient, "ensureWorkspace" | "addExternalWorkspaceMember">,
  options: WorkspaceIdResolverOptions,
): (target: WorkspaceIdTarget, resolution: WorkspaceIdOptions) => Promise<string> {
  // A personal connection belongs to the Opengeni user, so only distinct
  // users get personal setup by default (see `identities`).
  const isolatedPermissions = [
    ...(options.memberPermissions ??
      (options.identities === "shared" ? CONVERSATION_PERMISSIONS : PERSONAL_SETUP_PERMISSIONS)),
  ];
  const tenantPermissions = [
    ...(options.memberPermissions ??
      (options.identities === "per_user" ? PERSONAL_SETUP_PERMISSIONS : CONVERSATION_PERMISSIONS)),
  ];
  const tenantMembers =
    options.memberPermissions !== undefined || options.identities === "per_user";
  const cache = new Map<string, Promise<string>>();
  const members = new Map<string, Promise<void>>();
  const organizationId = async () =>
    typeof options.organizationId === "function"
      ? await options.organizationId()
      : options.organizationId;
  const remember = <T>(map: Map<string, Promise<T>>, key: string, pending: Promise<T>) => {
    pending.catch(() => {
      if (map.get(key) === pending) map.delete(key);
    });
    if (map.size >= 1_000) map.delete(map.keys().next().value!);
    map.set(key, pending);
    return pending;
  };
  // Defaulted personal setup must not break a host whose organization key
  // policy predates it (a custom policy without `connections:personal` or
  // `connections:write`): then the member gets the conversation defaults.
  const defaulted = options.memberPermissions === undefined && options.identities === undefined;
  const addMember = async (
    workspaceId: string,
    source: string,
    user: string,
    permissions: readonly Permission[],
  ) => {
    const add = async (granted: readonly Permission[], operation: unknown[]) =>
      await client.addExternalWorkspaceMember(workspaceId, {
        identity: { source, externalId: user },
        permissions: [...granted],
        operationId: await uuidV5(JSON.stringify(operation), ISOLATION_NAMESPACE),
      });
    try {
      try {
        await add(permissions, ["member", workspaceId, source, user]);
      } catch (error) {
        if (
          !defaulted ||
          !permissions.includes("connections:personal") ||
          !(error instanceof OpenGeniApiError) ||
          error.status !== 403
        )
          throw error;
        await add(CONVERSATION_PERMISSIONS, ["member", workspaceId, source, user, "conversation"]);
      }
    } catch (error) {
      // The member may exist already (added by the API on an earlier first
      // request, or by this key with other permissions), or the grant may have
      // been cancelled. A definitive conflict must never mint a new key or
      // update access. Return only the address: every asUser operation still
      // checks the live membership, including reduced or withdrawn permissions.
      if (
        !(error instanceof OpenGeniApiError) ||
        error.status !== 409 ||
        error.code !== "conflict" ||
        error.outcomeUnknown
      )
        throw error;
    }
  };
  return async (target, resolution) => {
    const isolated = resolution.isolation === "user";
    if (!isolated && !target.tenant) throw new TypeError("workspaceIdFor requires a tenant.");
    if (isolated && !target.user) {
      throw new TypeError("User isolation requires an authenticated product user.");
    }
    const source = target.source ?? options.source;
    // A per-user workspace without a tenant has its own key shape, so it can
    // never alias a tenant-scoped isolated workspace.
    const key = target.tenant
      ? JSON.stringify([
          resolution.isolation,
          options.source,
          source,
          target.tenant,
          isolated ? target.user : null,
        ])
      : JSON.stringify(["user", options.source, source, target.user]);
    const workspaceId = await (cache.get(key) ??
      remember(
        cache,
        key,
        (async () => {
          const productSource = options.source.trim();
          const isolatedSource = `opengeni-sdk:user-isolation:${await uuidV5(productSource, ISOLATION_NAMESPACE)}`;
          const label = target.tenant ?? target.user!;
          const { workspace } = await client.ensureWorkspace({
            accountId: await organizationId(),
            externalSource: isolated
              ? isolatedSource === productSource
                ? `${isolatedSource}:user`
                : isolatedSource
              : options.source,
            externalId: isolated ? await uuidV5(key, ISOLATION_NAMESPACE) : target.tenant!,
            name: options.workspaceName?.(label) ?? label,
          });
          if (isolated) await addMember(workspace.id, source, target.user!, isolatedPermissions);
          return workspace.id;
        })(),
      ));
    if (!isolated && tenantMembers && target.user) {
      const memberKey = JSON.stringify([workspaceId, source, target.user]);
      await (members.get(memberKey) ??
        remember(
          members,
          memberKey,
          addMember(workspaceId, source, target.user, tenantPermissions),
        ));
    }
    return workspaceId;
  };
}
