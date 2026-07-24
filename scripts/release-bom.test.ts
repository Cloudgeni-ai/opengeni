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
const chart = {
  reference: "oci://ghcr.io/cloudgeni-ai/charts/opengeni" as const,
  version: "0.16.0",
  manifestDigest: `sha256:${"6".repeat(64)}`,
  bytesSha256: "7".repeat(64),
  artifact: "opengeni-0.16.0.tgz",
};

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
        chart,
      }),
    ).toEqual({
      schemaVersion: 2,
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
      chart,
    });
  });

  test("supports a coherent non-GHCR public registry identity", () => {
    const prefix = "registry.example/open-source";
    const portableImages = images.map((image) => ({
      ...image,
      name: image.name.replace("ghcr.io/cloudgeni-ai", prefix),
    }));
    const portableChart = {
      ...chart,
      reference: `oci://${prefix}/charts/opengeni`,
    };

    const bom = buildReleaseBom({
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
      images: portableImages,
      chart: portableChart,
    });

    expect(bom.images).toEqual([...portableImages].sort((a, b) => a.name.localeCompare(b.name)));
    expect(bom.chart.reference).toBe(portableChart.reference);
  });

  test("rejects image or chart registry drift", () => {
    const valid: Parameters<typeof buildReleaseBom>[0] = {
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
      chart,
    };
    expect(() =>
      buildReleaseBom({
        ...valid,
        images: valid.images.map((image) =>
          image.name.endsWith("/opengeni-worker")
            ? { ...image, name: image.name.replace("ghcr.io/cloudgeni-ai", "registry.example") }
            : image,
        ),
      }),
    ).toThrow("missing required image");
    expect(() =>
      buildReleaseBom({
        ...valid,
        chart: { ...chart, reference: "oci://registry.example/charts/opengeni" },
      }),
    ).toThrow("official OCI chart");
  });

  test("rejects mutable, incomplete, duplicate, or unpublished identities", () => {
    const valid: Parameters<typeof buildReleaseBom>[0] = {
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
      chart,
    };

    expect(() => buildReleaseBom({ ...valid, sourceSha: "main" })).toThrow("sourceSha");
    expect(() =>
      buildReleaseBom({
        ...valid,
        packages: [{ ...valid.packages[0]!, state: "pending" } as any],
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
      "must contain exactly",
    );
    expect(() =>
      buildReleaseBom({
        ...valid,
        images: [
          ...valid.images,
          {
            name: "ghcr.io/cloudgeni-ai/opengeni-desktop",
            digest: `sha256:${"6".repeat(64)}`,
          },
        ],
      }),
    ).toThrow("must contain exactly");
    expect(() =>
      buildReleaseBom({
        ...valid,
        chart: { ...chart, bytesSha256: "0".repeat(64) },
      }),
    ).not.toThrow();
    expect(() =>
      buildReleaseBom({
        ...valid,
        chart: { ...chart, version: "0.17.0" },
      }),
    ).toThrow("chart version must equal");
  });
});
