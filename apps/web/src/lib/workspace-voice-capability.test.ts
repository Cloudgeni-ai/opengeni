import { expect, test } from "bun:test";
import type { ClientConfig } from "@opengeni/sdk";
import { startWorkspaceVoiceCapabilityRefresh } from "./workspace-voice-capability";
const config = (available: boolean) =>
  ({ voiceInput: { available, providers: [] } }) as unknown as ClientConfig;

test("workspace change retires old readiness even when the old read ignores abort", async () => {
  let resolve!: (value: ClientConfig) => void;
  const writes: unknown[] = [];
  const dispose = startWorkspaceVoiceCapabilityRefresh({
    read: () => new Promise((r) => (resolve = r)),
    ownsWorkspace: () => true,
    apply: (v) => writes.push(v),
    subscribeFocus: () => () => {},
  });
  dispose();
  resolve(config(true));
  await Promise.resolve();
  expect(writes).toEqual([]);
});

test("focus retries readiness and a stale principal cannot repopulate it", async () => {
  let owns = true,
    focus!: () => void;
  const writes: unknown[] = [];
  const pending: ((value: ClientConfig) => void)[] = [];
  const dispose = startWorkspaceVoiceCapabilityRefresh({
    read: () => new Promise((r) => pending.push(r)),
    ownsWorkspace: () => owns,
    apply: (v) => writes.push(v),
    subscribeFocus: (f) => {
      focus = f;
      return () => {};
    },
  });
  pending.shift()!(config(false));
  await Promise.resolve();
  focus();
  pending.shift()!(config(true));
  await Promise.resolve();
  expect(writes).toEqual([config(false).voiceInput, config(true).voiceInput]);
  focus();
  owns = false;
  pending.shift()!(config(true));
  await Promise.resolve();
  expect(writes).toHaveLength(2);
  dispose();
});
