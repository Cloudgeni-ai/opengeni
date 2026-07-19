import { describe, expect, test } from "bun:test";
import {
  SESSION_EVENT_PAYLOAD_MAX_BYTES,
  boundSessionEventPayload,
  sessionEventJsonBytes,
  sessionEventPayloadTruncation,
} from "../src/event-preview";

describe("bounded session event payloads", () => {
  test("returns ordinary payloads by reference", () => {
    const payload = { id: "call-1", output: "ok", isError: false };
    expect(boundSessionEventPayload(payload)).toBe(payload);
  });

  test("bounds multi-megabyte text with explicit, exact metadata and head/tail truth", () => {
    const output = `HEAD-${"x".repeat(3 * 1024 * 1024)}-TAIL`;
    const bounded = boundSessionEventPayload({ id: "call-1", output });
    const metadata = sessionEventPayloadTruncation(bounded);

    expect(sessionEventJsonBytes(bounded)).toBeLessThanOrEqual(SESSION_EVENT_PAYLOAD_MAX_BYTES);
    expect(bounded.id).toBe("call-1");
    expect(String(bounded.output)).toStartWith("HEAD-");
    expect(String(bounded.output)).toEndWith("-TAIL");
    expect(String(bounded.output)).toContain("bytes omitted");
    expect(metadata).not.toBeNull();
    expect(metadata?.surface).toBe("durable_audit");
    expect(metadata?.reason).toBe("payload_bytes_exceeded");
    expect(metadata?.originalBytes).toBe(sessionEventJsonBytes({ id: "call-1", output }));
    expect(metadata?.deliveredBytes).toBe(sessionEventJsonBytes(bounded));
    expect(metadata?.omittedBytes).toBe(
      (metadata?.originalBytes ?? 0) - (metadata?.deliveredBytes ?? 0),
    );
    expect(metadata?.fullEvidence).toEqual({
      available: false,
      reason: "not_retained",
    });
  });

  test("bounds structured, mixed, error, and parallel-shaped output deterministically", () => {
    const payload = {
      id: "call-error",
      name: "parallel",
      isError: true,
      output: Array.from({ length: 400 }, (_, index) => ({
        index,
        stdout: `head-${index}-${"🙂".repeat(4096)}-tail-${index}`,
        error: index % 7 === 0 ? { code: "EFAIL", message: "boom".repeat(20_000) } : null,
      })),
    };
    const first = boundSessionEventPayload(payload);
    const second = boundSessionEventPayload(payload);

    expect(first).toEqual(second);
    expect(sessionEventJsonBytes(first)).toBeLessThanOrEqual(SESSION_EVENT_PAYLOAD_MAX_BYTES);
    expect(first).toMatchObject({
      id: "call-error",
      name: "parallel",
      isError: true,
    });
    expect(
      sessionEventPayloadTruncation(first)?.details.some((detail) => detail.kind === "array"),
    ).toBeTrue();
    expect(JSON.stringify(first)).not.toContain("�");
  });

  test("replaces inline images and typed binary data with truthful non-retained facts", () => {
    const imageBytes = 2 * 1024 * 1024;
    const dataUrl = `data:image/png;base64,${"A".repeat(Math.ceil((imageBytes * 4) / 3))}`;
    const bounded = boundSessionEventPayload({
      id: "shot-1",
      output: [
        { type: "input_image", image: dataUrl },
        { type: "text", text: "visible explanation" },
        new Uint8Array(1024),
      ],
    });

    expect(sessionEventJsonBytes(bounded)).toBeLessThanOrEqual(SESSION_EVENT_PAYLOAD_MAX_BYTES);
    expect(JSON.stringify(bounded)).not.toContain("data:image/png;base64");
    expect(bounded).toMatchObject({ id: "shot-1" });
    expect(sessionEventPayloadTruncation(bounded)?.reason).toBe("inline_media_not_retained");
    expect(sessionEventPayloadTruncation(bounded)?.fullEvidence.available).toBeFalse();
    expect(JSON.stringify(bounded)).toContain("visible explanation");
    expect(JSON.stringify(bounded)).toContain("media_preview");
    expect(JSON.stringify(bounded)).toContain("binary_preview");
  });

  test("defensive surfaces identify where a legacy payload was bounded", () => {
    const bounded = boundSessionEventPayload(
      { id: "legacy", output: "z".repeat(200_000) },
      { surface: "sse_legacy_guard" },
    );
    expect(sessionEventPayloadTruncation(bounded)?.surface).toBe("sse_legacy_guard");
  });

  test("reports cyclic source size as unknown instead of measuring a placeholder", () => {
    const cyclic: Record<string, unknown> = {
      id: "cyclic-output",
      text: "visible",
    };
    cyclic.self = cyclic;

    const bounded = boundSessionEventPayload(cyclic);
    const metadata = sessionEventPayloadTruncation(bounded);

    expect(sessionEventJsonBytes(bounded)).toBeLessThanOrEqual(SESSION_EVENT_PAYLOAD_MAX_BYTES);
    expect(metadata).toMatchObject({
      reason: "payload_not_serializable",
      originalBytes: null,
      omittedBytes: null,
      estimatedOriginalTokens: null,
      deliveredBytes: sessionEventJsonBytes(bounded),
    });
  });

  test("turns BigInt, function, and symbol values into serializable explicit omissions", () => {
    const bounded = boundSessionEventPayload({
      id: "unserializable-values",
      bigint: 10n,
      function: () => "not retained",
      symbol: Symbol("not retained"),
    });
    const metadata = sessionEventPayloadTruncation(bounded);

    expect(() => JSON.stringify(bounded)).not.toThrow();
    expect(JSON.stringify(bounded)).toContain("bigint value omitted");
    expect(JSON.stringify(bounded)).toContain("function value omitted");
    expect(JSON.stringify(bounded)).toContain("symbol value omitted");
    expect(metadata?.reason).toBe("payload_not_serializable");
    expect(metadata?.originalBytes).toBeNull();
    expect(metadata?.deliveredBytes).toBe(sessionEventJsonBytes(bounded));
  });

  test("bounds total traversal and reports unknown size without enumerating a broad graph", () => {
    const payload: Record<string, unknown> = { id: "broad-output" };
    for (let field = 0; field < 3_000; field += 1) {
      payload[`field-${field}`] = { value: field };
    }

    const bounded = boundSessionEventPayload(payload);
    const metadata = sessionEventPayloadTruncation(bounded);

    expect(sessionEventJsonBytes(bounded)).toBeLessThanOrEqual(SESSION_EVENT_PAYLOAD_MAX_BYTES);
    expect(metadata).toMatchObject({
      reason: "payload_measurement_bounded",
      originalBytes: null,
      omittedBytes: null,
      estimatedOriginalTokens: null,
      fullEvidence: { available: false, reason: "not_retained" },
    });
    expect(
      metadata?.details.some(
        (detail) => detail.kind === "budget" || detail.omittedEntries === null,
      ),
    ).toBeTrue();
  });

  test("measures JSON string escapes exactly without materializing the full payload JSON", () => {
    const output = `${'"\\\n'.repeat(500_000)}TAIL`;
    const payload = { id: "escaped-output", output };
    const bounded = boundSessionEventPayload(payload);
    expect(sessionEventPayloadTruncation(bounded)?.originalBytes).toBe(
      sessionEventJsonBytes(payload),
    );
    expect(sessionEventJsonBytes(bounded)).toBeLessThanOrEqual(SESSION_EVENT_PAYLOAD_MAX_BYTES);
  });

  test("matches JSON wire bytes for representative structured values", () => {
    const nullPrototype = Object.assign(Object.create(null), {
      alpha: "β",
      omitted: undefined,
      nested: [1, true, null],
    }) as Record<string, unknown>;
    const values: unknown[] = [
      'quotes-"-slashes-\\-controls-\b\t\n\f\r\u0000\u001f',
      "multilingual-Καλημέρα-你好-🙂",
      `surrogates-${String.fromCharCode(0xd800)}-${String.fromCharCode(0xdc00)}-pair-🙂`,
      [undefined, () => null, Symbol("array"), Number.NaN, Infinity, -Infinity],
      {
        undefinedValue: undefined,
        functionValue: () => null,
        symbolValue: Symbol("object"),
        negativeZero: -0,
      },
      new Date("2026-07-19T03:00:00.000Z"),
      new Date(Number.NaN),
      nullPrototype,
    ];

    for (const [index, value] of values.entries()) {
      const payload = {
        id: `parity-${index}`,
        value,
        padding: "p".repeat(SESSION_EVENT_PAYLOAD_MAX_BYTES),
      };
      const bounded = boundSessionEventPayload(payload);
      expect(sessionEventPayloadTruncation(bounded)?.originalBytes).toBe(
        sessionEventJsonBytes(payload),
      );
    }
  });

  test("keeps UTF-8 truncation allocation-bounded and reports the exact omitted source bytes", () => {
    const output = `HEAD-${"🙂é".repeat(1_000_000)}-TAIL`;
    const bounded = boundSessionEventPayload({ id: "utf8-output", output });
    const delivered = String(bounded.output);
    const marker = /…\[(\d+) bytes omitted\]…/u.exec(delivered);

    expect(marker).not.toBeNull();
    const retained = delivered.replace(marker?.[0] ?? "", "");
    expect(Number(marker?.[1])).toBe(
      new TextEncoder().encode(output).byteLength - new TextEncoder().encode(retained).byteLength,
    );
    expect(delivered).toStartWith("HEAD-");
    expect(delivered).toEndWith("-TAIL");
    expect(delivered).not.toContain("�");
  });

  test("does not invoke custom serializers or accessors while measuring and previewing", () => {
    let serializerCalls = 0;
    let accessorCalls = 0;
    const custom = {
      visible: "kept",
      toJSON() {
        serializerCalls += 1;
        return "must-not-run";
      },
    };
    Object.defineProperty(custom, "dangerous", {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return "must-not-run";
      },
    });

    const bounded = boundSessionEventPayload({ id: "custom-output", custom });
    expect(serializerCalls).toBe(0);
    expect(accessorCalls).toBe(0);
    expect(sessionEventPayloadTruncation(bounded)?.reason).toBe("payload_measurement_bounded");
    expect(JSON.stringify(bounded)).toContain("accessor value omitted");
    expect(JSON.stringify(bounded)).not.toContain("must-not-run");
  });

  test("bounds measurement recursion before deeply nested JSON can exhaust the stack", () => {
    const payload: Record<string, unknown> = { id: "deep-output" };
    let cursor = payload;
    for (let depth = 0; depth < 5_000; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    const bounded = boundSessionEventPayload(payload);
    expect(sessionEventPayloadTruncation(bounded)?.reason).toBe("payload_measurement_bounded");
    expect(sessionEventJsonBytes(bounded)).toBeLessThanOrEqual(SESSION_EVENT_PAYLOAD_MAX_BYTES);
  });
});
