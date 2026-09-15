import { ApiError } from "@/api";

export function signInMethodFailure(error: unknown): {
  kind: "reauth" | "rejected" | "unknown";
  message: string;
} {
  if (!(error instanceof ApiError) || error.outcomeUnknown || error.status >= 500) {
    return {
      kind: "unknown",
      message:
        "The result of this change is unknown. Cancel any open dialog, then retry the same request or refresh to check your methods. Don't submit a new change yet.",
    };
  }
  const code = error.code?.toUpperCase().replace(/^SIGN_IN_METHOD_/, "");
  if (error.status === 401 || code === "REAUTHENTICATION_REQUIRED") {
    return {
      kind: "reauth",
      message:
        "Sign in again with an existing method, then review and retry this change. If this dialog is open, cancel it to continue.",
    };
  }
  const messages: Record<string, string> = {
    EMAIL_NOT_VERIFIED:
      "Verify your OpenGeni account email before changing sign-in methods, then refresh this page.",
    LAST_USABLE_METHOD:
      "You can't remove your last usable sign-in method. Connect another method or set a password first.",
    CURRENT_PASSWORD_REQUIRED:
      "Enter your current password to change it. If you've forgotten it, use the password-reset option on the sign-in screen.",
    REVISION_CONFLICT:
      "Your sign-in methods changed. Cancel any open dialog and refresh before making another change.",
    PASSWORD_CHANGED:
      "Your password changed during this request. Sign in again with your current password before trying another change.",
    ACCOUNT_COLLISION:
      "This provider account is connected to another OpenGeni account. Use a different provider account; accounts are not merged.",
    ALREADY_CONNECTED:
      "This sign-in provider is already connected. Refresh to see your current methods.",
    NOT_CONNECTED:
      "This sign-in provider is no longer connected. Refresh to see your current methods.",
    EXPLICIT_RECONNECT_REQUIRED:
      "This method was explicitly disconnected. Refresh, then choose Reconnect here to authorize it again.",
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
