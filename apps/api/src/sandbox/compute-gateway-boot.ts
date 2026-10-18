/**
 * Start the compute agent gateway (./compute-gateway.ts) when this deployment
 * serves compute sandboxes: the fabric API, its key and the gateway's own URL
 * are configured, and every other compute setting checks out. Otherwise it
 * stays off and the API serves no link route.
 */

import {
  computeGatewayConfigured,
  computeSettingsIssues,
  resolveRelayTokenSecret,
  type Settings,
} from "@opengeni/config";
import { signRelayToken } from "@opengeni/contracts";
import { relayDialBaseFromSettings } from "@opengeni/core";
import {
  openSandboxAgentLink,
  releaseSandboxAgentLink,
  renewSandboxAgentLink,
  type Database,
} from "@opengeni/db";
import { createAgentLinkNatsConnection, type AgentLinkNats } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import { ComputeFabricClient } from "@opengeni/runtime/sandbox";
import { observabilityEventBusOptions } from "../observability";
import { ComputeAgentGateway, type ComputeAgentLinkStore } from "./compute-gateway";
import { ComputeLinkVerifier } from "./compute-link-tokens";
import { AGENT_CONNECTION_LEASE_MS } from "./connection-authority";

/** The database claim store for link sessions, with the Connected Machine
 * connection lease. */
export function databaseComputeAgentLinkStore(db: Database): ComputeAgentLinkStore {
  return {
    open: async (claim) => {
      const result = await openSandboxAgentLink(db, {
        ...claim,
        leaseMs: AGENT_CONNECTION_LEASE_MS,
      });
      return result.opened
        ? { opened: true, superseded: result.superseded }
        : { opened: false, code: result.code };
    },
    renew: async (claim) =>
      await renewSandboxAgentLink(db, { ...claim, leaseMs: AGENT_CONNECTION_LEASE_MS }),
    release: async (claim) => {
      await releaseSandboxAgentLink(db, claim);
    },
  };
}

export type ComputeGatewayHandle = {
  gateway: ComputeAgentGateway;
  close(): Promise<void>;
};

export async function startComputeAgentGateway(input: {
  db: Database;
  settings: Settings;
  natsAuth: { user: string; pass: string } | undefined;
  maxWebSocketMessageBytes: number;
  observability?: Observability;
  /** Injected for tests. */
  connectNats?: () => Promise<AgentLinkNats>;
  fetch?: typeof fetch;
}): Promise<ComputeGatewayHandle | undefined> {
  const { settings, observability } = input;
  if (!computeGatewayConfigured(settings)) return undefined;
  const issues = computeSettingsIssues(settings);
  if (issues.length > 0) {
    observability?.warn("Opengeni compute agent gateway is not started", {
      errorCode: "compute_gateway_misconfigured",
      issues: issues.join("; "),
    });
    return undefined;
  }
  const relaySecret = resolveRelayTokenSecret(settings)!;
  const fabric = new ComputeFabricClient({
    baseUrl: settings.computeApiUrl!,
    apiKey: settings.computeApiKey!,
    requestTimeoutMs: 10_000,
    maxAttempts: 2,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  const nats = input.connectNats
    ? await input.connectNats()
    : await createAgentLinkNatsConnection(settings.natsUrl, input.natsAuth, {
        name: "opengeni-compute-gateway",
        ...(observability ? observabilityEventBusOptions(observability) : {}),
      });
  const gateway = new ComputeAgentGateway({
    linkUrl: settings.computeLinkUrl!,
    verifier: new ComputeLinkVerifier({
      fetchKeys: () => fabric.linkKeys(),
      audience: settings.computeLinkUrl!,
    }),
    nats,
    store: databaseComputeAgentLinkStore(input.db),
    relay: {
      url: relayDialBaseFromSettings(settings),
      mint: async ({ workspaceId, agentId, expiresAtMs }) =>
        await signRelayToken(relaySecret, {
          workspaceId,
          agentId,
          exp: Math.floor(expiresAtMs / 1000),
        }),
    },
    maxWebSocketMessageBytes: input.maxWebSocketMessageBytes,
    ...(observability
      ? {
          logger: {
            info: (message, attributes) => observability.info(message, attributes),
            warn: (message, attributes) => observability.warn(message, attributes),
          },
        }
      : {}),
  });
  gateway.start();
  observability?.info("Opengeni compute agent gateway started", { path: gateway.path });
  return {
    gateway,
    close: async () => {
      await gateway.close();
      await nats.close();
    },
  };
}
