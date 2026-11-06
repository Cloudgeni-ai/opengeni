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
import { testSettings } from "@opengeni/testing/settings";
import {
  RIG_PROVIDER_IMAGE_BUILD_STALE_AFTER_MS,
  resolveRigProviderImageSelection,
  rigProviderImageBuildSupported,
  rigProviderImageContentSourceImage,
  rigProviderImageSourceImage,
  settingsWithRigProviderImage,
} from "@opengeni/core";
import {
  RIG_VERIFICATION_OWNER_TTL_MS,
  buildVerifiedRigProviderImage,
  recordComputeEnvironmentVerificationFailure,
  rigPlatformChecksForSettings,
  rigProviderImageContentMarkerCommand,
  settingsForRigVerification,
  verifyRigProviderImageColdBoot,
  type BuildVerifiedRigProviderImageDependencies,
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
    changelog: null,
    providerImages: {},
    createdBy: "user:test",
    active: true,
    createdAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("rig platform verification contracts", () => {
  test("uses a valid ephemeral browser token and the desktop launcher's actual noVNC path", () => {
    const checks = rigPlatformChecksForSettings(
      platformSettings({ sandboxTerminalEnabled: true, sandboxDesktopEnabled: true }),
    );
    const browser = checks.find((check) => check.name === "opengeni-platform-browser");
    const desktop = checks.find((check) => check.name === "opengeni-platform-computer-desktop");

    expect(browser?.command).toContain("od -An -N32 -tx1 /dev/urandom");
    expect(browser?.command).toContain('test "${#__og_browser_token_value}" -eq 64');
    expect(browser?.command).toContain("Authorization: Bearer $__og_browser_token_value");
    expect(browser?.command).not.toContain("Bearer rig-platform-check");
    expect(desktop?.command).toContain("test -x /opt/noVNC/utils/novnc_proxy");
    expect(desktop?.command).not.toContain("command -v websockify");
  });
});

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
      version: 1,
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
    const runOwnedSandbox: RigProviderImageColdBootDependencies["runOwnedSandbox"] = async <T>(
      input,
      run,
    ): Promise<T> => {
      expect(input.settings.modalImageId).toBe("im-built-rig-image");
      expect(input.settings.modalWorkspacePersistence).toBe("snapshot_directory");
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
        rigVersionId: VERSION_ID,
        sessionIdPrefix: "rig-provider-image-test",
        imageId: "im-built-rig-image",
        contentHash: `sha256:${"a".repeat(64)}`,
        checks: [
          { name: "bash", command: "bash --version" },
          { name: "git", command: "git --version" },
        ],
        lifecycle: {
          signal: new AbortController().signal,
          cleanupDeadlineAtMs: null,
          dispose: () => undefined,
        },
      },
      {
        runOwnedSandbox,
        now: () => new Date("2026-08-10T00:00:00.500Z"),
      },
    );

    expect(checkedAt).toBe("2026-08-10T00:00:00.500Z");
    expect(commands[0]).toBe(`test -f '/var/opengeni/rig-setup-content-${"a".repeat(64)}.done'`);
    expect(commands.some((command) => command.includes("opengeni-browserd-up"))).toBe(true);
    expect(commands.some((command) => command.includes("opengeni-terminal-up"))).toBe(true);
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
    const verification = settingsForRigVerification(deployment, null);
    expect(verification).toBe(deployment);
    expect(verification.modalImageRef).toBe("deployment:latest");
    expect(verification.modalImageId).toBe("im-deployment");
    expect(rigProviderImageSourceImage(verification, "modal")).toBe("im-deployment");

    const rigOverride = settingsForRigVerification(deployment, "rig:pinned");
    expect(rigOverride).toBe(deployment);
  });
});

