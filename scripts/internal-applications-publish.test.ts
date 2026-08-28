import { describe, expect, test } from "bun:test";

import {
  internalApplicationBundleManifest,
  parseInternalApplicationPublisherConfig,
  sha256Digest,
} from "./internal-applications-publish";

const id = "11111111-1111-4111-8111-111111111111";
const digest = `sha256:${"a".repeat(64)}` as const;

const config = parseInternalApplicationPublisherConfig({
  schemaVersion: 1,
  apiUrl: "https://opengeni.internal",
  workspaceId: id,
  applicationId: id,
  applicationRevisionId: id,
  sourceDirectory: ".",
  imageReference: "registry.internal/apps/materials-demo",
  architecture: "amd64",
  runtime: { command: ["bun", "run", "start"], workingDirectory: "/app" },
  health: { path: "/healthz", port: 3000 },
  configurationKeys: ["OPENGENI_RUNTIME_URL"],
});

describe("trusted internal-application publisher", () => {
  test("builds a credential-free, digest-pinned manifest", () => {
    const manifest = internalApplicationBundleManifest({
      config,
      imageDigest: digest,
      sbomDigest: digest,
      provenanceDigest: digest,
    });
    expect(manifest).toMatchObject({
      image: { reference: config.imageReference, digest },
      sbomDigest: digest,
      provenanceDigest: digest,
    });
    expect(JSON.stringify(manifest)).not.toMatch(/token|password|apiKey|secret/iu);
  });

  test("hashes identical publisher evidence reproducibly", () => {
    expect(sha256Digest("same input")).toBe(sha256Digest("same input"));
    expect(sha256Digest("same input")).not.toBe(sha256Digest("changed input"));
  });

  test("rejects unbounded or credential-bearing config fields", () => {
    expect(() =>
      parseInternalApplicationPublisherConfig({
        ...config,
        apiKey: "must-not-be-in-config",
      }),
    ).toThrow();
  });
});
