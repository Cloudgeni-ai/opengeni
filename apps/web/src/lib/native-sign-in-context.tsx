import type { NativeAppPlatform } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { createContext, useContext, type ReactNode } from "react";

/**
 * What the native app approval page needs: the signed-in person and the API.
 * It renders right after sign-in, ahead of the workspace gates, because a
 * device can be signed in before the person has any organization.
 */
export type NativeSignInContextValue = {
  client: OpenGeniBrowserClient;
  email: string;
  handleManagedSignOut: () => Promise<void>;
};
/** The app's request, as it arrives in the page URL. */
export type NativeSignInSearch = {
  redirect_uri?: string;
  code_challenge?: string;
  state?: string;
  platform?: NativeAppPlatform;
  device_name?: string;
};
const NativeSignInContext = createContext<NativeSignInContextValue | null>(null);
export function NativeSignInProvider({
  value,
  children,
}: {
  value: NativeSignInContextValue;
  children: ReactNode;
}) {
  return <NativeSignInContext.Provider value={value}>{children}</NativeSignInContext.Provider>;
}
export function useNativeSignInContext() {
  return useContext(NativeSignInContext);
}
