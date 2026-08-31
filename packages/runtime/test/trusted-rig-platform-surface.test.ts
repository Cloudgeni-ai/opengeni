import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  attachProviderTrustedRigPlatformSurface,
  type BrowserControlPlacementSession,
  type TrustedRigPlatformSurfaceOperation,
} from "../src/sandbox";
import {
  createTrustedRigPlatformSurface,
  type TrustedRigPlatformSidecar,
} from "../src/sandbox/providers/trusted-rig-platform-surface";

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
  });

  test("the production Modal adapter uses the exact immutable sidecar and ignores root session exec", async () => {
    let rootExecCalls = 0;
    let sidecarExecCalls = 0;
    let createdImageId = "";
    let createdName = "";
    const sidecar = {
      containerId: "container-trusted",
      containerName: "",
      exec: async (command: string[], options?: { pty?: boolean; workdir?: string }) => {
        sidecarExecCalls += 1;
        expect(command).toEqual([
          "/bin/sh",
          "-lc",
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
      filesystem: { writeBytes: async () => undefined },
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
          fromId: async (imageId: string) => {
            createdImageId = imageId;
            return { imageId };
          },
        },
      },
      sandbox: {
        experimentalSidecars: {
          create: async (name: string) => {
            createdName = name;
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
        settings: testSettings({ sandboxBackend: "modal", sandboxDesktopEnabled: false }),
        session,
        instanceId: INSTANCE_ID,
        providerImage: PROVIDER_IMAGE,
        trustedProviderImageId: IMAGE_ID,
        leaseId: LEASE_ID,
        leaseEpoch: 7,
        workspaceGeneration: 3,
        sandboxGroupId: GROUP_ID,
        rigVersionId: VERSION_ID,
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
    });
    await expect(surface.runTerminalProbe(operation())).resolves.toEqual({
      cwd: "/workspace",
      uid: 0,
      bunVersion: "1.4.0",
      interactive: true,
    });
    expect(createdImageId).toBe(IMAGE_ID);
    expect(createdName).toStartWith("opengeni-rig-surface-");
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
      }),
    ).resolves.toBe(false);
    expect(Object.hasOwn(session, "trustedRigPlatformSurface")).toBe(false);
  });

  test("deadline cancellation waits for and terminates a sidecar that materializes late", async () => {
    let resolveCreate: ((sidecar: TrustedRigPlatformSidecar) => void) | null = null;
    let terminated = false;
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
    await Bun.sleep(1);
    resolveCreate?.({
      sidecarId: "late-sidecar",
      exec: async () => ({ exitCode: 0, output: "OPENGENI_TRUSTED_TERMINAL_OK" }),
      terminate: async () => {
        terminated = true;
      },
    });
    await expect(pending).rejects.toThrow("cancel trusted sidecar");
    expect(terminated).toBe(true);
  });
});
