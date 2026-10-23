import { appHost } from "../lib/app-host";
import { startProblem } from "../lib/start-error";

/** The whole-window state when the app can't load: what happened and the one thing to do. */
export function StartProblem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const problem = startProblem(error);
  // Outside the Mac app there is no sign-in window to go back to; reloading signs in again.
  const signIn = problem.signIn && appHost !== null;
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div>
        <p className="text-lg font-medium text-[var(--app-fg)]">{problem.title}</p>
        <p className="mt-1 max-w-md text-sm text-[var(--app-muted)]">{problem.message}</p>
        <button
          type="button"
          className="mt-4 rounded-full bg-[var(--app-accent)] px-4 py-2 text-sm font-medium text-white"
          onClick={() => (signIn ? appHost?.signInAgain() : onRetry())}
        >
          {signIn ? "Sign in" : "Try again"}
        </button>
      </div>
    </div>
  );
}
