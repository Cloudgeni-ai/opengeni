/* ----------------------------------------------------------------------------
   A poll interval change is not a new query. When live hints take over from
   polling (or polling resumes), the read in flight must finish undisturbed:
   no aborted request and no duplicate read, only a rescheduled poll.
   -------------------------------------------------------------------------- */
import { expect, test } from "bun:test";
import { usePolledValue } from "../src/hooks/internal";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom({ clock: "virtual" });

type Read = { signal: AbortSignal | undefined; finish: (value: number) => void };

function controlledLoader() {
  const reads: Read[] = [];
  const load = (signal?: AbortSignal) =>
    new Promise<number>((resolve) => {
      reads.push({ signal, finish: resolve });
    });
  return { reads, load };
}

test("dropping the poll interval during the first read keeps that read and stops polling", async () => {
  const { reads, load } = controlledLoader();
  const hook = await renderHook(
    ({ pollIntervalMs }: { pollIntervalMs: number | undefined }) =>
      usePolledValue(load, { pollIntervalMs }),
    { pollIntervalMs: 15_000 as number | undefined },
  );
  try {
    expect(reads).toHaveLength(1);
    await hook.rerender({ pollIntervalMs: undefined });
    expect(reads).toHaveLength(1);
    expect(reads[0]!.signal?.aborted).toBe(false);
    await actRun(() => reads[0]!.finish(1));
    await flush();
    expect(hook.result.current.data).toBe(1);
    expect(hook.result.current.loading).toBe(false);
    await flush(60_000);
    expect(reads).toHaveLength(1);
  } finally {
    for (const read of reads) read.finish(0);
    await hook.unmount();
  }
});

test("starting to poll after the first read schedules the next read one interval later", async () => {
  const { reads, load } = controlledLoader();
  const hook = await renderHook(
    ({ pollIntervalMs }: { pollIntervalMs: number | undefined }) =>
      usePolledValue(load, { pollIntervalMs }),
    { pollIntervalMs: undefined as number | undefined },
  );
  try {
    await actRun(() => reads[0]!.finish(1));
    await flush();
    expect(hook.result.current.data).toBe(1);
    await hook.rerender({ pollIntervalMs: 1_000 });
    expect(reads).toHaveLength(1);
    await flush(1_000);
    expect(reads).toHaveLength(2);
    await actRun(() => reads[1]!.finish(2));
    await flush();
    expect(hook.result.current.data).toBe(2);
    await flush(1_000);
    expect(reads).toHaveLength(3);
  } finally {
    for (const read of reads) read.finish(0);
    await hook.unmount();
  }
});

test("changing the interval while a read is in flight waits for it before the next poll", async () => {
  const { reads, load } = controlledLoader();
  const hook = await renderHook(
    ({ pollIntervalMs }: { pollIntervalMs: number | undefined }) =>
      usePolledValue(load, { pollIntervalMs }),
    { pollIntervalMs: 15_000 as number | undefined },
  );
  try {
    await hook.rerender({ pollIntervalMs: 1_000 });
    expect(reads).toHaveLength(1);
    expect(reads[0]!.signal?.aborted).toBe(false);
    await flush(5_000);
    expect(reads).toHaveLength(1);
    await actRun(() => reads[0]!.finish(1));
    await flush(1_000);
    expect(hook.result.current.data).toBe(1);
    expect(reads).toHaveLength(2);
  } finally {
    for (const read of reads) read.finish(0);
    await hook.unmount();
  }
});

test("ending the query still aborts the read in flight", async () => {
  const { reads, load } = controlledLoader();
  const hook = await renderHook(
    ({ enabled }: { enabled: boolean }) =>
      usePolledValue(load, { pollIntervalMs: 15_000, enabled }),
    { enabled: true },
  );
  try {
    expect(reads).toHaveLength(1);
    await hook.rerender({ enabled: false });
    expect(reads[0]!.signal?.aborted).toBe(true);
  } finally {
    for (const read of reads) read.finish(0);
    await hook.unmount();
  }
});
