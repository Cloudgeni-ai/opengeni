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
const SECRET_NAME = "acr-credentials-gecko";

/** A fake modal module capturing the fromRegistry(tag, secret) call shape. */
function fakeModal() {
  const fakeImage = { imageId: "im-fake", objectId: "im-fake" };
  const fromRegistry = mock((_tag: string, _secret: unknown) => fakeImage);
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
        constructor(_opts: unknown) {}
      },
    }) as unknown as Awaited<ReturnType<ModalModuleLoader>>;
  return { loadModal, fromRegistry, secretFromName, fakeImage };
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
    const { loadModal, fromRegistry, secretFromName, fakeImage } = fakeModal();

    await ensureModalRegistryImage(settings, loadModal);

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
