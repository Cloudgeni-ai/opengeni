import { router } from "expo-router";

/**
 * Back to the home screen, from wherever the stack is. An account switch can
 * already have reset the stack, so only dismiss what is there.
 */
export function dismissToHome(): void {
  if (router.canDismiss()) router.dismissAll();
}
