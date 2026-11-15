// Usage credits from a live usage body through the stored quota to what the
// account list and the pooled-limits card show (fixtures captured live in
// packages/config/test/fixtures/claude-usage-live.ts).
import { describe, expect, test } from "bun:test";
import { parseClaudeUsageHeaders, parseClaudeUsageResponse } from "@opengeni/config";
import {
  decodeSubscriptionCoreClaudeQuota,
  SUBSCRIPTION_CORE_CLAUDE,
} from "../src/subscription-core-claude-adapter";
import {
  subscriptionCoreClaudeUpstreamModelIds,
  subscriptionCoreClaudeUsageDetails,
} from "../src/subscription-core-claude-usage";
import { subscriptionCoreOperations } from "../src/subscription-core/operations";
import { decodeSubscriptionQuota } from "../src/subscription-core-repository";
import { subscriptionPoolUsageCredits } from "../src/subscription-usage-pool";
import {
  CLAUDE_HEADERS_OUT_OF_CREDITS,
  CLAUDE_USAGE_AT_WEEKLY_LIMIT,
  CLAUDE_USAGE_THREE_FABLE_GRANTS,
} from "../../config/test/fixtures/claude-usage-live";

const models = ["organization-claude-subscription/claude-opus-5-5"];
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 11, 8, 20 + minutes));
type Row = Parameters<typeof subscriptionPoolUsageCredits>[0][number];

function row(id: string, label: string, quota: unknown = null): Row {
  return {
    id,
    label,
    account_email: null,
    provider_account_id: null,
    quota,
    quota_revision: 1,
    quota_observed_refresh_generation: quota === null ? null : 1,
    quota_updated_at: at(0),
  };
}

/** The row after merging one observation (a usage body or response headers) into it. */
function merged(current: Row, observation: ReturnType<typeof parseClaudeUsageResponse>): Row {
  const decoded = decodeSubscriptionCoreClaudeQuota({
    observation: observation!,
    refreshGeneration: 1,
    upstreamModelIds: subscriptionCoreClaudeUpstreamModelIds(models),
  });
  const write = subscriptionCoreOperations(
    SUBSCRIPTION_CORE_CLAUDE,
  ).mergeSubscriptionCoreUsageObservation(current.quota === null ? null : (current as never), 1, {
    ...decoded,
    revision: Number(current.quota_revision ?? 0),
  })!;
  return { ...current, quota: write.stored, quota_observed_refresh_generation: 1 };
}

describe("usage credits on the pooled accounts", () => {
  test("each account's stored reading decides on, off or unknown", () => {
    const on = merged(
      row("00000000-0000-4000-8000-000000000001", "Max A"),
      parseClaudeUsageResponse(CLAUDE_USAGE_THREE_FABLE_GRANTS, at(0)),
    );
    const off = merged(
      row("00000000-0000-4000-8000-000000000002", "Max B"),
      parseClaudeUsageResponse(CLAUDE_USAGE_AT_WEEKLY_LIMIT, at(0)),
    );
    const unread = row("00000000-0000-4000-8000-000000000003", "Max C");
    expect(subscriptionPoolUsageCredits([on, off, unread])).toEqual([
      { id: on.id, label: "Max A", state: "on" },
      { id: off.id, label: "Max B", state: "off" },
      { id: unread.id, label: "Max C", state: "unknown" },
    ]);
    // The account page reads the same stored part.
    expect(
      subscriptionCoreClaudeUsageDetails(decodeSubscriptionQuota(on as never)).extraUsage?.state,
    ).toBe("enabled");
  });

  test("a reading stored before the setting was parsed (extraUsage null) is unknown", () => {
    const stored = merged(
      row("00000000-0000-4000-8000-000000000004", "Max D"),
      parseClaudeUsageResponse(CLAUDE_USAGE_THREE_FABLE_GRANTS, at(0)),
    );
    const quota = stored.quota as { providerDetails: Record<string, { value: unknown }> };
    quota.providerDetails.extraUsage!.value = null;
    expect(subscriptionPoolUsageCredits([stored])[0]!.state).toBe("unknown");
  });

  test("a later model response's headers keep the setting the usage read stored", () => {
    const read = merged(
      row("00000000-0000-4000-8000-000000000005", "Max E"),
      parseClaudeUsageResponse(CLAUDE_USAGE_THREE_FABLE_GRANTS, at(0)),
    );
    const after = merged(
      read,
      parseClaudeUsageHeaders(new Headers(CLAUDE_HEADERS_OUT_OF_CREDITS), at(5)) as never,
    );
    expect(subscriptionPoolUsageCredits([after])[0]!.state).toBe("on");
  });
});
