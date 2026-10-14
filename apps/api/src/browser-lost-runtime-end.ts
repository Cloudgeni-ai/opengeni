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

function isPreservedLostBrowserRuntime(error: unknown): boolean {
  return (
    error instanceof BrowserControlRequestError &&
    error.status === 409 &&
    error.error.code === "resource_unavailable" &&
    !error.retryable
  );
}
