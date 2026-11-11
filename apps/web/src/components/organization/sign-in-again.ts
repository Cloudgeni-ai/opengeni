import { useBrowserAccounts } from "@opengeni/react/accounts";
import { useAppContext } from "@opengeni/react/app/app-context";
import { useCallback } from "react";

import { useBrowserAccountPopup } from "@/components/use-browser-account-popup";

/**
 * Signs the person in again for an action that needs a recent sign-in, the
 * way Personal settings > Security does. Call it from the click itself, so a
 * sign-in window keeps the click's permission to open. `onSignedIn` runs once
 * the sign-in settled (completed or cancelled); `onError` when it couldn't
 * start.
 */
export type SignInAgain = (onSignedIn: () => void, onError: (message: string) => void) => void;

/** With browser accounts: re-authenticates the selected account in a sign-in window. */
export function useBrowserAccountSignInAgain(): SignInAgain {
  const accounts = useBrowserAccounts();
  const popup = useBrowserAccountPopup();
  const { revalidatePrincipalAccess } = useAppContext();
  return useCallback(
    (onSignedIn, onError) => {
      const slotId = accounts.projection?.selectedSlotId;
      if (!slotId) {
        onError("Select your account, then try again.");
        return;
      }
      popup.open(() => accounts.beginReauth(slotId), {
        onError: () => onError("Couldn't open sign-in. Allow popups for Opengeni and try again."),
        onSettled: () => {
          revalidatePrincipalAccess();
          onSignedIn();
        },
      });
    },
    [accounts, popup, revalidatePrincipalAccess],
  );
}

/** Without browser accounts: signs out, then comes back here to sign in. */
export function useSignOutSignInAgain(): SignInAgain {
  const { handleManagedSignOut } = useAppContext();
  return useCallback(
    (_onSignedIn, onError) => {
      const returnPath = `${window.location.pathname}${window.location.search}`;
      void handleManagedSignOut()
        .then(() => window.location.assign(returnPath))
        .catch(() => onError("Couldn't sign out. Try again."));
    },
    [handleManagedSignOut],
  );
}
