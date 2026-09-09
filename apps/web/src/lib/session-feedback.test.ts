import { afterEach, expect, jest, mock, test } from "bun:test";
import { loadSessionFeedback } from "./session-feedback";

afterEach(() => jest.useRealTimers());
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("a failed shared ratings read recovers without a request per message", async () => {
  jest.useFakeTimers();
  const result = { feedback: [] };
  const listOwnFeedback = mock()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(result);
  const onLoaded = mock();
  const dispose = loadSessionFeedback({ listOwnFeedback }, "workspace", "session", onLoaded);
  await flush();
  expect(onLoaded).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1_000);
  await flush();
  expect(listOwnFeedback).toHaveBeenCalledTimes(2);
  expect(listOwnFeedback).toHaveBeenLastCalledWith("workspace", {
    sessionId: "session",
    includeTurns: true,
  });
  expect(onLoaded).toHaveBeenCalledWith(result);
  jest.advanceTimersByTime(60_000);
  expect(listOwnFeedback).toHaveBeenCalledTimes(2);
  dispose();
});

test("leaving the session cancels pending retries and ignores in-flight results", async () => {
  jest.useFakeTimers();
  const onLoaded = mock();
  const failedRead = mock().mockRejectedValue(new Error("offline"));
  const dispose = loadSessionFeedback(
    { listOwnFeedback: failedRead },
    "workspace",
    "old",
    onLoaded,
  );
  await flush();
  dispose();
  jest.advanceTimersByTime(60_000);
  expect(failedRead).toHaveBeenCalledTimes(1);
  let resolve!: (value: { feedback: [] }) => void;
  const pendingRead = mock(
    () =>
      new Promise<{ feedback: [] }>((done) => {
        resolve = done;
      }),
  );
  const disposePending = loadSessionFeedback(
    { listOwnFeedback: pendingRead },
    "workspace",
    "old",
    onLoaded,
  );
  disposePending();
  resolve({ feedback: [] });
  await flush();
  expect(onLoaded).not.toHaveBeenCalled();
});
