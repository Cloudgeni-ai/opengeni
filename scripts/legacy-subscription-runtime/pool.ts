import {
  SUBSCRIPTION_RENAMED_POLICIES,
  SUBSCRIPTION_RENAMED_RELATIONS,
  SUBSCRIPTION_RENAMED_TRIGGERS,
  SUBSCRIPTION_RETIRED_POLICIES,
  SUBSCRIPTION_RETIRED_ROUTINE_NAMES,
  SUBSCRIPTION_RETIRED_TRIGGERS,
} from "../../packages/db/src/runtime-posture";
import type { LegacySubscriptionRetirement } from "./types";

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Retired routine names that differ only by provider, split around it. */
const PROVIDER_TEMPLATED = SUBSCRIPTION_RETIRED_ROUTINE_NAMES.filter((name) =>
  name.includes("xai"),
).map((name) => {
  const [prefix = "", suffix = ""] = name.split("xai");
  return { prefix: escaped(prefix), suffix: escaped(suffix) };
});
const PROVIDER_NAMED = SUBSCRIPTION_RETIRED_ROUTINE_NAMES.filter((name) =>
  /(?:^|_)(?:xai|claude)(?:_|$)/.test(name),
).map(escaped);

/**
 * The shared legacy pool runtime retired by the M4 retirement step (R), once
 * every provider runs on the shared subscription core: the synthetic
 * pool-worker subjects that owned shared legacy pool rows, and every routine,
 * policy and trigger the drained retirement migration 0751 drops (the
 * SuperGrok and Claude pool writers, resolvers, revalidators, policy
 * predicates and trigger functions, the Codex twins of the 0707 neutral
 * routines and their owner-only internals), plus the Codex names its reach
 * finalization replaces (0689's reach table, auto-assignment and plan-change
 * triggers and functions, owner-only policies and their setting). The names
 * come from the runtime posture's inventory, which requires the same objects
 * absent.
 */
export const LEGACY_POOL_RUNTIME: LegacySubscriptionRetirement = {
  id: "pool",
  name: "Shared pool (M4 R)",
  identifiers: [
    "subscriptionPoolWorkerSubject",
    "isSubscriptionPoolWorkerSubject",
    "withSubscriptionPoolSessionAccess",
    "withTemporaryPoolSessionAccessInTransaction",
    ...SUBSCRIPTION_RETIRED_ROUTINE_NAMES,
    ...new Set(SUBSCRIPTION_RETIRED_POLICIES.map(({ policy }) => policy)),
    ...SUBSCRIPTION_RETIRED_TRIGGERS.map(({ trigger }) => trigger),
    ...SUBSCRIPTION_RENAMED_POLICIES.map(({ from }) => from),
    ...SUBSCRIPTION_RENAMED_TRIGGERS.map(({ from }) => from),
    ...SUBSCRIPTION_RENAMED_RELATIONS.map(({ from }) => from),
    // The setting the renamed policies read before 0721
    // (opengeni.subscription_codex_auto_assign).
    "subscription_codex_auto_assign",
  ],
  patterns: [
    {
      pattern: /["'`]worker:(?:xai|claude)-workspace["'`]/g,
      message: "Retired synthetic pool-worker subject",
    },
    {
      pattern: /worker:\$\{[^}]*\}-workspace/g,
      message: "Retired provider-templated synthetic pool-worker subject",
    },
    {
      pattern: /["'`]worker:["'`]\s*\+\s*[\w$.]+\s*\+\s*["'`]-workspace["'`]/g,
      message: "Retired provider-templated synthetic pool-worker subject",
    },
    {
      // "resolve_xai_authority_pool".replace("xai", provider) and the like.
      pattern: new RegExp(
        `["'\`](?:${PROVIDER_NAMED.join("|")})["'\`]\\s*\\.\\s*replace(?:All)?\\(`,
        "g",
      ),
      message: "Retired provider-templated legacy subscription routine",
    },
    {
      // `resolve_${provider}_authority_pool` and the like.
      pattern: new RegExp(
        PROVIDER_TEMPLATED.map(
          ({ prefix, suffix }) =>
            `${prefix ? `(?<![A-Za-z0-9_])${prefix}` : ""}\\$\\{[^}]*\\}${suffix}(?![A-Za-z0-9_])`,
        ).join("|"),
        "g",
      ),
      message: "Retired provider-templated legacy subscription routine",
    },
    {
      // "resolve_" + provider + "_authority_pool" and the like.
      pattern: new RegExp(
        PROVIDER_TEMPLATED.map(({ prefix, suffix }) =>
          prefix
            ? `["'\`]${prefix}["'\`]\\s*\\+\\s*[\\w$.]+\\s*\\+\\s*["'\`]${suffix}["'\`]`
            : `[\\w$.)]\\s*\\+\\s*["'\`]${suffix}["'\`]`,
        ).join("|"),
        "g",
      ),
      message: "Retired provider-templated legacy subscription routine",
    },
  ],
  testFixtures: /pre-retirement-grants|legacy-subscription-session-access/,
  exceptions: {
    "packages/db/src/runtime-posture.ts": {
      declarations: [
        "SUBSCRIPTION_CODEX_TWIN_PRIVATE_ROUTINES",
        "SUBSCRIPTION_RETIRED_ROUTINES",
        "SUBSCRIPTION_RETIRED_POLICIES",
        "SUBSCRIPTION_RETIRED_TRIGGERS",
        "SUBSCRIPTION_RENAMED_ROUTINES",
        "SUBSCRIPTION_RENAMED_TRIGGERS",
        "SUBSCRIPTION_RENAMED_POLICIES",
        "SUBSCRIPTION_RENAMED_RELATIONS",
      ],
      reason:
        "The retired-object inventory (dropped objects and the Codex names of renamed ones) the runtime posture requires absent after migration 0751; never a call.",
    },
    "packages/db/src/codex-subscription-core-cutover.ts": {
      declarations: ["moveCodexCredentials"],
      reason:
        "0689 migration codec stage: runs only while that historical migration replays, before 0721 renames the reach table it fills.",
    },
  },
};
