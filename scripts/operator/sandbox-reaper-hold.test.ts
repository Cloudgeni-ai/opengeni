import { describe, expect, test } from "bun:test";
import type { LeaseSnapshot } from "@opengeni/db";
import {
  main,
  sandboxReaperHoldInput,
  type SandboxReaperHoldDependencies,
} from "./sandbox-reaper-hold";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const base = {
  OPENGENI_SANDBOX_REAPER_HOLD_ACCOUNT_ID: id("1"),
  OPENGENI_SANDBOX_REAPER_HOLD_WORKSPACE_ID: id("2"),
  OPENGENI_SANDBOX_REAPER_HOLD_GROUP_ID: id("3"),
  OPENGENI_SANDBOX_REAPER_HOLD_EPOCH: "7",
  OPENGENI_SANDBOX_REAPER_HOLD_INSTANCE_ID: "sb-exact",
  OPENGENI_SANDBOX_REAPER_HOLD_ID: id("4"),
};

function lease(overrides: Partial<LeaseSnapshot> = {}): LeaseSnapshot {
  return {
    id: id("5"),
    sandboxGroupId: id("3"),
    liveness: "draining",
    refcount: 0,
    turnHolders: 0,
    viewerHolders: 0,
    instanceId: "sb-exact",
    backend: "modal",
    os: "linux",
    image: null,
    rigVersionId: null,
    dataPlaneUrl: null,
    terminalDataPlaneUrl: null,
    leaseEpoch: 7,
    workspaceGeneration: 4,
    archiveGeneration: 3,
    archiveComplete: false,
    archiveCapture: null,
    reaperHold: null,
    resumeBackendId: "modal",
    resumeState: { secret: "must-not-be-output" },
    recovery: {
      provider: { status: "exists", instanceId: "sb-exact", observedAt: null },
      archive: { status: "none", current: null, previous: null },
      restore: {
        status: "not_required",
        rematerializationId: null,
        selectedRevision: null,
        startedAt: null,
        completedAt: null,
      },
      workspace: { status: "ready", verifiedRevision: null, verifiedAt: null },
    },
    providerCreatedAt: null,
    providerDeadlineAt: null,
    rotationRequestedAt: null,
    rotationReason: null,
    currentCheckpointArtifactId: null,
    previousCheckpointArtifactId: null,
    expiresAt: new Date("2026-08-07T12:00:00.000Z"),
    ...overrides,
  };
}

function dependencies(overrides: Partial<SandboxReaperHoldDependencies> = {}) {
  const output: string[] = [];
  const calls: string[] = [];
  const deps: SandboxReaperHoldDependencies = {
    openDatabase: () => ({
      db: null as never,
      close: async () => {
        calls.push("close");
      },
    }),
    read: async () => lease(),
    acquire: async () => ({ status: "held", renewed: false, lease: lease() }),
    release: async () => true,
    providerDeadlineHeadroomMs: () => 3_600_000,
    output: (line) => output.push(line),
    ...overrides,
  };
  return { deps, output, calls };
}

describe("sandbox reaper hold operator CLI", () => {
  test("parses only exact, bounded modes and tuples", () => {
    expect(
      sandboxReaperHoldInput({
        ...base,
        OPENGENI_SANDBOX_REAPER_HOLD: "acquire",
        OPENGENI_SANDBOX_REAPER_HOLD_TTL_MS: "60000",
        OPENGENI_SANDBOX_REAPER_HOLD_REASON: "preserve exact workspace",
      }),
    ).toEqual({
      mode: "acquire",
      accountId: id("1"),
      workspaceId: id("2"),
      sandboxGroupId: id("3"),
      expectedEpoch: 7,
      expectedInstanceId: "sb-exact",
      holdId: id("4"),
      ttlMs: 60_000,
      reason: "preserve exact workspace",
    });
    expect(() =>
      sandboxReaperHoldInput({ ...base, OPENGENI_SANDBOX_REAPER_HOLD: "pause" }),
    ).toThrow("exactly preview, acquire, or release");
    expect(() =>
      sandboxReaperHoldInput({
        ...base,
        OPENGENI_SANDBOX_REAPER_HOLD: "acquire",
        OPENGENI_SANDBOX_REAPER_HOLD_TTL_MS: `${24 * 60 * 60_000 + 1}`,
        OPENGENI_SANDBOX_REAPER_HOLD_REASON: "too long",
      }),
    ).toThrow("24 hours");
  });

  test("preview is read-only, exact-fenced, secret-free, and closes the database", async () => {
    let mutations = 0;
    const { deps, output, calls } = dependencies({
      acquire: async () => {
        mutations += 1;
        throw new Error("must not acquire");
      },
      release: async () => {
        mutations += 1;
        return false;
      },
    });
    expect(await main({ ...base, OPENGENI_SANDBOX_REAPER_HOLD: "preview" }, deps)).toBe(0);
    expect(mutations).toBe(0);
    expect(calls).toEqual(["close"]);
    expect(output[0]).toContain('"status":"exact"');
    expect(output[0]).not.toContain("must-not-be-output");
  });

  test("acquire uses deployment headroom and returns a durable receipt", async () => {
    let observed: unknown;
    const { deps, output, calls } = dependencies({
      acquire: async (_db, input) => {
        observed = input;
        return { status: "held", renewed: true, lease: lease() };
      },
    });
    expect(
      await main(
        {
          ...base,
          OPENGENI_SANDBOX_REAPER_HOLD: "acquire",
          OPENGENI_SANDBOX_REAPER_HOLD_TTL_MS: "5000",
          OPENGENI_SANDBOX_REAPER_HOLD_REASON: "operator recovery",
        },
        deps,
      ),
    ).toBe(0);
    expect(observed).toMatchObject({
      accountId: id("1"),
      expectedEpoch: 7,
      expectedInstanceId: "sb-exact",
      holdId: id("4"),
      ttlMs: 5_000,
      providerDeadlineHeadroomMs: 3_600_000,
      reason: "operator recovery",
    });
    expect(output[0]).toContain('"renewed":true');
    expect(calls).toEqual(["close"]);
  });

  test("release is exact and reports a fenced no-op", async () => {
    let observed: unknown;
    const { deps, output, calls } = dependencies({
      release: async (_db, input) => {
        observed = input;
        return false;
      },
    });
    expect(await main({ ...base, OPENGENI_SANDBOX_REAPER_HOLD: "release" }, deps)).toBe(2);
    expect(observed).toMatchObject({
      sandboxGroupId: id("3"),
      expectedEpoch: 7,
      expectedInstanceId: "sb-exact",
      holdId: id("4"),
    });
    expect(output[0]).toContain('"status":"fenced"');
    expect(calls).toEqual(["close"]);
  });
});
