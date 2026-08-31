import { describe, expect, test } from "bun:test";

const modalAdapter = new URL(
  "../node_modules/@openai/agents-extensions/dist/sandbox/modal/sandbox.mjs",
  import.meta.url,
);
const modalAdapterTypes = new URL(
  "../node_modules/@openai/agents-extensions/dist/sandbox/modal/sandbox.d.ts",
  import.meta.url,
);

describe("Modal resource reservation adapter", () => {
  test("types CPU and memory reservations on client options and durable session state", async () => {
    const source = await Bun.file(modalAdapterTypes).text();
    expect(source.match(/cpu\?: number;/g)).toHaveLength(2);
    expect(source.match(/memoryMiB\?: number;/g)).toHaveLength(2);
  });

  test("preserves reservations across create, replacement, deserialize, and resume", async () => {
    const source = await Bun.file(modalAdapter).text();

    expect(source).toContain("{ cpu: this.state.cpu }");
    expect(source).toContain("{ memoryMiB: this.state.memoryMiB }");
    expect(source).toContain("{ cpu: resolvedOptions.cpu }");
    expect(source).toContain("{ memoryMiB: resolvedOptions.memoryMiB }");
    expect(source).toContain("cpu: resolvedOptions.cpu");
    expect(source).toContain("memoryMiB: resolvedOptions.memoryMiB");
    expect(source).toContain("cpu: readOptionalNumber(state, 'cpu')");
    expect(source).toContain("memoryMiB: readOptionalNumber(state, 'memoryMiB')");
    expect(source).toContain("cpu: state.cpu");
    expect(source).toContain("memoryMiB: state.memoryMiB");
    expect(source).toContain("cpu: overrides?.cpu ?? defaults.cpu");
    expect(source).toContain("memoryMiB: overrides?.memoryMiB ?? defaults.memoryMiB");
    expect(source).toContain("['cpu', options.cpu]");
    expect(source).toContain("['memoryMiB', options.memoryMiB]");
  });
});
