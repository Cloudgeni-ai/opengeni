import { describe, expect, test } from "bun:test";
import {
  directRetainedProcessMatchesBackend,
  retainedProcessBackgroundSettlement,
} from "../src/sandbox/routing";
import { managedSessionGroupBackend, managedSessionGroupOs } from "../src/sandbox/runtime-settings";

describe("managed session-group backend", () => {
  test("uses the deployment provider only for an explicit machine-home fallback", () => {
    expect(managedSessionGroupBackend("modal", "selfhosted")).toBe("modal");
    expect(managedSessionGroupBackend("opensandbox", "selfhosted")).toBe("opensandbox");
    expect(managedSessionGroupBackend("local", "modal")).toBe("modal");
    expect(managedSessionGroupBackend("modal", "none")).toBeNull();
    expect(managedSessionGroupBackend("none", "selfhosted")).toBeNull();
    expect(managedSessionGroupBackend("selfhosted", "selfhosted")).toBeNull();
    expect(managedSessionGroupOs("selfhosted", "macos")).toBe("linux");
    expect(managedSessionGroupOs("modal", "windows")).toBe("windows");
  });
});

describe("API-direct retained-process route identity", () => {
  test("accepts the default active pointer without misclassifying it as a home route", () => {
    const process = { id: "process-id", providerSessionId: 7 };
    const backend = {
      session: {},
      sandboxId: null,
      kind: "modal",
      leaseEpoch: 3,
      providerInstanceId: "modal-instance",
      activeEpoch: 0,
    };

    expect(
      directRetainedProcessMatchesBackend(
        {
          providerSessionId: 7,
          providerBackend: "modal",
          providerInstanceId: "modal-instance",
          leaseEpoch: 3,
          routeKind: "active",
          routeTargetId: null,
          routeEpoch: 0,
        },
        process,
        backend,
      ),
    ).toBe(true);

    expect(
      directRetainedProcessMatchesBackend(
        {
          providerSessionId: 7,
          providerBackend: "modal",
          providerInstanceId: "modal-instance",
          leaseEpoch: 3,
          routeKind: "home",
          routeTargetId: null,
          routeEpoch: 0,
        },
        process,
        backend,
      ),
    ).toBe(false);
  });

  test("propagates the first durable terminal reason to background-command settlement", () => {
    expect(
      retainedProcessBackgroundSettlement(
        {
          state: "lost",
          exitCode: null,
          settlementReason: "provider_instance_not_found",
        },
        {
          outcome: "lost",
          exitCode: null,
          reason: "provider_session_lost_banner",
        },
      ),
    ).toEqual({
      outcome: "lost",
      exitCode: null,
      reason: "provider_instance_not_found",
    });
  });

  test("rejects an impossible active process returned from terminal settlement", () => {
    expect(() =>
      retainedProcessBackgroundSettlement(
        { state: "active", exitCode: null, settlementReason: null },
        {
          outcome: "lost",
          exitCode: null,
          reason: "provider_session_lost_banner",
        },
      ),
    ).toThrow("active durable process");
  });
});
