import { describe, expect, test } from "bun:test";
import { parseSseStream } from "../src/sse";
import { bytesStream, collect } from "./helpers";

describe("parseSseStream", () => {
  test("parses id, event, and data fields", async () => {
    const messages = await collect(parseSseStream(bytesStream([
      'id: 7\nevent: agent.message.delta\ndata: {"a":1}\n\n',
    ])));
    expect(messages).toEqual([{ id: "7", event: "agent.message.delta", data: '{"a":1}' }]);
  });

  test("handles chunks split at arbitrary byte boundaries", async () => {
    const wire = 'id: 1\nevent: x\ndata: {"long":"payload"}\n\nid: 2\nevent: y\ndata: {}\n\n';
    const chunks = [...wire].map((char) => char); // one byte per chunk
    const messages = await collect(parseSseStream(bytesStream(chunks)));
    expect(messages).toEqual([
      { id: "1", event: "x", data: '{"long":"payload"}' },
      { id: "2", event: "y", data: "{}" },
    ]);
  });

  test("joins multi-line data with newlines", async () => {
    const messages = await collect(parseSseStream(bytesStream(["data: line1\ndata: line2\n\n"])));
    expect(messages).toEqual([{ data: "line1\nline2" }]);
  });

  test("supports CRLF line endings", async () => {
    const messages = await collect(parseSseStream(bytesStream(["id: 3\r\ndata: hello\r\n\r\n"])));
    expect(messages).toEqual([{ id: "3", data: "hello" }]);
  });

  test("ignores comment lines and blocks without data", async () => {
    const messages = await collect(parseSseStream(bytesStream([
      ": connected\n\nid: 9\n\ndata: real\n\n",
    ])));
    expect(messages).toEqual([{ data: "real" }]);
  });

  test("strips exactly one leading space from field values", async () => {
    const messages = await collect(parseSseStream(bytesStream(["data:  spaced\ndata:tight\n\n"])));
    expect(messages).toEqual([{ data: " spaced\ntight" }]);
  });

  test("discards a block truncated before its blank line", async () => {
    const messages = await collect(parseSseStream(bytesStream([
      "data: complete\n\nid: 5\ndata: {\"trunc",
    ])));
    expect(messages).toEqual([{ data: "complete" }]);
  });

  test("treats a field line without a colon as an empty value", async () => {
    const messages = await collect(parseSseStream(bytesStream(["data\n\n"])));
    expect(messages).toEqual([{ data: "" }]);
  });
});
