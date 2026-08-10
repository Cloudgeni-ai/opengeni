import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@opengeni/config";
import type { RigProviderImage, RigVersion } from "@opengeni/contracts";
import {
  rigProviderImageBuildRequestId,
  rigProviderImageContentHash,
  rigProviderImageSetupHash,
} from "@opengeni/core";
import { rigSetupScriptCommand } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import {
  resolveRigProviderImageSelection,
  rigProviderImageSourceImage,
  settingsWithRigImage,
} from "../src/activities/packs";
import { rigProviderImageContentMarkerCommand } from "../src/activities/rig-verification";

const VERSION_ID = "11111111-1111-4111-8111-111111111111";

function version(overrides: Partial<RigVersion> = {}): RigVersion {
  return {
    id: VERSION_ID,
    rigId: "22222222-2222-4222-8222-222222222222",
    version: 1,
    image: "ubuntu:24.04",
    setupScript: "printf setup-ran > /tmp/rig-setup-proof",
    checks: [{ name: "shell", command: "bash --version" }],
    credentialHooks: [],
    defaultVariableSetIds: [],
    changelog: null,
    providerImages: {},
    createdBy: "user:test",
    active: true,
    createdAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function readyImage(settings: Settings, definition: RigVersion): RigProviderImage {
  const sourceImage = rigProviderImageSourceImage(settings, "modal");
  const contentHash = rigProviderImageContentHash({
    backend: "modal",
    sourceImage,
    definition,
  });
  return {
    backend: "modal",
    provider: "modal",
    status: "ready",
    contentHash,
    setupHash: rigProviderImageSetupHash(definition),
    sourceImage,
    buildRequestId: rigProviderImageBuildRequestId({
      targetId: definition.id,
      backend: "modal",
      contentHash,
    }),
    imageId: "im-reused-rig-image",
    imageDigest: null,
    providerBindingKeyHash: `sha256:${"5".repeat(64)}`,
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

async function execute(command: string): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, output, error] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, output: `${output}${error}` };
}

describe("build-once rig provider image runtime", () => {
  test("two fresh boxes select the same immutable image and skip setup from its content marker", async () => {
    const logicalSettings = settingsWithRigImage(
      testSettings({ sandboxBackend: "modal" }),
      "ubuntu:24.04",
    );
    const base = version();
    const image = readyImage(logicalSettings, base);
    const verified = { ...base, providerImages: { modal: image } };

    const first = resolveRigProviderImageSelection(logicalSettings, verified, "modal");
    const second = resolveRigProviderImageSelection(logicalSettings, verified, "modal");
    expect(first.reason).toBe("selected");
    expect(second.reason).toBe("selected");
    expect(first.settings.modalImageId).toBe(image.imageId);
    expect(second.settings.modalImageId).toBe(image.imageId);
    expect(first.contentHash).toBe(second.contentHash);

    for (const suffix of ["a", "b"]) {
      const root = await mkdtemp(join(tmpdir(), `opengeni-rig-image-${suffix}-`));
      try {
        const marker = join(
          root,
          `rig-setup-content-${image.contentHash.slice("sha256:".length)}.done`,
        );
        const sealed = await execute(rigProviderImageContentMarkerCommand(image.contentHash, root));
        expect(sealed.exitCode).toBe(0);
        expect(await readFile(marker, "utf8")).toBe("");
        const proof = join(root, "setup-ran");
        const command = rigSetupScriptCommand(
          `printf setup-ran > ${JSON.stringify(proof)}`,
          verified.id,
          10_000,
          root,
          image.contentHash,
        );
        const result = await execute(command);
        expect(result.exitCode).toBe(0);
        expect(result.output).toContain("__OPENGENI_RIG_SETUP_SKIPPED__");
        await expect(readFile(proof, "utf8")).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test("a planted old image record cannot survive changed setup content", async () => {
    const logicalSettings = settingsWithRigImage(
      testSettings({ sandboxBackend: "modal" }),
      "ubuntu:24.04",
    );
    const oldVersion = version();
    const oldImage = readyImage(logicalSettings, oldVersion);
    const changedVersion = version({
      id: "33333333-3333-4333-8333-333333333333",
      version: 2,
      setupScript: "printf changed",
      providerImages: { modal: oldImage },
    });

    const selected = resolveRigProviderImageSelection(logicalSettings, changedVersion, "modal");
    expect(selected.reason).toBe("content_mismatch");
    expect(selected.settings.modalImageId).toBeUndefined();
    expect(selected.contentHash).not.toBe(oldImage.contentHash);

    const root = await mkdtemp(join(tmpdir(), "opengeni-rig-image-mismatch-"));
    try {
      const proof = join(root, "changed-ran");
      const command = rigSetupScriptCommand(
        `printf changed > ${JSON.stringify(proof)}`,
        changedVersion.id,
        10_000,
        root,
        selected.contentHash!,
      );
      const result = await execute(command);
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("__OPENGENI_RIG_SETUP_SKIPPED__");
      expect(await readFile(proof, "utf8")).toBe("changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("unsupported backends preserve runtime setup fallback without changing settings", () => {
    const settings = testSettings({ sandboxBackend: "docker", dockerImage: "ubuntu:24.04" });
    const selected = resolveRigProviderImageSelection(settings, version(), "docker");
    expect(selected).toEqual({
      settings,
      reason: "provider_unsupported",
      contentHash: null,
      imageId: null,
    });
  });

  test("a provider-native base image ID participates in source fencing", () => {
    const baseSettings = testSettings({
      sandboxBackend: "modal",
      modalImageRef: "ubuntu:24.04",
      modalImageId: "im-base-image-a",
    });
    const base = version({ image: null });
    const image = readyImage(baseSettings, base);
    const verified = { ...base, providerImages: { modal: image } };

    const selected = resolveRigProviderImageSelection(baseSettings, verified, "modal");
    expect(selected.reason).toBe("selected");
    expect(image.sourceImage).toBe("im-base-image-a");
    expect(selected.settings.modalImageId).toBe(image.imageId);

    const rotatedBase = { ...baseSettings, modalImageId: "im-base-image-b" };
    const rejected = resolveRigProviderImageSelection(rotatedBase, verified, "modal");
    expect(rejected.reason).toBe("content_mismatch");
    expect(rejected.settings.modalImageId).toBe("im-base-image-b");
  });
});
