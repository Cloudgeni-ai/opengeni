import { describe, expect, test } from "bun:test";

import {
  decideVoiceDeployment,
  VOICE_RELOADING_MESSAGE,
  voiceRelaunchUrl,
  withVoiceDeploymentGuard,
  type VoiceDeploymentDecision,
} from "./voice-deployment-guard";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const current = {
  bundleRevision: "rev-a",
  serverRevision: "rev-a",
  bundleContract: "contract-1",
  serverContract: "contract-1",
};

describe("live voice deployment guard", () => {
  test("starts on the current build and reloads a stale one exactly once", () => {
    const storage = memoryStorage();
    expect(decideVoiceDeployment(current, { reloadBlocked: false, storage })).toBe("current");
    const deployed = { ...current, serverRevision: "rev-b" };
    expect(decideVoiceDeployment(deployed, { reloadBlocked: false, storage })).toBe("reload");
    // Still stale after the reload (for example a CDN lag): start rather than loop.
    expect(decideVoiceDeployment(deployed, { reloadBlocked: false, storage })).toBe("current");
    // An API contract change alone is also a stale bundle.
    expect(
      decideVoiceDeployment(
        { ...current, serverContract: "contract-2" },
        { reloadBlocked: false, storage },
      ),
    ).toBe("reload");
    // Local builds without a revision only compare the contract.
    expect(
      decideVoiceDeployment(
        { ...current, bundleRevision: "", serverRevision: "rev-b" },
        { reloadBlocked: false, storage: memoryStorage() },
      ),
    ).toBe("current");
  });

  test("prompts instead of reloading over other work, without consuming the reload", () => {
    const storage = memoryStorage();
    const deployed = { ...current, serverRevision: "rev-b" };
    expect(decideVoiceDeployment(deployed, { reloadBlocked: true, storage })).toBe("prompt");
    expect(decideVoiceDeployment(deployed, { reloadBlocked: false, storage })).toBe("reload");
  });

  test("relaunches with the voice model so voice resumes after reload", () => {
    expect(voiceRelaunchUrl("https://app.example.test/w/1/sessions/2?find=x", "m/1")).toBe(
      "https://app.example.test/w/1/sessions/2?find=x&realtime=m%2F1",
    );
  });

  test("the wrapped client reloads before begin on a stale bundle and passes through otherwise", async () => {
    const begins: string[] = [];
    const relaunched: Array<string | undefined> = [];
    let prompts = 0;
    let decision: VoiceDeploymentDecision = "reload";
    const client = {
      label: "client",
      async beginSessionRealtime(_w: string, _s: string, request: { model: string }) {
        begins.push(`${this.label}:${request.model}`);
        return { ok: true };
      },
      other() {
        return this.label;
      },
    };
    const guarded = withVoiceDeploymentGuard(client, {
      decide: async () => decision,
      relaunch: (model) => relaunched.push(model),
      prompt: () => {
        prompts += 1;
      },
    });
    await expect(guarded.beginSessionRealtime("w", "s", { model: "voice" })).rejects.toThrow(
      VOICE_RELOADING_MESSAGE,
    );
    expect(relaunched).toEqual(["voice"]);
    expect(begins).toEqual([]);

    decision = "prompt";
    await expect(guarded.beginSessionRealtime("w", "s", { model: "voice" })).resolves.toEqual({
      ok: true,
    });
    expect(prompts).toBe(1);

    decision = "current";
    await guarded.beginSessionRealtime("w", "s", { model: "voice" });
    expect(begins).toEqual(["client:voice", "client:voice"]);
    expect(guarded.other()).toBe("client");
  });

  test("a later begin for a call already running here is never reloaded (for example End)", async () => {
    let decisions = 0;
    const relaunched: Array<string | undefined> = [];
    const guarded = withVoiceDeploymentGuard(
      {
        async beginSessionRealtime(
          _w: string,
          _s: string,
          _r: { model: string; operationId: string },
        ) {
          return { ok: true };
        },
      },
      {
        decide: async () => {
          decisions += 1;
          return decisions === 1 ? "current" : "reload";
        },
        relaunch: (model) => relaunched.push(model),
        prompt: () => undefined,
      },
    );
    await guarded.beginSessionRealtime("w", "s", { model: "voice", operationId: "op-1" });
    // The deployment changes mid-call; reconciling the same operation passes through.
    await guarded.beginSessionRealtime("w", "s", { model: "voice", operationId: "op-1" });
    expect(decisions).toBe(1);
    expect(relaunched).toEqual([]);
    // A new call is checked again.
    await expect(
      guarded.beginSessionRealtime("w", "s", { model: "voice", operationId: "op-2" }),
    ).rejects.toThrow(VOICE_RELOADING_MESSAGE);
  });

  test("a failed deployment check never blocks voice", async () => {
    let begun = false;
    const guarded = withVoiceDeploymentGuard(
      {
        async beginSessionRealtime() {
          begun = true;
        },
      },
      {
        decide: async () => {
          throw new Error("offline");
        },
        relaunch: () => undefined,
        prompt: () => undefined,
      },
    );
    await guarded.beginSessionRealtime();
    expect(begun).toBe(true);
  });
});
