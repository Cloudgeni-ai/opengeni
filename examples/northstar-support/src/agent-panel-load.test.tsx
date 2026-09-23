import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentPanelLoadBoundary,
  AgentPanelLoadError,
  agentPanelContentWhilePresent,
  createAgentPanelLoadLifecycle,
  loadAgentPanelModule,
  shouldRestoreAgentPanel,
  type AgentPanelLoadEnvironment,
} from "./agent-panel-load";

describe("Northstar deferred agent panel recovery", () => {
  test("removes provider content as soon as the animated panel begins exiting", () => {
    const provider = <div data-provider>provider</div>;
    expect(renderToStaticMarkup(agentPanelContentWhilePresent(true, provider))).toContain(
      "data-provider",
    );
    expect(renderToStaticMarkup(agentPanelContentWhilePresent(false, provider))).toBe("");
  });

  test("does not reload a stale panel after disable, even if a later enable starts", async () => {
    const storage = memoryStorage();
    const reloads: string[] = [];
    const navigation = new Error("navigation requested");
    const failure = new TypeError("Failed to fetch dynamically imported module");
    let resolveCurrentBuild: (buildId: string) => void = () => {};
    const currentBuildRequested = Promise.withResolvers<void>();
    const staleEnvironment = environment({
      loadedBuildId: "/assets/index-old.js",
      currentBuildId: "/assets/index-new.js",
      storage,
      reloads,
      navigation,
    });
    staleEnvironment.readCurrentBuildId = () => {
      currentBuildRequested.resolve();
      return new Promise((resolve) => {
        resolveCurrentBuild = resolve;
      });
    };
    const lifecycle = createAgentPanelLoadLifecycle(true);
    const loadGeneration = lifecycle.capture();

    const pendingLoad = loadAgentPanelModule(
      async () => {
        throw failure;
      },
      staleEnvironment,
      () => lifecycle.isCurrent(loadGeneration),
    );
    await currentBuildRequested.promise;
    lifecycle.setEnabled(false);
    lifecycle.setEnabled(true);
    resolveCurrentBuild("/assets/index-new.js");

    await expect(pendingLoad).rejects.toBe(failure);
    expect(reloads).toEqual([]);
    expect(shouldRestoreAgentPanel(staleEnvironment)).toBe(false);
  });

  test("reloads once into the current build and clears the marker after recovery", async () => {
    const storage = memoryStorage();
    const reloads: string[] = [];
    const navigation = new Error("navigation requested");
    const staleEnvironment = environment({
      loadedBuildId: "/assets/index-old.js",
      currentBuildId: "/assets/index-new.js",
      storage,
      reloads,
      navigation,
    });

    await expect(
      loadAgentPanelModule(async () => {
        throw new TypeError("Failed to fetch dynamically imported module");
      }, staleEnvironment),
    ).rejects.toBe(navigation);
    expect(reloads).toEqual(["/assets/index-new.js"]);
    expect(shouldRestoreAgentPanel(staleEnvironment)).toBe(true);

    const recoveredEnvironment = environment({
      loadedBuildId: "/assets/index-new.js",
      currentBuildId: "/assets/index-new.js",
      storage,
      reloads,
      navigation,
    });
    await expect(loadAgentPanelModule(async () => "loaded", recoveredEnvironment)).resolves.toBe(
      "loaded",
    );
    expect(shouldRestoreAgentPanel(recoveredEnvironment)).toBe(false);
    expect(reloads).toHaveLength(1);
  });

  test("consumes a build-B marker after a successful build-C load so a later disable persists", async () => {
    const storage = memoryStorage();
    const reloads: string[] = [];
    const navigation = new Error("navigation requested");
    const staleEnvironment = environment({
      loadedBuildId: "/assets/index-a.js",
      currentBuildId: "/assets/index-b.js",
      storage,
      reloads,
      navigation,
    });

    await expect(
      loadAgentPanelModule(async () => {
        throw new TypeError("Failed to fetch dynamically imported module");
      }, staleEnvironment),
    ).rejects.toBe(navigation);
    expect(shouldRestoreAgentPanel(staleEnvironment)).toBe(true);

    const loadedBuildC = environment({
      loadedBuildId: "/assets/index-c.js",
      currentBuildId: "/assets/index-c.js",
      storage,
      reloads,
      navigation,
    });
    await expect(loadAgentPanelModule(async () => "loaded", loadedBuildC)).resolves.toBe("loaded");
    expect(shouldRestoreAgentPanel(loadedBuildC)).toBe(false);

    const laterReloadAfterUserDisable = environment({
      loadedBuildId: "/assets/index-c.js",
      currentBuildId: "/assets/index-c.js",
      storage,
      reloads,
      navigation,
    });
    expect(shouldRestoreAgentPanel(laterReloadAfterUserDisable)).toBe(false);
    expect(reloads).toEqual(["/assets/index-b.js"]);
  });

  test("repeated same-build failures reject visibly without a reload loop", async () => {
    const storage = memoryStorage();
    const reloads: string[] = [];
    const navigation = new Error("navigation requested");
    const failure = new Error("module initialization failed");
    const staleEnvironment = environment({
      loadedBuildId: "/assets/index-old.js",
      currentBuildId: "/assets/index-current.js",
      storage,
      reloads,
      navigation,
    });

    await expect(
      loadAgentPanelModule(async () => {
        throw failure;
      }, staleEnvironment),
    ).rejects.toBe(navigation);
    expect(shouldRestoreAgentPanel(staleEnvironment)).toBe(true);

    const currentEnvironment = environment({
      loadedBuildId: "/assets/index-current.js",
      currentBuildId: "/assets/index-current.js",
      storage,
      reloads,
      navigation,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        loadAgentPanelModule(async () => {
          throw failure;
        }, currentEnvironment),
      ).rejects.toBe(failure);
    }
    expect(shouldRestoreAgentPanel(currentEnvironment)).toBe(false);
    expect(reloads).toEqual(["/assets/index-current.js"]);

    expect(AgentPanelLoadBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const fallback = renderToStaticMarkup(<AgentPanelLoadError />);
    expect(fallback).toContain('role="alert"');
    expect(fallback).toContain("OpenGeni panel unavailable");
    expect(fallback).toContain("Reload demo");
  });
});

function environment({
  loadedBuildId,
  currentBuildId,
  storage,
  reloads,
  navigation,
}: {
  loadedBuildId: string;
  currentBuildId: string;
  storage: Storage;
  reloads: string[];
  navigation: Error;
}): AgentPanelLoadEnvironment {
  return {
    loadedBuildId,
    readCurrentBuildId: async () => currentBuildId,
    reload: (targetBuildId) => reloads.push(targetBuildId),
    storage,
    waitForNavigation: async () => {
      throw navigation;
    },
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
