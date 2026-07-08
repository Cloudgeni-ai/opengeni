import { describe, expect, test } from "bun:test";
import { ScriptedModel, testSettings } from "@opengeni/testing";
import { buildManifest, buildOpenGeniAgent, runOwnedSandboxSetup } from "../src/index";
import { RoutingSandboxSession, type RoutableBackendSession } from "../src/sandbox";
import { applyManifestToProvidedSession } from "../../../node_modules/.bun/@openai+agents-core@0.11.6+4b65e697391ccbcb/node_modules/@openai/agents-core/dist/sandbox/runtime/providedSessionManifest.js";

async function manifestEnv(manifest: { resolveEnvironment?: () => Promise<Record<string, string>>; environment?: Record<string, { value?: string }> }): Promise<Record<string, string | undefined>> {
  if (manifest.resolveEnvironment) {
    return manifest.resolveEnvironment();
  }
  return Object.fromEntries(Object.entries(manifest.environment ?? {}).map(([key, value]) => [key, value.value]));
}

describe("lazy provisioning synthetic manifest", () => {
  test("SDK provided-session apply sees synthetic current === target and performs no write", async () => {
    const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
    const environment = { HOME: "/workspace", DEPLOY_TARGET: "lazy-test" };
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
    });
    const target = (agent as { defaultManifest: unknown }).defaultManifest;
    const synthetic = {
      state: { manifest: target },
      async materializeEntry() {
        throw new Error("synthetic session must not materialize an empty manifest delta");
      },
    };

    await applyManifestToProvidedSession(synthetic as never, target as never);

    expect(synthetic.state.manifest).toBe(target);
  });

  test("manifest environment stays stable when proxy switches from synthetic to real backend", async () => {
    const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
    const environment = { HOME: "/workspace", DEPLOY_TARGET: "lazy-test", GIT_ASKPASS: "/workspace/.opengeni/askpass" };
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
    });
    const syntheticManifest = (agent as { defaultManifest: unknown }).defaultManifest;
    const realManifest = buildManifest(settings, [], environment);
    const realBackend: RoutableBackendSession = {
      state: { manifest: realManifest },
      async exec() {
        return { stdout: "real", exitCode: 0 };
      },
    };
    const proxy = new RoutingSandboxSession({
      defaultResolved: {
        session: { state: { manifest: syntheticManifest } },
        sandboxId: null,
        kind: "unprovisioned",
      },
      readPointer: async () => ({ activeSandboxId: null, activeEpoch: 1 }),
      resolveActiveBackend: async () => ({ session: realBackend, sandboxId: null, kind: "modal" }),
    });

    const before = await manifestEnv((proxy.state as { manifest: never }).manifest);
    await proxy.exec({ cmd: "true" });
    const after = await manifestEnv((proxy.state as { manifest: never }).manifest);

    expect(before).toEqual(environment);
    expect(after).toEqual(environment);
  });

  test("real backend manifest equal to agent manifest emits no env drift during lazy setup", async () => {
    const settings = testSettings({ sandboxBackend: "modal", webSearchEnabled: false });
    const environment = { HOME: "/workspace", DEPLOY_TARGET: "lazy-test", GIT_ASKPASS: "/workspace/.opengeni/askpass" };
    const agent = buildOpenGeniAgent(settings, [], {
      model: new ScriptedModel([]),
      sandboxEnvironment: environment,
    });
    const realBackend: RoutableBackendSession = {
      state: { manifest: buildManifest(settings, [], environment) },
    };
    const events: Array<{ type: string; payload: unknown }> = [];

    await runOwnedSandboxSetup(agent, realBackend as never, realBackend as never, {
      settings,
      environment,
      onRuntimeEvent: (event) => {
        events.push(event);
      },
    });

    expect(events.filter((event) => event.type === "sandbox.env.drift")).toEqual([]);
    expect(await manifestEnv((agent as { defaultManifest: never }).defaultManifest)).toEqual(environment);
  });
});
