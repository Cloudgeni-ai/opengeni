import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrowserDriver } from "../src";
import { ManagedBrowserRunner } from "../src/runner";
import {
  BrowserRecording,
  RECORDING_BUNDLE_MAGIC,
  type RecordingFrameSource,
} from "../src/recording";

const chromiumE2e =
  process.env.OPENGENI_BROWSERD_E2E === "1" || process.env.OPENGENI_BROWSERD_HEADED_E2E === "1"
    ? test
    : test.skip;

type Bundle = {
  header: {
    frames: { t: number; offset: number; length: number; targetId: string }[];
    actions: { kind: string; targetId: string; action?: unknown }[];
    durationMs: number;
  };
  frames: Buffer[];
};

async function readBundle(path: string): Promise<Bundle> {
  const bytes = await readFile(path);
  expect(bytes.subarray(0, RECORDING_BUNDLE_MAGIC.length).toString()).toBe(RECORDING_BUNDLE_MAGIC);
  const headerEnd = bytes.indexOf(0x0a, RECORDING_BUNDLE_MAGIC.length);
  const header = JSON.parse(
    bytes.subarray(RECORDING_BUNDLE_MAGIC.length, headerEnd).toString(),
  ) as Bundle["header"];
  const body = bytes.subarray(headerEnd + 1);
  return {
    header,
    frames: header.frames.map((frame) => body.subarray(frame.offset, frame.offset + frame.length)),
  };
}

function fakeSource() {
  const streams = new Map<string, (jpeg: Uint8Array) => void>();
  const started: string[] = [];
  const source: RecordingFrameSource = async (targetId, onFrame) => {
    started.push(targetId);
    streams.set(targetId, (jpeg) => onFrame(jpeg, Date.now()));
    return async () => {
      streams.delete(targetId);
    };
  };
  return {
    source,
    started,
    emit(targetId: string, bytes: number[]) {
      streams.get(targetId)?.(Uint8Array.from(bytes));
    },
  };
}

