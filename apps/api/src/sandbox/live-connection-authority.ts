import { setTimeout as delay } from "node:timers/promises";
import { getEnrollment } from "@opengeni/db";
import type { NatsConnection } from "@opengeni/events";
import type { AuthCalloutDeps } from "./auth-callout";

// This is an authorization audit, NOT a socket lifetime. A healthy connection
// survives arbitrarily many audits. No heartbeat deadline is used to revoke it.
export const LIVE_AUTHORITY_AUDIT_INTERVAL_MS = 5_000;
const AUTHORITY_NAME_PREFIX = "opengeni-agent-authority/";
const PAGE_SIZE = 1024;

interface Authority {
  workspaceId: string;
  enrollmentId: string;
  credentialGeneration: number;
  connectionInstanceId: string;
}

/** Signed JWT name. Auth-callout replaces the CONNECT username with this name;
 * CONNZ exposes it as authorized_user (NOT the client-controlled CONNECT name). */
export function connectionAuthorityName(authority: Authority): string {
  return `${AUTHORITY_NAME_PREFIX}${authority.workspaceId}/${authority.enrollmentId}/${authority.credentialGeneration}/${authority.connectionInstanceId}`;
}

function parseAuthority(name: string | undefined): Authority | null {
  if (!name?.startsWith(AUTHORITY_NAME_PREFIX)) return null;
  const parts = name.slice(AUTHORITY_NAME_PREFIX.length).split("/");
  const [workspaceId, enrollmentId, generation, connectionInstanceId] = parts;
  const credentialGeneration = Number(generation);
  if (
    parts.length !== 4 ||
    !workspaceId ||
    !enrollmentId ||
    !connectionInstanceId ||
    !Number.isSafeInteger(credentialGeneration) ||
    credentialGeneration < 1
  )
    throw new Error("invalid signed agent connection authority");
  return { workspaceId, enrollmentId, credentialGeneration, connectionInstanceId };
}

interface BrokerResponse {
  server: { id: string };
  error?: { code: number; description: string };
  data?: {
    total: number;
    connections: Array<{ cid: number; account?: string; authorized_user?: string }>;
  };
}

async function kick(nc: NatsConnection, serverId: string, cid: number): Promise<void> {
  const msg = await nc.request(`$SYS.REQ.SERVER.${serverId}.KICK`, JSON.stringify({ cid }), {
    timeout: 2_000,
  });
  const response = msg.json<BrokerResponse>();
  if (response.server?.id !== serverId) throw new Error("invalid broker revocation response");
  // Another replica may already have kicked it, or the client disconnected.
  if (response.error && response.error.description !== "no such client or leafnode id") {
    throw new Error(`broker revocation failed: ${response.error.code}`);
  }
}

/** Recover authority from the broker itself, including sockets admitted before
 * this API process started. Fan out to all servers and paginate their inventories.
 * Never infer revocation from a missed heartbeat, a DB error, or bearer expiry. */
export async function reconcileLiveConnections(
  deps: AuthCalloutDeps,
  nc: NatsConnection,
): Promise<void> {
  const enrollments = new Map<string, Awaited<ReturnType<typeof getEnrollment>>>();
  const checkedServers = new Set<string>();
  let total = 0;
  for (let offset = 0; offset === 0 || offset < total; offset += PAGE_SIZE) {
    const replies = await nc.requestMany(
      "$SYS.REQ.ACCOUNT.PING.CONNZ",
      JSON.stringify({
        auth: true,
        offset,
        limit: PAGE_SIZE,
      }),
      { maxWait: 1_000 },
    );
    let received = false;
    for await (const msg of replies) {
      const response = msg.json<BrokerResponse>();
      const serverId = response.server?.id;
      if (response.error || !serverId || !response.data?.connections) {
        throw new Error("broker authority inventory unavailable");
      }
      received = true;
      // CID 0 never belongs to a client. This harmless probe proves the required
      // service import works on every server before we grant non-expiring access.
      if (!checkedServers.has(serverId)) {
        await kick(nc, serverId, 0);
        checkedServers.add(serverId);
      }
      total = Math.max(total, response.data.total);
      for (const connection of response.data.connections) {
        if (connection.account !== deps.callout.accountName) continue;
        const authority = parseAuthority(connection.authorized_user);
        if (!authority) continue; // Privileged users, or old finite-lifetime JWTs.
        const key = `${authority.workspaceId}/${authority.enrollmentId}`;
        if (!enrollments.has(key)) {
          enrollments.set(
            key,
            await getEnrollment(deps.db, authority.workspaceId, authority.enrollmentId),
          );
        }
        const enrollment = enrollments.get(key);
        if (
          deps.settings.sandboxSelfhostedEnabled &&
          enrollment?.status === "active" &&
          enrollment.credentialGeneration === authority.credentialGeneration &&
          enrollment.connectionInstanceId === authority.connectionInstanceId
        )
          continue;
        await kick(nc, serverId, connection.cid);
      }
    }
    if (!received) throw new Error("broker authority inventory returned no servers");
  }
}

/** A single non-overlapping audit loop. Broker/DB failure blocks new admission,
 * logs an operational error, and retries; it never disconnects valid work. */
export async function startLiveConnectionAuthority(deps: AuthCalloutDeps, nc: NatsConnection) {
  await reconcileLiveConnections(deps, nc);
  let ready = true;
  const stop = new AbortController();
  const loop = (async () => {
    while (!stop.signal.aborted) {
      try {
        await delay(LIVE_AUTHORITY_AUDIT_INTERVAL_MS, undefined, { signal: stop.signal });
      } catch {
        break;
      }
      try {
        await reconcileLiveConnections(deps, nc);
        ready = true;
      } catch (error) {
        ready = false;
        deps.observability?.error?.("NATS live connection authority audit failed", { error });
      }
    }
  })();
  return {
    isReady: () => ready && !stop.signal.aborted,
    close: async () => {
      stop.abort();
      await loop;
    },
  };
}
