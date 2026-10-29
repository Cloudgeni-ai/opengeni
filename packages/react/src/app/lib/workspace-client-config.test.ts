import { expect, test } from "bun:test";
import type { ClientConfig } from "@opengeni/sdk";
import {
  startWorkspaceClientConfigRefresh,
  withWorkspaceClientConfig,
  workspaceClientConfig,
} from "./workspace-client-config";
const config = (available: boolean) =>
  ({ voiceInput: { available, providers: [] } }) as unknown as ClientConfig;

test("workspace change retires old readiness even when the old read ignores abort", async () => {
  let resolve!: (value: ClientConfig) => void;
  const writes: unknown[] = [];
  const dispose = startWorkspaceClientConfigRefresh({
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
  const dispose = startWorkspaceClientConfigRefresh({
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
  expect(writes.map((write) => (write as ClientConfig).voiceInput)).toEqual([
    config(false).voiceInput,
    config(true).voiceInput,
  ]);
  focus();
  owns = false;
  pending.shift()!(config(true));
  await Promise.resolve();
  expect(writes).toHaveLength(2);
  dispose();
});

test("the open workspace's answer replaces the boot read's region and voice fields", () => {
  const boot = {
    ...config(true),
    defaultModel: "boot",
    inferenceFeatures: [{ id: "web_search", available: true, unavailableReason: null }],
  } as unknown as ClientConfig;
  // Until the workspace answers, voice input is off and nothing else changes.
  const waiting = withWorkspaceClientConfig(boot, undefined);
  expect(waiting.voiceInput?.available).toBe(false);
  expect(waiting.inferenceFeatures).toEqual(boot.inferenceFeatures);
  const workspace = workspaceClientConfig({
    ...config(true),
    inferenceFeatures: [
      { id: "web_search", available: false, unavailableReason: "region_restricted" },
    ],
    agentConfig: { capabilities: [{ id: "webSearch", available: false }] },
    codeSearch: { available: false, workspaceDefault: "off" },
  } as unknown as ClientConfig);
  const merged = withWorkspaceClientConfig(boot, workspace);
  expect(merged.defaultModel).toBe("boot");
  expect(merged.inferenceFeatures).toEqual(workspace.inferenceFeatures);
  expect(merged.agentConfig).toEqual(workspace.agentConfig);
  expect(merged.codeSearch).toEqual(workspace.codeSearch);
  expect(merged.voiceInput?.available).toBe(true);
});
