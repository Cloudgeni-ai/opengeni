import { describe, expect, test } from "bun:test";
import { localRuntimeBuildId } from "./prepare-local-agent-runtime";

describe("local Connected Machine runtime identity", () => {
  test("is deterministic and changes with the complete source identity", () => {
    const source = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const first = localRuntimeBuildId(source);
    expect(first).toBe(localRuntimeBuildId(source));
    expect(first).toStartWith(`local-${process.platform}-${process.arch}-0123456789abcdef0123`);
    expect(first).not.toBe(localRuntimeBuildId(`f${source.slice(1)}`));
  });
});
