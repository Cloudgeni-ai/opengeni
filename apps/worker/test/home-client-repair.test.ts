import { expect, test } from "bun:test";

const scenarios = [
  "eager",
  "lazy",
  "admission-failure",
  "preparation-failure",
  "settlement-failure",
  "unchanged",
  "native",
  "routing-await",
  "routing-rejection",
  "routing-unchanged",
] as const;

for (const scenario of scenarios) {
  test(`bounded home client repair: ${scenario}`, async () => {
    // Bun module mocks are process-global: never let fixture doubles leak into
    // another worker test (or import the worker before installing those mocks).
    const child = Bun.spawn(
      [
        process.execPath,
        new URL("./fixtures/home-client-repair.ts", import.meta.url).pathname,
        scenario,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout.trim()).toBe(`passed:${scenario}`);
  }, 30_000);
}
