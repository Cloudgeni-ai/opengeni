import { describe, expect, test } from "bun:test";

import { resolveOptionalOciManifest } from "./resolve-optional-oci-manifest";

const digest = `sha256:${"a".repeat(64)}`;

describe("optional OCI manifest resolution", () => {
  test("fails closed when the registry lookup times out", async () => {
    await expect(
      resolveOptionalOciManifest("registry.example/image:1.0.0", async () => ({
        exitCode: 143,
        stdout: "",
        stderr: "",
        timedOut: true,
      })),
    ).rejects.toThrow("OCI manifest lookup timed out");
  });

  test("returns only an exact immutable digest", async () => {
    await expect(
      resolveOptionalOciManifest("registry.example/image:1.0.0", async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ mediaType: "application/vnd.oci.image.manifest.v1+json", digest }),
        stderr: "",
      })),
    ).resolves.toBe(digest);
    await expect(
      resolveOptionalOciManifest("registry.example/image:1.0.0", async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ digest: "latest" }),
        stderr: "",
      })),
    ).rejects.toThrow("invalid manifest digest");
    await expect(
      resolveOptionalOciManifest("registry.example/image:1.0.0", async () => ({
        exitCode: 0,
        stdout: "not-json",
        stderr: "",
      })),
    ).rejects.toThrow("invalid manifest document");
  });

  test("classifies only an explicit missing manifest as absent", async () => {
    for (const stderr of [
      "manifest unknown",
      "code: MANIFEST_UNKNOWN",
      "unexpected status: 404 Not Found",
      "ERROR: registry.example/image:1.0.0: not found",
      "warning from the local shell\nERROR: registry.example/image:1.0.0: not found",
    ]) {
      await expect(
        resolveOptionalOciManifest("registry.example/image:1.0.0", async () => ({
          exitCode: 1,
          stdout: "",
          stderr,
        })),
      ).resolves.toBeNull();
    }
  });

  test("fails closed on authorization, network, and malformed-reference errors", async () => {
    for (const stderr of ["403 Forbidden", "connection reset", "no such host"]) {
      await expect(
        resolveOptionalOciManifest("registry.example/image:1.0.0", async () => ({
          exitCode: 1,
          stdout: "",
          stderr,
        })),
      ).rejects.toThrow(stderr);
    }
    await expect(resolveOptionalOciManifest("registry.example/image:bad tag")).rejects.toThrow(
      "reference is invalid",
    );
  });
});
