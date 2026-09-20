import { managedActorTrackedResponse } from "../src/api";

document.querySelector<HTMLButtonElement>("#run")!.onclick = async () => {
  const method = new URLSearchParams(location.search).get("method") === "text" ? "text" : "json";
  const actor = new AbortController();
  const events: string[] = [];
  const source = new ReadableStream<Uint8Array>(
    {
      pull() {
        events.push("read");
      },
      cancel() {
        events.push("cancel");
      },
    },
    { highWaterMark: 0 },
  );
  const response = managedActorTrackedResponse(new Response(source), actor.signal, () =>
    events.push("cleanup"),
  );
  // Run in the page's script realm, not Playwright's evaluation realm: Gecko
  // reports synthetic Response body failures differently between those realms.
  const result = response[method]().then(
    () => ({ resolved: true }),
    (error: unknown) => ({
      name: error instanceof Error ? error.name : String(error),
    }),
  );
  setTimeout(() => {
    events.push("abort");
    actor.abort();
  }, 0);
  const outcome = await result;
  // Source cancellation releases its reader in a separate promise-finally job.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  document.querySelector("#result")!.textContent = JSON.stringify({
    outcome,
    events,
    bodyUsed: response.bodyUsed,
    sourceLocked: source.locked,
  });
};
