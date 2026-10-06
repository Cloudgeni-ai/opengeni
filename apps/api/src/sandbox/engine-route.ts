import { readSandboxSessionEngineRoute, type Database } from "@opengeni/db";
import { SessionCapabilities, type Session } from "@opengeni/contracts";
import { ApiHttpError } from "../http/api-error";

type SessionRouteInput = {
  accountId: string;
  workspaceId: string;
  session: Pick<Session, "id">;
};

/** The durable group choice governs API access too. Flags and deployment
 * defaults cannot send an existing native machine through legacy setup. */
export async function sandboxApiUsesNativeMachine(db: Database, input: SessionRouteInput) {
  return (
    (
      await readSandboxSessionEngineRoute(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.session.id,
      })
    ).engine === "machine-v2"
  );
}

/** Native agent commands do not establish human interactive ownership. Keep
 * the ordinary output feed, but advertise no unsupported API or stream grant.
 * This descriptor resolves no legacy placement, lease or provider material. */
export function unavailableNativeSandboxApiCapabilities(input: {
  session: Pick<Session, "id" | "sandboxBackend" | "sandboxOs">;
  shared: boolean;
  sharedSessionIds: string[];
  acknowledged: boolean;
}) {
  const reason = "backend_unsupported" as const;
  return SessionCapabilities.parse({
    sessionId: input.session.id,
    backend: input.session.sandboxBackend,
    os: input.session.sandboxOs,
    liveness: "cold",
    leaseEpoch: 0,
    FileSystem: {
      available: false,
      readOnly: true,
      root: "/workspace",
      pathSep: "/",
      treeMode: "lazy",
      reason,
    },
    Terminal: {
      transport: "sse-events",
      ptyCapable: false,
      shell: "/bin/bash",
      url: null,
      token: null,
      expiresAt: null,
      reason,
    },
    Git: { available: false, repos: [], reason },
    DesktopStream: {
      transport: null,
      client: null,
      mode: "read-only",
      url: null,
      token: null,
      expiresAt: null,
      unredacted: true,
      requiresAcknowledgment: true,
      acknowledged: input.acknowledged,
      shared: input.shared,
      sharedSessionIds: input.sharedSessionIds,
      reason,
    },
    Recording: { available: false, modes: [], codecs: [], reason },
    ComputerUse: { available: false, readOnly: true, reason: "disabled_by_policy" },
    negotiatedAt: new Date().toISOString(),
  });
}

/** Native interactive owners must be installed before this API path can serve
 * them. Refuse before resolving material, acquiring a lease or provider I/O. */
export async function requireLegacySandboxApiRoute(db: Database, input: SessionRouteInput) {
  if (await sandboxApiUsesNativeMachine(db, input))
    throw new ApiHttpError(409, {
      code: "conflict",
      message: "Workspace compute is unavailable for this operation.",
      retryable: false,
      outcomeUnknown: false,
      details: { code: "SANDBOX_V2_INTERACTIVE_UNAVAILABLE" },
    });
}
