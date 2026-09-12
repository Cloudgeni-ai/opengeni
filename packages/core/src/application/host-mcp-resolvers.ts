import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  HostMcpResolverSource,
  PutHostMcpResolverRequest,
  RevokeHostMcpResolverRequest,
} from "@opengeni/contracts/host-mcp-resolvers";
import { getHostMcpResolver, mutateHostMcpResolver, HostMcpResolverError } from "@opengeni/db";
import { isLocalTestEnvironment, validateHttpUrl } from "@opengeni/network";
import {
  accountScopedApiKeyWorkspaceAuthority,
  requireAccessContext,
  type AccessDeps,
} from "../access";
import { requireVariableSetEncryption } from "../domain/environments";
import { hasLegacyHostMcpResolver } from "../remote-mcp-credentials";

export async function hostMcpResolverForRequest(
  context: Context,
  deps: AccessDeps,
  organizationId: string,
  source: string,
  method: "get" | "put" | "revoke",
  raw?: unknown,
) {
  const id = z.string().uuid().safeParse(organizationId);
  const externalSource = HostMcpResolverSource.safeParse(source);
  if (!id.success || !externalSource.success)
    throw new HTTPException(422, { message: "invalid resolver identity" });
  const access = await requireAccessContext(context, deps);
  const service = accountScopedApiKeyWorkspaceAuthority(access);
  const account = access.accountGrants.find(
    (grant) => grant.accountId === id.data && grant.subjectId === access.subjectId,
  );
  if (!service || service.accountId !== id.data || !account?.permissions.includes("account:admin"))
    throw new HTTPException(403, {
      message: "resolver administration requires an organization service key",
    });
  const actor = { accountId: id.data, subjectId: access.subjectId };
  try {
    if (method === "get") return await getHostMcpResolver(deps.db, actor, externalSource.data);
    const common = {
      externalSource: externalSource.data,
      encryptionKey: requireVariableSetEncryption(deps.settings),
      legacyConfigured: hasLegacyHostMcpResolver(deps.settings, id.data),
    };
    if (method === "put") {
      const parsed = PutHostMcpResolverRequest.safeParse(raw);
      if (!parsed.success) throw new HTTPException(422, { message: "invalid resolver operation" });
      let url: string;
      try {
        url = validateHttpUrl(parsed.data.url, {
          allowLoopbackHttp: isLocalTestEnvironment(deps.settings.environment),
        });
        if (
          new URL(url).protocol !== "https:" &&
          !isLocalTestEnvironment(deps.settings.environment)
        )
          throw new Error();
      } catch {
        throw new HTTPException(422, { message: "invalid resolver URL" });
      }
      return await mutateHostMcpResolver(deps.db, actor, {
        ...common,
        kind: "put",
        request: { ...parsed.data, url },
      });
    }
    const parsed = RevokeHostMcpResolverRequest.safeParse(raw);
    if (!parsed.success) throw new HTTPException(422, { message: "invalid resolver operation" });
    return await mutateHostMcpResolver(deps.db, actor, {
      ...common,
      kind: "revoke",
      request: parsed.data,
    });
  } catch (error) {
    if (error instanceof HostMcpResolverError)
      throw new HTTPException(error.status, { message: error.message });
    if (error instanceof HTTPException) throw error;
    // Database/encryption errors can carry SQL parameters. Never expose or log
    // the underlying credential-bearing cause at the public route boundary.
    throw new HTTPException(503, { message: "resolver administration unavailable" });
  }
}
