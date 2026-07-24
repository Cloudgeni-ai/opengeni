import { describe, expect, test } from "bun:test";

import { resolveOptionalOciManifest } from "./resolve-optional-oci-manifest";

const digest = `sha256:${"a".repeat(64)}`;

describe("optional OCI manifest resolution", () => {
  test("returns only an exact immutable digest", async () => {
    await expect(
      resolveOptionalOciManifest("registry.example/image:1.0.0", async () => ({
        exitCode: 0,
        stdout: `${digest}\n`,
        stderr: "",
      })),
    ).resolves.toBe(digest);
    await expect(
      resolveOptionalOciManifest("registry.example/image:1.0.0", async () => ({
        exitCode: 0,
        stdout: "latest\n",
        stderr: "",
      })),
    ).rejects.toThrow("invalid manifest digest");
  });

  test("classifies only an explicit missing manifest as absent", async () => {
    for (const stderr of [
      "manifest unknown",
      "code: MANIFEST_UNKNOWN",
      "unexpected status: 404 Not Found",
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
