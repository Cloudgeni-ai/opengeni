import {
  WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX,
  type AccessGrant,
  type ToolGatewayIdentity,
} from "@opengeni/contracts";
import {
  availableMcpAccountBindings,
  expandMcpAccountRoutes,
  settingsWithEnabledCapabilityMcpServers,
  type ApiRouteDeps,
} from "@opengeni/core";
import {
  getSessionTurnMcpAccountBindings,
  WorkspaceArtifactOperationError,
  type EnabledMcpCapabilityServer,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { ApiHttpError } from "./http/api-error";
import { exactAgentAttemptClaims } from "./sandbox/agent-fleet-context";
import { allGatewayToolRefs } from "./workspace-tool-gateway";

/**
 * How a Site's declared tools reach the person viewing it.
 *
 * A Site version declares tool identities. A declared *canonical* connector
 * identity (`{ serverId: <connector>, toolName }`) means "this tool on the
 * viewer's own account": it resolves per viewer to that viewer's account
 * routes, never to another member's personal connection. A declared account
 * route is honoured exactly for its owner; for anyone else it resolves through
 * the canonical identity the same version declares for that tool. Account
 * route ids are hashes and are never parsed: the mapping comes only from the
 * viewer's own bindings and the version's declarations.
 */
export type SiteToolAccount = {
  /** The viewer's own account route for this tool. */
  identity: ToolGatewayIdentity;
  /** The connector, e.g. "Gmail". */
  connector: string;
  /** The account, e.g. "ada@example.com". */
  account: string;
  /** The canonical connector the route belongs to. */
  canonicalServerId: string;
  connectionId: string;
  /** The connection is shared with the workspace rather than the viewer's own. */
  shared?: boolean;
};

export type SiteToolConnect = {
  capabilityId: string | null;
  name: string;
  providerDomain: string;
};

export type SiteToolRouting =
  /** Run exactly this identity (the viewer's own route, or a tool without accounts). */
  | {
      kind: "direct";
      identity: ToolGatewayIdentity;
      /** The declared identity that authorizes it. */
      declaredIdentity: ToolGatewayIdentity;
      /** Key of an "Always allow for this Site" consent for this call. */
      allowance: {
        serverId: string;
        toolName: string;
        connectionId: string | null;
      };
      account?: SiteToolAccount;
      /**
       * Set when nothing in the viewer's inventory explains the declared
       * identity (another member's account route the version pairs with no
       * connector, or a connector no longer here). It still runs as itself,
       * so whatever the gateway can resolve keeps working; a miss is answered
       * as `site_tool_not_available_for_viewer` instead of a bare 404.
       */
      unresolved?: true;
    }
  /** The viewer chooses one of their own accounts. */
  | {
      kind: "accounts";
      declaredIdentity: ToolGatewayIdentity;
      accounts: SiteToolAccount[];
    }
  /** The viewer has no account for the declared connector yet. */
  | {
      kind: "connect";
      declaredIdentity: ToolGatewayIdentity;
      connect: SiteToolConnect;
    };

const same = (left: ToolGatewayIdentity, right: ToolGatewayIdentity) =>
  left.serverId === right.serverId && left.toolName === right.toolName;

export const siteToolNotAuthorized = () =>
  new HTTPException(403, { message: "site_tool_not_authorized" });

/**
 * A tool the pinned Site version declares that the viewer cannot use, and
 * cannot connect from here. Keeps the status of the unavailable-tool answer
 * (404) so existing callers see no change; the typed code and message let the
 * Site say why. Discloses nothing beyond the version's own declarations.
 */
export const siteToolNotAvailableForViewer = () =>
  new ApiHttpError(404, {
    code: "not_found",
    message:
      "This Site uses an account that isn't yours, so it can't run this for you. Ask the Site's owner to publish it again so it can use your own account.",
    retryable: false,
    outcomeUnknown: false,
    details: { code: "site_tool_not_available_for_viewer" },
  });

export type SiteToolAccountInventory = {
  /** Connectors whose tools run on a person's account, by canonical id. */
  canonical: ReadonlyMap<string, SiteToolConnect>;
  /** Servers that run as themselves (first-party, connectors without accounts). */
  plain: ReadonlySet<string>;
  /** The viewer's own account routes. */
  accounts: ReadonlyArray<Omit<SiteToolAccount, "identity"> & { serverId: string }>;
};

/** The viewer's own connector accounts, read once; grants nothing by itself. */
export async function readSiteToolAccountInventory(
  deps: ApiRouteDeps,
  grant: AccessGrant,
): Promise<SiteToolAccountInventory> {
  const base = deps.catalogSourceSettings ?? deps.settings;
  let capabilityServers: readonly EnabledMcpCapabilityServer[] = [];
  const settings = await settingsWithEnabledCapabilityMcpServers(deps.db, grant.workspaceId, base, {
    subjectId: grant.subjectId,
    onResolvedCapabilityServers: (servers) => {
      capabilityServers = servers;
    },
  });
  const source: Parameters<typeof availableMcpAccountBindings>[0]["source"] =
    grant.principalKind === "service" || grant.principalKind === "api_key"
      ? { kind: "none" }
      : {
          kind: "subject",
          accountId: grant.accountId,
          subjectId: grant.subjectId,
        };
  const tools = allGatewayToolRefs(settings);
  const bindings = await availableMcpAccountBindings({
    db: deps.db,
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    settings,
    tools,
    source,
  });
  const routes = expandMcpAccountRoutes({ settings, tools, bindings });
  const canonical = new Map<string, SiteToolConnect>();
  const plain = new Set<string>();
  for (const server of settings.mcpServers) {
    const ref = server.connectionRef;
    if (!ref || ref.authoritySource === "host") {
      plain.add(server.id);
      continue;
    }
    canonical.set(server.id, {
      capabilityId:
        capabilityServers.find((candidate) => candidate.id === server.id)?.capabilityId ?? null,
      name: server.name ?? server.id,
      providerDomain: ref.providerDomain,
    });
  }
  const accounts = bindings.flatMap((binding) => {
    // Only routes the gateway would actually expose to this viewer.
    const label = routes.accountLabels.get(binding.serverId);
    if (!label || !canonical.has(binding.canonicalServerId)) return [];
    // "ada@example.com · Yours" -> "ada@example.com"
    const account = binding.accountLabel.replace(/ · [^·]+$/u, "");
    return [
      {
        serverId: binding.serverId,
        connector: label.connector,
        account,
        canonicalServerId: binding.canonicalServerId,
        connectionId: binding.connectionId,
        shared: binding.subjectScope === "workspace",
      },
    ];
  });
  return { canonical, plain, accounts };
}

/**
 * Route one Site call for its viewer. Throws `site_tool_not_authorized` when
 * the version declares nothing that covers the identity.
 */
export function routeSiteTool(
  inventory: SiteToolAccountInventory,
  declared: readonly ToolGatewayIdentity[],
  identity: ToolGatewayIdentity,
): SiteToolRouting {
  const accountsFor = (canonicalServerId: string, toolName: string): SiteToolAccount[] =>
    inventory.accounts
      .filter((account) => account.canonicalServerId === canonicalServerId)
      .map(({ serverId, ...account }) => ({
        ...account,
        identity: { serverId, toolName },
      }));
  const choose = (declaredIdentity: ToolGatewayIdentity): SiteToolRouting => {
    const accounts = accountsFor(declaredIdentity.serverId, declaredIdentity.toolName);
    if (accounts.length === 0)
      return {
        kind: "connect",
        declaredIdentity,
        connect: inventory.canonical.get(declaredIdentity.serverId)!,
      };
    return { kind: "accounts", declaredIdentity, accounts };
  };
  const own = inventory.accounts.find((account) => account.serverId === identity.serverId);
  if (own) {
    const canonicalIdentity = {
      serverId: own.canonicalServerId,
      toolName: identity.toolName,
    };
    const declaredIdentity = declared.find(
      (item) => same(item, identity) || same(item, canonicalIdentity),
    );
    if (!declaredIdentity) throw siteToolNotAuthorized();
    return {
      kind: "direct",
      identity,
      declaredIdentity,
      allowance: {
        serverId: own.canonicalServerId,
        toolName: identity.toolName,
        connectionId: own.connectionId,
      },
      account: {
        identity,
        connector: own.connector,
        account: own.account,
        canonicalServerId: own.canonicalServerId,
        connectionId: own.connectionId,
        ...(own.shared === undefined ? {} : { shared: own.shared }),
      },
    };
  }
  if (!declared.some((item) => same(item, identity))) throw siteToolNotAuthorized();
  // A declared canonical connector: the viewer's own accounts.
  if (inventory.canonical.has(identity.serverId)) return choose(identity);
  const asItself = (unresolved?: true): SiteToolRouting => ({
    kind: "direct",
    identity,
    declaredIdentity: identity,
    allowance: {
      serverId: identity.serverId,
      toolName: identity.toolName,
      connectionId: null,
    },
    ...(unresolved ? { unresolved } : {}),
  });
  // A declared identity that is not an account route at all (first-party or a
  // connector without accounts) runs as itself.
  if (inventory.plain.has(identity.serverId)) return asItself();
  // Another member's account route: only through the canonical identity this
  // version also declares for the same tool, and only when that is unambiguous.
  const candidates = declared.filter(
    (item) => item.toolName === identity.toolName && inventory.canonical.has(item.serverId),
  );
  if (candidates.length === 1) return choose(candidates[0]!);
  // Otherwise it stays that route, which the gateway does not resolve for this
  // viewer; the miss is answered as `site_tool_not_available_for_viewer`.
  return asItself(true);
}

/**
 * The tools a new Site version declares, as every viewer can use them. An
 * agent sees its own account routes (`account-<hash>`), so a Site it builds
 * declares the publisher's routes. Each one the publisher owns is paired with
 * its connector's canonical identity, which `routeSiteTool` resolves per
 * viewer to their own account, or to the connect card when they have none.
 * Uses only the publisher's own bindings; nothing else is added. A list that
 * would pass the declaration limit is refused rather than silently left
 * working only for the publisher.
 */
export function siteToolDeclarationsForEveryViewer(
  inventory: { accounts: ReadonlyArray<{ serverId: string; canonicalServerId: string }> },
  declared: readonly ToolGatewayIdentity[],
): ToolGatewayIdentity[] {
  const result = [...declared];
  const seen = new Set(declared.map((item) => JSON.stringify([item.serverId, item.toolName])));
  for (const item of declared) {
    const own = inventory.accounts.find((account) => account.serverId === item.serverId);
    if (!own) continue;
    const canonical = { serverId: own.canonicalServerId, toolName: item.toolName };
    const key = JSON.stringify([canonical.serverId, canonical.toolName]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
  }
  if (result.length > WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX)
    throw new WorkspaceArtifactOperationError(
      `These ${declared.length} tools use your own connected accounts, so each is also declared for its connector so that other viewers can use their own account. That makes ${result.length} declarations, more than the limit of ${WORKSPACE_ARTIFACT_REQUESTED_TOOLS_MAX}. Declare fewer tools.`,
    );
  return result;
}

/**
 * `siteToolDeclarationsForEveryViewer` over the publisher's own accounts. An
 * agent publishes as its attempt, not as the person, so its accounts are the
 * turn's frozen account bindings: exactly the routes in its tool catalog, the
 * same ones the publication's catalog check accepts.
 */
export async function declareSiteToolsForEveryViewer(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  declared: readonly ToolGatewayIdentity[],
  readAccounts: typeof readSiteToolAccountInventory = readSiteToolAccountInventory,
  readTurnBindings: typeof getSessionTurnMcpAccountBindings = getSessionTurnMcpAccountBindings,
): Promise<ToolGatewayIdentity[]> {
  if (declared.length === 0) return [...declared];
  const claims = exactAgentAttemptClaims(grant);
  if (claims) {
    // Pairing nothing would leave the Site working only for the publisher, so
    // a turn whose bindings can't be read refuses the publication.
    const bindings = await readTurnBindings(
      deps.db,
      grant.workspaceId,
      claims.sessionId,
      claims.turnId,
    ).catch((error: unknown) => {
      throw new WorkspaceArtifactOperationError(
        "Couldn't read this turn's connected accounts, so the Site's tools couldn't be shared with other viewers. Nothing was published; publish again.",
        { cause: error },
      );
    });
    return siteToolDeclarationsForEveryViewer({ accounts: bindings ?? [] }, declared);
  }
  return siteToolDeclarationsForEveryViewer(await readAccounts(deps, grant), declared);
}

/**
 * The viewer's choices for one Site call: every own account that may run the
 * declared tool (with the one the Site asked for selected), or how to connect
 * one. An account is offered only when routing it would itself be authorized.
 */
export function siteToolConsentChoices(
  inventory: SiteToolAccountInventory,
  declared: readonly ToolGatewayIdentity[],
  identity: ToolGatewayIdentity,
): {
  accounts: SiteToolAccount[];
  selected: ToolGatewayIdentity | null;
  connect: SiteToolConnect | null;
} {
  const routed = routeSiteTool(inventory, declared, identity);
  if (routed.kind === "connect") return { accounts: [], selected: null, connect: routed.connect };
  if (routed.kind === "accounts")
    return { accounts: routed.accounts, selected: null, connect: null };
  if (!routed.account) return { accounts: [], selected: null, connect: null };
  const canonicalServerId = routed.account.canonicalServerId;
  const accounts = inventory.accounts.flatMap((account) => {
    if (account.canonicalServerId !== canonicalServerId) return [];
    try {
      const candidate = routeSiteTool(inventory, declared, {
        serverId: account.serverId,
        toolName: identity.toolName,
      });
      return candidate.kind === "direct" && candidate.account ? [candidate.account] : [];
    } catch {
      return [];
    }
  });
  return { accounts, selected: routed.identity, connect: null };
}