describe("compute environment templates", () => {
  const COMPUTE_BINDING_KEY = "compute:https://compute.test:team-a";

  function computeSettings(overrides: Partial<Settings> = {}): Settings {
    return testSettings({
      sandboxBackend: "compute",
      computeImage: "opengeni",
      deploymentRevision: "release-1",
      ...overrides,
    });
  }

  function readyTemplate(settings: Settings, definition: RigVersion): RigProviderImage {
    const sourceImage = rigProviderImageContentSourceImage(settings, "compute");
    const contentHash = rigProviderImageContentHash({
      backend: "compute",
      sourceImage,
      definition,
    });
    return {
      backend: "compute",
      provider: "compute",
      status: "ready",
      contentHash,
      setupHash: rigProviderImageSetupHash(definition),
      sourceImage,
      buildRequestId: rigProviderImageBuildRequestId({
        targetId: definition.id,
        backend: "compute",
        contentHash,
      }),
      imageId: "tpl-env",
      imageDigest: "captured-env",
      artifactId: null,
      providerBindingKeyHash: rigProviderImageProviderBindingKeyHash(COMPUTE_BINDING_KEY),
      coldBootValidation: { version: 1, checkedAt: "2026-08-10T00:00:00.500Z" },
      provenance: { kind: "rig_verification", targetKind: "version", targetId: definition.id },
      startedAt: "2026-08-10T00:00:00.000Z",
      finishedAt: "2026-08-10T00:00:01.000Z",
      error: null,
    };
  }

  test("a verified template boots fresh compute sandboxes with the environment already set up", async () => {
    const settings = computeSettings();
    const base = version();
    const template = readyTemplate(settings, base);
    const selection = await resolveRigProviderImageForRun(
      settings,
      { ...base, providerImages: { compute: template } },
      "compute",
      async (_settings, backend) => {
        expect(backend).toBe("compute");
        return { key: COMPUTE_BINDING_KEY };
      },
    );
    expect(selection.reason).toBe("selected");
    expect(selection.imageId).toBe("tpl-env");
    expect(selection.settings.computeTemplate).toBe("tpl-env");
    expect(selection.settings.modalImageId).toBeUndefined();
    // The logical image stays the deployment's: only fresh creates change.
    expect(selection.settings.computeImage).toBe("opengeni");
  });

  test("a template captured for an earlier release is stale once the image name moves on", () => {
    const base = version();
    const template = readyTemplate(computeSettings(), base);
    const nextRelease = computeSettings({ deploymentRevision: "release-2" });
    const selection = resolveRigProviderImageSelection(
      nextRelease,
      { ...base, providerImages: { compute: template } },
      "compute",
      template.providerBindingKeyHash,
    );
    expect(selection.reason).toBe("content_mismatch");
    expect(selection.settings.computeTemplate).toBeUndefined();
    expect(selection.contentHash).not.toBe(template.contentHash);

    // A compute image name, even one that looks digest-pinned, names an image
    // the hosts build with their own guest programs, so the release is
    // always part of the identity.
    const pinned = `registry.test/sandbox@sha256:${"d".repeat(64)}`;
    expect(
      rigProviderImageContentSourceImage(computeSettings({ computeImage: pinned }), "compute"),
    ).toBe(`${pinned} release release-1`);
    expect(
      rigProviderImageContentSourceImage(
        computeSettings({ computeImage: pinned, deploymentRevision: "release-2" }),
        "compute",
      ),
    ).toBe(`${pinned} release release-2`);
  });

  test("compute without an identifiable image keeps the setup path", () => {
    for (const settings of [
      computeSettings({ computeImage: undefined }),
      computeSettings({ deploymentRevision: "dev" }),
    ]) {
      expect(rigProviderImageBuildSupported(settings, "compute")).toBe(false);
      const selection = resolveRigProviderImageSelection(settings, version(), "compute", null);
      expect(selection).toEqual({
        settings,
        reason: "provider_unsupported",
        contentHash: null,
        imageId: null,
      });
    }
    expect(rigProviderImageBuildSupported(computeSettings(), "compute")).toBe(true);
  });

  test("a version with setup that was never built for the backend is unbuilt", () => {
    const settings = computeSettings();
    const never = resolveRigProviderImageSelection(settings, version(), "compute", null);
    expect(never.reason).toBe("unbuilt");
    expect(never.contentHash).toBe(
      rigProviderImageContentHash({
        backend: "compute",
        sourceImage: rigProviderImageContentSourceImage(settings, "compute"),
        definition: version(),
      }),
    );
    expect(never.settings).toBe(settings);

    const recordedUnsupported = resolveRigProviderImageSelection(
      settings,
      version({
        providerImages: {
          compute: { ...readyTemplate(settings, version()), status: "unsupported", imageId: null },
        },
      }),
      "compute",
      null,
    );
    expect(recordedUnsupported.reason).toBe("unbuilt");

    // Nothing to skip: no build is worth asking for.
    const noSetup = resolveRigProviderImageSelection(
      settings,
      version({ setupScript: "  " }),
      "compute",
      null,
    );
    expect(noSetup.reason).toBe("missing");
    expect(noSetup.contentHash).toBeNull();
  });

  test("a failed or stopped build of other content, or an abandoned build, asks for a rebuild", () => {
    const settings = computeSettings();
    const base = version();
    const current = readyTemplate(settings, base);
    const earlier = readyTemplate(computeSettings({ deploymentRevision: "release-0" }), base);
    const now = Date.parse("2026-08-10T01:00:00.000Z");
    const select = (image: RigProviderImage) =>
      resolveRigProviderImageSelection(
        settings,
        { ...base, providerImages: { compute: image } },
        "compute",
        null,
        now,
      );
    for (const status of ["failed", "building"] as const) {
      const other = select({ ...earlier, status, imageId: null, startedAt: new Date(now).toISOString() });
      expect(other.reason).toBe("content_mismatch");
      expect(other.contentHash).toBe(current.contentHash);
    }
    const stale = select({
      ...current,
      status: "building",
      imageId: null,
      startedAt: new Date(now - RIG_PROVIDER_IMAGE_BUILD_STALE_AFTER_MS).toISOString(),
    });
    expect(stale.reason).toBe("build_abandoned");
    expect(stale.contentHash).toBe(current.contentHash);
    const running = select({
      ...current,
      status: "building",
      imageId: null,
      startedAt: new Date(now - RIG_PROVIDER_IMAGE_BUILD_STALE_AFTER_MS + 1).toISOString(),
    });
    expect(running.reason).toBe("not_ready");
    // A failed build of this exact content waits for the content to change.
    expect(select({ ...current, status: "failed", imageId: null }).reason).toBe("not_ready");
    // The window matches the build claim's, so a rebuild can take the claim over.
    expect(RIG_PROVIDER_IMAGE_BUILD_STALE_AFTER_MS).toBe(RIG_VERIFICATION_OWNER_TTL_MS);
  });

  test("Modal keeps its selection: no record is missing and other failed content is not ready", () => {
    const settings = platformSettings();
    expect(resolveRigProviderImageSelection(settings, version(), "modal", null).reason).toBe(
      "missing",
    );
  });

  describe("a build's template ownership", () => {
    const settings = computeSettings();
    const definition = version();
    const STARTED = "2026-08-10T00:00:00.000Z";

    function harness(options: {
      created?: boolean;
      buildFails?: boolean;
      coldBootFails?: boolean;
      finalizeSucceeds?: boolean;
      replaced?: RigProviderImage | null;
      current?: (claimed: RigProviderImage) => RigProviderImage | null;
      currentThrows?: boolean;
      abortDuringColdBoot?: boolean;
    }) {
      const deleted: string[] = [];
      const finalized: RigProviderImage[] = [];
      const stop = new AbortController();
      let claimed: RigProviderImage | null = null;
      const dependencies: BuildVerifiedRigProviderImageDependencies = {
        buildImage: async () => {
          if (options.buildFails) throw new Error("capture failed");
          return {
            provider: "compute",
            backend: "compute",
            imageId: "tpl-new",
            imageDigest: "blake3-new",
            providerBindingKey: COMPUTE_BINDING_KEY,
            providerBinding: { provider: "compute" },
            ...(options.created === undefined ? {} : { created: options.created }),
          };
        },
        verifyColdBoot: async () => {
          if (options.abortDuringColdBoot) stop.abort(new Error("cancelled"));
          if (options.coldBootFails) throw new Error("cold boot failed");
          return "2026-08-10T00:00:02.000Z";
        },
        claim: async (_db, input) => {
          claimed = { ...input.image, startedAt: STARTED };
          return { status: "claimed", image: claimed, replaced: options.replaced ?? null };
        },
        finalize: async (_db, input) => {
          finalized.push(input.image);
          return options.finalizeSucceeds ?? true;
        },
        currentImage: async () => {
          if (options.currentThrows) throw new Error("database unavailable");
          return options.current ? options.current(claimed!) : claimed;
        },
        deleteComputeTemplate: async (_settings, template) => {
          deleted.push(template);
        },
      };
      const run = () =>
        buildVerifiedRigProviderImage(
          {
            settings,
            db: {} as never,
            observability: { warn: () => undefined } as never,
            accountId: "33333333-3333-4333-8333-333333333333",
            workspaceId: "44444444-4444-4444-8444-444444444444",
            existingVersionId: VERSION_ID,
            definition,
            target: { kind: "version", id: VERSION_ID },
            established: {
              backendId: "compute",
              client: {},
              instanceId: "sbx-build",
              session: { state: { sandboxId: "sbx-build" } },
              sessionState: {},
            } as never,
            ownership: {
              leaseId: "lease-build",
              leaseEpoch: 1,
              workspaceGeneration: 0,
              instanceId: "sbx-build",
            },
            lifecycle: { signal: stop.signal, cleanupDeadlineAtMs: null, dispose: () => undefined },
            signal: stop.signal,
          },
          dependencies,
        );
      return { run, deleted, finalized };
    }

    test("publishing deletes the template it replaced and keeps its own", async () => {
      const replaced = { ...readyTemplate(settings, definition), imageId: "tpl-old" };
      const { run, deleted } = harness({ replaced });
      const published = await run();
      expect(published.status).toBe("ready");
      expect(published.imageId).toBe("tpl-new");
      expect(deleted).toEqual(["tpl-old"]);
    });

    test("a failed build deletes the template it made while its claim still holds", async () => {
      const { run, deleted, finalized } = harness({ coldBootFails: true });
      const result = await run();
      expect(result.status).toBe("failed");
      expect(finalized.at(-1)?.status).toBe("failed");
      expect(deleted).toEqual(["tpl-new"]);
    });

    test("a failed build keeps a template a takeover now owns or the record references", async () => {
      const takenOver = harness({
        coldBootFails: true,
        current: (claimed) => ({ ...claimed, startedAt: "2026-08-10T00:30:00.000Z" }),
      });
      await takenOver.run();
      expect(takenOver.deleted).toEqual([]);

      const published = harness({
        coldBootFails: true,
        current: (claimed) => ({ ...claimed, status: "ready", imageId: "tpl-new" }),
      });
      await published.run();
      expect(published.deleted).toEqual([]);

      // When the record cannot be read the template stays for the next build.
      const unreadable = harness({ coldBootFails: true, currentThrows: true });
      await unreadable.run();
      expect(unreadable.deleted).toEqual([]);
    });

    test("a template found under the build's name is never deleted by this build", async () => {
      const { run, deleted } = harness({ created: false, coldBootFails: true });
      expect((await run()).status).toBe("failed");
      expect(deleted).toEqual([]);
    });

    test("a fenced publication keeps the template for a same-request takeover", async () => {
      const sameRequest = harness({
        finalizeSucceeds: false,
        current: (claimed) => ({ ...claimed, startedAt: "2026-08-10T00:30:00.000Z" }),
      });
      const fenced = await sameRequest.run();
      expect(fenced.error?.code).toBe("provider_image_publication_fenced");
      expect(sameRequest.deleted).toEqual([]);

      const otherBuild = harness({
        finalizeSucceeds: false,
        current: (claimed) => ({ ...claimed, buildRequestId: crypto.randomUUID() }),
      });
      await otherBuild.run();
      expect(otherBuild.deleted).toEqual(["tpl-new"]);
    });

    test("a cancelled build deletes the template it made and rethrows", async () => {
      const { run, deleted, finalized } = harness({ abortDuringColdBoot: true });
      await expect(run()).rejects.toThrow("cancelled");
      expect(deleted).toEqual(["tpl-new"]);
      expect(finalized).toEqual([]);
    });
  });

  test("a verification that fails before any build records a failed build of this content", async () => {
    const settings = computeSettings();
    const definition = version();
    const replaced = { ...readyTemplate(computeSettings({ deploymentRevision: "release-0" }), definition), imageId: "tpl-old" };
    const finalized: RigProviderImage[] = [];
    const deleted: string[] = [];
    const recorded = await recordComputeEnvironmentVerificationFailure(
      {
        settings,
        db: {} as never,
        observability: { warn: () => undefined } as never,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        version: definition,
        message: "setup exited with status 1",
      },
      {
        claim: async (_db, input) => ({ status: "claimed", image: input.image, replaced }),
        finalize: async (_db, input) => {
          finalized.push(input.image);
          return true;
        },
        deleteComputeTemplate: async (_settings, template) => {
          deleted.push(template);
        },
      },
    );
    expect(recorded).toBe(true);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({
      status: "failed",
      contentHash: readyTemplate(settings, definition).contentHash,
      error: { code: "provider_image_verification_failed", message: "setup exited with status 1" },
    });
    expect(deleted).toEqual(["tpl-old"]);
    // The record then holds the turn back from asking again for this content.
    expect(
      resolveRigProviderImageSelection(
        settings,
        { ...definition, providerImages: { compute: finalized[0]! } },
        "compute",
        null,
      ).reason,
    ).toBe("not_ready");

    // Another backend, or a claim another build holds, records nothing.
    expect(
      await recordComputeEnvironmentVerificationFailure({
        settings: platformSettings(),
        db: {} as never,
        observability: { warn: () => undefined } as never,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        version: definition,
        message: "x",
      }),
    ).toBe(false);
    const busy = await recordComputeEnvironmentVerificationFailure(
      {
        settings,
        db: {} as never,
        observability: { warn: () => undefined } as never,
        workspaceId: "44444444-4444-4444-8444-444444444444",
        version: definition,
        message: "x",
      },
      {
        claim: async (_db, input) => ({ status: "in_progress", image: input.image }),
        finalize: async () => {
          throw new Error("not asked");
        },
        deleteComputeTemplate: async () => {
          throw new Error("not asked");
        },
      },
    );
    expect(busy).toBe(false);
  });

  test("a template's cold-boot proof boots the template, with no Modal settings", async () => {
    let seen: Settings | null = null;
    const runOwnedSandbox: RigProviderImageColdBootDependencies["runOwnedSandbox"] = async <T>(
      input,
      run,
    ): Promise<T> => {
      seen = input.settings;
      return await run(
        { backendId: "compute", client: {}, instanceId: "sbx-cold", session: {}, sessionState: {} },
        {
          signal: new AbortController().signal,
          commandRunner: async () => ({ exitCode: 0, output: "ok" }),
          ownership: {
            leaseId: "lease-cold-boot",
            leaseEpoch: 1,
            workspaceGeneration: 0,
            instanceId: "sbx-cold",
          },
        },
      );
    };
    await verifyRigProviderImageColdBoot(
      {
        settings: computeSettings(),
        db: {} as never,
        observability: {} as never,
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        rigVersionId: VERSION_ID,
        sessionIdPrefix: "rig-provider-image-test",
        imageId: "tpl-env",
        contentHash: `sha256:${"a".repeat(64)}`,
        checks: [],
        lifecycle: {
          signal: new AbortController().signal,
          cleanupDeadlineAtMs: null,
          dispose: () => undefined,
        },
      },
      { runOwnedSandbox, now: () => new Date("2026-08-10T00:00:00.500Z") },
    );
    expect(seen!.computeTemplate).toBe("tpl-env");
    expect(seen!.modalImageId).toBeUndefined();
    expect(seen!.modalWorkspacePersistence).toBe(computeSettings().modalWorkspacePersistence);
  });
});
