import type { Settings } from "@opengeni/config";
import { ModalImageSelector } from "@openai/agents-extensions/sandbox/modal";
import type { ModalCreateImagePreparation } from "./modal-create-boundary";

type ModalModule = typeof import("modal");

// --- Modal provider-native / private-registry image resolution --------------------
//
// OPENGENI_MODAL_IMAGE_ID is the preferred immutable provider-native path. The
// Agents extension resolves it with ModalImageSelector.fromId and serializes the
// actual imageId into the session state, while modalImageRef remains the logical
// digest persisted on the Opengeni lease.
//
// The Agents-extension Modal backend resolves `modalImageRef` via
// `Image.fromRegistry(tag)` with NO secret, so it can only pull PUBLIC images. To run
// a PRIVATE image we resolve the named Modal Secret and pre-build the authenticated
// `fromRegistry(tag, secret)` image ONCE per process, then hand the provider `build`
// a `ModalImageSelector.fromImage(...)`. `build` is synchronous and modal is imported
// lazily (never loaded for non-modal backends), so resolution can't happen inside
// `build`; the worker awaits `ensureModalRegistryImage` at boot for global refs and

// images are lazy, workspace-scoped definitions, so an image built by this module's
// client is usable by the ModalSandboxClient's own client.

/** Loader seam so unit tests can inject a fake modal module. */
export type ModalModuleLoader = () => Promise<Pick<ModalModule, "ModalClient">>;

const defaultModalLoader: ModalModuleLoader = () => import("modal");

/** Settled, synchronously-readable resolved images, keyed per config. */
const resolvedRegistryImages = new Map<string, unknown>();
let preparedRegistryImages = new WeakMap<object, Readonly<{ imageRef: string; imageId: string }>>();

/** Only native results of the authenticated registry preparation below enter
 * this map. Copied image IDs, settings strings and arbitrary Image objects do
 * not supply registry provenance. */
export function readCanonicalModalRegistryPreparation(
  image: unknown,
): Readonly<{ imageRef: string; imageId: string }> | undefined {
  return image !== null && typeof image === "object"
    ? preparedRegistryImages.get(image)
    : undefined;
}

/** The actual native selector path, shared by production physical creation and
 * its focused tests. Preparation finishes before the create wire boundary. */
export async function prepareCanonicalModalCreateImage(
  modal: Pick<InstanceType<ModalModule["ModalClient"]>, "images">,
  app: Awaited<ReturnType<InstanceType<ModalModule["ModalClient"]>["apps"]["fromName"]>>,
  selector: ModalImageSelector,
): Promise<{ image: import("modal").Image; preparation: ModalCreateImagePreparation }> {
  let image: import("modal").Image;
  if (selector.kind === "image") image = selector.value as import("modal").Image;
  else if (typeof selector.value !== "string" || !selector.value.trim())
    throw new Error("Modal image identity must be non-empty");
  else if (selector.kind === "id") image = await modal.images.fromId(selector.value);
  else if (selector.kind === "tag") image = modal.images.fromRegistry(selector.value);
  else throw new Error("Unsupported Modal image selector");
  if (typeof image?.build !== "function")
    throw new Error("Modal image selector requires a native Image");
  const registryPreparation = readCanonicalModalRegistryPreparation(image);
  const builtImage = await image.build(app);
  if (!builtImage.imageId?.startsWith("im-"))
    throw new Error("Modal image preparation returned no immutable image identity");
  const preparation: ModalCreateImagePreparation =
    selector.kind === "tag"
      ? { kind: "registry-import", imageRef: selector.value as string, imageId: builtImage.imageId }
      : selector.kind === "image" && registryPreparation?.imageId === builtImage.imageId
        ? { kind: "registry-import", ...registryPreparation }
        : {
            kind: selector.kind === "id" ? "provider-image-id" : "unqualified-image",
            imageId: builtImage.imageId,
          };
  return { image: builtImage, preparation };
}
/** In-flight resolutions, for cross-call de-duplication. */
const inFlightRegistryImages = new Map<string, Promise<void>>();
const MODAL_AUTHENTICATED_REGISTRY_LABEL = "LABEL io.opengeni.registry-import=authenticated";

function registryImageCacheKey(settings: Settings): string {
  return [
    settings.modalImageRef ?? "",
    settings.modalImageRegistrySecret ?? "",
    settings.modalEnvironment ?? "",
  ].join("|");
}

