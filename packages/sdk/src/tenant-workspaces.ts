import type { OpenGeniEmbeddingClient } from "./embedding-client";
import { uuidV5 } from "./chat/ids";

const ISOLATION_NAMESPACE = "fc398712-b4db-5b0b-8842-57cb4f2a65f9";
const CONVERSATION_PERMISSIONS = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:upload",
  "files:read",
] as const;

export type WorkspaceIdTarget = {
  tenant: string;
  user?: string | undefined;
  /** External user identity source; defaults to the resolver's source. */
  source?: string | undefined;
};

export type WorkspaceIdOptions = {
  /** User isolation provisions a separate workspace and its one external member. */
  isolation: "tenant" | "user";
};

export type WorkspaceIdResolverOptions = {
  organizationId: string;
  source: string;
  workspaceName?: ((tenant: string) => string) | undefined;
};

/**
 * Server-only tenant resolution using external workspace/member provisioning.
 * User isolation admits only the authenticated user; keyed retries never restore a revoked grant.
 */
export function createWorkspaceIdResolver(
  client: Pick<OpenGeniEmbeddingClient, "ensureWorkspace" | "addExternalWorkspaceMember">,
  options: WorkspaceIdResolverOptions,
): (target: WorkspaceIdTarget, resolution: WorkspaceIdOptions) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return async (target, resolution) => {
    if (!target.tenant) throw new TypeError("workspaceIdFor requires a tenant.");
    if (resolution.isolation === "user" && !target.user) {
      throw new TypeError("User isolation requires an authenticated product user.");
    }
    const source = target.source ?? options.source;
    const isolated = resolution.isolation === "user";
    const key = JSON.stringify([
      resolution.isolation,
      options.source,
      source,
      target.tenant,
      isolated ? target.user : null,
    ]);
    let pending = cache.get(key);
    if (!pending) {
      pending = (async () => {
        const productSource = options.source.trim();
        const isolatedSource = `opengeni-sdk:user-isolation:${await uuidV5(productSource, ISOLATION_NAMESPACE)}`;
        const { workspace } = await client.ensureWorkspace({
          accountId: options.organizationId,
          externalSource: isolated
            ? isolatedSource === productSource
              ? `${isolatedSource}:user`
              : isolatedSource
            : options.source,
          externalId: isolated ? await uuidV5(key, ISOLATION_NAMESPACE) : target.tenant,
          name: options.workspaceName?.(target.tenant) ?? target.tenant,
        });
        if (isolated) {
          await client.addExternalWorkspaceMember(workspace.id, {
            identity: { source, externalId: target.user! },
            permissions: [...CONVERSATION_PERMISSIONS],
            operationId: await uuidV5(
              JSON.stringify(["member", workspace.id, source, target.user]),
              ISOLATION_NAMESPACE,
            ),
          });
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
