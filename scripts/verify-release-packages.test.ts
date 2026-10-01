import { describe, expect, test } from "bun:test";
import {
  assertPackageEvidenceMatchesRegistry,
  deriveExpectedReleasePackages,
  loadPublishablePackages,
  parseExpectedPackages,
  readRegistryPackage,
  reconcileReleasePackages,
  REGISTRY_SETTLEMENT_TIMEOUT_MS,
  resolveExpectedReleasePackages,
  validateVerifiedPackagePublicationReceipt,
  type PublishablePackage,
  type ReleasePackageReceipt,
  type RegistryPackage,
} from "./verify-release-packages";

const sha = "a".repeat(40);
const packageSha = "d".repeat(40);
const react = { name: "@opengeni/react", version: "0.14.0" };
const sdk = { name: "@opengeni/sdk", version: "0.13.0" };

function published(pkg: PublishablePackage, gitHead = sha): RegistryPackage {
  return {
    ...pkg,
    gitHead,
    integrity: "sha512-release-integrity",
  };
}

function receipt(pkg: PublishablePackage, gitHead: string): ReleasePackageReceipt {
  return {
    ...pkg,
    state: "published",
    gitHead,
    integrity: "sha512-release-integrity",
  };
}

describe("release registry settlement", () => {
  test("verification tolerates delayed visibility and incomplete identity for eleven minutes", async () => {
    let elapsed = 0;
    let reads = 0;
    const result = await readRegistryPackage(react, true, {
      now: () => elapsed,
      sleep: async (milliseconds) => {
        elapsed += milliseconds;
      },
      fetchPackage: async () => {
        reads += 1;
        if (elapsed < 6 * 60_000) return null;
        return {
          ...published(react),
          gitHead: elapsed < 9 * 60_000 ? null : sha,
          integrity: elapsed < 11 * 60_000 ? null : "sha512-release-integrity",
        };
      },
    });
    expect(result).toEqual(published(react));
    expect(elapsed).toBe(11 * 60_000);
    expect(reads).toBe(133);
    expect(elapsed).toBeLessThan(REGISTRY_SETTLEMENT_TIMEOUT_MS);
  });

  test("verification includes slow requests in its deadline and starts no read after expiry", async () => {
    let elapsed = 0;
    const readStarts: number[] = [];
    const result = await readRegistryPackage(react, true, {
      now: () => elapsed,
      sleep: async (milliseconds) => {
        elapsed += milliseconds;
      },
      fetchPackage: async () => {
        readStarts.push(elapsed);
        elapsed += 20_000;
        return null;
      },
    });
    expect(result).toBeNull();
    expect(elapsed).toBe(REGISTRY_SETTLEMENT_TIMEOUT_MS);
    expect(readStarts).toHaveLength(36);
    expect(readStarts.every((start) => start < REGISTRY_SETTLEMENT_TIMEOUT_MS)).toBe(true);
  });

  test("verification propagates a terminal registry read failure instead of claiming settlement", async () => {
    let elapsed = 0;
    const error = new Error("registry unavailable");
    await expect(
      readRegistryPackage(react, true, {
        now: () => elapsed,
        sleep: async (milliseconds) => {
          elapsed += milliseconds;
        },
        fetchPackage: async () => {
          elapsed += 100_000;
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });

  test("complete but wrong source identity is returned for immediate fail-closed reconciliation", async () => {
    const wrongSource = published(react, "b".repeat(40));
    const result = await readRegistryPackage(react, true, {
      now: () => 0,
      fetchPackage: async () => wrongSource,
      sleep: async () => {
        throw new Error("must not retry an immutable identity mismatch");
      },
    });
    expect(result).toEqual(wrongSource);
    expect(() =>
      reconcileReleasePackages({
        sourceSha: sha,
        phase: "verify",
        publishable: [react],
        expected: [react],
        registry: new Map([[react.name, result]]),
      }),
    ).toThrow("gitHead");
  });

  test("planning returns an absent package immediately without a settlement wait", async () => {
    let reads = 0;
    expect(
      await readRegistryPackage(react, false, {
        fetchPackage: async () => {
          reads += 1;
          return null;
        },
        sleep: async () => {
          throw new Error("planning must not wait for publication");
        },
      }),
    ).toBeNull();
    expect(reads).toBe(1);
  });

  test("planning preserves its three-read transient-error retry limit", async () => {
    let reads = 0;
    const sleeps: number[] = [];
    const error = new Error("registry unavailable");
    await expect(
      readRegistryPackage(react, false, {
        fetchPackage: async () => {
          reads += 1;
          throw error;
        },
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      }),
    ).rejects.toBe(error);
    expect(reads).toBe(3);
    expect(sleeps).toEqual([5_000, 5_000]);
  });
});

describe("release package evidence", () => {
  test("inventories the exact publishable workspace closure, including app packages", () => {
    const publishable = loadPublishablePackages();
    expect(publishable).toContainEqual(expect.objectContaining({ name: "@opengeni/api-router" }));
    expect(publishable).toContainEqual(
      expect.objectContaining({ name: "@opengeni/worker-bundle" }),
    );
    expect(publishable).not.toContainEqual(expect.objectContaining({ name: "opengeni-web" }));
  });

  test("parses a bounded comma/newline package set and rejects duplicates", () => {
    expect(parseExpectedPackages("")).toEqual([]);
    expect(parseExpectedPackages("@opengeni/react@0.14.0,\n@opengeni/sdk@0.13.0")).toEqual([
      react,
      sdk,
    ]);
    expect(() => parseExpectedPackages("@opengeni/react@0.14.0,@opengeni/react@0.14.0")).toThrow(
      "duplicate expected package",
    );
    expect(() => parseExpectedPackages("react@latest")).toThrow("invalid expected package spec");
  });

  test("supports an application-only release with a complete published package BOM", () => {
    const result = reconcileReleasePackages({
      sourceSha: sha,
      phase: "verify",
      publishable: [react, sdk],
      expected: [],
      registry: new Map([
        [react.name, published(react, "b".repeat(40))],
        [sdk.name, published(sdk, "c".repeat(40))],
      ]),
    });
    expect(result).toEqual({
      needsPublish: false,
      releaseReady: true,
      packages: [],
      bomPackages: [
        {
          ...react,
          state: "published",
          gitHead: "b".repeat(40),
          integrity: "sha512-release-integrity",
        },
        {
          ...sdk,
          state: "published",
          gitHead: "c".repeat(40),
          integrity: "sha512-release-integrity",
        },
      ],
    });
  });

  test("accepts an exact verified package publication receipt as an application-only BOM", () => {
    const reactReceipt = receipt(react, packageSha);
    const sdkReceipt = receipt(sdk, "c".repeat(40));
    const evidence = validateVerifiedPackagePublicationReceipt(
      {
        schemaVersion: 1,
        phase: "verify",
        sourceSha: packageSha,
        needsPublish: false,
        releaseReady: true,
        packages: [reactReceipt],
        bomPackages: [sdkReceipt, reactReceipt],
      },
      { sourceSha: packageSha, packageNames: [react.name, sdk.name] },
    );

    expect(evidence.bomPackages).toEqual([reactReceipt, sdkReceipt]);
    expect(() =>
      assertPackageEvidenceMatchesRegistry(evidence, [reactReceipt, sdkReceipt]),
    ).not.toThrow();
    expect(() =>
      assertPackageEvidenceMatchesRegistry(evidence, [
        { ...reactReceipt, integrity: "sha512-drift" },
        sdkReceipt,
      ]),
    ).toThrow("no longer matches npm registry identity");
  });

  test("rejects incomplete, mutable, or source-mismatched package publication evidence", () => {
    const reactReceipt = receipt(react, packageSha);
    const sdkReceipt = receipt(sdk, "c".repeat(40));
    const base = {
      schemaVersion: 1,
      phase: "verify",
      sourceSha: packageSha,
      needsPublish: false,
      releaseReady: true,
      packages: [reactReceipt],
      bomPackages: [reactReceipt, sdkReceipt],
    };
    const expected = { sourceSha: packageSha, packageNames: [react.name, sdk.name] };

    expect(() =>
      validateVerifiedPackagePublicationReceipt({ ...base, sourceSha: sha }, expected),
    ).toThrow("source SHA does not match");
    expect(() =>
      validateVerifiedPackagePublicationReceipt({ ...base, bomPackages: [reactReceipt] }, expected),
    ).toThrow("exact package closure");
    expect(() =>
      validateVerifiedPackagePublicationReceipt(
        { ...base, packages: [{ ...reactReceipt, gitHead: sha }] },
        expected,
      ),
    ).toThrow("does not belong to the package source SHA");
    expect(() =>
      validateVerifiedPackagePublicationReceipt(
        { ...base, bomPackages: [{ ...reactReceipt, state: "pending" }, sdkReceipt] },
        expected,
      ),
    ).toThrow("is invalid");
  });

  test("plans exactly the declared missing package and ignores unchanged published packages", () => {
    const result = reconcileReleasePackages({
      sourceSha: sha,
      phase: "plan",
      publishable: [react, sdk],
      expected: [react],
      registry: new Map([
        [react.name, null],
        [sdk.name, published(sdk, "b".repeat(40))],
      ]),
    });
    expect(result.needsPublish).toBe(true);
    expect(result.releaseReady).toBe(false);
    expect(result.packages).toEqual([
      { ...react, state: "pending", gitHead: null, integrity: null },
    ]);
    expect(result.bomPackages).toEqual([
      { ...react, state: "pending", gitHead: null, integrity: null },
      {
        ...sdk,
        state: "published",
        gitHead: "b".repeat(40),
        integrity: "sha512-release-integrity",
      },
    ]);
  });

  test("derives the complete unpublished package set without caller-maintained input", () => {
    expect(
      deriveExpectedReleasePackages(
        [react, sdk],
        new Map([
          [react.name, null],
          [sdk.name, published(sdk, "b".repeat(40))],
        ]),
      ),
    ).toEqual([react]);
  });

  test("derivation fails closed when registry coverage is incomplete", () => {
    expect(() => deriveExpectedReleasePackages([react], new Map())).toThrow(
      "registry state was not loaded",
    );
  });

  test("automatic derivation is explicit and cannot change other empty-input callers", () => {
    const registry = new Map<string, RegistryPackage | null>([[react.name, null]]);
    expect(
      resolveExpectedReleasePackages({
        phase: "plan",
        deriveExpected: false,
        declaredExpected: [],
        publishable: [react],
        registry,
      }),
    ).toEqual([]);
    expect(
      resolveExpectedReleasePackages({
        phase: "plan",
        deriveExpected: true,
        declaredExpected: [],
        publishable: [react],
        registry,
      }),
    ).toEqual([react]);
    expect(() =>
      resolveExpectedReleasePackages({
        phase: "verify",
        deriveExpected: true,
        declaredExpected: [],
        publishable: [react],
        registry,
      }),
    ).toThrow("only during planning");
    expect(() =>
      resolveExpectedReleasePackages({
        phase: "plan",
        deriveExpected: true,
        declaredExpected: [react],
        publishable: [react],
        registry,
      }),
    ).toThrow("cannot be combined");
  });

  test("a frozen candidate package set makes partial-publication retries idempotent", () => {
    const result = reconcileReleasePackages({
      sourceSha: sha,
      phase: "plan",
      publishable: [react, sdk],
      expected: [react, sdk],
      registry: new Map([
        [react.name, published(react)],
        [sdk.name, null],
      ]),
    });

    expect(result.needsPublish).toBe(true);
    expect(result.packages).toEqual([
      {
        ...react,
        state: "published",
        gitHead: sha,
        integrity: "sha512-release-integrity",
      },
      { ...sdk, state: "pending", gitHead: null, integrity: null },
    ]);
  });

  test("fails before publish when an unlisted package would escape", () => {
    expect(() =>
      reconcileReleasePackages({
        sourceSha: sha,
        phase: "plan",
        publishable: [react, sdk],
        expected: [react],
        registry: new Map([
          [react.name, null],
          [sdk.name, null],
        ]),
      }),
    ).toThrow("unlisted unpublished package versions");
  });

  test("rejects local-version drift and an occupied version from another source", () => {
    expect(() =>
      reconcileReleasePackages({
        sourceSha: sha,
        phase: "plan",
        publishable: [react],
        expected: [{ ...react, version: "0.15.0" }],
        registry: new Map([[react.name, null]]),
      }),
    ).toThrow("checkout contains");

    expect(() =>
      reconcileReleasePackages({
        sourceSha: sha,
        phase: "verify",
        publishable: [react],
        expected: [react],
        registry: new Map([[react.name, published(react, "b".repeat(40))]]),
      }),
    ).toThrow("version collision");
  });

  test("accepts only an exact gitHead plus integrity and makes retries idempotent", () => {
    const result = reconcileReleasePackages({
      sourceSha: sha,
      phase: "verify",
      publishable: [react, sdk],
      expected: [react],
      registry: new Map([
        [react.name, published(react)],
        [sdk.name, published(sdk, "b".repeat(40))],
      ]),
    });
    expect(result.needsPublish).toBe(false);
    expect(result.releaseReady).toBe(true);
    expect(result.packages[0]).toMatchObject({
      ...react,
      state: "published",
      gitHead: sha,
    });
    expect(result.bomPackages).toHaveLength(2);
    expect(result.bomPackages.every((pkg) => pkg.state === "published")).toBe(true);
  });

  test("fails closed when an unchanged BOM member lacks immutable registry identity", () => {
    expect(() =>
      reconcileReleasePackages({
        sourceSha: sha,
        phase: "plan",
        publishable: [react, sdk],
        expected: [react],
        registry: new Map([
          [react.name, null],
          [sdk.name, { ...sdk, gitHead: null, integrity: "sha512-release-integrity" }],
        ]),
      }),
    ).toThrow("registry gitHead is missing or invalid");
  });

  test("verify fails closed while an expected package is still missing", () => {
    expect(() =>
      reconcileReleasePackages({
        sourceSha: sha,
        phase: "verify",
        publishable: [react],
        expected: [react],
        registry: new Map([[react.name, null]]),
      }),
    ).toThrow("publication did not settle");
  });
});
