import type { OpenGeniClient } from "@opengeni/sdk";

/** One shared read per session, with recovery after a transient network failure. */
export function loadSessionFeedback(
  client: Pick<OpenGeniClient, "listOwnFeedback">,
  workspaceId: string,
  sessionId: string,
  onLoaded: (result: Awaited<ReturnType<OpenGeniClient["listOwnFeedback"]>>) => void,
): () => void {
  let current = true;
  let delay = 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const load = () => {
    void client.listOwnFeedback(workspaceId, { sessionId, includeTurns: true }).then(
      (result) => {
        if (current) onLoaded(result);
      },
      () => {
        if (!current) return;
        timer = setTimeout(load, delay);
        delay = Math.min(delay * 2, 30_000);
      },
    );
  };
  load();
  return () => {
    current = false;
    clearTimeout(timer);
  };
}
