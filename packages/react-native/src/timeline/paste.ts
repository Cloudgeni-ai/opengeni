import { useEffect, useId, useRef } from "react";
import { Platform } from "react-native";
import type { NativePickedFile } from "../adapters";

/**
 * Image paste for the composer. React Native's iOS text views only paste
 * text; the package's native module lets inputs whose test id starts with
 * this prefix also take pasted images (screenshots, photos), which it writes
 * to temporary files and reports here as attachments.
 */
export const COMPOSER_PASTE_INPUT_PREFIX = "opengeni-composer-input";

type PastedImage = {
  uri: string;
  name: string;
  mimeType: string;
  size?: number | null;
};

type PasteModule = {
  addListener(
    eventName: "onPasteImages",
    listener: (event: { inputId: string; files: PastedImage[] }) => void,
  ): { remove(): void };
};

function pasteModule(): PasteModule | null {
  if (Platform.OS !== "ios") return null;
  const registry = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo?.modules;
  const module = registry?.OpenGeniPaste as PasteModule | undefined;
  return module && typeof module.addListener === "function" ? module : null;
}

let pasteCount = 0;

/**
 * The test id to put on a composer input so it accepts pasted images, or
 * undefined where image paste is unavailable (Android, web, or a build without
 * the native module) or the host gave no handler.
 */
export function useComposerImagePaste(
  onPasteImages: ((files: NativePickedFile[]) => void) | undefined,
): string | undefined {
  const reactId = useId();
  const handler = useRef(onPasteImages);
  handler.current = onPasteImages;
  const enabled = Boolean(onPasteImages) && pasteModule() !== null;
  const inputId = `${COMPOSER_PASTE_INPUT_PREFIX}-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`;
  useEffect(() => {
    const module = pasteModule();
    if (!enabled || !module) return;
    const subscription = module.addListener("onPasteImages", (event) => {
      if (event.inputId !== inputId || event.files.length === 0) return;
      handler.current?.(
        event.files.map((file) => ({
          id: `pasted-${Date.now()}-${(pasteCount += 1)}`,
          uri: file.uri,
          name: file.name,
          contentType: file.mimeType,
          sizeBytes: file.size ?? null,
          kind: "image" as const,
          previewUri: file.uri,
        })),
      );
    });
    return () => subscription.remove();
  }, [enabled, inputId]);
  return enabled ? inputId : undefined;
}
