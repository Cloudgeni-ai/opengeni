import { describe, expect, test } from "bun:test";

import {
  buildReleaseCandidateReceipt,
  deploymentImageDigests,
  RELEASE_IMAGE_NAMES,
  RELEASE_IMAGE_ROLES,
  releaseBomImages,
  validateReleaseCandidateReceipt,
  type ReleaseCandidateReceipt,
  type ReleaseImageRole,
} from "./release-candidate";

const sourceSha = "a".repeat(40);
const packages = [
  { name: "@opengeni/react", version: "0.18.0" },
  { name: "@opengeni/sdk", version: "0.18.0" },
];
const imageDigests = Object.fromEntries(
  RELEASE_IMAGE_ROLES.map((role, index) => [role, `sha256:${String(index + 1).repeat(64)}`]),
) as Record<ReleaseImageRole, string>;

describe("release candidate receipt", () => {
  test("normalizes the exact package and physical image inventory", () => {
    const receipt = buildReleaseCandidateReceipt({
      sourceSha,
      packages: [...packages].reverse(),
      imageDigests,
    });

    expect(receipt).toEqual({
      schemaVersion: 1,
      sourceSha,
      releaseVersion: "0.18.0",
      packages,
      images: Object.fromEntries(
        RELEASE_IMAGE_ROLES.map((role) => [
          role,
          { name: RELEASE_IMAGE_NAMES[role], digest: imageDigests[role] },
        ]),
      ) as ReleaseCandidateReceipt["images"],
      aliases: { migration: "api" },
    });
    expect(deploymentImageDigests(receipt)).toEqual({
      api: imageDigests.api,
      migration: imageDigests.api,
      worker: imageDigests.worker,
      web: imageDigests.web,
      relay: imageDigests.relay,
      sandbox: imageDigests.sandbox,
    });
    expect(releaseBomImages(receipt)).toEqual(
      RELEASE_IMAGE_ROLES.map((role) => ({
        name: RELEASE_IMAGE_NAMES[role],
        digest: imageDigests[role],
      })),
    );
  });

  test("rejects missing, extra, mutable, or provider-drifted image identities", () => {
    const valid = buildReleaseCandidateReceipt({ sourceSha, packages, imageDigests });

    const missing = structuredClone(valid) as any;
    delete missing.images.relay;
    expect(() => validateReleaseCandidateReceipt(missing)).toThrow("exactly");

    const extra = structuredClone(valid) as any;
    extra.images.desktop = { name: "ghcr.io/example/desktop", digest: imageDigests.api };
    expect(() => validateReleaseCandidateReceipt(extra)).toThrow("exactly");

    const mutable = structuredClone(valid) as any;
    mutable.images.api.digest = "latest";
    expect(() => validateReleaseCandidateReceipt(mutable)).toThrow("exact sha256 digest");

    const drifted = structuredClone(valid) as any;
    drifted.images.worker.name = "ghcr.io/example/worker";
    expect(() => validateReleaseCandidateReceipt(drifted)).toThrow(RELEASE_IMAGE_NAMES.worker);
  });

  test("binds source, package plan, release version, and migration alias", () => {
    const valid = buildReleaseCandidateReceipt({ sourceSha, packages, imageDigests });
    expect(
      validateReleaseCandidateReceipt(valid, {
        sourceSha,
        packages,
      }),
    ).toEqual(valid);

    expect(() =>
      validateReleaseCandidateReceipt(valid, { sourceSha: "b".repeat(40), packages }),
    ).toThrow("does not match");
    expect(() =>
      validateReleaseCandidateReceipt(valid, {
        sourceSha,
        packages: [{ name: "@opengeni/sdk", version: "0.19.0" }],
      }),
    ).toThrow("package plan");

    const wrongVersion = structuredClone(valid) as any;
    wrongVersion.releaseVersion = "0.19.0";
    expect(() => validateReleaseCandidateReceipt(wrongVersion)).toThrow("package plan");

    const wrongAlias = structuredClone(valid) as any;
    wrongAlias.aliases.migration = "worker";
    expect(() => validateReleaseCandidateReceipt(wrongAlias)).toThrow("alias the API");
  });
});
