import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  attachProviderTrustedRigPlatformSurface,
  captureTrustedRigPlatformRuntimeManifest,
  inspectProviderTrustedRigPlatformRuntime,
  type BrowserControlPlacementSession,
  type TrustedRigPlatformRuntimeManifest,
  type TrustedRigPlatformSurfaceOperation,
} from "../src/sandbox";
import {
  createTrustedRigPlatformSurface,
  type TrustedRigPlatformSidecar,
} from "../src/sandbox/providers/trusted-rig-platform-surface";
import { dockerTrustedRigPlatformPathMetadataFromHeader } from "../src/sandbox/providers/docker-trusted-rig-platform-surface";

const PROVIDER_IMAGE = "registry.example.com/opengeni@sha256:platform";
const IMAGE_ID = "im-platform-immutable";
const INSTANCE_ID = "sb-exact";
const LEASE_ID = "11111111-1111-4111-8111-111111111111";
const GROUP_ID = "22222222-2222-4222-8222-222222222222";
const VERSION_ID = "33333333-3333-4333-8333-333333333333";

function operation(
  overrides: Partial<TrustedRigPlatformSurfaceOperation> = {},
): TrustedRigPlatformSurfaceOperation {
  return {
    backendId: "modal",
    instanceId: INSTANCE_ID,
    providerImage: PROVIDER_IMAGE,
    providerImageId: IMAGE_ID,
    leaseId: LEASE_ID,
    leaseEpoch: 7,
    workspaceGeneration: 3,
    sandboxGroupId: GROUP_ID,
    rigVersionId: VERSION_ID,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function textStream(value: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

const BROWSER_ENGINE = "/usr/lib/chromium/chromium";
const RUNTIME_DIRECTORIES = new Set([
  "/bin",
  "/etc",
  "/etc/opengeni",
  "/opt",
  "/opt/noVNC",
  "/opt/noVNC/utils",
  "/usr",
  "/usr/bin",
  "/usr/lib",
  "/usr/lib/chromium",
  "/usr/local",
  "/usr/local/bin",
  "/usr/local/lib",
  "/usr/local/lib/opengeni",
]);

function pristineRuntimeBytes(path: string): Uint8Array {
  return new TextEncoder().encode(
    path === "/etc/opengeni/browser-engine" ? `${BROWSER_ENGINE}\n` : `pristine:${path}`,
  );
}

function pristineRuntimeMetadata(path: string) {
  const directory = RUNTIME_DIRECTORIES.has(path);
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    type: directory ? ("directory" as const) : ("file" as const),
    size: directory ? 0 : pristineRuntimeBytes(path).byteLength,
    mode: directory ? 0o040755 : 0o100755,
    permissions: directory ? "rwxr-xr-x" : "rwxr-xr-x",
    owner: "root",
    group: "root",
    modifiedTime: 0,
    symlinkTarget: null,
  };
}

function pristineTrustedRuntimeMetadata(path: string) {
  const metadata = pristineRuntimeMetadata(path);
  return {
    path: metadata.path,
    type: metadata.type,
    sizeBytes: metadata.size,
    mode: metadata.mode,
    symlinkTarget: metadata.symlinkTarget,
  };
}

function dockerPathMetadataHeader(input: {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size?: number;
  symlinkTarget?: string;
}): string {
  const mode =
    input.type === "directory"
      ? 0x8000_0000 | 0o755
      : input.type === "symlink"
        ? 0x0800_0000 | 0o777
        : input.type === "other"
          ? 0x0200_0000 | 0o600
          : 0o755;
  return Buffer.from(
    JSON.stringify({
      name: input.path.slice(input.path.lastIndexOf("/") + 1),
      size: input.size ?? 0,
      mode: mode >>> 0,
      mtime: "2026-09-02T00:00:00Z",
      linkTarget: input.symlinkTarget ?? "",
    }),
  ).toString("base64");
}

async function runtimeManifest(
  settings = testSettings({ sandboxBackend: "modal", sandboxDesktopEnabled: false }),
): Promise<TrustedRigPlatformRuntimeManifest> {
  return await captureTrustedRigPlatformRuntimeManifest({
    settings,
    inspectPath: async (path) => pristineTrustedRuntimeMetadata(path),
    readBytes: async (path) => pristineRuntimeBytes(path),
  });
}

describe("provider-owned trusted Rig platform surfaces", () => {
  test("the Docker adapter isolates controller traffic from the root-owned verifier container", async () => {
    const source = await Bun.file(
      new URL("../src/sandbox/providers/docker-trusted-rig-platform-surface.ts", import.meta.url),
    ).text();
    expect(source).toContain('"network",\n      "create",\n      "--internal"');
    expect(source).toContain('"--publish",\n        "127.0.0.1::7682"');
    expect(source).not.toContain("`container:${input.instanceId}`");
    expect(source).toContain("removeDockerSidecarResources");
    expect(source).toContain('child.kill("SIGKILL")');
    expect(source).toContain("if (stopPromise) await stopPromise;");
    expect(source).toContain("options?.signal,\n        terminate,");
    expect(source).toContain('method: "HEAD"');
    expect(source).toContain('response.headers["x-docker-container-path-stat"]');
    expect(source).toContain('args: ["cp", `${input.containerId}:${path}`, localPath]');
    expect(source).toContain("const copied = await lstat(localPath)");
    expect(source).not.toContain('"--follow-link"');
    expect(source.indexOf("const actualRuntimeManifest = await captureDocker")).toBeLessThan(
      source.indexOf("const execute = async"),
    );
  });

  test("the production Modal adapter uses the exact immutable sidecar and ignores root session exec", async () => {
    let rootExecCalls = 0;
    let sidecarExecCalls = 0;
    let createdImageId = "";
    let createdName = "";
    let imageTimeoutMs = 0;
    let createTimeoutMs = 0;
    const settings = testSettings({ sandboxBackend: "modal", sandboxDesktopEnabled: false });
    const sidecar = {
      containerId: "container-trusted",
      containerName: "",
      exec: async (command: string[], options?: { pty?: boolean; workdir?: string }) => {
        sidecarExecCalls += 1;
        expect(command).toEqual([
          "/bin/sh",
          "-c",
          expect.stringContaining("OPENGENI_TRUSTED_TERMINAL_OK"),
        ]);
        expect(options?.pty).toBe(true);
        expect(options?.workdir).toBe("/workspace");
        return {
          stdout: textStream("OPENGENI_TRUSTED_TERMINAL_OK\n"),
          stderr: textStream(""),
          wait: async () => 0,
        };
      },
      filesystem: {
        readBytes: async (path: string) => pristineRuntimeBytes(path),
        stat: async (path: string) => pristineRuntimeMetadata(path),
        writeBytes: async () => undefined,
      },
      terminate: async () => 0,
    };
    const session = {
      state: { sandboxId: INSTANCE_ID, imageId: IMAGE_ID },
      exec: async () => {
        rootExecCalls += 1;
        throw new Error("root session exec must not validate the trusted surface");
      },
      modal: {
        images: {
          fromId: async (imageId: string, options?: { timeoutMs?: number }) => {
            createdImageId = imageId;
            imageTimeoutMs = options?.timeoutMs ?? 0;
            return { imageId };
          },
        },
      },
      sandbox: {
        filesystem: {
          readBytes: async (path: string) => pristineRuntimeBytes(path),
          stat: async (path: string) => pristineRuntimeMetadata(path),
        },
        experimentalSidecars: {
          create: async (_name: string, _image: unknown, options?: { timeoutMs?: number }) => {
            const name = _name;
            createdName = name;
            createTimeoutMs = options?.timeoutMs ?? 0;
            sidecar.containerName = name;
            return sidecar;
          },
          get: async () => sidecar,
        },
      },
      resolveExposedPort: async () => ({
        baseUrl: "http://127.0.0.1:7682",
        hostFetchAllowed: true,
      }),
    };

    const inspected = await inspectProviderTrustedRigPlatformRuntime({
      backend: "modal",
      settings,
      session,
      instanceId: INSTANCE_ID,
      providerImage: PROVIDER_IMAGE,
      expectedProviderImageId: IMAGE_ID,
      timeoutMs: 5_000,
    });
    expect(inspected).toEqual(await runtimeManifest(settings));
    expect(rootExecCalls).toBe(0);
    expect(sidecarExecCalls).toBe(0);

    await expect(
      attachProviderTrustedRigPlatformSurface({
        backend: "modal",
        settings,
        session,
        instanceId: INSTANCE_ID,
        providerImage: PROVIDER_IMAGE,
        expectedProviderImageId: IMAGE_ID,
        leaseId: LEASE_ID,
        leaseEpoch: 7,
        workspaceGeneration: 3,
        sandboxGroupId: GROUP_ID,
        rigVersionId: VERSION_ID,
        runtimeManifest: inspected!,
      }),
    ).resolves.toBe(true);

    const descriptor = Object.getOwnPropertyDescriptor(session, "trustedRigPlatformSurface");
    expect(descriptor).toMatchObject({ configurable: false, enumerable: false, writable: false });
    const surface = (session as BrowserControlPlacementSession).trustedRigPlatformSurface!;
    expect(surface.binding).toEqual({
      authority: "deployment_control_plane",
      backendId: "modal",
      instanceId: INSTANCE_ID,
      providerImage: PROVIDER_IMAGE,
      providerImageId: IMAGE_ID,
      leaseId: LEASE_ID,
      leaseEpoch: 7,
      workspaceGeneration: 3,
      sandboxGroupId: GROUP_ID,
      rigVersionId: VERSION_ID,
      runtimeManifestDigest: inspected!.digest,
    });
    await expect(surface.runTerminalProbe(operation())).resolves.toEqual({
      cwd: "/workspace",
      uid: 0,
      bunVersion: "1.4.0",
      interactive: true,
    });
    expect(createdImageId).toBe(IMAGE_ID);
    expect(createdName).toStartWith("opengeni-rig-surface-");
    expect(imageTimeoutMs).toBeGreaterThan(0);
    expect(createTimeoutMs).toBeGreaterThan(0);
    expect(sidecarExecCalls).toBe(1);
    expect(rootExecCalls).toBe(0);

    await expect(surface.runTerminalProbe(operation({ leaseEpoch: 8 }))).rejects.toThrow(
      "changed its exact binding",
    );
    expect(sidecarExecCalls).toBe(1);
    expect(() =>
      Object.defineProperty(session, "trustedRigPlatformSurface", { value: {} }),
    ).toThrow();
  });

  for (const replacedPath of [
    "/usr/local/bin/bun",
    "/usr/local/bin/opengeni-desktop-up",
    "/usr/local/bin/opengeni-browserd-up",
  ]) {
    test(`provider-owned inspection rejects a root replacement of ${replacedPath} before sidecar creation`, async () => {
      const settings = testSettings({
        sandboxBackend: "modal",
        sandboxDesktopEnabled: true,
        sandboxTerminalEnabled: true,
      });
      const expectedRuntimeManifest = await runtimeManifest(settings);
      let rootExecCalls = 0;
      let sidecarCreateCalls = 0;
      const session = {
        state: { sandboxId: INSTANCE_ID, imageId: IMAGE_ID },
        exec: async () => {
          rootExecCalls += 1;
          throw new Error("candidate root exec must not run before integrity rejection");
        },
        sandbox: {
          filesystem: {
            readBytes: async (path: string) =>
              path === replacedPath
                ? new TextEncoder().encode("#!/bin/sh\nprintf forged-evidence\\n")
                : pristineRuntimeBytes(path),
            stat: async (path: string) => {
              const metadata = pristineRuntimeMetadata(path);
              return path === replacedPath
                ? {
                    ...metadata,
                    size: new TextEncoder().encode("#!/bin/sh\nprintf forged-evidence\\n")
                      .byteLength,
                  }
                : metadata;
            },
          },
          experimentalSidecars: {
            create: async () => {
              sidecarCreateCalls += 1;
              throw new Error("sidecar creation must not run before integrity rejection");
            },
          },
        },
      };

      await expect(
        inspectProviderTrustedRigPlatformRuntime({
          backend: "modal",
          settings,
          session,
          instanceId: INSTANCE_ID,
          providerImage: PROVIDER_IMAGE,
          expectedProviderImageId: IMAGE_ID,
          expectedRuntimeManifest,
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(`runtime integrity mismatch at ${replacedPath}`);
      expect(rootExecCalls).toBe(0);
      expect(sidecarCreateCalls).toBe(0);
    });
  }

  for (const replacedPath of [
    "/usr/local/bin/bun",
    "/usr/local/bin/opengeni-desktop-up",
    "/usr/local/bin/opengeni-browserd-up",
  ]) {
    for (const replacementType of ["symlink", "directory"] as const) {
      test(`Modal metadata rejects a ${replacementType} replacement of ${replacedPath} before bytes, root exec, or sidecar creation`, async () => {
        const settings = testSettings({
          sandboxBackend: "modal",
          sandboxDesktopEnabled: true,
          sandboxTerminalEnabled: true,
        });
        const expectedRuntimeManifest = await runtimeManifest(settings);
        let replacedReadCalls = 0;
        let rootExecCalls = 0;
        let sidecarCreateCalls = 0;
        const session = {
          state: { sandboxId: INSTANCE_ID, imageId: IMAGE_ID },
          exec: async () => {
            rootExecCalls += 1;
            throw new Error("candidate root exec must not run before metadata rejection");
          },
          sandbox: {
            filesystem: {
              readBytes: async (path: string) => {
                if (path === replacedPath) replacedReadCalls += 1;
                return pristineRuntimeBytes(path);
              },
              stat: async (path: string) => {
                const metadata = pristineRuntimeMetadata(path);
                if (path !== replacedPath) return metadata;
                return replacementType === "symlink"
                  ? {
                      ...metadata,
                      type: "symlink" as const,
                      size: pristineRuntimeBytes(path).byteLength,
                      mode: 0o120777,
                      symlinkTarget: "/workspace/forged-runtime",
                    }
                  : {
                      ...metadata,
                      type: "directory" as const,
                      size: 0,
                      mode: 0o040755,
                    };
              },
            },
            experimentalSidecars: {
              create: async () => {
                sidecarCreateCalls += 1;
                throw new Error("sidecar creation must not run before metadata rejection");
              },
            },
          },
        };

        await expect(
          inspectProviderTrustedRigPlatformRuntime({
            backend: "modal",
            settings,
            session,
            instanceId: INSTANCE_ID,
            providerImage: PROVIDER_IMAGE,
            expectedProviderImageId: IMAGE_ID,
            expectedRuntimeManifest,
            timeoutMs: 5_000,
          }),
        ).rejects.toThrow(`runtime path must be a regular non-symlink file: ${replacedPath}`);
        expect(replacedReadCalls).toBe(0);
        expect(rootExecCalls).toBe(0);
        expect(sidecarCreateCalls).toBe(0);
      });
    }
  }

  test("Modal metadata rejects a symlinked protected-path parent before reading its leaf", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      sandboxDesktopEnabled: true,
      sandboxTerminalEnabled: true,
    });
    let descendantReads = 0;
    const session = {
      state: { sandboxId: INSTANCE_ID, imageId: IMAGE_ID },
      sandbox: {
        filesystem: {
          readBytes: async (path: string) => {
            if (path.startsWith("/usr/local/")) descendantReads += 1;
            return pristineRuntimeBytes(path);
          },
          stat: async (path: string) =>
            path === "/usr/local"
              ? {
                  ...pristineRuntimeMetadata(path),
                  type: "symlink" as const,
                  mode: 0o120777,
                  symlinkTarget: "/workspace/local",
                }
              : pristineRuntimeMetadata(path),
        },
      },
    };
    await expect(
      inspectProviderTrustedRigPlatformRuntime({
        backend: "modal",
        settings,
        session,
        instanceId: INSTANCE_ID,
        providerImage: PROVIDER_IMAGE,
        expectedProviderImageId: IMAGE_ID,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("runtime path component must be a real directory: /usr/local");
    expect(descendantReads).toBe(0);
  });

  test("runtime capture rejects a leaf rebound to a symlink while its bytes are read", async () => {
    const target = "/bin/bash";
    let targetStatCalls = 0;
    let targetReadCalls = 0;
    await expect(
      captureTrustedRigPlatformRuntimeManifest({
        settings: testSettings({
          sandboxBackend: "modal",
          sandboxDesktopEnabled: false,
          sandboxTerminalEnabled: false,
        }),
        inspectPath: async (path) => {
          if (path !== target) return pristineTrustedRuntimeMetadata(path);
          targetStatCalls += 1;
          if (targetStatCalls === 1) return pristineTrustedRuntimeMetadata(path);
          return {
            ...pristineTrustedRuntimeMetadata(path),
            type: "symlink" as const,
            mode: 0o120777,
            symlinkTarget: "/workspace/rebound-bash",
          };
        },
        readBytes: async (path) => {
          if (path === target) targetReadCalls += 1;
          return pristineRuntimeBytes(path);
        },
      }),
    ).rejects.toThrow(`runtime path must be a regular non-symlink file: ${target}`);
    expect(targetReadCalls).toBe(1);
    expect(targetStatCalls).toBe(2);
  });

  for (const replacedPath of [
    "/usr/local/bin/bun",
    "/usr/local/bin/opengeni-desktop-up",
    "/usr/local/bin/opengeni-browserd-up",
  ]) {
    for (const replacementType of ["symlink", "other"] as const) {
      test(`Docker daemon metadata rejects a ${replacementType} replacement of ${replacedPath} before copying the leaf`, async () => {
        const settings = testSettings({
          sandboxBackend: "docker",
          sandboxDesktopEnabled: true,
          sandboxTerminalEnabled: true,
        });
        let replacedReadCalls = 0;
        await expect(
          captureTrustedRigPlatformRuntimeManifest({
            settings,
            inspectPath: async (path) => {
              const pristine = pristineRuntimeMetadata(path);
              const type = path === replacedPath ? replacementType : pristine.type;
              return dockerTrustedRigPlatformPathMetadataFromHeader(
                path,
                dockerPathMetadataHeader({
                  path,
                  type,
                  size: type === "file" ? pristineRuntimeBytes(path).byteLength : 0,
                  ...(type === "symlink" ? { symlinkTarget: "/workspace/forged-runtime" } : {}),
                }),
              );
            },
            readBytes: async (path) => {
              if (path === replacedPath) replacedReadCalls += 1;
              return pristineRuntimeBytes(path);
            },
          }),
        ).rejects.toThrow(`runtime path must be a regular non-symlink file: ${replacedPath}`);
        expect(replacedReadCalls).toBe(0);
      });
    }
  }

  test("Modal revalidates a post-activation sidecar mutation before its first protected command", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      sandboxDesktopEnabled: false,
      sandboxTerminalEnabled: true,
    });
    const expectedRuntimeManifest = await runtimeManifest(settings);
    let sidecarCreateCalls = 0;
    let sidecarExecCalls = 0;
    let sidecarTerminateCalls = 0;
    const sidecar = {
      containerId: "container-mutated-after-activation",
      containerName: "",
      exec: async () => {
        sidecarExecCalls += 1;
        throw new Error("protected sidecar command must not run before revalidation");
      },
      filesystem: {
        readBytes: async (path: string) => pristineRuntimeBytes(path),
        stat: async (path: string) =>
          path === "/usr/local/bin/bun"
            ? {
                ...pristineRuntimeMetadata(path),
                type: "symlink" as const,
                mode: 0o120777,
                symlinkTarget: "/workspace/bun",
              }
            : pristineRuntimeMetadata(path),
        writeBytes: async () => undefined,
      },
      terminate: async () => {
        sidecarTerminateCalls += 1;
        return 0;
      },
    };
    const session = {
      state: { sandboxId: INSTANCE_ID, imageId: IMAGE_ID },
      modal: { images: { fromId: async () => ({ imageId: IMAGE_ID }) } },
      sandbox: {
        filesystem: {
          readBytes: async (path: string) => pristineRuntimeBytes(path),
          stat: async (path: string) => pristineRuntimeMetadata(path),
        },
        experimentalSidecars: {
          create: async (name: string) => {
            sidecarCreateCalls += 1;
            sidecar.containerName = name;
            return sidecar;
          },
          get: async () => sidecar,
        },
      },
      resolveExposedPort: async () => ({
        baseUrl: "http://127.0.0.1:7682",
        hostFetchAllowed: true,
      }),
    };
    await expect(
      attachProviderTrustedRigPlatformSurface({
        backend: "modal",
        settings,
        session,
        instanceId: INSTANCE_ID,
        providerImage: PROVIDER_IMAGE,
        expectedProviderImageId: IMAGE_ID,
        leaseId: LEASE_ID,
        leaseEpoch: 7,
        workspaceGeneration: 3,
        sandboxGroupId: GROUP_ID,
        rigVersionId: VERSION_ID,
        runtimeManifest: expectedRuntimeManifest,
      }),
    ).resolves.toBe(true);
    await expect(
      (session as BrowserControlPlacementSession).trustedRigPlatformSurface!.runTerminalProbe(
        operation(),
      ),
    ).rejects.toThrow("runtime path must be a regular non-symlink file: /usr/local/bin/bun");
    expect(sidecarCreateCalls).toBe(1);
    expect(sidecarExecCalls).toBe(0);
    expect(sidecarTerminateCalls).toBeGreaterThan(0);
  });

  test("unsupported providers remain explicit and fail closed", async () => {
    const session = {};
    await expect(
      attachProviderTrustedRigPlatformSurface({
        backend: "local",
        settings: testSettings({ sandboxBackend: "local" }),
        session,
        instanceId: "local-process",
        providerImage: PROVIDER_IMAGE,
        leaseId: LEASE_ID,
        leaseEpoch: 1,
        workspaceGeneration: 0,
        sandboxGroupId: GROUP_ID,
        rigVersionId: VERSION_ID,
        runtimeManifest: await runtimeManifest(),
      }),
    ).resolves.toBe(false);
    expect(Object.hasOwn(session, "trustedRigPlatformSurface")).toBe(false);
  });

  test("cancellation does not wait forever for a provider create call", async () => {
    const surface = createTrustedRigPlatformSurface({
      binding: {
        authority: "deployment_control_plane",
        backendId: "modal",
        instanceId: INSTANCE_ID,
        providerImage: PROVIDER_IMAGE,
        providerImageId: IMAGE_ID,
        leaseId: LEASE_ID,
        leaseEpoch: 7,
        workspaceGeneration: 3,
        sandboxGroupId: GROUP_ID,
        rigVersionId: VERSION_ID,
        runtimeManifestDigest: `sha256:${"c".repeat(64)}`,
      },
      desktopEnabled: false,
      createSidecar: async () => await new Promise<TrustedRigPlatformSidecar>(() => undefined),
    });
    const controller = new AbortController();
    const pending = surface.runTerminalProbe(operation({ signal: controller.signal }));
    controller.abort(new Error("cancel never-settling sidecar"));
    await expect(pending).rejects.toThrow("cancel never-settling sidecar");
  });

  test("creation observes cancellation that happens synchronously inside the provider factory", async () => {
    const controller = new AbortController();
    const surface = createTrustedRigPlatformSurface({
      binding: {
        authority: "deployment_control_plane",
        backendId: "modal",
        instanceId: INSTANCE_ID,
        providerImage: PROVIDER_IMAGE,
        providerImageId: IMAGE_ID,
        leaseId: LEASE_ID,
        leaseEpoch: 7,
        workspaceGeneration: 3,
        sandboxGroupId: GROUP_ID,
        rigVersionId: VERSION_ID,
        runtimeManifestDigest: `sha256:${"c".repeat(64)}`,
      },
      desktopEnabled: false,
      createSidecar: async () => {
        controller.abort(new Error("cancel during provider create"));
        return await new Promise<TrustedRigPlatformSidecar>(() => undefined);
      },
    });
    await expect(
      surface.runTerminalProbe(operation({ signal: controller.signal })),
    ).rejects.toThrow("cancel during provider create");
  });

  test("cancellation terminates a sidecar that materializes after the caller is released", async () => {
    let resolveCreate: ((sidecar: TrustedRigPlatformSidecar) => void) | null = null;
    let terminateCalls = 0;
    const surface = createTrustedRigPlatformSurface({
      binding: {
        authority: "deployment_control_plane",
        backendId: "modal",
        instanceId: INSTANCE_ID,
        providerImage: PROVIDER_IMAGE,
        providerImageId: IMAGE_ID,
        leaseId: LEASE_ID,
        leaseEpoch: 7,
        workspaceGeneration: 3,
        sandboxGroupId: GROUP_ID,
        rigVersionId: VERSION_ID,
        runtimeManifestDigest: `sha256:${"c".repeat(64)}`,
      },
      desktopEnabled: false,
      createSidecar: async () =>
        await new Promise<TrustedRigPlatformSidecar>((resolve) => {
          resolveCreate = resolve;
        }),
    });
    const controller = new AbortController();
    const pending = surface.runTerminalProbe(operation({ signal: controller.signal }));
    controller.abort(new Error("cancel trusted sidecar"));
    await expect(pending).rejects.toThrow("cancel trusted sidecar");
    resolveCreate?.({
      sidecarId: "late-sidecar",
      exec: async () => ({ exitCode: 0, output: "OPENGENI_TRUSTED_TERMINAL_OK" }),
      terminate: async () => {
        terminateCalls += 1;
      },
    });
    await Bun.sleep(1);
    expect(terminateCalls).toBe(1);
  });

  test("the Modal adapter forwards cancellation and performs bounded stable-name cleanup", async () => {
    let imageSignal: AbortSignal | undefined;
    let createSignal: AbortSignal | undefined;
    let cleanupTimeoutMs = 0;
    const session = {
      state: { sandboxId: INSTANCE_ID, imageId: IMAGE_ID },
      modal: {
        images: {
          fromId: async (_imageId: string, options?: { signal?: AbortSignal }) => {
            imageSignal = options?.signal;
            return { imageId: IMAGE_ID };
          },
        },
      },
      sandbox: {
        experimentalSidecars: {
          create: async (_name: string, _image: unknown, options?: { signal?: AbortSignal }) => {
            createSignal = options?.signal;
            return await new Promise<never>((_resolve, reject) => {
              if (options?.signal?.aborted) {
                reject(options.signal.reason);
                return;
              }
              options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
                once: true,
              });
            });
          },
          get: async (_name: string, options?: { timeoutMs?: number }) => {
            cleanupTimeoutMs = options?.timeoutMs ?? 0;
            const error = new Error("missing sidecar");
            error.name = "NotFoundError";
            throw error;
          },
        },
      },
      resolveExposedPort: async () => ({
        baseUrl: "http://127.0.0.1:7682",
        hostFetchAllowed: true,
      }),
    };
    await expect(
      attachProviderTrustedRigPlatformSurface({
        backend: "modal",
        settings: testSettings({ sandboxBackend: "modal", sandboxDesktopEnabled: false }),
        session,
        instanceId: INSTANCE_ID,
        providerImage: PROVIDER_IMAGE,
        expectedProviderImageId: IMAGE_ID,
        leaseId: LEASE_ID,
        leaseEpoch: 7,
        workspaceGeneration: 3,
        sandboxGroupId: GROUP_ID,
        rigVersionId: VERSION_ID,
        runtimeManifest: await runtimeManifest(),
      }),
    ).resolves.toBe(true);
    const controller = new AbortController();
    const pending = (
      session as BrowserControlPlacementSession
    ).trustedRigPlatformSurface!.runTerminalProbe(operation({ signal: controller.signal }));
    controller.abort(new Error("cancel Modal create"));
    await expect(pending).rejects.toThrow("cancel Modal create");
    await Bun.sleep(1);
    expect(imageSignal).toBe(controller.signal);
    expect(createSignal).toBe(controller.signal);
    expect(cleanupTimeoutMs).toBeGreaterThan(0);
  });
});
