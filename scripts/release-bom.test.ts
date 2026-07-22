import { describe, expect, test } from "bun:test";
import { buildReleaseBom } from "./release-bom";

const sourceSha = "a".repeat(40);
const integrity = `sha512-${Buffer.from("release-integrity").toString("base64")}`;

describe("release BOM", () => {
  test("normalizes a complete immutable package and image inventory", () => {
    expect(
      buildReleaseBom({
        sourceSha,
        releaseVersion: "0.16.0",
        packages: [
          {
            name: "@opengeni/sdk",
            version: "0.16.0",
            gitHead: sourceSha,
            integrity,
            state: "published",
          },
          {
            name: "@opengeni/contracts",
            version: "0.11.0",
            gitHead: "b".repeat(40),
            integrity,
            state: "published",
          },
        ],
        images: [
          { name: "ghcr.io/cloudgeni-ai/opengeni-worker", digest: `sha256:${"2".repeat(64)}` },
          { name: "ghcr.io/cloudgeni-ai/opengeni-api", digest: `sha256:${"1".repeat(64)}` },
        ],
      }),
    ).toEqual({
      schemaVersion: 1,
      sourceSha,
      releaseVersion: "0.16.0",
      packages: [
        {
          name: "@opengeni/contracts",
          version: "0.11.0",
          gitHead: "b".repeat(40),
          integrity,
        },
        {
          name: "@opengeni/sdk",
          version: "0.16.0",
          gitHead: sourceSha,
          integrity,
        },
      ],
      images: [
        { name: "ghcr.io/cloudgeni-ai/opengeni-api", digest: `sha256:${"1".repeat(64)}` },
        { name: "ghcr.io/cloudgeni-ai/opengeni-worker", digest: `sha256:${"2".repeat(64)}` },
      ],
    });
  });

  test("rejects mutable, incomplete, duplicate, or unpublished identities", () => {
    const valid = {
      sourceSha,
      releaseVersion: "0.16.0",
      packages: [
        {
          name: "@opengeni/sdk",
          version: "0.16.0",
          gitHead: sourceSha,
          integrity,
          state: "published",
        },
      ],
      images: [{ name: "ghcr.io/cloudgeni-ai/opengeni-api", digest: `sha256:${"1".repeat(64)}` }],
    };

    expect(() => buildReleaseBom({ ...valid, sourceSha: "main" })).toThrow("sourceSha");
    expect(() =>
      buildReleaseBom({
        ...valid,
        packages: [{ ...valid.packages[0]!, state: "pending" }],
      }),
    ).toThrow("not published");
    expect(() =>
      buildReleaseBom({ ...valid, images: [{ ...valid.images[0]!, digest: "latest" }] }),
    ).toThrow("invalid release BOM image identity");
    expect(() =>
      buildReleaseBom({ ...valid, packages: [...valid.packages, ...valid.packages] }),
    ).toThrow("duplicate package");
    expect(() => buildReleaseBom({ ...valid, images: [] })).toThrow("images must not be empty");
  });
});