test("a recording keeps distinct frames, follows the agent's tab and bundles an action log", async () => {
  const directory = await mkdtemp("/tmp/ogb-recording-");
  let released = 0;
  try {
    const fake = fakeSource();
    const recording = await BrowserRecording.start({
      directory,
      targetId: "tab-a",
      source: fake.source,
      releasePresence: () => (released += 1),
    });
    fake.emit("tab-a", [1, 1, 1]);
    fake.emit("tab-a", [1, 1, 1]); // A repeated frame is dropped.
    fake.emit("tab-a", [2, 2]);
    recording.noteTarget("action", "tab-a", { action: { type: "click", ref: "e1" } });
    recording.noteTarget("open_tab", "tab-b", { url: "https://example.com/" });
    await Bun.sleep(10);
    fake.emit("tab-a", [9]); // The old tab no longer streams into the recording.
    fake.emit("tab-b", [3, 3, 3, 3]);

    const summary = await recording.stop();
    expect(summary).toMatchObject({
      state: "stopped",
      stopReason: "requested",
      frameCount: 3,
      frameBytes: 9,
      actionCount: 2,
    });
    expect(released).toBe(1);
    expect(fake.started).toEqual(["tab-a", "tab-b"]);
    expect(await recording.stop()).toEqual(summary);

    const exported = recording.exportable();
    expect(exported.sha256).toBe(summary.bundle!.sha256);
    const bundle = await readBundle(exported.path);
    expect(bundle.frames.map((frame) => [...frame])).toEqual([
      [1, 1, 1],
      [2, 2],
      [3, 3, 3, 3],
    ]);
    expect(bundle.header.frames.map((frame) => frame.targetId)).toEqual([
      "tab-a",
      "tab-a",
      "tab-b",
    ]);
    expect(bundle.header.actions).toEqual([
      expect.objectContaining({
        kind: "action",
        targetId: "tab-a",
        action: { type: "click", ref: "e1" },
      }),
      expect.objectContaining({ kind: "open_tab", targetId: "tab-b", url: "https://example.com/" }),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exporting before stop is refused", async () => {
  const directory = await mkdtemp("/tmp/ogb-recording-");
  try {
    const recording = await BrowserRecording.start({
      directory,
      targetId: "tab-a",
      source: fakeSource().source,
      releasePresence: () => undefined,
    });
    expect(() => recording.exportable()).toThrow("stop the recording");
    await recording.discard();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a bundle uploads once per object: retries join it, failures and replace upload again", async () => {
  const directory = await mkdtemp("/tmp/ogb-recording-");
  try {
    const fake = fakeSource();
    const recording = await BrowserRecording.start({
      directory,
      targetId: "tab-a",
      source: fake.source,
      releasePresence: () => undefined,
    });
    fake.emit("tab-a", [1, 2, 3]);
    expect(() => recording.transferTo("https://s/a", async () => undefined)).toThrow(
      "stop the recording",
    );
    await recording.stop();

    const uploads: string[] = [];
    let finish!: () => void;
    const slow = () =>
      new Promise<void>((resolve) => {
        uploads.push("slow");
        finish = resolve;
      });
    const first = recording.transferTo("https://s/a", slow);
    await Bun.sleep(0);
    expect(first.state).toBe("uploading");
    // A caller that gave up waiting and asks again joins the running upload.
    expect(recording.transferTo("https://s/a", slow)).toBe(first);
    expect(uploads).toEqual(["slow"]);
    finish();
    await first.done;
    expect(first.state).toBe("uploaded");
    // A finished upload to the same object is not repeated...
    expect(recording.transferTo("https://s/a", slow)).toBe(first);
    expect(uploads).toEqual(["slow"]);
    // ...unless the caller found that object gone.
    const replaced = recording.transferTo(
      "https://s/a",
      async () => {
        uploads.push("replace");
      },
      true,
    );
    await replaced.done;
    expect(replaced).not.toBe(first);
    expect(uploads).toEqual(["slow", "replace"]);

    const failing = recording.transferTo("https://s/b", async () => {
      throw new Error("network down");
    });
    await expect(failing.done).rejects.toThrow("network down");
    expect(failing.state).toBe("failed");
    // A failed upload is replaced by the next request.
    const retried = recording.transferTo("https://s/b", async () => {
      uploads.push("retry");
    });
    expect(retried).not.toBe(failing);
    await retried.done;
    expect(retried.state).toBe("uploaded");
    expect(uploads).toEqual(["slow", "replace", "retry"]);
    await recording.discard();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

chromiumE2e(
  "records a changing background tab from Chromium's screencast",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-recording-e2e-");
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: process.env.OPENGENI_BROWSERD_HEADED_E2E === "1",
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
      focusEmulation: true,
    });
    try {
      const ticking = `data:text/html,${encodeURIComponent(
        "<!doctype html><h1 id=n>0</h1><script>let n=0;setInterval(()=>{document.getElementById('n').textContent=++n},300)</script>",
      )}`;
      const recorded = await driver.start(ticking);
      // Another tab in front: the recorded tab is a background tab.
      await driver.openTarget("data:text/html,<h1>Front</h1>");
      const recording = await BrowserRecording.start({
        directory: join(directory, "recordings"),
        targetId: recorded.target.id,
        source: async (targetId, onFrame, onEnd) =>
          await driver.recordFrames(targetId, onFrame, onEnd),
        releasePresence: () => undefined,
      });
      await Bun.sleep(3_000);
      const summary = await recording.stop();
      expect(summary.streamError).toBeNull();
      expect(summary.frameCount).toBeGreaterThanOrEqual(5);
      expect(summary.frameCount).toBeLessThanOrEqual(35);
      const bundle = await readBundle(recording.exportable().path);
      for (const frame of bundle.frames) expect([...frame.subarray(0, 2)]).toEqual([0xff, 0xd8]);
      const times = bundle.header.frames.map((frame) => frame.t);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
