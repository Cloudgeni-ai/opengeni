import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { DesktopSystemAudioError } from "../src/contract";
import { DESKTOP_IPC } from "../src/contract";
import {
  handleSystemAudioIpc,
  SystemAudioCaptures,
  systemAudioHelperName,
  systemAudioSupported,
  type SystemAudioTarget,
} from "../src/main/system-audio";

const fake = join(import.meta.dirname, "fixtures", "fake-audio-capture.ts");

class Page implements SystemAudioTarget {
  readonly samples: Float32Array[] = [];
  ended: { error: DesktopSystemAudioError | null } | null = null;
  private endedListeners: Array<() => void> = [];
  constructor(readonly id: number) {}
  isDestroyed() {
    return false;
  }
  send(channel: string, _captureId: unknown, payload: unknown) {
    if (channel === "samples") this.samples.push(payload as Float32Array);
    if (channel === "ended") {
      this.ended = { error: payload as DesktopSystemAudioError | null };
      for (const listener of this.endedListeners) listener();
    }
  }
  whenEnded(): Promise<void> {
    return this.ended
      ? Promise.resolve()
      : new Promise((resolve) => this.endedListeners.push(resolve));
  }
}

function captures(mode = "ok", startTimeoutMs?: number) {
  process.env.FAKE_CAPTURE_MODE = mode;
  return new SystemAudioCaptures({
    helperPath: process.execPath,
    helperArgs: [fake],
    excludePid: 4242,
    excludeBundlePrefix: "com.example.app",
    channels: { samples: "samples", ended: "ended" },
    platform: "linux",
    osRelease: "6.8.0",
    ...(startTimeoutMs === undefined ? {} : { startTimeoutMs }),
  });
}

describe("system audio", () => {
  test("versions with a capture API", () => {
    expect(systemAudioSupported("darwin", "23.2.0")).toBe(true);
    expect(systemAudioSupported("darwin", "25.0.0")).toBe(true);
    expect(systemAudioSupported("darwin", "23.1.0")).toBe(false);
    expect(systemAudioSupported("darwin", "22.6.0")).toBe(false);
    expect(systemAudioSupported("win32", "10.0.19041")).toBe(true);
    expect(systemAudioSupported("win32", "10.0.26100")).toBe(true);
    expect(systemAudioSupported("win32", "10.0.18363")).toBe(false);
    expect(systemAudioSupported("linux", "6.8.0")).toBe(true);
  });

  test("forwards every sample in order, then reports a clean stop", async () => {
    const audio = captures();
    const page = new Page(1);
    const started = await audio.start(page);
    expect(started.sampleRate).toBe(1000);
    await Bun.sleep(200);
    audio.stop(started.captureId, page);
    await page.whenEnded();
    expect(page.ended?.error).toBeNull();
    const all = page.samples.flatMap((batch) => [...batch]);
    expect(all).toHaveLength(250);
    expect(all[0]).toBe(0);
    expect(all[249]).toBeCloseTo(0.249, 5);
    // Batches of at least a tenth of a second, the rest when the capture ends.
    for (const batch of page.samples.slice(0, -1)) expect(batch.length).toBeGreaterThanOrEqual(100);
  });

  test("a helper error rejects the start with the app's plain sentence", async () => {
    const audio = captures("error");
    const page = new Page(2);
    const error = await audio.start(page).catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "permission_denied",
      detail: "denied",
    });
    expect((error as DesktopSystemAudioError).message).toContain("System Settings");
  });

  test("a helper that dies before starting rejects as a failed capture", async () => {
    const audio = captures("crash");
    const error = await audio.start(new Page(3)).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "capture_failed" });
  });

  test("a helper that doesn't start in time rejects as a failed capture", async () => {
    const audio = captures("slow", 100);
    const error = await audio.start(new Page(7)).catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "capture_failed",
      detail: "The helper did not start in time.",
    });
  });

  test("while the OS asks the person, the start waits for their answer", async () => {
    const audio = captures("ask", 100);
    const page = new Page(8);
    const started = await audio.start(page);
    expect(started.sampleRate).toBe(1000);
    audio.stop(started.captureId, page);
    await page.whenEnded();
    expect(page.ended?.error).toBeNull();
  });

  test("turned down in the OS prompt, the start rejects as not allowed", async () => {
    const audio = captures("ask-denied", 100);
    const error = await audio.start(new Page(9)).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "permission_denied" });
  });

  test("unavailable without a helper", async () => {
    const audio = new SystemAudioCaptures({
      helperPath: null,
      excludePid: 1,
      excludeBundlePrefix: "x",
      channels: { samples: "samples", ended: "ended" },
    });
    expect(audio.available()).toBe(false);
    expect(await audio.start(new Page(4)).catch((reason: unknown) => reason)).toMatchObject({
      code: "unavailable",
    });
  });

  test("starting again on the same page ends the first capture", async () => {
    const audio = captures();
    const page = new Page(5);
    const first = await audio.start(page);
    const second = await audio.start(page);
    expect(second.captureId).not.toBe(first.captureId);
    audio.stopFor(page);
    await Bun.sleep(300);
  });

  test("answers the preload for allowed pages only, and ends a capture when its page leaves", async () => {
    expect(systemAudioHelperName("win32")).toBe("opengeni-audio-capture.exe");
    expect(systemAudioHelperName("darwin")).toBe("opengeni-audio-capture");
    const audio = captures();
    type Listener = (event: unknown, ...args: unknown[]) => unknown;
    const handlers = new Map<string, Listener>();
    handleSystemAudioIpc({
      ipcMain: {
        handle: (channel: string, listener: Listener) => {
          handlers.set(channel, listener);
        },
      } as never,
      captures: audio,
      allow: (event) => {
        if ((event as { trusted?: boolean }).trusted !== true) throw new Error("Not allowed");
      },
    });
    const listeners = new Map<string, (details?: unknown) => void>();
    const page = Object.assign(new Page(6), {
      once: (name: string, listener: () => void) => listeners.set(name, listener),
      on: (name: string, listener: (details?: unknown) => void) => listeners.set(name, listener),
    });
    const start = handlers.get(DESKTOP_IPC.systemAudioStart)!;
    await expect(start({ trusted: false, sender: page })).rejects.toThrow("Not allowed");
    const started = (await start({ trusted: true, sender: page })) as { ok: boolean };
    expect(started.ok).toBe(true);
    // A same-document navigation keeps it; leaving the page ends it.
    listeners.get("did-start-navigation")!({ isMainFrame: true, isSameDocument: true });
    await Bun.sleep(100);
    expect(page.ended).toBeNull();
    listeners.get("did-start-navigation")!({ isMainFrame: true, isSameDocument: false });
    await page.whenEnded();
    expect(page.ended?.error).toBeNull();
  });
});
