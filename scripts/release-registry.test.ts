import { describe, expect, test } from "bun:test";

import {
  DEFAULT_RELEASE_OCI_PREFIX,
  isExactSha256Digest,
  normalizeReleaseOciPrefix,
  releaseChartReference,
  releaseImageName,
  releaseRegistryHost,
} from "./release-registry";

describe("release registry identity", () => {
  test("defaults to the current public GHCR namespace", () => {
    expect(normalizeReleaseOciPrefix()).toBe(DEFAULT_RELEASE_OCI_PREFIX);
    expect(releaseRegistryHost(DEFAULT_RELEASE_OCI_PREFIX)).toBe("ghcr.io");
    expect(releaseImageName(DEFAULT_RELEASE_OCI_PREFIX, "api")).toBe(
      "ghcr.io/cloudgeni-ai/opengeni-api",
    );
    expect(releaseChartReference(DEFAULT_RELEASE_OCI_PREFIX)).toBe(
      "oci://ghcr.io/cloudgeni-ai/charts/opengeni",
    );
  });

  test("supports a registry root or nested repository namespace", () => {
    expect(normalizeReleaseOciPrefix("registry.example")).toBe("registry.example");
    expect(releaseImageName("registry.example", "worker")).toBe("registry.example/opengeni-worker");
    expect(normalizeReleaseOciPrefix("registry.example/open/source")).toBe(
      "registry.example/open/source",
    );
    expect(releaseRegistryHost("registry.example:5000/open/source")).toBe("registry.example:5000");
  });

  test("rejects schemes, credentials, tags, digests, traversal, case, and invalid ports", () => {
    for (const value of [
      "",
      " https://registry.example",
      "https://registry.example",
      "user@registry.example",
      "registry.example/project:latest",
      "registry.example/project@sha256:abc",
      "registry.example/../project",
      "Registry.example/project",
      "registry.example:65536/project",
      "registry.example/",
    ]) {
      expect(() => normalizeReleaseOciPrefix(value)).toThrow();
    }
  });

  test("rejects arbitrary image roles", () => {
    expect(() => releaseImageName("registry.example", "../api")).toThrow("lowercase identifier");
  });

  test("recognizes only exact immutable SHA-256 digests", () => {
    expect(isExactSha256Digest(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(isExactSha256Digest("sha256:abc")).toBe(false);
    expect(isExactSha256Digest("latest")).toBe(false);
    expect(isExactSha256Digest(null)).toBe(false);
  });
});
