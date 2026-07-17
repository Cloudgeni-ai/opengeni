import { describe, expect, test } from "bun:test";
import {
  loadPublishablePackages,
  parseExpectedPackages,
  reconcileReleasePackages,
  type PublishablePackage,
  type RegistryPackage,
} from "./verify-release-packages";

const sha = "a".repeat(40);
const react = { name: "@opengeni/react", version: "0.14.0" };
const sdk = { name: "@opengeni/sdk", version: "0.13.0" };

function published(pkg: PublishablePackage, gitHead = sha): RegistryPackage {
  return {
    ...pkg,
    gitHead,
    integrity: "sha512-release-integrity",
  };
}

describe("release package evidence", () => {
  test("inventories the exact publishable workspace closure, including app packages", () => {
    const publishable = loadPublishablePackages();
    expect(publishable).toContainEqual(
      expect.objectContaining({ name: "@opengeni/api-router" }),
    );
    expect(publishable).toContainEqual(
      expect.objectContaining({ name: "@opengeni/worker-bundle" }),
    );
    expect(publishable).not.toContainEqual(expect.objectContaining({ name: "opengeni-web" }));
  });

  test("parses a bounded comma/newline package set and rejects duplicates", () => {
    expect(parseExpectedPackages("@opengeni/react@0.14.0,\n@opengeni/sdk@0.13.0")).toEqual([
      react,
      sdk,
    ]);
    expect(() => parseExpectedPackages("@opengeni/react@0.14.0,@opengeni/react@0.14.0")).toThrow(
      "duplicate expected package",
    );
    expect(() => parseExpectedPackages("react@latest")).toThrow("invalid expected package spec");
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
    expect(result.packages[0]).toMatchObject({ ...react, state: "published", gitHead: sha });
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
