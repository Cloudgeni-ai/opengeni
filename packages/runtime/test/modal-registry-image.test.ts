import { afterEach, describe, expect, mock, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  __resetModalRegistryImageCacheForTest,
  ensureModalRegistryImage,
  modalProvider,
  resolveModalImageSelector,
  type ModalModuleLoader,
} from "../src/sandbox/providers/modal";

const IMAGE_REF = "acr.example.com/cloudgeni-sandbox@sha256:abc";
const IMAGE_ID = "im-1234567890123456789012";
const SECRET_NAME = "acr-credentials-gecko";

/** A fake modal module capturing the fromRegistry(tag, secret) call shape. */
function fakeModal() {
  const fakeImage = { imageId: "im-fake", objectId: "im-fake" };
  const fromRegistry = mock((_tag: string, _secret: unknown) => fakeImage);
  const clientOptions: unknown[] = [];
  // The Secret is resolved via the AUTHENTICATED client (client.secrets.fromName),
  // never the static modal.Secret.fromName (which uses getDefaultClient).
  const secretFromName = mock(async (_name: string, _params?: unknown) => ({
    secretId: "sec-fake",
  }));
  const loadModal: ModalModuleLoader = async () =>
    ({
      ModalClient: class {
        images = { fromRegistry };
        secrets = { fromName: secretFromName };

        constructor(options: unknown) {
          clientOptions.push(options);
        }
      },
    }) as unknown as Awaited<ReturnType<ModalModuleLoader>>;
  return { loadModal, fromRegistry, secretFromName, clientOptions, fakeImage };
}

afterEach(() => {
  __resetModalRegistryImageCacheForTest();
});

describe("resolveModalImageSelector", () => {
  test("no image ref → undefined (Modal default image)", () => {
    const settings = testSettings({ sandboxBackend: "modal", modalImageRef: undefined });
    expect(resolveModalImageSelector(settings)).toBeUndefined();
  });

  test("image ref, no registry secret → public fromTag selector", () => {
    const settings = testSettings({ sandboxBackend: "modal", modalImageRef: IMAGE_REF });
    const selector = resolveModalImageSelector(settings);
    expect(selector?.kind).toBe("tag");
    expect(selector?.value).toBe(IMAGE_REF);
  });

  test("provider-native image ID wins while retaining the logical image ref", () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      modalImageRef: IMAGE_REF,
      modalImageId: IMAGE_ID,
      modalImageRegistrySecret: SECRET_NAME,
    });
    const selector = resolveModalImageSelector(settings);
    expect(selector?.kind).toBe("id");
    expect(selector?.value).toBe(IMAGE_ID);
  });

  test("registry secret set but NOT yet resolved (cold) → falls back to fromTag", () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      modalImageRef: IMAGE_REF,
      modalImageRegistrySecret: SECRET_NAME,
    });
    // ensureModalRegistryImage was not awaited → cache cold → tag path (safe for
    // resume/attach; the create path always warms first at worker boot).
    expect(resolveModalImageSelector(settings)?.kind).toBe("tag");
  });

  test("registry secret set AND resolved → fromImage selector using the pulled image", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      modalImageRef: IMAGE_REF,
      modalImageRegistrySecret: SECRET_NAME,
      modalEnvironment: "main",
    });
    const { loadModal, fromRegistry, secretFromName, clientOptions, fakeImage } = fakeModal();

    await ensureModalRegistryImage(settings, loadModal);

    expect(clientOptions).toEqual([
      {
        tokenId: settings.modalTokenId,
        tokenSecret: settings.modalTokenSecret,
        environment: "main",
      },
    ]);
    expect(clientOptions[0]).not.toHaveProperty("timeoutMs");
    expect(secretFromName).toHaveBeenCalledTimes(1);
    expect(secretFromName.mock.calls[0]?.[0]).toBe(SECRET_NAME);
    expect(secretFromName.mock.calls[0]?.[1]).toEqual({ environment: "main" });
    expect(fromRegistry).toHaveBeenCalledTimes(1);
    expect(fromRegistry.mock.calls[0]?.[0]).toBe(IMAGE_REF);
    expect(fromRegistry.mock.calls[0]?.[1]).toEqual({ secretId: "sec-fake" });

    const selector = resolveModalImageSelector(settings);
    expect(selector?.kind).toBe("image");
    expect(selector?.value).toBe(fakeImage);
  });
});

