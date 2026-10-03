import { describe, expect, test } from "bun:test";
import {
  BrowserSession,
  CreateBrowserSessionRequest,
  EPHEMERAL_CHROMIUM_DRIVER_ID,
  browserSessionStorageMode,
} from "@opengeni/contracts";
import {
  assertEphemeralBrowserCreateEnabled,
  ephemeralBrowserPartition,
} from "../src/browser-ephemeral";

const id = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const request = { operationId: id("1"), sessionId: id("2") };
const ephemeral = { ...request, storageMode: "ephemeral_context" };

function session() {
  return BrowserSession.parse({
    id: id("3"),
    accountId: id("4"),
    workspaceId: id("5"),
    name: "Disposable",
    lifecycle: "active",
    placement: { kind: "sandbox_group", sandboxGroupId: id("6") },
    controller: null,
    driverId: EPHEMERAL_CHROMIUM_DRIVER_ID,
    engine: "chromium",
    engineVersion: null,
    headless: true,
    identityId: null,
    baseRevisionId: null,
    networkRouteId: null,
    linkedComputerSessionId: null,
    capabilities: Object.fromEntries(
      [
        "semanticObservation",
        "screenshots",
        "liveFrames",
        "humanInput",
        "tabs",
        "downloads",
        "uploads",
        "clipboard",
        "permissions",
        "diagnostics",
        "rawCdp",
        "linkedComputer",
        "privateCheckpoint",
        "identityPublication",
        "parallelTargets",
      ].map((key) => [key, false]),
    ),
    associations: [],
    createdBySubjectId: "actor-a",
    createdAt: "2026-09-26T00:00:00Z",
    lastUsedAt: "2026-09-26T00:00:00Z",
    failureCode: null,
  });
}

describe("experimental ephemeral browser admission and authority", () => {
  test("default remains private profile; explicit ephemeral mode requires deployment opt-in", () => {
    const standard = CreateBrowserSessionRequest.parse(request);
    expect(standard.storageMode).toBe("private_profile");
    expect(() => assertEphemeralBrowserCreateEnabled(standard, false)).not.toThrow();
    const pooled = CreateBrowserSessionRequest.parse(ephemeral);
    expect(() => assertEphemeralBrowserCreateEnabled(pooled, false)).toThrow();
    expect(() => assertEphemeralBrowserCreateEnabled(pooled, true)).not.toThrow();
    expect(browserSessionStorageMode(session())).toBe("ephemeral_context");
    expect(browserSessionStorageMode({ driverId: "opengeni.cdp.v1" })).toBe("private_profile");
  });

  test("rejects durable state, custom networking, native windows and unsupported placements", () => {
    for (const incompatible of [
      { headless: false },
      { engine: "lightpanda" },
      { identityId: id("7") },
      { identityId: id("7"), baseRevisionId: id("8") },
      { networkRouteId: id("7") },
      { linkedComputerSessionId: id("7"), headless: false },
      { placement: { kind: "connected_machine", sandboxId: id("7") } },
      { placement: { kind: "attached_device", deviceId: id("7") }, headless: false },
      {
        placement: { kind: "external_provider", providerId: "provider", placementId: "placement" },
      },
      { authorityPartition: "actor-b" },
      { ephemeralPartition: "a".repeat(64) },
    ]) {
      expect(CreateBrowserSessionRequest.safeParse({ ...ephemeral, ...incompatible }).success).toBe(
        false,
      );
    }
  });

  test("pool partitions bind all authority fences while allowing same-actor sibling contexts", () => {
    const current = session();
    const partition = ephemeralBrowserPartition(current, "placement-instance-a", "root-secret-a");
    expect(ephemeralBrowserPartition(current, "placement-instance-a", "root-secret-a")).toBe(
      partition,
    );
    expect(
      ephemeralBrowserPartition(
        { ...current, id: id("9") },
        "placement-instance-a",
        "root-secret-a",
      ),
    ).toBe(partition);
    for (const changed of [
      { ...current, accountId: id("7") },
      { ...current, workspaceId: id("7") },
      { ...current, createdBySubjectId: "actor-b" },
      { ...current, placement: { kind: "sandbox_group" as const, sandboxGroupId: id("7") } },
    ]) {
      expect(ephemeralBrowserPartition(changed, "placement-instance-a", "root-secret-a")).not.toBe(
        partition,
      );
    }
    expect(ephemeralBrowserPartition(current, "placement-instance-b", "root-secret-a")).not.toBe(
      partition,
    );
    expect(ephemeralBrowserPartition(current, "placement-instance-a", "root-secret-b")).not.toBe(
      partition,
    );
    expect(partition).not.toContain(current.createdBySubjectId);
    expect(partition).not.toContain("root-secret-a");
  });
});
