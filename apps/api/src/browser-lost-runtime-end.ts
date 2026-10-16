import { BrowserControlRequestError, type BrowserControlClient } from "@opengeni/runtime/sandbox";

type BrowserEndClient = Pick<BrowserControlClient, "endSession">;

/** A person ending a browser. When the browser's controller lost the running
 * browser (it restarted, or the runtime vanished) it preserves the working
 * runtime and refuses a plain end; the person's explicit end then discards
 * it. Cleanup after a failed or expired resume never takes this path, so a
 * possibly accepted launch stays preserved there. Controllers older than the
 * discard flag reject it as an unknown field and keep their original refusal. */
export async function endBrowserDiscardingLostRuntime(
  client: BrowserEndClient,
  reference: { browserSessionId: string; controllerGeneration: string },
): Promise<void> {
  try {
    await client.endSession(reference, { removeState: true });
    return;
  } catch (error) {
    if (!isPreservedLostBrowserRuntime(error)) throw error;
    try {
      await client.endSession(reference, { removeState: true, discardWorkingRuntime: true });
    } catch (discardError) {
      if (discardError instanceof BrowserControlRequestError && discardError.status === 400) {
        throw error;
      }
      throw discardError;
    }
  }
}

/** Return an expired resume to its checkpoint. A plain end of the expired
 * generation succeeds when its launch provably never happened (or is already
 * gone). When the controller instead preserves an interrupted launch (one that
 * never recorded completion, so it can't be adopted), it is asked to move that
 * launch's directory aside intact; nothing is discarded, and a launch that did
 * complete, or whose profile may still be in use, keeps refusing. Controllers
 * older than the set-aside flag reject it and keep their original refusal. */
export async function endExpiredResumeSettingAsideInterruptedLaunch(
  client: BrowserEndClient,
  reference: { browserSessionId: string; controllerGeneration: string },
): Promise<void> {
  try {
    await client.endSession(reference, { removeState: true });
    return;
  } catch (error) {
    if (isMissingControllerSession(error)) return;
    if (!isPreservedLostBrowserRuntime(error)) throw error;
    try {
      await client.endSession(reference, { removeState: true, setAsideInterruptedLaunch: true });
    } catch (setAsideError) {
      if (isMissingControllerSession(setAsideError)) return;
      if (setAsideError instanceof BrowserControlRequestError && setAsideError.status === 400) {
        throw error;
      }
      throw setAsideError;
    }
  }
}

function isMissingControllerSession(error: unknown): boolean {
  return error instanceof BrowserControlRequestError && error.status === 404;
}

function isPreservedLostBrowserRuntime(error: unknown): boolean {
  return (
    error instanceof BrowserControlRequestError &&
    error.status === 409 &&
    error.error.code === "resource_unavailable" &&
    !error.retryable
  );
}
