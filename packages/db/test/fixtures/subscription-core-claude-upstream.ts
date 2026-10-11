/**
 * The scripted upstream of the Claude conformance runs: model requests go to
 * the shared scripted upstream (keyed by the access token), and usage is a
 * Claude usage-endpoint reading decoded by the Claude adapter's own decoder
 * (`parseClaudeUsageResponse`, then `decodeSubscriptionCoreClaudeQuota`).
 * No network: the reading is held in process.
 */
import { parseClaudeUsageResponse } from "@opengeni/config";
import type { SubscriptionQuota } from "@opengeni/subscriptions";
import {
  decodeSubscriptionCoreClaudeQuota,
  type SubscriptionCoreClaudeCredential,
} from "../../src/subscription-core-claude-adapter";
import { ScriptedApiKeyUpstream } from "./subscription-core-fake-api-key";

export class ScriptedClaudeUpstream extends ScriptedApiKeyUpstream<SubscriptionCoreClaudeCredential> {
  private readonly readings = new Map<string, unknown>();

  constructor(private readonly upstreamModelIds: readonly string[]) {
    super((credential) => credential.token);
  }

  /** Claude's usage endpoint, read through the Claude decoder. */
  override readonly usage = {
    // The plan has room again: both account windows well below their limit.
    restore: (credential: SubscriptionCoreClaudeCredential) => {
      const reset = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
      this.readings.set(credential.token, {
        five_hour: { utilization: 12, resets_at: reset(4) },
        seven_day: { utilization: 30, resets_at: reset(100) },
        seven_day_opus: { utilization: 5, resets_at: reset(100) },
      });
    },
    read: async (
      credential: SubscriptionCoreClaudeCredential,
      observedAt: number,
      refreshGeneration: number,
    ): Promise<SubscriptionQuota> => {
      const observation = parseClaudeUsageResponse(
        this.readings.get(credential.token) ?? {},
        new Date(observedAt),
      );
      if (!observation) throw new Error("The scripted Claude usage endpoint has no reading");
      return {
        ...decodeSubscriptionCoreClaudeQuota({
          observation,
          refreshGeneration,
          upstreamModelIds: this.upstreamModelIds,
        }),
        revision: 0,
      };
    },
  };
}
