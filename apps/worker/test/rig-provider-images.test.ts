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
import type { TrustedRigPlatformRuntimeManifest } from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import {
  resolveRigProviderImageSelection,
  rigProviderImageSourceImage,
  settingsWithRigProviderImage,
} from "../src/activities/packs";
import {
  buildVerifiedRigProviderImage,
  RigProviderImageBuildDeadlineError,
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
const RUNTIME_MANIFEST = {
  version: 2,
  digest: `sha256:${"a".repeat(64)}`,
  entries: [
    {
      path: "/usr/local/bin/opengeni-browserd-up",
      resolvedPath: "/usr/local/bin/opengeni-browserd-up",
      fileType: "regular",
      mode: 0o100755,
      sizeBytes: 1,
      sha256: `sha256:${"b".repeat(64)}`,
    },
  ],
} as TrustedRigPlatformRuntimeManifest;

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
      version: 3,
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
  test("persists cleanup ownership before a timed-out build and records its late image", async () => {
    let providerTimeoutMs = 0;
    let resolveBuild:
      | ((value: {
          provider: "modal";
          backend: "modal";
          imageId: string;
          imageDigest: null;
          providerBindingKey: string;
          providerBinding: Record<string, unknown>;
        }) => void)
      | null = null;
    const events: string[] = [];
    const recorded: string[] = [];
    const buildFailed: string[] = [];
    const outcomeUnknown: string[] = [];
    const providerBinding = JSON.parse(PROVIDER_BINDING_KEY) as Record<string, unknown>;
    const startedAt = Date.now();
    await expect(
      buildVerifiedRigProviderImage(
        {
          settings: platformSettings({ sandboxSnapshotTimeoutMs: 10_000 }),
          db: {} as never,
          observability: {} as never,
          accountId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          definition: version(),
          target: { kind: "version", id: VERSION_ID },
          verificationAttemptId: "55555555-5555-4555-8555-555555555555",
          verificationExecutionGeneration: 1,
          established: {
            backendId: "modal",
            instanceId: "sandbox-build",
            client: {},
            session: {},
            sessionState: {},
          },
          ownership: {
            leaseId: "66666666-6666-4666-8666-666666666666",
            leaseEpoch: 1,
            workspaceGeneration: 0,
            instanceId: "sandbox-build",
          },
          runtimeManifest: RUNTIME_MANIFEST,
          lifecycle: {
            signal: new AbortController().signal,
            workDeadlineAtMs: Date.now() + 40,
            cleanupDeadlineAtMs: Date.now() + 1_000,
            dispose: () => undefined,
          },
          signal: new AbortController().signal,
        },
        {
          resolveProviderBinding: async () => ({
            key: PROVIDER_BINDING_KEY,
            binding: providerBinding as never,
          }),
          beginCleanupObligation: async () => {
            events.push("obligation");
            return {
              id: "77777777-7777-4777-8777-777777777777",
              state: "building",
              buildRequestId: rigProviderImageBuildRequestId({
                targetId: VERSION_ID,
                backend: "modal",
                contentHash: rigProviderImageContentHash({
                  backend: "modal",
                  sourceImage: PLATFORM_IMAGE,
                  definition: version(),
                }),
              }),
              objectId: null,
              providerBindingKey: PROVIDER_BINDING_KEY,
              providerBinding,
              sourceLeaseId: "66666666-6666-4666-8666-666666666666",
              sourceInstanceId: "sandbox-build",
            };
          },
          buildImmutableProviderImage: async (input) => {
            events.push("build");
            providerTimeoutMs = input.timeoutMs;
            return await new Promise((resolve) => {
              resolveBuild = resolve;
            });
          },
          recordCleanupObject: async (_db, input) => {
            recorded.push(input.objectId);
            return true;
          },
          settleCleanupObligation: async () => true,
          markCleanupBuildFailed: async (_db, input) => {
            buildFailed.push(input.error ?? "");
            return true;
          },
          markCleanupOutcomeUnknown: async (_db, input) => {
            outcomeUnknown.push(input.error ?? "");
            return true;
          },
        },
      ),
    ).rejects.toBeInstanceOf(RigProviderImageBuildDeadlineError);
    expect(providerTimeoutMs).toBeGreaterThan(0);
    expect(providerTimeoutMs).toBeLessThanOrEqual(40);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(events).toEqual(["obligation", "build"]);
    expect(buildFailed).toEqual([]);
    expect(outcomeUnknown).toEqual([]);

    resolveBuild?.({
      provider: "modal",
      backend: "modal",
      imageId: "im-late-build",
      imageDigest: null,
      providerBindingKey: PROVIDER_BINDING_KEY,
      providerBinding,
    });
    for (let attempt = 0; attempt < 100 && recorded.length === 0; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(recorded).toEqual(["im-late-build"]);
  });

  for (const [failureKind, providerError, expectedCleanupState] of [
    [
      "timeout",
      Object.assign(new Error("Modal snapshot deadline exceeded after admission"), {
        name: "TimeoutError",
      }),
      "outcome_unknown",
    ],
    [
      "transport",
      Object.assign(new Error("Modal snapshot transport closed after admission"), {
        name: "ClientError",
        code: 14,
      }),
      "outcome_unknown",
    ],
    [
      "permission",
      Object.assign(new Error("Modal snapshot permission denied"), {
        name: "ClientError",
        code: 7,
      }),
      "build_failed",
    ],
  ] as const) {
    test(`classifies a ${failureKind} rejection for durable cleanup`, async () => {
      const providerBinding = JSON.parse(PROVIDER_BINDING_KEY) as Record<string, unknown>;
      const buildFailed: string[] = [];
      const outcomeUnknown: string[] = [];
      const result = await buildVerifiedRigProviderImage(
        {
          settings: platformSettings({ sandboxSnapshotTimeoutMs: 10_000 }),
          db: {} as never,
          observability: {} as never,
          accountId: "11111111-1111-4111-8111-111111111111",
          workspaceId: "22222222-2222-4222-8222-222222222222",
          definition: version(),
          target: { kind: "version", id: VERSION_ID },
          verificationAttemptId: "55555555-5555-4555-8555-555555555555",
          verificationExecutionGeneration: 1,
          established: {
            backendId: "modal",
            instanceId: "sandbox-build",
            client: {},
            session: {},
            sessionState: {},
          },
          ownership: {
            leaseId: "66666666-6666-4666-8666-666666666666",
            leaseEpoch: 1,
            workspaceGeneration: 0,
            instanceId: "sandbox-build",
          },
          runtimeManifest: RUNTIME_MANIFEST,
          lifecycle: {
            signal: new AbortController().signal,
            workDeadlineAtMs: Date.now() + 5_000,
            cleanupDeadlineAtMs: Date.now() + 10_000,
            dispose: () => undefined,
          },
          signal: new AbortController().signal,
        },
        {
          resolveProviderBinding: async () => ({
            key: PROVIDER_BINDING_KEY,
            binding: providerBinding as never,
          }),
          beginCleanupObligation: async () => ({
            id: "77777777-7777-4777-8777-777777777777",
            state: "building",
            buildRequestId: rigProviderImageBuildRequestId({
              targetId: VERSION_ID,
              backend: "modal",
              contentHash: rigProviderImageContentHash({
                backend: "modal",
                sourceImage: PLATFORM_IMAGE,
                definition: version(),
              }),
            }),
            objectId: null,
            providerBindingKey: PROVIDER_BINDING_KEY,
            providerBinding,
            sourceLeaseId: "66666666-6666-4666-8666-666666666666",
            sourceInstanceId: "sandbox-build",
          }),
          buildImmutableProviderImage: async () => {
            throw providerError;
          },
          recordCleanupObject: async () => {
            throw new Error("a rejected build has no image id to record yet");
          },
          settleCleanupObligation: async () => true,
          markCleanupBuildFailed: async (_db, input) => {
            buildFailed.push(input.error ?? "");
            return true;
          },
          markCleanupOutcomeUnknown: async (_db, input) => {
            outcomeUnknown.push(input.error ?? "");
            return true;
          },
        },
      );

      expect(result.image.status).toBe("failed");
      expect(result.image.error).toMatchObject({
        code: "provider_image_build_failed",
        retryable: true,
      });
      expect(buildFailed).toEqual(
        expectedCleanupState === "build_failed" ? [providerError.message] : [],
      );
      expect(outcomeUnknown).toEqual(
        expectedCleanupState === "outcome_unknown" ? [providerError.message] : [],
      );
    });
  }

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
      expect(input.expectedProviderImageId).toBe("im-built-rig-image");
      expect(input.expectedRuntimeManifest).toBe(RUNTIME_MANIFEST);
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
          trustedRuntimeManifest: RUNTIME_MANIFEST,
          ownership: {
            leaseId: "lease-cold-boot",
            leaseEpoch: 2,
            workspaceGeneration: 0,
            instanceId: "sb-cold-boot",
          },
        },
      );
    };
    const surfaceReceipt = {
      version: 3 as const,
      checkedAt: "2026-08-10T00:00:00.400Z",
      binding: {
        leaseId: "11111111-1111-4111-8111-111111111111",
        sandboxGroupId: "33333333-3333-4333-8333-333333333333",
        leaseEpoch: 2,
        workspaceGeneration: 0,
        instanceId: "sb-cold-boot",
        backendId: "modal",
        rigVersionId: VERSION_ID,
      },
      provenance: {
        authority: "deployment_control_plane" as const,
        providerImage: "im-built-rig-image",
        providerImageId: "im-built-rig-image",
      },
      terminal: { status: "disabled" as const },
      browser: {
        status: "passed" as const,
        browserSessionId: "22222222-2222-4222-8222-222222222222",
        controllerGeneration: "sb-cold-boot",
        targetId: "page-1",
        observedTargetGeneration: "page-generation-1",
      },
      computer: { status: "disabled" as const },
    };
    const validation = await verifyRigProviderImageColdBoot(
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
        expectedRuntimeManifest: RUNTIME_MANIFEST,
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
            providerImage: input.providerImage,
            providerImageId: input.providerImageId,
          });
          return surfaceReceipt;
        },
        now: () => new Date("2026-08-10T00:00:00.500Z"),
      },
    );

    expect(validation).toEqual({
      checkedAt: "2026-08-10T00:00:00.500Z",
      platformSurfaceValidation: surfaceReceipt,
    });
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
        providerImage: "im-built-rig-image",
        providerImageId: "im-built-rig-image",
      },
    ]);
    expect(commands.at(-2)).toBe("bash --version");
    expect(commands.at(-1)).toBe("git --version");
  });

  for (const [surface, replacedCommand, expectedCheck] of [
    ["Browser", "opengeni-browserd-up", "opengeni-platform-browser"],
    ["Terminal", "opengeni-terminal-up", "opengeni-platform-terminal"],
  ] as const) {
    test(`rejects a derived image whose setup replaced the ${surface} binary`, async () => {
      const commands: string[] = [];
      let surfaceValidationCalls = 0;
      const runOwnedSandbox: RigProviderImageColdBootDependencies["runOwnedSandbox"] = async <T>(
        _input,
        run,
      ): Promise<T> =>
        await run(
          {
            backendId: "modal",
            client: {},
            instanceId: "sb-replaced-platform-binary",
            session: {},
            sessionState: {},
          },
          {
            signal: new AbortController().signal,
            commandRunner: async (_session, args) => {
              commands.push(args.cmd);
              return args.cmd.includes(replacedCommand)
                ? {
                    exitCode: 1,
                    output: `setup replaced ${replacedCommand} inside the derived image`,
                  }
                : { exitCode: 0, output: "ok" };
            },
            trustedRuntimeManifest: RUNTIME_MANIFEST,
            ownership: {
              leaseId: "lease-replaced-platform-binary",
              leaseEpoch: 2,
              workspaceGeneration: 0,
              instanceId: "sb-replaced-platform-binary",
            },
          },
        );

      await expect(
        verifyRigProviderImageColdBoot(
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
            sessionIdPrefix: "rig-provider-image-replaced-platform-binary",
            imageId: "im-derived-with-replaced-platform-binary",
            expectedRuntimeManifest: RUNTIME_MANIFEST,
            contentHash: `sha256:${"a".repeat(64)}`,
            checks: [],
            lifecycle: {
              signal: new AbortController().signal,
              workDeadlineAtMs: null,
              cleanupDeadlineAtMs: null,
              dispose: () => undefined,
            },
          },
          {
            runOwnedSandbox,
            runSurfaceValidation: async () => {
              surfaceValidationCalls += 1;
              return {} as never;
            },
            now: () => new Date("2026-08-31T12:00:00.000Z"),
          },
        ),
      ).rejects.toThrow(`failed mandatory platform check ${JSON.stringify(expectedCheck)}`);
      expect(commands.some((command) => command.includes(replacedCommand))).toBe(true);
      expect(surfaceValidationCalls).toBe(0);
    });
  }

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
