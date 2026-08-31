import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "@opengeni/config";
import type { RigProviderImage, RigVersion } from "@opengeni/contracts";
import {
  rigProviderImageBuildRequestId,
  rigProviderImageContentHash,
  rigProviderImageProviderBindingKeyHash,
  rigProviderImageSetupHash,
  resolveRigProviderImageForRun,
} from "@opengeni/core";
import { rigSetupScriptCommand } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import {
  resolveRigProviderImageSelection,
  rigProviderImageSourceImage,
  settingsWithRigProviderImage,
} from "../src/activities/packs";
import {
  rigProviderImageContentMarkerCommand,
  settingsForRigVerification,
  verifyRigProviderImageColdBoot,
  type RigProviderImageColdBootDependencies,
} from "../src/activities/rig-verification";

const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_BINDING_KEY = JSON.stringify({
  version: 1,
  serverUrl: "https://api.modal.com",
  workspaceName: "workspace-a",
  environment: "main",
});
const PLATFORM_IMAGE = "registry.example.com/opengeni-desktop@sha256:platform";

function platformSettings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({
    sandboxBackend: "modal",
    modalImageRef: PLATFORM_IMAGE,
    ...overrides,
  });
}

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
    artifactId: "44444444-4444-4444-8444-444444444444",
    providerBindingKeyHash: rigProviderImageProviderBindingKeyHash(PROVIDER_BINDING_KEY),
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
  test("publishes cold-boot proof only after the exact image marker and checks pass", async () => {
    const commands: string[] = [];
    const surfaceBindings: Array<Record<string, unknown>> = [];
    const runOwnedSandbox: RigProviderImageColdBootDependencies["runOwnedSandbox"] = async <T>(
      input,
      run,
    ): Promise<T> => {
      expect(input.settings.modalImageId).toBe("im-built-rig-image");
      expect(input.settings.modalWorkspacePersistence).toBe("snapshot_directory");
      expect(input.sandboxGroupId).toBe("33333333-3333-4333-8333-333333333333");
      return await run(
        {
          backendId: "modal",
          client: {},
          instanceId: "sb-cold-boot",
          session: {},
          sessionState: {},
        },
        {
          signal: new AbortController().signal,
          commandRunner: async (_session, args) => {
            commands.push(args.cmd);
            return { exitCode: 0, output: "ok" };
          },
          ownership: {
            leaseId: "lease-cold-boot",
            leaseEpoch: 2,
            workspaceGeneration: 0,
            instanceId: "sb-cold-boot",
          },
        },
      );
    };
    const checkedAt = await verifyRigProviderImageColdBoot(
      {
        settings: platformSettings(),
        db: {} as never,
        observability: {} as never,
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        buildRequestId: "33333333-3333-4333-8333-333333333333",
        rigVersionId: VERSION_ID,
        verificationAttemptId: "55555555-5555-4555-8555-555555555555",
        verificationExecutionGeneration: 2,
        sessionIdPrefix: "rig-provider-image-test",
        imageId: "im-built-rig-image",
        contentHash: `sha256:${"a".repeat(64)}`,
        checks: [
          { name: "bash", command: "bash --version" },
          { name: "git", command: "git --version" },
        ],
        lifecycle: {
          signal: new AbortController().signal,
          workDeadlineAtMs: null,
          cleanupDeadlineAtMs: null,
          dispose: () => undefined,
        },
      },
      {
        runOwnedSandbox,
        runSurfaceValidation: async (input) => {
          surfaceBindings.push({
            sandboxGroupId: input.sandboxGroupId,
            rigVersionId: input.rigVersionId,
            instanceId: input.established.instanceId,
            leaseId: input.ownership.leaseId,
            leaseEpoch: input.ownership.leaseEpoch,
          });
          return {} as never;
        },
        now: () => new Date("2026-08-10T00:00:00.500Z"),
      },
    );

    expect(checkedAt).toBe("2026-08-10T00:00:00.500Z");
    expect(commands[0]).toBe(`test -f '/var/opengeni/rig-setup-content-${"a".repeat(64)}.done'`);
    expect(commands.some((command) => command.includes("opengeni-browserd-up"))).toBe(true);
    expect(commands.some((command) => command.includes("opengeni-terminal-up"))).toBe(true);
    expect(surfaceBindings).toEqual([
      {
        sandboxGroupId: "33333333-3333-4333-8333-333333333333",
        rigVersionId: VERSION_ID,
        instanceId: "sb-cold-boot",
        leaseId: "lease-cold-boot",
        leaseEpoch: 2,
      },
    ]);
    expect(commands.at(-2)).toBe("bash --version");
    expect(commands.at(-1)).toBe("git --version");
  });

  test("two fresh boxes select the same immutable image and skip setup from its content marker", async () => {
    const logicalSettings = platformSettings();
    const base = version();
    const image = readyImage(logicalSettings, base);
    const verified = { ...base, providerImages: { modal: image } };

    const first = resolveRigProviderImageSelection(
      logicalSettings,
      verified,
      "modal",
      image.providerBindingKeyHash,
    );
    const second = resolveRigProviderImageSelection(
      logicalSettings,
      verified,
      "modal",
      image.providerBindingKeyHash,
    );
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
          { timeoutMs: 10_000, markerRoot: root, contentHash: image.contentHash },
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
    const logicalSettings = platformSettings();
    const oldVersion = version();
    const oldImage = readyImage(logicalSettings, oldVersion);
    const changedVersion = version({
      id: "33333333-3333-4333-8333-333333333333",
      version: 2,
      setupScript: "printf changed",
      providerImages: { modal: oldImage },
    });

    const selected = resolveRigProviderImageSelection(
      logicalSettings,
      changedVersion,
      "modal",
      oldImage.providerBindingKeyHash,
    );
    expect(selected.reason).toBe("content_mismatch");
    expect(selected.settings.modalImageId).toBeUndefined();
    expect(selected.contentHash).not.toBe(oldImage.contentHash);

    const root = await mkdtemp(join(tmpdir(), "opengeni-rig-image-mismatch-"));
    try {
      const proof = join(root, "changed-ran");
      const command = rigSetupScriptCommand(
        `printf changed > ${JSON.stringify(proof)}`,
        changedVersion.id,
        { timeoutMs: 10_000, markerRoot: root, contentHash: selected.contentHash! },
      );
      const result = await execute(command);
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("__OPENGENI_RIG_SETUP_SKIPPED__");
      expect(await readFile(proof, "utf8")).toBe("changed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a legacy ready image is not selected until an independent cold boot validates it", () => {
    const settings = platformSettings();
    const base = version();
    const { coldBootValidation: _legacyMissing, ...legacyImage } = readyImage(settings, base);
    const selected = resolveRigProviderImageSelection(
      settings,
      { ...base, providerImages: { modal: legacyImage } },
      "modal",
      legacyImage.providerBindingKeyHash,
    );

    expect(selected.reason).toBe("not_cold_boot_validated");
    expect(selected.settings.modalImageId).toBeUndefined();
    expect(selected.imageId).toBeNull();

    const obsoleteProof = {
      ...base,
      providerImages: {
        modal: {
          ...readyImage(settings, base),
          coldBootValidation: {
            version: 1 as const,
            checkedAt: "2026-08-10T00:00:00.500Z",
          },
        },
      },
    };
    expect(
      resolveRigProviderImageSelection(
        settings,
        obsoleteProof,
        "modal",
        obsoleteProof.providerImages.modal.providerBindingKeyHash,
      ).reason,
    ).toBe("not_cold_boot_validated");
  });

  test("a v1 cold-boot record is not selected without the current native-surface proof", () => {
    const settings = platformSettings();
    const base = version();
    const legacyImage = {
      ...readyImage(settings, base),
      coldBootValidation: {
        version: 1 as const,
        checkedAt: "2026-08-10T00:00:00.500Z",
      },
    };
    const selected = resolveRigProviderImageSelection(
      settings,
      { ...base, providerImages: { modal: legacyImage } },
      "modal",
      legacyImage.providerBindingKeyHash,
    );

    expect(selected.reason).toBe("not_cold_boot_validated");
    expect(selected.imageId).toBeNull();
  });

  test("unsupported backends preserve runtime setup fallback without changing settings", () => {
    const settings = testSettings({ sandboxBackend: "docker", dockerImage: "ubuntu:24.04" });
    const selected = resolveRigProviderImageSelection(settings, version(), "docker", null);
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

    const selected = resolveRigProviderImageSelection(
      baseSettings,
      verified,
      "modal",
      image.providerBindingKeyHash,
    );
    expect(selected.reason).toBe("selected");
    expect(image.sourceImage).toBe("im-base-image-a");
    expect(selected.settings.modalImageId).toBe(image.imageId);

    const rotatedBase = { ...baseSettings, modalImageId: "im-base-image-b" };
    const rejected = resolveRigProviderImageSelection(
      rotatedBase,
      verified,
      "modal",
      image.providerBindingKeyHash,
    );
    expect(rejected.reason).toBe("content_mismatch");
    expect(rejected.settings.modalImageId).toBe("im-base-image-b");
  });

  test("provider binding rotation falls back before passing a stale Modal image ID", async () => {
    const logicalSettings = platformSettings();
    const base = version();
    const image = readyImage(logicalSettings, base);
    const verified = { ...base, providerImages: { modal: image } };
    const rotatedHash = rigProviderImageProviderBindingKeyHash(
      PROVIDER_BINDING_KEY.replace("workspace-a", "workspace-b"),
    );

    const mismatch = resolveRigProviderImageSelection(
      logicalSettings,
      verified,
      "modal",
      rotatedHash,
    );
    expect(mismatch.reason).toBe("provider_binding_mismatch");
    expect(mismatch.settings.modalImageId).toBeUndefined();

    const selected = await settingsWithRigProviderImage(
      logicalSettings,
      verified,
      "modal",
      async () => ({
        key: PROVIDER_BINDING_KEY,
        binding: {
          version: 1,
          serverUrl: "https://api.modal.com",
          workspaceName: "workspace-a",
          environment: "main",
        },
      }),
    );
    expect(selected.modalImageId).toBe(image.imageId);

    const selection = await resolveRigProviderImageForRun(
      logicalSettings,
      verified,
      "modal",
      async () => ({
        key: PROVIDER_BINDING_KEY,
        binding: {
          version: 1,
          serverUrl: "https://api.modal.com",
          workspaceName: "workspace-a",
          environment: "main",
        },
      }),
    );
    expect(selection.reason).toBe("selected");
    expect(selection.imageId).toBe(image.imageId);

    const unavailable = await settingsWithRigProviderImage(
      logicalSettings,
      verified,
      "modal",
      async () => {
        throw new Error("identity unavailable");
      },
    );
    expect(unavailable.modalImageId).toBeUndefined();
    expect(unavailable.modalImageRef).toBe(PLATFORM_IMAGE);
  });

  test("verification always uses the deployment platform base", () => {
    const deployment = testSettings({
      sandboxBackend: "modal",
      modalImageRef: "deployment:latest",
      modalImageId: "im-deployment",
    });
    const packRuntime = {
      sandboxImage: "pack:stable",
      sandboxProviderImages: { modal: { imageId: "im-pack" } },
      skills: [],
    };

    const verification = settingsForRigVerification(deployment, packRuntime, null);
    expect(verification).toBe(deployment);
    expect(verification.modalImageRef).toBe("deployment:latest");
    expect(verification.modalImageId).toBe("im-deployment");
    expect(rigProviderImageSourceImage(verification, "modal")).toBe("im-deployment");

    const rigOverride = settingsForRigVerification(deployment, packRuntime, "rig:pinned");
    expect(rigOverride).toBe(deployment);
  });
});
