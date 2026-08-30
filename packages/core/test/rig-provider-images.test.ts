import { describe, expect, test } from "bun:test";
import type { RigChangeVerification, RigProviderImage, RigVersion } from "@opengeni/contracts";
import {
  rigProviderImageBuildRequestId,
  rigProviderImageContentHash,
  rigProviderImageSetupHash,
  rigProviderImagesFromVerification,
} from "../src/rigs";

const version: RigVersion = {
  id: "11111111-1111-4111-8111-111111111111",
  rigId: "22222222-2222-4222-8222-222222222222",
  version: 1,
  image: "ubuntu:24.04",
  setupScript: "apt-get update && apt-get install -y jq",
  checks: [{ name: "jq", command: "jq --version" }],
  credentialHooks: ["azure-cli-login"],
  defaultVariableSetIds: ["33333333-3333-4333-8333-333333333333"],
  changelog: "initial",
  providerImages: {},
  createdBy: "user:test",
  active: true,
  createdAt: "2026-08-10T00:00:00.000Z",
};
const DEPLOYMENT_BASE = "registry.example.com/opengeni-desktop@sha256:platform";

function readyImage(definition: RigVersion = version): RigProviderImage {
  const contentHash = rigProviderImageContentHash({
    backend: "modal",
    sourceImage: DEPLOYMENT_BASE,
    definition,
  });
  return {
    backend: "modal",
    provider: "modal",
    status: "ready",
    contentHash,
    setupHash: rigProviderImageSetupHash(definition),
    sourceImage: DEPLOYMENT_BASE,
    buildRequestId: rigProviderImageBuildRequestId({
      targetId: definition.id,
      backend: "modal",
      contentHash,
    }),
    imageId: "im-rig-version-one",
    imageDigest: null,
    artifactId: "55555555-5555-4555-8555-555555555555",
    providerBindingKeyHash: `sha256:${"4".repeat(64)}`,
    coldBootValidation: {
      version: 2,
      checkedAt: "2026-08-10T00:00:00.500Z",
    },
    provenance: {
      kind: "rig_verification",
      targetKind: "version",
      targetId: definition.id,
    },
    startedAt: "2026-08-10T00:00:00.000Z",
    finishedAt: "2026-08-10T00:00:01.000Z",
    error: null,
  };
}

describe("rig provider image identity", () => {
  test("is deterministic, ignores retired Rig image metadata, and invalidates setup/content", () => {
    const firstHash = rigProviderImageContentHash({
      backend: "modal",
      sourceImage: DEPLOYMENT_BASE,
      definition: version,
    });
    const secondHash = rigProviderImageContentHash({
      backend: "modal",
      sourceImage: DEPLOYMENT_BASE,
      definition: version,
    });
    expect(secondHash).toBe(firstHash);

    expect(
      rigProviderImageContentHash({
        backend: "modal",
        sourceImage: DEPLOYMENT_BASE,
        definition: { ...version, image: "historical.example/ignored:latest" },
      }),
    ).toBe(firstHash);

    const changed = { ...version, setupScript: `${version.setupScript}\necho changed` };
    const changedHash = rigProviderImageContentHash({
      backend: "modal",
      sourceImage: DEPLOYMENT_BASE,
      definition: changed,
    });
    expect(changedHash).not.toBe(firstHash);
    expect(
      rigProviderImageBuildRequestId({
        targetId: version.id,
        backend: "modal",
        contentHash: changedHash,
      }),
    ).not.toBe(
      rigProviderImageBuildRequestId({
        targetId: version.id,
        backend: "modal",
        contentHash: firstHash,
      }),
    );
  });

  test("promotion copies only a finalized build matching the exact promoted definition", () => {
    const image = readyImage();
    const verification = { providerImage: image } as RigChangeVerification;
    expect(rigProviderImagesFromVerification(verification, version)).toEqual({ modal: image });
    expect(
      rigProviderImagesFromVerification(verification, {
        ...version,
        setupScript: `${version.setupScript}\necho planted-stale-image`,
      }),
    ).toEqual({});
    expect(
      rigProviderImagesFromVerification(
        {
          providerImage: {
            ...image,
            status: "building",
            imageId: null,
            finishedAt: null,
          },
        } as RigChangeVerification,
        version,
      ),
    ).toEqual({});
  });
});
