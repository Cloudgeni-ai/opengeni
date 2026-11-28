import { describe, expect, test } from "bun:test";
import { SseProgressScanner } from "../src/stream-progress";

const encode = (text: string) => new TextEncoder().encode(text);

describe("SseProgressScanner", () => {
  test("status events are not progress whatever the order of their JSON properties", () => {
    const scanner = new SseProgressScanner();
    expect(scanner.push(encode(`data: {"type":"response.in_progress"}\n\n`))).toBe(false);
    expect(
      scanner.push(encode(`data: {"sequence_number":1,"type":"response.in_progress"}\n\n`)),
    ).toBe(false);
    expect(
      scanner.push(
        encode(`data: {"response":{"type":"x","status":"queued"},"type":"response.queued"}\n\n`),
      ),
    ).toBe(false);
  });

  test("the SSE event name marks a status event even when the data does not", () => {
    const scanner = new SseProgressScanner();
    expect(
      scanner.push(encode(`event: response.in_progress\ndata: {"sequence_number":1}\n\n`)),
    ).toBe(false);
    // The name ends with its event; the next event is judged on its own.
    expect(scanner.push(encode(`data: {"sequence_number":2}\n\n`))).toBe(true);
  });

  test("model events are progress, including across chunk boundaries", () => {
    const scanner = new SseProgressScanner();
    expect(scanner.push(encode(`event: response.output_text.delta\ndata: {"seq`))).toBe(false);
    expect(
      scanner.push(encode(`uence_number":3,"type":"response.output_text.delta","delta":"hi"}\n\n`)),
    ).toBe(true);
    expect(scanner.push(encode(`data: {"choices":[{"delta":{"content":"x"}}]}\n\n`))).toBe(true);
    expect(scanner.push(encode(`data: [DONE]\n\n`))).toBe(true);
  });

  test("comments and keepalive pings are not progress", () => {
    const scanner = new SseProgressScanner();
    expect(scanner.push(encode(`: keepalive\n\nevent: ping\ndata: {}\n\n`))).toBe(false);
  });
});