describe("ensureModalRegistryImage", () => {
  test("provider-native image ID bypasses registry loading", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      modalImageRef: IMAGE_REF,
      modalImageId: IMAGE_ID,
      modalImageRegistrySecret: SECRET_NAME,
    });
    const loadModal = mock(async () => {
      throw new Error("modal registry loader must not run for a provider-native image ID");
    });
    await ensureModalRegistryImage(settings, loadModal as unknown as ModalModuleLoader);
    expect(loadModal).not.toHaveBeenCalled();
  });

  test("no-op (never loads modal) when the registry secret is unset", async () => {
    const settings = testSettings({ sandboxBackend: "modal", modalImageRef: IMAGE_REF });
    const loadModal = mock(async () => {
      throw new Error("modal must not be loaded when no registry secret is configured");
    });
    await ensureModalRegistryImage(settings, loadModal as unknown as ModalModuleLoader);
    expect(loadModal).not.toHaveBeenCalled();
  });

  test("no-op when the image ref is unset (nothing to pull)", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      modalImageRef: undefined,
      modalImageRegistrySecret: SECRET_NAME,
    });
    const loadModal = mock(async () => {
      throw new Error("modal must not be loaded without an image ref");
    });
    await ensureModalRegistryImage(settings, loadModal as unknown as ModalModuleLoader);
    expect(loadModal).not.toHaveBeenCalled();
  });

  test("memoized: a second call does not re-resolve", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      modalImageRef: IMAGE_REF,
      modalImageRegistrySecret: SECRET_NAME,
    });
    const { loadModal, fromRegistry } = fakeModal();
    await ensureModalRegistryImage(settings, loadModal);
    await ensureModalRegistryImage(settings, loadModal);
    expect(fromRegistry).toHaveBeenCalledTimes(1);
  });
});

describe("modalProvider.build with a resolved registry image", () => {
  test("build accepts a provider-native image ID with logical provenance", () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      modalImageRef: IMAGE_REF,
      modalImageId: IMAGE_ID,
    });
    const client = modalProvider.build({ settings, environment: {}, exposedPorts: [] });
    expect(client).toBeDefined();
  });

  test("provider-native image ID is self-contained without a logical image ref", () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      modalImageRef: undefined,
      modalImageId: IMAGE_ID,
    });
    expect(() => modalProvider.validateCredentials(settings)).not.toThrow();
    const selector = resolveModalImageSelector(settings);
    expect(selector?.kind).toBe("id");
    expect(selector?.value).toBe(IMAGE_ID);
  });

  test("build attaches the pulled image (no throw) once resolved", async () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      modalImageRef: IMAGE_REF,
      modalImageRegistrySecret: SECRET_NAME,
      modalTokenId: "id",
      modalTokenSecret: "secret",
    });
    const { loadModal } = fakeModal();
    await ensureModalRegistryImage(settings, loadModal);
    // build() must construct a client without throwing; the selector it uses is the
    // resolved-image branch (asserted via resolveModalImageSelector above).
    const client = modalProvider.build({ settings, environment: {}, exposedPorts: [] });
    expect(client).toBeDefined();
  });
});

describe("modalProvider immutable rig image build", () => {
  test("snapshots the exact live sandbox once with the durable request UUID", async () => {
    const requestId = "77777777-7777-4777-8777-777777777777";
    const snapshotFilesystem = mock(async (_input: unknown) => ({ imageId: IMAGE_ID }));
    const detach = mock(() => undefined);
    const snapshotHandle = { snapshotFilesystem, detach };
    const sandboxes = {
      fromId: mock(function (this: unknown, sandboxId: string) {
        expect(this).toBe(sandboxes);
        expect(sandboxId).toBe("sb-rig-verifier");
        return Promise.resolve(snapshotHandle);
      }),
    };
    const session = {
      state: { sandboxId: "sb-rig-verifier" },
      modal: {
        sandboxes,
        cpClient: {
          workspaceNameLookup: mock(async () => ({ workspaceName: "workspace-a" })),
        },
        profile: { serverUrl: "https://api.modal.com" },
        environmentName: mock(() => "main"),
      },
    };
    const settings = testSettings({ sandboxBackend: "modal", modalEnvironment: "main" });

    const built = await modalProvider.buildImmutableImage!({
      settings,
      session,
      requestId,
      timeoutMs: 123_456,
    });

    expect(sandboxes.fromId).toHaveBeenCalledTimes(1);
    expect(snapshotFilesystem).toHaveBeenCalledTimes(1);
    expect(snapshotFilesystem.mock.calls[0]?.[0]).toEqual({
      snapshotId: requestId,
      timeoutMs: 123_456,
      ttlMs: null,
    });
    expect(detach).toHaveBeenCalledTimes(1);
    expect(built).toEqual({
      provider: "modal",
      backend: "modal",
      imageId: IMAGE_ID,
      imageDigest: null,
      providerBindingKey: JSON.stringify({
        version: 1,
        serverUrl: "https://api.modal.com",
        workspaceName: "workspace-a",
        environment: "main",
      }),
    });
  });
});
