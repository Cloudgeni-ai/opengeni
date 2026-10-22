import { Linking } from "react-native";
import { parseAppLink } from "@/app-links";

/*
 * The one entry point for opening a tapped or handed-over link. The account
 * environment registers the in-app router (AppLinkRouting); until it does, or
 * outside it, links open in the browser.
 */

type Handler = (url: string) => void;
let handler: Handler | null = null;

export function setAppLinkHandler(next: Handler | null): void {
  handler = next;
}

export function openInBrowser(url: string): void {
  void Linking.openURL(url).catch(() => undefined);
}

/** Open a link the person tapped or the web handed over. Safe to call from anywhere. */
export function openLinkFromApp(url: string): void {
  if (handler) handler(url);
  else openInBrowser(parseAppLink(url)?.webUrl ?? url);
}
