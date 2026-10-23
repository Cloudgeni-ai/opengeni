// What the app says when it can't load: one plain sentence and what to do.
// Raw server text never shows; it rarely means anything to the person.

export type StartProblem = {
  title: string;
  message: string;
  /** Signing in (again, or as someone else) is what fixes it. */
  signIn: boolean;
  /** Signing in as someone else is a way out, next to Try again. */
  otherAccount?: true;
};

/** The signed-in account has no workspace to open. */
export class NoWorkspaceError extends Error {
  constructor() {
    super("No workspace is available for this account.");
  }
}

export function startProblem(error: unknown): StartProblem {
  if (error instanceof NoWorkspaceError) {
    return {
      title: "No workspace yet",
      message: "This account isn't part of an Opengeni workspace. Sign in with another account.",
      signIn: true,
    };
  }
  const status =
    error && typeof error === "object" && "status" in error && typeof error.status === "number"
      ? error.status
      : null;
  if (status === 401) {
    return {
      title: "Sign in again",
      message: "Your sign-in has expired or was signed out elsewhere.",
      signIn: true,
    };
  }
  // Signed in fine, just not allowed: signing in again would change nothing.
  if (status === 403) {
    return {
      title: "No access",
      message: "This account can't use agents in this workspace. Ask a workspace admin.",
      signIn: false,
      otherAccount: true,
    };
  }
  if (status === null) {
    return {
      title: "Opengeni can't be reached",
      message: "Check your internet connection and try again.",
      signIn: false,
    };
  }
  return {
    title: "Couldn't open your agents",
    message: "Opengeni is having trouble right now. Try again in a moment.",
    signIn: false,
  };
}
