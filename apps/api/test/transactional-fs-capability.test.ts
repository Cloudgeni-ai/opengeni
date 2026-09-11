import { expect, test } from "bun:test";
import { Hello } from "@opengeni/agent-proto";
import { helloRuntimeCapabilities } from "../src/sandbox/metrics-ingestion";

test("Hello capability projection preserves true and resets on false or missing", () => {
  for (const transactionalFsWrite of [true, false, undefined]) {
    const hello = Hello.decode(
      Hello.encode(
        Hello.fromPartial({
          capabilities: { transactionalFsWrite },
        }),
      ).finish(),
    );
    expect(helloRuntimeCapabilities(hello).transactionalFsWrite).toBe(
      transactionalFsWrite === true,
    );
  }
  expect(helloRuntimeCapabilities(Hello.fromPartial({}))).toEqual({});
});
