import { describe, expect, test } from "bun:test";
import {
  failureOrigin,
  isCustomerEndpointMetricProvider,
  isCustomerManagedMetricProvider,
} from "../src/failure-attribution";

describe("failure ownership", () => {
  test("the organization's plan refusing a sandbox is customer_plan whoever pays for the model", () => {
    for (const code of ["sandbox_compute_unavailable", "sandbox_card_required"]) {
      for (const customerManaged of [false, true]) {
        expect(failureOrigin({ customerManaged, outcome: "failed", code })).toBe("customer_plan");
        expect(failureOrigin({ customerManaged, outcome: "completed", code })).toBe("none");
      }
    }
    // Shared unpaid capacity is the platform's fleet, not the organization's plan.
    expect(
      failureOrigin({
        customerManaged: false,
        outcome: "failed",
        code: "sandbox_capacity_unpaid_busy",
      }),
    ).toBe("platform");
  });
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
  test("a customer's own endpoint that cannot be reached or refuses the request is customer-provider", () => {
    // Production page: an organization's OpenAI-compatible endpoint failed
    // every call without an HTTP status and each failure counted as platform.
    expect(
      failureOrigin({
        customerManaged: true,
        customerEndpoint: true,
        outcome: "failed",
        transportFailure: true,
      }),
    ).toBe("customer_provider");
    for (const httpStatus of [408, 409, 410, 415, 451]) {
      expect(
        failureOrigin({
          customerManaged: true,
          customerEndpoint: true,
          outcome: "failed",
          httpStatus,
        }),
      ).toBe("customer_provider");
    }
    // Request-shape refusals can be our own serialization bug, and an
    // unexplained failure stays ours.
    // Request-shape, path/method and size refusals can be our own request.
    for (const httpStatus of [undefined, 400, 404, 405, 413, 422]) {
      expect(
        failureOrigin({
          customerManaged: true,
          customerEndpoint: true,
          outcome: "failed",
          ...(httpStatus ? { httpStatus } : {}),
        }),
      ).toBe("platform");
    }
    // A managed provider's unreachable endpoint is ours to fix.
    expect(
      failureOrigin({ customerManaged: true, outcome: "failed", transportFailure: true }),
    ).toBe("platform");
    expect(
      failureOrigin({ customerManaged: false, outcome: "failed", transportFailure: true }),
    ).toBe("platform");
    expect(isCustomerEndpointMetricProvider("organization-compatible-6e55ba3e")).toBe(true);
    expect(isCustomerEndpointMetricProvider("workspace-compatible-abc")).toBe(true);
    for (const provider of [
      "organization-compatible-",
      "organization-openrouter",
      "workspace-openai-abc",
      "azure-sol",
    ]) {
      expect(isCustomerEndpointMetricProvider(provider)).toBe(false);
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
