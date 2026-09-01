import type { StartedProcess } from "@opengeni/testing";

/** Start both framework demos as one unit and retire any partial success. */
export async function startFrameworkUiDemos(
  startReact: () => Promise<StartedProcess>,
  startSvelte: () => Promise<StartedProcess>,
): Promise<[react: StartedProcess, svelte: StartedProcess]> {
  const [react, svelte] = await Promise.allSettled([
    Promise.resolve().then(startReact),
    Promise.resolve().then(startSvelte),
  ]);
  if (react.status === "fulfilled" && svelte.status === "fulfilled") {
    return [react.value, svelte.value];
  }

  const started = [react, svelte]
    .filter(
      (result): result is PromiseFulfilledResult<StartedProcess> => result.status === "fulfilled",
    )
    .map((result) => result.value);
  await Promise.allSettled(started.map(async (process) => await process.stop()));

  const failures = [react, svelte]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(failures, "React and Svelte demo startup both failed");
}
