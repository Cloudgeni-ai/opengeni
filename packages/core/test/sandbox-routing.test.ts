import { describe, expect, test } from "bun:test";
import { directRetainedProcessMatchesBackend } from "../src/sandbox/routing";

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
});
