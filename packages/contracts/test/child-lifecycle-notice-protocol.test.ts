import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

import {
  childLifecycleNoticeSchemaFingerprint,
  FLAG_GATED_CHILD_LIFECYCLE_NOTICE_KINDS,
  renderChildLifecycleNoticeProtocol,
} from "../src/child-lifecycle-notice-protocol";
import { CHILD_LIFECYCLE_SYSTEM_UPDATE_KINDS, SessionSystemUpdateKind } from "../src/index";

function utf8Bounded(maxBytes: number) {
  return z
    .string()
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
      `must be at most ${maxBytes} UTF-8 bytes`,
    );
}

describe("child lifecycle notice protocol", () => {
  test("the committed rendering matches the source schemas", () => {
    const committed = readFileSync(
      new URL("../src/child-lifecycle-notice-protocol.gen.json", import.meta.url),
      "utf8",
    );
    expect(committed).toBe(renderChildLifecycleNoticeProtocol());
  });

  test("the gated kinds are every child lifecycle kind except the terminal result", () => {
    expect([...FLAG_GATED_CHILD_LIFECYCLE_NOTICE_KINDS].sort()).toEqual(
      CHILD_LIFECYCLE_SYSTEM_UPDATE_KINDS.filter((kind) => kind !== "child_terminal_result").sort(),
    );
    for (const kind of FLAG_GATED_CHILD_LIFECYCLE_NOTICE_KINDS) {
      expect(SessionSystemUpdateKind.options).toContain(kind);
    }
  });

  test("every gated payload records its refinements", () => {
    const rendered = JSON.parse(renderChildLifecycleNoticeProtocol()) as {
      payloads: Record<string, unknown>;
    };
    expect(Object.keys(rendered.payloads).sort()).toEqual(
      [...FLAG_GATED_CHILD_LIFECYCLE_NOTICE_KINDS].sort(),
    );
    expect(JSON.stringify(rendered.payloads)).toContain("x-opengeni-refinements");
  });

  test("a refinement limit change changes the fingerprint", () => {
    const before = childLifecycleNoticeSchemaFingerprint(z.object({ note: utf8Bounded(512) }));
    const same = childLifecycleNoticeSchemaFingerprint(z.object({ note: utf8Bounded(512) }));
    const after = childLifecycleNoticeSchemaFingerprint(z.object({ note: utf8Bounded(1024) }));
    expect(JSON.stringify(same)).toBe(JSON.stringify(before));
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });

  test("a new optional field changes the fingerprint", () => {
    const before = childLifecycleNoticeSchemaFingerprint(z.object({ a: z.string() }));
    const after = childLifecycleNoticeSchemaFingerprint(
      z.object({ a: z.string(), b: z.string().optional() }),
    );
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });

  test("a refinement without a message is refused", () => {
    expect(() =>
      childLifecycleNoticeSchemaFingerprint(z.object({ note: z.string().refine((v) => v !== "") })),
    ).toThrow(/refinement has no message string/);
  });

  test("preprocessing and transforms are refused", () => {
    expect(() =>
      childLifecycleNoticeSchemaFingerprint(z.object({ note: z.preprocess((v) => v, z.string()) })),
    ).toThrow(/cannot be fingerprinted/);
    expect(() =>
      childLifecycleNoticeSchemaFingerprint(
        z.object({ note: z.string().transform((v) => v.length) }),
      ),
    ).toThrow(/cannot be fingerprinted/);
  });

  test("a value rewrite changes the fingerprint", () => {
    const before = childLifecycleNoticeSchemaFingerprint(z.object({ note: z.string() }));
    const after = childLifecycleNoticeSchemaFingerprint(z.object({ note: z.string().trim() }));
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });
});
