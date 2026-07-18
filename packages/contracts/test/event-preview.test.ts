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
    expect(metadata?.fullEvidence).toEqual({ available: false, reason: "not_retained" });
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
    expect(first).toMatchObject({ id: "call-error", name: "parallel", isError: true });
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
});
