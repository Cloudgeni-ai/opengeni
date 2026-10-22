import { expect, test } from "bun:test";

// Each adapter must be a valid first import in a fresh process. Importing
// the package barrel first can mask adapter -> codec -> repository ->
// registry initialization cycles, so an in-process test is insufficient.
test.each(["claude", "codex", "xai"])(
  "%s adapter can be imported before the registry",
  (id) => {
    const adapter = new URL(`../src/subscription-core-${id}-adapter.ts`, import.meta.url).pathname;
    const registry = new URL("../src/subscription-core-providers.ts", import.meta.url).pathname;
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `
    await import(${JSON.stringify(adapter)});
    const registry = await import(${JSON.stringify(registry)});
    const ids = registry.subscriptionCoreProviderIds();
    for (const id of ids) {
      if (registry.subscriptionCoreProvider(id).adapter.provider !== id) throw new Error("binding mismatch");
    }
    console.log(JSON.stringify(ids));
  `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual(["claude", "codex", "xai"]);
  },
  30_000,
);
