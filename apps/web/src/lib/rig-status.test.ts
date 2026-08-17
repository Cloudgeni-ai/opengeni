import { describe, expect, test } from "bun:test";

import { rigManagedSandboxReadinessView, rigProviderImageStatusView } from "./rig-status";

describe("rig provider-image status copy", () => {
  test("distinguishes active preparation, ready reuse, failure fallback, and unsupported fallback", () => {
    expect(rigProviderImageStatusView("building")).toMatchObject({
      label: "Preparing image",
      tone: "running",
      pulse: true,
    });
    expect(rigProviderImageStatusView("ready")).toMatchObject({
      label: "Image ready",
      tone: "idle",
      pulse: false,
    });
    expect(rigProviderImageStatusView("failed")).toMatchObject({
      label: "Image build failed",
      tone: "failed",
      pulse: false,
    });
    expect(rigProviderImageStatusView("unsupported")).toMatchObject({
      label: "Uses setup fallback",
      tone: "queued",
      pulse: false,
    });
  });
});

describe("managed sandbox rig readiness copy", () => {
  test("makes first-use fallback and terminal readiness explicit without implying content is omitted", () => {
    expect(
      rigManagedSandboxReadinessView({ backend: "modal", status: "unprepared" }),
    ).toMatchObject({
      label: "Fast startup not prepared yet",
      description: expect.stringContaining("complete rig setup"),
    });
    expect(rigManagedSandboxReadinessView({ backend: "modal", status: "building" })).toMatchObject({
      label: "Preparing fast startup",
      pulse: true,
    });
    expect(rigManagedSandboxReadinessView({ backend: "modal", status: "ready" })).toMatchObject({
      label: "Fast startup ready",
      tone: "idle",
    });
    expect(rigManagedSandboxReadinessView({ backend: "modal", status: "failed" })).toMatchObject({
      label: "Fast image unavailable",
      description: expect.stringContaining("complete setup"),
    });
    expect(
      rigManagedSandboxReadinessView({ backend: "docker", status: "unsupported" }),
    ).toMatchObject({
      label: "Setup runs at sandbox start",
    });
    expect(rigManagedSandboxReadinessView(null)).toBeNull();
  });
});
