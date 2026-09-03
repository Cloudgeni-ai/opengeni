import { describe, expect, test } from "bun:test";

import {
  codexCapacityWaitFailurePayload,
  codexCredentialFailoverLimit,
  codexDefinitiveFailureDisposition,
} from "../src/activities/agent-turn/failure-settlement";

const base = {
  rotationEnabled: true,
  pinDisposition: "unpinned" as const,
  decisionKind: "active" as const,
  decisionCredentialId: "alternate",
  servingCredentialId: "serving",
};

describe("definitive Codex credential failure disposition", () => {
  test("rotation-on quota refusal recovers the same turn on an eligible alternate", () => {
    expect(codexDefinitiveFailureDisposition({ ...base, failureKind: "quota" })).toBe("failover");
  });

  test("rotation-on auth refusal also fails over only when an alternate is eligible", () => {
    expect(codexDefinitiveFailureDisposition({ ...base, failureKind: "auth" })).toBe("failover");
  });

  test("rotation-off quota refusal waits even when the ranker sees a healthy alternate", () => {
    expect(
      codexDefinitiveFailureDisposition({
        ...base,
        failureKind: "quota",
        rotationEnabled: false,
      }),
    ).toBe("wait");
  });

  test("manual pin quota refusal waits instead of silently walking the pool", () => {
    expect(
      codexDefinitiveFailureDisposition({
        ...base,
        failureKind: "quota",
        pinDisposition: "manual",
      }),
    ).toBe("wait");
  });

  test("manual pins and rotation-off also wait for auth health recovery", () => {
    expect(
      codexDefinitiveFailureDisposition({
        ...base,
        failureKind: "auth",
        pinDisposition: "manual",
      }),
    ).toBe("wait");
    expect(
      codexDefinitiveFailureDisposition({
        ...base,
        failureKind: "forbidden",
        rotationEnabled: false,
      }),
    ).toBe("wait");
  });

  test("all-unavailable pools enter durable capacity waiting for every definitive refusal", () => {
    for (const failureKind of ["quota", "rate_limit", "auth", "forbidden"] as const) {
      expect(
        codexDefinitiveFailureDisposition({
          ...base,
          failureKind,
          decisionKind: "allCapped",
          decisionCredentialId: null,
        }),
      ).toBe("wait");
    }
  });

  test("auth or forbidden refusal without an alternate remains terminal", () => {
    for (const failureKind of ["auth", "forbidden"] as const) {
      expect(
        codexDefinitiveFailureDisposition({
          ...base,
          failureKind,
          decisionKind: "none",
          decisionCredentialId: null,
        }),
      ).toBe("terminal");
    }
  });
});

describe("definitive Codex failure settlement helpers", () => {
  test("non-usage-limit quota codes retain quota semantics in durable waits", () => {
    expect(
      codexCapacityWaitFailurePayload({
        failureKind: "quota",
        usageLimit: null,
        cooldownSeconds: 3600,
        detail: "provider returned insufficient_quota",
        allAccounts: false,
      }),
    ).toEqual({
      error:
        "Your ChatGPT/Codex subscription usage limit has been reached. Access resets in about 1h. You can switch this session to a different model in the meantime, or wait for the limit to reset.",
      code: "codex_usage_limit_reached",
      detail: "provider returned insufficient_quota",
      retryable: false,
    });
  });

  test("allocator-disabled rows do not enlarge the same-turn failover budget", () => {
    expect(
      codexCredentialFailoverLimit([
        { allocatorEnabled: true },
        { allocatorEnabled: true },
        ...Array.from({ length: 20 }, () => ({ allocatorEnabled: false })),
      ]),
    ).toBe(1);
    expect(codexCredentialFailoverLimit([{ allocatorEnabled: true }])).toBe(1);
  });
});
