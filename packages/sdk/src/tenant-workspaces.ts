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
   * Per-user workspaces only (user isolation): permissions for the one member
   * this resolver adds explicitly, its owner. Replaces the defaults: workspace
   * read, session create/read/control (including sending messages), file
   * upload/read, and attaching the host's per-session MCP servers. No admin
   * permissions are granted by default. Tenant workspaces rely on the API,
   * which adds a missing member with those defaults on their first request.
   * Existing grants are never changed here; change them with
   * `updateExternalWorkspaceMember`. The organization API key must also allow
   * the selected permissions.
   */
  memberPermissions?: readonly Permission[] | undefined;
};

/**
 * Server-only workspace resolution using external workspace provisioning.
 * Workspaces are created on first use and cached. A tenant workspace's members
 * are added by the API on their first `asUser` request (the organization key
 * needs `members:manage`). A per-user workspace stays single-user: the API
 * never auto-admits anyone there, and this resolver adds its owner with a
 * stable onboarding key, so retries never restore a revoked grant.
 */
export function createWorkspaceIdResolver(
  client: Pick<OpenGeniEmbeddingClient, "ensureWorkspace" | "addExternalWorkspaceMember">,
  options: WorkspaceIdResolverOptions,
): (target: WorkspaceIdTarget, resolution: WorkspaceIdOptions) => Promise<string> {
  const memberPermissions = [...(options.memberPermissions ?? CONVERSATION_PERMISSIONS)];
  const cache = new Map<string, Promise<string>>();
  const organizationId = async () =>
    typeof options.organizationId === "function"
      ? await options.organizationId()
      : options.organizationId;
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
    let pending = cache.get(key);
    if (!pending) {
      pending = (async () => {
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
        if (isolated) {
          try {
            await client.addExternalWorkspaceMember(workspace.id, {
              identity: { source, externalId: target.user! },
              permissions: [...memberPermissions],
              operationId: await uuidV5(
                JSON.stringify(["member", workspace.id, source, target.user]),
                ISOLATION_NAMESPACE,
              ),
            });
          } catch (error) {
            // Defaults/custom permissions may have changed since this stable
            // onboarding key committed, or the grant may have been cancelled.
            // A definitive conflict must never mint a new key or update access.
            // Return only the address: every asUser operation still checks the
            // live membership, including reduced or withdrawn permissions.
            if (
              !(error instanceof OpenGeniApiError) ||
              error.status !== 409 ||
              error.code !== "conflict" ||
              error.outcomeUnknown
            )
              throw error;
          }
        }
        return workspace.id;
      })();
      pending.catch(() => {
        if (cache.get(key) === pending) cache.delete(key);
      });
      if (cache.size >= 1_000) cache.delete(cache.keys().next().value!);
      cache.set(key, pending);
    }
    return await pending;
  };
}
