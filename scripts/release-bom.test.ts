import { describe, expect, test } from "bun:test";
import { buildReleaseBom } from "./release-bom";

const sourceSha = "a".repeat(40);
const integrity = `sha512-${Buffer.from("release-integrity").toString("base64")}`;
const images = [
  { name: "ghcr.io/cloudgeni-ai/opengeni-api", digest: `sha256:${"1".repeat(64)}` },
  { name: "ghcr.io/cloudgeni-ai/opengeni-relay", digest: `sha256:${"2".repeat(64)}` },
  { name: "ghcr.io/cloudgeni-ai/opengeni-sandbox", digest: `sha256:${"3".repeat(64)}` },
  { name: "ghcr.io/cloudgeni-ai/opengeni-web", digest: `sha256:${"4".repeat(64)}` },
  { name: "ghcr.io/cloudgeni-ai/opengeni-worker", digest: `sha256:${"5".repeat(64)}` },
];

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
        images: [...images].reverse(),
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
        { name: "ghcr.io/cloudgeni-ai/opengeni-relay", digest: `sha256:${"2".repeat(64)}` },
        { name: "ghcr.io/cloudgeni-ai/opengeni-sandbox", digest: `sha256:${"3".repeat(64)}` },
        { name: "ghcr.io/cloudgeni-ai/opengeni-web", digest: `sha256:${"4".repeat(64)}` },
        { name: "ghcr.io/cloudgeni-ai/opengeni-worker", digest: `sha256:${"5".repeat(64)}` },
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
      images,
    };

    expect(() => buildReleaseBom({ ...valid, sourceSha: "main" })).toThrow("sourceSha");
    expect(() =>
      buildReleaseBom({
        ...valid,
        packages: [{ ...valid.packages[0]!, state: "pending" }],
      }),
    ).toThrow("not published");
    expect(() =>
      buildReleaseBom({
        ...valid,
        images: valid.images.map((image, index) =>
          index === 0 ? { ...image, digest: "latest" } : image,
        ),
      }),
    ).toThrow("invalid release BOM image identity");
    expect(() =>
      buildReleaseBom({ ...valid, packages: [...valid.packages, ...valid.packages] }),
    ).toThrow("duplicate package");
    expect(() => buildReleaseBom({ ...valid, images: [] })).toThrow("images must not be empty");
    expect(() => buildReleaseBom({ ...valid, images: valid.images.slice(0, -1) })).toThrow(
      "missing required image",
    );
  });
});
