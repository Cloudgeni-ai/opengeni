import { describe, expect, test } from "bun:test";
import { failureOrigin, isCustomerManagedMetricProvider } from "../src/failure-attribution";

describe("failure ownership", () => {
  test("closed provider-account refusals count only on customer-managed providers", () => {
    for (const providerAccountRefusal of [
      "byok_capacity_restricted",
      "customer_verification_required",
      "key_limit_exceeded",
    ]) {
      expect(
        failureOrigin({ customerManaged: true, outcome: "failed", providerAccountRefusal }),
      ).toBe("customer_provider");
      expect(
        failureOrigin({ customerManaged: false, outcome: "failed", providerAccountRefusal }),
      ).toBe("platform");
      expect(
        failureOrigin({ customerManaged: true, outcome: "completed", providerAccountRefusal }),
      ).toBe("none");
    }
    for (const providerAccountRefusal of ["", "not_found", 404, null, {}]) {
      expect(
        failureOrigin({
          customerManaged: true,
          outcome: "failed",
          httpStatus: 404,
          providerAccountRefusal,
        }),
      ).toBe("platform");
    }
  });
  test("a compaction request refused for exhausted provider quota is customer-provider; other compaction failures are not", () => {
    expect(
      failureOrigin({
        customerManaged: true,
        outcome: "failed",
        code: "context_compaction_failed",
        quotaScope: "credits",
      }),
    ).toBe("customer_provider");
    for (const quotaScope of [undefined, "", "weekly"]) {
      expect(
        failureOrigin({
          customerManaged: true,
          outcome: "failed",
          code: "context_compaction_failed",
          quotaScope,
        }),
      ).toBe("platform");
    }
    expect(
      failureOrigin({
        customerManaged: false,
        outcome: "failed",
        code: "context_compaction_failed",
        quotaScope: "daily",
      }),
    ).toBe("platform");
  });
  test("the same exhausted quota counts against deployment health only when deployment funded", () => {
    expect(
      failureOrigin({
        customerManaged: false,
        outcome: "failed",
        code: "provider_quota_exhausted",
      }),
    ).toBe("platform");
    expect(
      failureOrigin({ customerManaged: true, outcome: "failed", code: "provider_quota_exhausted" }),
    ).toBe("customer_provider");
  });
  test("customer provider responses are separated without masking malformed requests or transport uncertainty", () => {
    for (const httpStatus of [401, 402, 403, 429, 500, 503]) {
      expect(failureOrigin({ customerManaged: true, outcome: "failed", httpStatus })).toBe(
        "customer_provider",
      );
      expect(failureOrigin({ customerManaged: false, outcome: "failed", httpStatus })).toBe(
        "platform",
      );
    }
    for (const httpStatus of [undefined, 400, 404, 422]) {
      expect(
        failureOrigin({
          customerManaged: true,
          outcome: "failed",
          ...(httpStatus ? { httpStatus } : {}),
        }),
      ).toBe("platform");
    }
  });
  test("internal lease and authority failures do not become customer quota errors", () => {
    for (const code of [
      "subscription_lease_busy",
      "subscription_core_unsupported",
      "subscription_failover_exhausted",
      "provider_request_rejected",
      "provider_unavailable",
      "upstream_connectivity_unavailable",
      "history_persistence_failed",
    ]) {
      expect(failureOrigin({ customerManaged: true, outcome: "failed", code })).toBe("platform");
    }
    expect(
      failureOrigin({
        customerManaged: true,
        outcome: "failed",
        code: "subscription_capacity_unavailable",
        waitReason: "no_eligible_capacity",
      }),
    ).toBe("customer_provider");
    expect(
      failureOrigin({
        customerManaged: true,
        outcome: "failed",
        code: "subscription_capacity_unavailable",
        waitReason: "accepted_authority_unavailable",
      }),
    ).toBe("platform");
  });
  test("non-failures and reserved provider identity boundaries", () => {
    expect(
      failureOrigin({
        customerManaged: true,
        outcome: "completed",
        code: "provider_quota_exhausted",
      }),
    ).toBe("none");
    for (const provider of [
      "organization-openrouter",
      "workspace-gateway",
      "workspace-compatible-123",
      "workspace-openai-123",
      "workspace-azure-openai-123",
      "organization-compatible-123",
      "codex-subscription",
      "supergrok-subscription",
      "organization-claude-subscription",
    ])
      expect(isCustomerManagedMetricProvider(provider)).toBe(true);
    for (const provider of [
      "azure",
      "azure-sol",
      "openrouter",
      "vertex-gateway",
      "organization-openrouter-pretend",
      "workspace-openai-",
      "organization-compatible-",
    ])
      expect(isCustomerManagedMetricProvider(provider)).toBe(false);
  });
});

test("subscription quota and sign-in refusals are external while lost authority is not", () => {
  expect(
    failureOrigin({ customerManaged: true, outcome: "failed", code: "codex_usage_limit_reached" }),
  ).toBe("customer_provider");
  for (const refusal of ["sign_in", "forbidden", "entitlement"]) {
    expect(
      failureOrigin({
        customerManaged: true,
        outcome: "failed",
        code: "subscription_account_refused",
        refusal,
      }),
    ).toBe("customer_provider");
  }
  expect(
    failureOrigin({
      customerManaged: true,
      outcome: "failed",
      code: "subscription_account_refused",
      refusal: "access_lost",
    }),
  ).toBe("platform");
});
