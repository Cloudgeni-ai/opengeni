import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";

import {
  childLifecycleNoticeSchemaFingerprint,
  FLAG_GATED_CHILD_LIFECYCLE_NOTICE_KINDS,
  renderChildLifecycleNoticeProtocol,
} from "../src/child-lifecycle-notice-protocol";
import {
  CHILD_LIFECYCLE_SYSTEM_UPDATE_KINDS,
  SessionSystemUpdateKind,
  SystemUpdateClassification,
  UTF8_BYTE_LIMIT_CHECKS,
} from "../src/index";

/** A bounded string whose limit is recorded as data, like the contracts helper. */
function utf8Bounded(maxBytes: number, message = `must be at most ${maxBytes} UTF-8 bytes`) {
  const schema = z
    .string()
    .refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes, message);
  UTF8_BYTE_LIMIT_CHECKS.set(schema._zod.def.checks!.at(-1)!, maxBytes);
  return schema;
}

const render = (schema: z.ZodType) => JSON.stringify(childLifecycleNoticeSchemaFingerprint(schema));

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

  test("the rendering carries kinds, classifications and every gated payload's byte limits", () => {
    const rendered = JSON.parse(renderChildLifecycleNoticeProtocol()) as {
      kinds: string[];
      classifications: string[];
      payloads: Record<string, unknown>;
    };
    expect(rendered.kinds).toEqual([...SessionSystemUpdateKind.options]);
    expect(rendered.classifications).toEqual([...SystemUpdateClassification.options]);
    expect(Object.keys(rendered.payloads).sort()).toEqual(
      [...FLAG_GATED_CHILD_LIFECYCLE_NOTICE_KINDS].sort(),
    );
    expect(JSON.stringify(rendered.payloads)).toContain('"utf8MaxBytes":512');
  });

  test("identical schemas render identically", () => {
    expect(render(z.object({ note: utf8Bounded(512) }))).toBe(
      render(z.object({ note: utf8Bounded(512) })),
    );
  });

  for (const [name, before, after] of [
    [
      "a byte limit behind an unchanged message",
      utf8Bounded(10, "too long"),
      utf8Bounded(20, "too long"),
    ],
    ["a refinement message", utf8Bounded(10, "too long"), utf8Bounded(10, "is too long")],
    ["regex flags", z.string().regex(/x/), z.string().regex(/x/i)],
    ["a URL protocol", z.url({ protocol: /^https$/ }), z.url({ protocol: /^https?$/ })],
    ["a URL hostname", z.url({ hostname: /^a\.test$/ }), z.url({ hostname: /^b\.test$/ })],
    ["a length limit", z.string().max(5), z.string().max(6)],
    ["a value rewrite", z.string(), z.string().trim()],
    [
      "a new optional field",
      z.object({ a: z.string() }),
      z.object({ a: z.string(), b: z.string().optional() }),
    ],
    ["an enum option", z.enum(["a"]), z.enum(["a", "b"])],
  ] as const) {
    test(`${name} changes the rendering`, () => {
      expect(render(after)).not.toBe(render(before));
    });
  }

  test("a refinement that does not record its limit as data is refused", () => {
    expect(() =>
      render(z.object({ note: z.string().refine((value) => value.length < 10, "too long") })),
    ).toThrow(/does not record its limit as data/);
  });

  test("a conditional refinement is refused", () => {
    const schema = z
      .string()
      .refine((value) => value.length < 10, { message: "too long", when: () => false });
    UTF8_BYTE_LIMIT_CHECKS.set(schema._zod.def.checks!.at(-1)!, 10);
    expect(() => render(z.object({ note: schema }))).toThrow(/conditional/);
  });

  test("preprocessing and transforms are refused", () => {
    expect(() => render(z.object({ note: z.preprocess((v) => v, z.string()) }))).toThrow(
      /cannot be fingerprinted/,
    );
    expect(() => render(z.object({ note: z.string().transform((v) => v.length) }))).toThrow(
      /cannot be fingerprinted/,
    );
  });
});
