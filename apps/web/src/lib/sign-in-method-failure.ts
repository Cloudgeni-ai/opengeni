import { ApiError } from "@/api";
import { SIGN_IN_METHOD_ORIGIN_MESSAGE } from "./sign-in-method-origin";

export function signInMethodFailure(error: unknown): {
  kind: "identity_changed" | "reauth" | "rejected" | "unknown";
  message: string;
} {
  if (!(error instanceof ApiError) || error.outcomeUnknown || error.status >= 500) {
    return {
      kind: "unknown",
      message:
        "The result of this change is unknown. Cancel any open dialog, then retry the same request or refresh to check your methods. Don't submit a new change yet.",
    };
  }
  if (error.details?.code === "SIGN_IN_METHOD_SAME_ORIGIN_REQUIRED") {
    return { kind: "rejected", message: SIGN_IN_METHOD_ORIGIN_MESSAGE };
  }
  if (error.code?.startsWith("PASSKEY_")) {
    return { kind: "rejected", message: error.message };
  }
  const code = error.code?.toUpperCase().replace(/^SIGN_IN_METHOD_/, "");
  if (code === "IDENTITY_CHANGED")
    return {
      kind: "identity_changed",
      message:
        "The signed-in account changed in this browser. Sign in again with the account whose methods you intended to manage. No new change will be submitted from this page.",
    };
  if (error.status === 401 || code === "REAUTHENTICATION_REQUIRED") {
    return {
      kind: "reauth",
      message:
        "Sign in again with an existing method, then review and retry this change. If this dialog is open, cancel it to continue.",
    };
  }
  const messages: Record<string, string> = {
    EMAIL_NOT_VERIFIED:
      "Verify your Opengeni account email before changing sign-in methods, then refresh this page.",
    LAST_USABLE_METHOD:
      "You can't remove your last usable sign-in method. Connect another method or set a password first.",
    CURRENT_PASSWORD_REQUIRED:
      "Enter your current password to change it. If you've forgotten it, use the password-reset option on the sign-in screen.",
    REVISION_CONFLICT:
      "Your sign-in methods changed. Cancel any open dialog and refresh before making another change.",
    PASSWORD_CHANGED:
      "Your password changed during this request. Sign in again with your current password before trying another change.",
    ACCOUNT_COLLISION:
      "This provider account is connected to another Opengeni account. Use a different provider account; accounts are not merged.",
    ALREADY_CONNECTED:
      "This sign-in provider is already connected. Refresh to see your current methods.",
    NOT_CONNECTED:
      "This sign-in provider is no longer connected. Refresh to see your current methods.",
    EXPLICIT_RECONNECT_REQUIRED:
      "This method was explicitly disconnected. Refresh, then choose Reconnect here to authorize it again.",
    PASSKEY_LIMIT:
      "Your account has the most passkeys it can hold. Remove one before adding another.",
    RATE_LIMITED: "Too many sign-in method attempts. Wait a minute, then try again.",
  };
  return {
    kind: code === "PASSWORD_CHANGED" ? "reauth" : "rejected",
    message:
      messages[code ?? ""] ??
      (error.status === 409
        ? messages.REVISION_CONFLICT!
        : "The sign-in change was not accepted. Refresh your methods and try again."),
  };
}
