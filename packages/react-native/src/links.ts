import { useCallback } from "react";
import { Linking } from "react-native";
import { useNativeLinkAdapter } from "./environment";

/**
 * Open a link the person tapped: through the host's link adapter when it has
 * one (so its own conversations can open in place), else the system browser.
 * Works outside the provider too, where it always uses the browser.
 */
export function useOpenNativeLink(): (url: string) => void {
  const links = useNativeLinkAdapter();
  return useCallback(
    (url: string) => {
      if (links) links.openUrl(url);
      else void Linking.openURL(url).catch(() => undefined);
    },
    [links],
  );
}