export async function ensureModalRegistryImage(
  settings: Settings,
  loadModal: ModalModuleLoader = defaultModalLoader,
): Promise<void> {
  // A provider-native immutable image ID bypasses registry import entirely.
  // ModalImageSelector.fromId resolves it during sandbox creation and the
  // provider session state records that exact ID.
  if (settings.modalImageId) {
    return;
  }
  if (!settings.modalImageRegistrySecret || !settings.modalImageRef) {
    return;
  }
  const key = registryImageCacheKey(settings);
  if (resolvedRegistryImages.has(key)) {
    return;
  }
  let pending = inFlightRegistryImages.get(key);
  if (!pending) {
    pending = (async () => {
      const modal = await loadModal();
      const client = new modal.ModalClient(modalClientOptions(settings));
      // Resolve the Secret via the AUTHENTICATED client (client.secrets.fromName),
      // NOT the static `modal.Secret.fromName`, which resolves against
      // `getDefaultClient()` — i.e. the standard MODAL_TOKEN_ID/MODAL_TOKEN_SECRET env
      // or ~/.modal.toml — and so would throw "Profile is missing token_id" in any host
      // that supplies the token only through Opengeni settings (OPENGENI_MODAL_TOKEN_ID).
      const secret = await client.secrets.fromName(
        settings.modalImageRegistrySecret!,
        settings.modalEnvironment ? { environment: settings.modalEnvironment } : undefined,
      );
      // fromRegistry is synchronous and returns a lazy image definition. Build it
      // here with the same authenticated client that resolved the registry Secret.
      // Passing the lazy definition into ModalSandboxClient crosses a ModalClient
      // boundary and makes every sandbox creation hydrate/import it again; registry
      // auth can then be lost and failed imports become sticky image builds. A built
      // provider-native Image is immutable, reusable, and contains no registry
      // credential boundary for the sandbox client to reconstruct.
      const app = await client.apps.fromName(settings.modalAppName, {
        ...(settings.modalEnvironment ? { environment: settings.modalEnvironment } : {}),
        createIfMissing: true,
      });
      const registryImage = (forceBuild: boolean) =>
        client.images
          .fromRegistry(settings.modalImageRef!, secret)
          .dockerfileCommands([MODAL_AUTHENTICATED_REGISTRY_LABEL], {
            ...(forceBuild ? { forceBuild: true } : {}),
          });
      let builtImage;
      try {
        builtImage = await registryImage(false).build(app);
      } catch {
        // Modal memoizes registry-import failures by image definition. A
        // corrected/rotated Secret would otherwise receive the same stale
        // failed Image forever. Retry exactly once with the same deterministic
        // definition and Modal's explicit force-build bit; successful imports
        // remain cached normally on later worker starts.
        builtImage = await registryImage(true).build(app);
      }
      if (
        !builtImage ||
        typeof builtImage.imageId !== "string" ||
        !builtImage.imageId.startsWith("im-")
      )
        throw new Error("Modal registry preparation returned no immutable image identity");
      preparedRegistryImages.set(
        builtImage,
        Object.freeze({ imageRef: settings.modalImageRef!, imageId: builtImage.imageId }),
      );
      resolvedRegistryImages.set(key, builtImage);
    })().finally(() => {
      inFlightRegistryImages.delete(key);
    });
    inFlightRegistryImages.set(key, pending);
  }
  await pending;
}

/** The resolved private-registry image for these settings, or undefined if none. */
function cachedModalRegistryImage(settings: Settings): unknown | undefined {
  if (!settings.modalImageRegistrySecret || !settings.modalImageRef) {
    return undefined;
  }
  return resolvedRegistryImages.get(registryImageCacheKey(settings));
}

/**
 * Choose the image selector for a Modal sandbox client from settings. Returns:
 *  - `fromId(modalImageId)` when a provider-native immutable ID is configured;
 *  - `fromImage(resolved)` when a private-registry secret is configured AND the
 *    image has been resolved (ensureModalRegistryImage ran before create);
 *  - `fromTag(modalImageRef)` for the public path (no secret, or cold cache — the
 *    resume/attach paths never pull an image so the tag branch is harmless there);
 *  - `undefined` when no image ref is set (Modal uses its default image).
 * Exported for unit tests.
 */
export function resolveModalImageSelector(settings: Settings): ModalImageSelector | undefined {
  if (settings.modalImageId) {
    return ModalImageSelector.fromId(settings.modalImageId);
  }
  if (!settings.modalImageRef) {
    return undefined;
  }
  const registryImage = cachedModalRegistryImage(settings);
  return registryImage
    ? ModalImageSelector.fromImage(
        registryImage as Parameters<typeof ModalImageSelector.fromImage>[0],
      )
    : ModalImageSelector.fromTag(settings.modalImageRef);
}

/** Test-only: clear the resolved/in-flight image caches. */
export function __resetModalRegistryImageCacheForTest(): void {
  resolvedRegistryImages.clear();
  inFlightRegistryImages.clear();
  preparedRegistryImages = new WeakMap();
}

function modalClientOptions(
  settings: Settings,
): ConstructorParameters<ModalModule["ModalClient"]>[0] {
  return {
    ...(settings.modalTokenId ? { tokenId: settings.modalTokenId } : {}),
    ...(settings.modalTokenSecret ? { tokenSecret: settings.modalTokenSecret } : {}),
    ...(settings.modalEnvironment ? { environment: settings.modalEnvironment } : {}),
  };
}
